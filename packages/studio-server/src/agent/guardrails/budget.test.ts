import { afterEach, describe, expect, it } from "vitest";
import { parseUsage, resolveBudget, RunMeter, type CompletionUsage } from "./budget.js";

const ENV_KEYS = [
  "TABARIO_STUDIO_MAX_OUTPUT_TOKENS",
  "TABARIO_STUDIO_RUN_TOKEN_BUDGET",
  "TABARIO_STUDIO_RUN_COST_BUDGET_USD",
  "TABARIO_STUDIO_MODEL_RATES",
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

function payload(usage: Record<string, unknown> | undefined): unknown {
  return { choices: [{ message: { content: "ok" } }], ...(usage ? { usage } : {}) };
}

describe("run budget", () => {
  it("defaults to the documented ceilings and lets the environment lower them", () => {
    expect(resolveBudget()).toEqual({
      maxOutputTokens: 8_000,
      maxRunTokens: 400_000,
      maxRunCostUsd: 0.5,
    });
    process.env.TABARIO_STUDIO_MAX_OUTPUT_TOKENS = "512";
    process.env.TABARIO_STUDIO_RUN_COST_BUDGET_USD = "0.05";
    expect(resolveBudget()).toMatchObject({ maxOutputTokens: 512, maxRunCostUsd: 0.05 });
  });

  it("ignores a junk or non-positive override rather than disabling the ceiling", () => {
    // A ceiling silently set to zero by a typo is worse than no ceiling: it
    // refuses every run and reads like an outage.
    process.env.TABARIO_STUDIO_RUN_TOKEN_BUDGET = "0";
    process.env.TABARIO_STUDIO_MAX_OUTPUT_TOKENS = "not-a-number";
    expect(resolveBudget()).toMatchObject({ maxRunTokens: 400_000, maxOutputTokens: 8_000 });
  });
});

describe("usage parsing", () => {
  it("prefers the provider's own cost over any local table", () => {
    process.env.TABARIO_STUDIO_MODEL_RATES = JSON.stringify({
      "google/gemini-2.5-flash": { prompt: 1000, completion: 1000 },
    });
    expect(
      parseUsage(
        payload({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.004 }),
        "google/gemini-2.5-flash",
      ),
    ).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      costUsd: 0.004,
      costSource: "provider",
      costConfidence: "actual",
    });
  });

  it("falls back to the rate table, marked estimated", () => {
    process.env.TABARIO_STUDIO_MODEL_RATES = JSON.stringify({
      "google/gemini-2.5-flash": { prompt: 0.3, completion: 2.5 },
    });
    const usage = parseUsage(
      payload({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }),
      "google/gemini-2.5-flash",
    );
    expect(usage.costUsd).toBeCloseTo(2.8, 6);
    expect(usage.costSource).toBe("rate_table");
    expect(usage.costConfidence).toBe("estimated");
  });

  it("says unpriced rather than zero when nothing can price the run", () => {
    // The distinction this asserts is the whole point: a silent 0 would read as
    // a measured "this run was free" and would sum into a spend dashboard as
    // though it were one.
    const usage = parseUsage(payload({ prompt_tokens: 10, completion_tokens: 5 }), "unknown/model");
    expect(usage).toMatchObject({
      totalTokens: 15,
      costUsd: null,
      costSource: "unpriced",
      costConfidence: "unknown",
    });
  });

  it("survives a malformed rate table and a missing usage block", () => {
    process.env.TABARIO_STUDIO_MODEL_RATES = "{not json";
    expect(parseUsage(payload({ prompt_tokens: 3 }), "any/model").costSource).toBe("unpriced");
    expect(parseUsage(payload(undefined), "any/model")).toMatchObject({
      totalTokens: 0,
      costSource: "unpriced",
    });
  });

  it("derives total_tokens when the provider omits it", () => {
    expect(parseUsage(payload({ prompt_tokens: 7, completion_tokens: 4 }), "m").totalTokens).toBe(
      11,
    );
  });
});

function priced(total: number, cost: number): CompletionUsage {
  return {
    promptTokens: total,
    completionTokens: 0,
    totalTokens: total,
    costUsd: cost,
    costSource: "provider",
    costConfidence: "actual",
  };
}

describe("RunMeter", () => {
  it("does not stop a run that is within both ceilings", () => {
    const meter = new RunMeter({ maxOutputTokens: 100, maxRunTokens: 1000, maxRunCostUsd: 1 });
    meter.record(priced(400, 0.2));
    expect(meter.stop()).toBeNull();
    expect(meter.snapshot()).toMatchObject({ totalTokens: 400, costUsd: 0.2, rounds: 1 });
  });

  it("stops on the token ceiling", () => {
    const meter = new RunMeter({ maxOutputTokens: 100, maxRunTokens: 1000, maxRunCostUsd: 99 });
    meter.record(priced(600, 0.01));
    meter.record(priced(600, 0.01));
    expect(meter.stop()).toEqual({ reason: "tokens", used: 1200, limit: 1000 });
  });

  it("stops on the cost ceiling while the token ceiling is nowhere near", () => {
    // This is the case the token ceiling cannot see: a re-pointed model burns
    // the budget on comparatively few tokens.
    const meter = new RunMeter({ maxOutputTokens: 100, maxRunTokens: 400_000, maxRunCostUsd: 0.5 });
    meter.record(priced(2_000, 0.6));
    expect(meter.stop()).toEqual({ reason: "cost", used: 0.6, limit: 0.5 });
  });

  it("cannot enforce the cost ceiling on an unpriced run, and says so", () => {
    const meter = new RunMeter({
      maxOutputTokens: 100,
      maxRunTokens: 400_000,
      maxRunCostUsd: 0.01,
    });
    meter.record({
      promptTokens: 10,
      completionTokens: 10,
      totalTokens: 20,
      costUsd: null,
      costSource: "unpriced",
      costConfidence: "unknown",
    });
    expect(meter.stop()).toBeNull();
    expect(meter.snapshot()).toMatchObject({
      costUsd: null,
      costSource: "unpriced",
      costEnforceable: false,
    });
  });

  it("reports rate_table confidence only when no round was provider-priced", () => {
    const estimated: CompletionUsage = {
      promptTokens: 5,
      completionTokens: 5,
      totalTokens: 10,
      costUsd: 0.001,
      costSource: "rate_table",
      costConfidence: "estimated",
    };
    const onlyEstimates = new RunMeter({
      maxOutputTokens: 1,
      maxRunTokens: 1e9,
      maxRunCostUsd: 1e9,
    });
    onlyEstimates.record(estimated);
    expect(onlyEstimates.snapshot()).toMatchObject({
      costSource: "rate_table",
      costConfidence: "estimated",
    });

    const mixed = new RunMeter({ maxOutputTokens: 1, maxRunTokens: 1e9, maxRunCostUsd: 1e9 });
    mixed.record(estimated);
    mixed.record(priced(10, 0.002));
    expect(mixed.snapshot()).toMatchObject({ costSource: "provider", costConfidence: "actual" });
  });
});
