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
  | "complete"
  | "cancelled"
  | "failure";

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
