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
  critical?: boolean;
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
