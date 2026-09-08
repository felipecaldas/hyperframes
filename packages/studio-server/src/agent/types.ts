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
