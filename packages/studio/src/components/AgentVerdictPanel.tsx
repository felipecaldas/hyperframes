import type { AgentRunVerdict, AgentVerdictReceipt } from "@hyperframes/studio-server";

/**
 * The verdict as a person reads it. `saved` and `verified` are spelled out
 * against each other on purpose: the difference between them is the whole
 * reason the verdict exists, and "Saved" alone reads as "done".
 */
const VERDICT_LABELS: Record<AgentRunVerdict, string> = {
  refused: "Refused · nothing changed",
  dispatched: "Answered · nothing changed",
  saved: "Saved · not verified",
  verified: "Saved · verified",
  failed: "Failed · nothing changed",
};

const VERDICT_TONES: Record<AgentRunVerdict, string> = {
  refused: "border-amber-900/60 bg-amber-950/20 text-amber-200",
  dispatched: "border-neutral-800 bg-neutral-900/50 text-neutral-300",
  saved: "border-amber-900/60 bg-amber-950/20 text-amber-200",
  verified: "border-emerald-900/60 bg-emerald-950/20 text-emerald-200",
  failed: "border-red-900/60 bg-red-950/30 text-red-300",
};

/**
 * How far the run got, written by the server and shown under the reply
 * (TAB-1196).
 *
 * The reply is the model's account of the turn and reads the same whether the
 * change landed, landed unmeasured, or never landed at all. This is the run's
 * account. It is not folded away like the panels above it, because it is one
 * line and it is the line that says whether to believe the rest.
 */
export function AgentVerdictPanel({ verdict }: { verdict: AgentVerdictReceipt | null }) {
  if (!verdict) return null;
  return (
    <div
      role="status"
      data-verdict={verdict.verdict}
      className={`rounded border p-2 text-[10px] ${VERDICT_TONES[verdict.verdict]}`}
    >
      <div className="uppercase">{VERDICT_LABELS[verdict.verdict]}</div>
      {verdict.reason && <div className="mt-1 opacity-80">{verdict.reason}</div>}
    </div>
  );
}
