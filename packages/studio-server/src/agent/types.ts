import type { LayoutMeasurement } from "../helpers/layoutProbe.js";

export type AgentProvider = "tabario";

export type AgentRequestKind =
  | "catalog"
  | "selection"
  | "timeline"
  | "lint"
  | "storyboard-create"
  | "storyboard-feedback"
  | "storyboard-approval"
  | "chat";

export interface AgentRunRequest {
  provider: AgentProvider;
  kind: AgentRequestKind;
  prompt: string;
  registryItem?: string;
  newThread?: boolean;
  /** The element selected on the timeline when the message was sent, if any. */
  selection?: AgentSelectedElement;
}

/**
 * What Studio knows about the element the user had selected when they typed
 * (TAB-1063).
 *
 * A chat request used to carry the bare prompt. "Make this caption two lines"
 * could not resolve "this" without the model going to look, and one live run
 * did not look: it asked the user for the caption's text instead. The label is
 * the name shown on the timeline, the id is the element's `id` in the file,
 * so the model can go straight to it. Nothing here is trusted as content; the
 * words on screen are still read from the project.
 */
export interface AgentSelectedElement {
  /** The element's `id` attribute, or Studio's timeline id when it has none. */
  id: string;
  /** The name the user sees on the timeline, from `data-hf-label` when present. */
  label: string;
  /** Seconds into the timeline. */
  start: number;
  duration: number;
  /** The file that owns the element, when known; `index.html` otherwise. */
  sourceFile?: string;
}

export type AgentEventType =
  | "status"
  | "assistant"
  | "tool"
  | "changed-files"
  | "lint"
  | "measurement"
  | "metered"
  | "refusal"
  | "complete"
  | "cancelled"
  | "failure";

/**
 * How far a run got, as a proof level rather than a mood (TAB-1196).
 *
 * The vocabulary is upstream #3581's, the one its own write receipts use, so a
 * run and a single write are read the same way:
 *
 * - `refused`: a gate declined the turn. Nothing was applied.
 * - `dispatched`: the run ran and answered, and nothing was saved. A question
 *   ends here, and that is a complete outcome rather than a pending one.
 * - `saved`: changes landed and nothing measured them afterwards.
 * - `verified`: changes landed and a measurement taken after the last of them
 *   came back with a reading.
 * - `failed`: the run did not finish: an error, a timeout, a cancel.
 *
 * `verified` says a reading exists. It does not say the reading matches what
 * was asked, which no code here can judge. The receipt beside the reply is
 * where that comparison is made, by the person reading it.
 */
export type AgentRunVerdict = "refused" | "dispatched" | "saved" | "verified" | "failed";

/** The verdict and the sentence that goes with it, written by code. */
export interface AgentVerdictReceipt {
  verdict: AgentRunVerdict;
  reason: string;
}

/**
 * Which gate said no.
 *
 * - `lint`: the staged tree introduced lint errors the project did not have.
 * - `unsupported-change`: the run staged a change to a file it may not edit.
 * - `conflict`: the live project moved while the run was working.
 * - `egress`: the change made a project file reach the network (TAB-1195).
 */
export type AgentRefusalGate = "lint" | "unsupported-change" | "conflict" | "egress";

/**
 * One refusal, kept on the ledger and sent down the stream (TAB-1196).
 *
 * A refusal used to exist only as the text of a failure, so nothing could tell
 * a gate declining a change from a run falling over. `stage` separates the two
 * moments a gate can speak: `tool` is mid-run, where the model is told and may
 * repair it, and `apply` is the end of the turn, where nothing lands.
 */
export interface AgentRefusal {
  gate: AgentRefusalGate;
  stage: "tool" | "apply";
  message: string;
  /** The project file the refusal is about, when it is about one. */
  file?: string;
}

/**
 * What a run spent, emitted once per run and carried out of the sandbox
 * (TAB-1193).
 *
 * The sandbox holds the OpenRouter key and, deliberately, no Supabase key —
 * `STUDIO_CHILD_ENV_PASSTHROUGH` in video-compositor withholds every one of
 * them, and its env-boundary test asserts that list by name in both
 * directions. So the agent cannot write its own usage row and must not be
 * given the means to: that would hand every session a database writer. This
 * event is the way out. The compositor already proxies the run's SSE stream
 * and already holds the service client, so it does the writing.
 *
 * `promptHash` and not the prompt. Nothing a customer wrote leaves here.
 */
export interface AgentRunMeter {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costSource: "provider" | "rate_table" | "unpriced";
  costConfidence: "actual" | "estimated" | "unknown";
  /**
   * False when nothing in the run could be priced, so the per-run cost ceiling
   * could not bind. Recorded rather than inferred: an inert ceiling that looks
   * like a held one is the failure this epic is about.
   */
  costEnforceable: boolean;
  rounds: number;
  tools: Record<string, number>;
  stopReason: "complete" | "tokens" | "cost" | "rounds";
  promptHash: string;
}

export interface AgentRunEvent {
  id: number;
  type: AgentEventType;
  at: string;
  message?: string;
  text?: string;
  files?: AgentChangedFile[];
  findings?: Array<{
    severity: string;
    message: string;
    file?: string;
    fixHint?: string;
  }>;
  measurement?: AgentMeasurementReceipt;
  meter?: AgentRunMeter;
  /** On a `refusal` event: what was refused, and by which gate. */
  refusal?: AgentRefusal;
  /** On a terminal event: the run's one verdict and the reason for it. */
  verdict?: AgentRunVerdict;
  verdictReason?: string;
  critical?: boolean;
}

/**
 * What the run measured after its last change, said by code rather than by
 * the model (TAB-1061).
 *
 * The reply is the model's account of what it did. This is the probe's. They
 * are shown side by side because a live run measured a caption at one line
 * and replied "It is now two lines" — the measurement gate only checked that
 * `measure_layout` had been called, never what it said. `measurement` is null
 * when a renderable file changed and nothing was measured after the change,
 * and that null is itself the finding.
 */
export interface AgentMeasurementReceipt {
  /** The last measurement taken after the last write to a renderable file. */
  measurement: LayoutMeasurement | null;
}

/** One tool call and what it returned, kept in the run ledger for audit. */
export interface AgentToolTranscriptEntry {
  at: string;
  name: string;
  arguments: unknown;
  /** JSON of the result, truncated when large; the shape is the tool's own. */
  result: string;
}

export interface AgentChangedFile {
  path: string;
  change: "created" | "modified" | "deleted";
  beforeHash: string | null;
  afterHash: string | null;
  supported: boolean;
}

export interface AgentProviderCapability {
  installed: boolean;
  authenticated: boolean;
  available: boolean;
  guidance?: string;
}

export interface AgentThreadSummary {
  provider: AgentProvider;
  sessionId: string | null;
  invalidated: boolean;
  transcript: Array<{
    role: "user" | "assistant";
    text: string;
    at: string;
    kind?: AgentRequestKind;
    /**
     * What the model is told alongside a user turn and the user is not shown:
     * the selected element, in a sentence (TAB-1063). Kept apart from `text`
     * so the drawer's history shows what the user typed and nothing else.
     */
    context?: string;
  }>;
}

const AGENT_PROVIDERS: readonly AgentProvider[] = ["tabario"];
const AGENT_REQUEST_KINDS: readonly AgentRequestKind[] = [
  "catalog",
  "selection",
  "timeline",
  "lint",
  "storyboard-create",
  "storyboard-feedback",
  "storyboard-approval",
  "chat",
];

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === "string" && AGENT_PROVIDERS.includes(value as AgentProvider);
}

export function isAgentRequestKind(value: unknown): value is AgentRequestKind {
  return typeof value === "string" && AGENT_REQUEST_KINDS.includes(value as AgentRequestKind);
}
