/**
 * The one verdict a finished run carries, and the sentence that goes with it
 * (TAB-1196).
 *
 * Until this existed a run had three endings, `complete`, `cancelled` and
 * `failure`, and none of them said how much of the reply had anything behind
 * it. `complete` covered a question that changed nothing, an edit nobody
 * measured and an edit the probe confirmed. `failure` covered a gate declining
 * a change and the model provider being down. A live run was reported as
 * finished, twice, for a caption that was never touched, and the only thing
 * that could have said otherwise was the prose of the reply.
 *
 * The verdict is decided here, from facts the run already holds, and never from
 * anything the model wrote. That is the whole point of it: the reply is the
 * model's account, this is the run's.
 *
 * It is a list of rules read top to bottom, first match wins, for the same
 * reason `describeMeasuredElement` is a list of clauses: the next rule costs an
 * entry rather than a branch, and the fork's complexity gate stops deciding
 * when this file gets split.
 */
import type {
  AgentMeasurementReceipt,
  AgentRefusal,
  AgentRefusalGate,
  AgentRunMeter,
  AgentVerdictReceipt,
} from "../types.js";

export interface VerdictFacts {
  cancelled: boolean;
  /** The timeout that ended the run, in its own words, or null. */
  timeout: string | null;
  /** Why nothing was applied, or null when the run ended cleanly. */
  failure: string | null;
  /** Every refusal the run recorded, mid-run and at apply. */
  refusals: readonly AgentRefusal[];
  /** How many project files the run changed once applied. */
  changedFiles: number;
  /** The probe's receipt, absent when no renderable file changed. */
  verification: AgentMeasurementReceipt | null | undefined;
  /** Why the round loop ended, when the run got far enough to have a meter. */
  stopReason: AgentRunMeter["stopReason"] | null;
}

type Rule = (facts: VerdictFacts) => AgentVerdictReceipt | null;

const GATE_LABELS: Record<AgentRefusalGate, string> = {
  lint: "the change introduced errors the project did not have before",
  "unsupported-change": "the change touched a file Tabario AI is not allowed to edit",
  conflict: "the project was changed by something else while Tabario AI was working",
  egress: "the change would have made the project load from or send to another host",
};

/** The refusal that stopped the apply, when one did. */
function applyRefusal(facts: VerdictFacts): AgentRefusal | null {
  const atApply = facts.refusals.filter((refusal) => refusal.stage === "apply");
  return atApply[atApply.length - 1] ?? null;
}

const cancelled: Rule = (facts) =>
  facts.cancelled
    ? { verdict: "failed", reason: "The run was cancelled. Nothing was applied." }
    : null;

const timedOut: Rule = (facts) =>
  facts.timeout
    ? { verdict: "failed", reason: "The run ran out of time. Nothing was applied." }
    : null;

/**
 * A gate said no. Kept apart from `failed` because the two ask different things
 * of whoever reads them: a refusal is the system working and wants a different
 * request, a failure is the system not working and wants a retry.
 */
const refused: Rule = (facts) => {
  const refusal = applyRefusal(facts);
  if (!refusal) return null;
  return {
    verdict: "refused",
    reason: `A check refused the change, so nothing was applied: ${GATE_LABELS[refusal.gate]}.`,
  };
};

const failed: Rule = (facts) =>
  facts.failure ? { verdict: "failed", reason: "The run failed. Nothing was applied." } : null;

/**
 * The run answered and saved nothing. A complete outcome, not a pending one:
 * a question ends here.
 */
const dispatched: Rule = (facts) =>
  facts.changedFiles === 0
    ? { verdict: "dispatched", reason: "Tabario AI answered. Nothing in the project was changed." }
    : null;

const savedUnmeasurable: Rule = (facts) =>
  facts.verification
    ? null
    : {
        verdict: "saved",
        reason:
          "The changes were saved. None of them is something a measurement can read, so none was taken.",
      };

/**
 * The case the ticket exists for. A renderable file changed and nothing looked
 * at it afterwards, so whatever the reply says about how it looks is a claim
 * with nothing under it. Saved is true. Verified would not be.
 */
const savedUnmeasured: Rule = (facts) =>
  facts.verification?.measurement
    ? null
    : {
        verdict: "saved",
        reason:
          "The changes were saved and nothing measured them afterwards. What the reply says about how it looks is unchecked.",
      };

/**
 * A measurement was asked for and produced no reading. `measured` is true only
 * when at least one element was genuinely measured, so a probe that could not
 * start and a probe that found nothing to measure both land here.
 */
const savedNoReading: Rule = (facts) =>
  facts.verification?.measurement?.measured
    ? null
    : {
        verdict: "saved",
        reason:
          "The changes were saved. A measurement was tried and returned no reading, so how it looks is unchecked.",
      };

const verified: Rule = () => ({
  verdict: "verified",
  reason: "The changes were saved and measured afterwards. The reading is shown beside the reply.",
});

const RULES: readonly Rule[] = [
  cancelled,
  timedOut,
  refused,
  failed,
  dispatched,
  savedUnmeasurable,
  savedUnmeasured,
  savedNoReading,
  verified,
];

const EARLY_STOPS: Record<Exclude<AgentRunMeter["stopReason"], "complete">, string> = {
  tokens: "its token budget",
  cost: "its cost budget",
  rounds: "its limit of tool rounds",
};

/**
 * What ended the run early, as a sentence, or an empty string when nothing did.
 *
 * A ceiling is not a verdict of its own. The run it ended still saved something
 * or did not, and that is what the verdict says. The ceiling is said after it,
 * so a run stopped mid-task cannot read as one that reached the end.
 */
function earlyStop(stopReason: VerdictFacts["stopReason"]): string {
  if (!stopReason || stopReason === "complete") return "";
  return ` The run stopped early because it reached ${EARLY_STOPS[stopReason]}.`;
}

export function decideVerdict(facts: VerdictFacts): AgentVerdictReceipt {
  for (const rule of RULES) {
    const receipt = rule(facts);
    if (receipt) return { ...receipt, reason: `${receipt.reason}${earlyStop(facts.stopReason)}` };
  }
  // Unreachable: `verified` always answers. Kept so the function has a total
  // return type without an assertion.
  return { verdict: "failed", reason: "The run failed. Nothing was applied." };
}
