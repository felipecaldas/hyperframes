// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_IDLE_TIMEOUT_MS, agentStateRoot, unappliedReply } from "./runtime.js";

const source = readFileSync(new URL("./runtime.ts", import.meta.url).pathname, "utf8");

afterEach(() => {
  delete process.env.HYPERFRAMES_STATE_DIR;
});

describe("the agent run's budget and its state root", () => {
  /**
   * The CLI's `run_check` deadline is asserted to sit below this number, so the
   * number has to be the one the run actually uses. A constant exported for a
   * cross-package assertion and then not wired to the timer would make that
   * assertion green against nothing.
   */
  it("times a run out on the constant the CLI measures itself against", () => {
    expect(AGENT_IDLE_TIMEOUT_MS).toBe(3 * 60_000);
    expect(source).toContain(
      'timeoutFromEnv("HYPERFRAMES_AGENT_IDLE_TIMEOUT_MS", AGENT_IDLE_TIMEOUT_MS)',
    );
  });

  it("stages every run under the state root, which is what makes a staged path recognisable", () => {
    // The CLI refuses to screenshot a directory outside this root, so the root
    // has to be where staging actually goes.
    expect(source).toContain('join(agentStateRoot(), projectKey(job.project.dir), "staging")');
  });

  it("moves the state root with HYPERFRAMES_STATE_DIR, so a test can point both sides at a temp dir", () => {
    expect(agentStateRoot()).toBe(join(homedir(), ".hyperframes", "studio-agent"));

    process.env.HYPERFRAMES_STATE_DIR = "/tmp/hf-state-probe";

    expect(agentStateRoot()).toBe(join("/tmp/hf-state-probe", "studio-agent"));
  });
});

/**
 * TAB-1201. Caught on studio.tabario.com, not by a test: the gate refused two
 * caption edits for introducing nested `<div>`s, and the drawer told the user
 * both captions had been fixed. The refusal was present the whole time — as an
 * Activity line under the reply, and as `verdict = 'failed'` in `agent_runs`.
 * The ledger was right and the sentence the user read was wrong.
 */
describe("a turn that was refused does not get to claim it succeeded", () => {
  const REFUSAL =
    "Staged changes introduced lint errors and were not applied — " +
    'index.html: <div id="caption-11"> is a timeline element that contains nested <div>.';
  const CLAIM = 'I have updated "Caption 11" to display on two lines.';

  it("leads with the correction rather than appending it", () => {
    const reply = unappliedReply(CLAIM, REFUSAL);

    // Order is the entire signal — the drawer renders plain text, so a note
    // placed after the claim reads as a caveat to a success.
    expect(reply.indexOf("Nothing in your project changed")).toBe(0);
    expect(reply.indexOf(REFUSAL)).toBeLessThan(reply.indexOf(CLAIM));
  });

  it("keeps the model's account, marked as attempted rather than dropped", () => {
    const reply = unappliedReply(CLAIM, REFUSAL);

    // Discarding it would hide what the model tried, which is the one thing
    // that makes the refusal actionable.
    expect(reply).toContain(CLAIM);
    expect(reply).toContain("attempted, not what was changed");
  });

  it("still speaks when the model said nothing at all", () => {
    // Before this the run emitted no assistant bubble whatsoever and the only
    // account of the turn was an Activity line.
    expect(unappliedReply("", REFUSAL)).toContain(REFUSAL);
  });

  it("leaves an applied turn exactly as the model wrote it", () => {
    expect(unappliedReply(CLAIM, null)).toBe(CLAIM);
    expect(unappliedReply("", null)).toBe("");
  });

  it("is wired into the reply the run records, not merely exported", () => {
    // The transcript is fed back to the model by `execute`, so routing the
    // reply through this is what stops a refused claim becoming the next
    // turn's premise. Exported and unwired, every assertion above is green
    // against nothing.
    expect(source).toContain(
      "this.recordAssistant(job, thread, unappliedReply(assistantText, stopped))",
    );
    expect(source).toContain("const stopped = timeouts.reason() ?? failure;");
  });
});

describe("the check at apply is in the path of every change (TAB-1222)", () => {
  it("runs before the meter is recorded, so a refused run still says what the check cost", () => {
    const checked = source.indexOf("await this.checkStaged(job, thread, trees, timeouts.touch)");
    const metered = source.indexOf("this.recordMeter(job, ledger, result, tools, staged.review)");
    const applied = source.indexOf("await this.validateAndApply(job, ledger, trees, staged)");
    expect(checked).toBeGreaterThan(-1);
    expect(metered).toBeGreaterThan(checked);
    expect(applied).toBeGreaterThan(metered);
  });

  it("puts the check's ruling ahead of every other gate at apply", () => {
    const ruling = source.indexOf("change.review?.refusal ??");
    expect(ruling).toBeGreaterThan(-1);
    expect(source.indexOf("await this.stagedRefusal(", ruling)).toBeGreaterThan(ruling);
  });

  it("measures the model's change from the baseline, and hands the check no material", () => {
    expect(source).toContain("compareAgentSnapshots(baseline, diff.after)");
    // The check is given the transcript and picks the user's words out of it.
    // It is never given the request, which is where a panel's material lives.
    const call = source.slice(source.indexOf("return reviewChange({"));
    const given = call.slice(0, call.indexOf("});"));
    expect(given).toContain("transcript: thread.transcript");
    expect(given).not.toContain("material");
    expect(given).not.toContain("context");
  });
});
