/**
 * What a Tabario AI run is allowed to spend, and what it actually spent.
 *
 * Until TAB-1193 nothing here existed. `requestCompletion` sent no `max_tokens`
 * and `completionMessage` threw away the OpenRouter `usage` block, so a run
 * could issue 24 completions over a message array that only grows and no line
 * of code anywhere knew what that cost. The ceilings below are the first
 * numbers in the system that bound it.
 *
 * Three ceilings, because each one catches something the others cannot:
 *
 * - `maxOutputTokens` bounds a *single* completion. Without it one reply can
 *   run to the model's full context window.
 * - `maxRunTokens` bounds the *whole run*. Roughly 7-10x a typical run, so it
 *   is a runaway detector rather than a working limit.
 * - `maxRunCostUsd` bounds the *money*, which is not a function of tokens:
 *   `TABARIO_STUDIO_MODEL` and `OPENROUTER_MODEL` both sit in the sandbox env
 *   passthrough, so an operator change silently re-points the agent, and
 *   Flash -> a frontier model is ~30x per token. The token budget cannot see
 *   that happen. This one can.
 *
 * Every ceiling is a *stop*, never a throw. See `RunMeter.stop()`.
 */

/** Per-completion output cap. One reply cannot run to the context window. */
const DEFAULT_MAX_OUTPUT_TOKENS = 8_000;
/** Whole-run token cap. ~7-10x a typical run: a runaway detector. */
const DEFAULT_MAX_RUN_TOKENS = 400_000;
/** Whole-run spend cap, in USD. A typical run is $0.01-$0.03. */
const DEFAULT_MAX_RUN_COST_USD = 0.5;

export interface RunBudget {
  maxOutputTokens: number;
  maxRunTokens: number;
  maxRunCostUsd: number;
}

/**
 * Where a cost number came from, mirroring
 * `edit-videos/videomerge/services/provider_usage_telemetry.py` so the two
 * feeds can be read in one query.
 *
 * `unpriced` is a real answer, not a missing one. A null cost with no reason
 * beside it is indistinguishable from "the producer forgot", and a silent zero
 * is worse than either.
 */
export type CostSource = "provider" | "rate_table" | "unpriced";
export type CostConfidence = "actual" | "estimated" | "unknown";

export interface CompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costSource: CostSource;
  costConfidence: CostConfidence;
}

/** Why the round loop stopped, when it was a ceiling that stopped it. */
export type BudgetStop =
  | { reason: "tokens"; used: number; limit: number }
  | { reason: "cost"; used: number; limit: number };

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveBudget(): RunBudget {
  return {
    maxOutputTokens: envInt("TABARIO_STUDIO_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS),
    maxRunTokens: envInt("TABARIO_STUDIO_RUN_TOKEN_BUDGET", DEFAULT_MAX_RUN_TOKENS),
    maxRunCostUsd: envFloat("TABARIO_STUDIO_RUN_COST_BUDGET_USD", DEFAULT_MAX_RUN_COST_USD),
  };
}

function numberField(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Per-million-token rates, read from `TABARIO_STUDIO_MODEL_RATES` as
 * `{"<model>": {"prompt": 0.3, "completion": 2.5}}`.
 *
 * Only consulted when the provider did not report a cost. Parsed once per
 * call rather than cached, because the table is small and a cached parse would
 * outlive an operator's correction to it.
 */
interface ModelRate {
  prompt: number;
  completion: number;
}

function rateFor(model: string): ModelRate | null {
  const raw = process.env.TABARIO_STUDIO_MODEL_RATES?.trim();
  if (!raw) return null;
  let table: unknown;
  try {
    table = JSON.parse(raw);
  } catch {
    // A malformed table is an operator error, not a run failure. The run
    // proceeds and records `unpriced`, which is the honest outcome and is
    // visible in the row.
    return null;
  }
  if (typeof table !== "object" || table === null) return null;
  const entry = (table as Record<string, unknown>)[model];
  if (typeof entry !== "object" || entry === null) return null;
  const prompt = numberField(entry as Record<string, unknown>, "prompt");
  const completion = numberField(entry as Record<string, unknown>, "completion");
  if (prompt <= 0 && completion <= 0) return null;
  return { prompt, completion };
}

/**
 * Reads the OpenRouter `usage` block. Absent or unparseable is a real state —
 * the run continues and is recorded `unpriced` rather than failing, because a
 * provider that stopped reporting usage is not a reason to refuse a customer's
 * edit.
 */
export function parseUsage(payload: unknown, model: string): CompletionUsage {
  const body =
    typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  const rawUsage = body.usage;
  const usage =
    typeof rawUsage === "object" && rawUsage !== null ? (rawUsage as Record<string, unknown>) : {};

  const promptTokens = numberField(usage, "prompt_tokens");
  const completionTokens = numberField(usage, "completion_tokens");
  const totalTokens = numberField(usage, "total_tokens") || promptTokens + completionTokens;

  // OpenRouter reports `usage.cost` in USD when the request asks for it. That
  // is the actual charge against the key, so it wins over any local table.
  const reported = usage.cost;
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) {
    return {
      promptTokens,
      completionTokens,
      totalTokens,
      costUsd: reported,
      costSource: "provider",
      costConfidence: "actual",
    };
  }

  const rate = rateFor(model);
  if (rate && totalTokens > 0) {
    const costUsd = (promptTokens * rate.prompt + completionTokens * rate.completion) / 1_000_000;
    return {
      promptTokens,
      completionTokens,
      totalTokens,
      costUsd,
      costSource: "rate_table",
      costConfidence: "estimated",
    };
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd: null,
    costSource: "unpriced",
    costConfidence: "unknown",
  };
}

export interface RunMeterSnapshot {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costSource: CostSource;
  costConfidence: CostConfidence;
  rounds: number;
  /**
   * False when no round produced a priced usage block, so the cost ceiling
   * could not bind on this run.
   *
   * This matters more than it looks: the cost ceiling exists to catch a model
   * swap the token ceiling cannot see, and an unpriced model is exactly the
   * case where that catch is unavailable. Recording it means an operator can
   * see the ceiling was inert instead of assuming it held.
   */
  costEnforceable: boolean;
}

/**
 * Accumulates a run's usage and answers, between rounds, whether it may
 * continue.
 *
 * The returned stop is deliberately not an exception. Round exhaustion already
 * throws today (`providers.ts`), which `AgentRuntime.execute` catches and which
 * discards every staged change — so a run that did nine-tenths of the work and
 * hit a wall loses all of it. A budget stop falls through to `validateAndApply`
 * instead: staged work that passes the lint gate lands, and the verdict records
 * why the turn ended early.
 */
export class RunMeter {
  private promptTokens = 0;
  private completionTokens = 0;
  private totalTokens = 0;
  private costUsd = 0;
  private priced = false;
  private estimatedOnly = true;
  private rounds = 0;

  constructor(private readonly budget: RunBudget) {}

  record(usage: CompletionUsage): void {
    this.rounds += 1;
    this.promptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
    this.totalTokens += usage.totalTokens;
    if (usage.costUsd !== null) {
      this.costUsd += usage.costUsd;
      this.priced = true;
      if (usage.costSource === "provider") this.estimatedOnly = false;
    }
  }

  /** The ceiling that has been crossed, or null while the run may continue. */
  stop(): BudgetStop | null {
    if (this.totalTokens >= this.budget.maxRunTokens) {
      return { reason: "tokens", used: this.totalTokens, limit: this.budget.maxRunTokens };
    }
    if (this.priced && this.costUsd >= this.budget.maxRunCostUsd) {
      return { reason: "cost", used: this.costUsd, limit: this.budget.maxRunCostUsd };
    }
    return null;
  }

  snapshot(): RunMeterSnapshot {
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens,
      costUsd: this.priced ? this.costUsd : null,
      costSource: this.priced ? (this.estimatedOnly ? "rate_table" : "provider") : "unpriced",
      costConfidence: this.priced ? (this.estimatedOnly ? "estimated" : "actual") : "unknown",
      rounds: this.rounds,
      costEnforceable: this.priced,
    };
  }
}

/** What the model is told when a ceiling ends its turn. */
export function budgetStopMessage(stop: BudgetStop): string {
  return stop.reason === "tokens"
    ? `This run reached its token budget (${stop.used} of ${stop.limit}). Stop here.`
    : `This run reached its cost budget ($${stop.used.toFixed(4)} of $${stop.limit.toFixed(2)}). Stop here.`;
}
