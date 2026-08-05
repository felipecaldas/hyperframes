import type { AgentRequestKind } from "@hyperframes/studio-server";

export interface StudioAgentRequest {
  kind: AgentRequestKind;
  prompt: string;
  title?: string;
  registryItem?: string;
}

const REQUEST_EVENT = "hf:agent-request";
const TOGGLE_EVENT = "hf:agent-toggle";
const REFRESH_EVENT = "hf:agent-refresh";

let runActive = false;
let suppressRefreshUntil = 0;
let editorDirty = false;

export function openAgentBridge(request: StudioAgentRequest): void {
  window.dispatchEvent(new CustomEvent<StudioAgentRequest>(REQUEST_EVENT, { detail: request }));
}

export function toggleAgentBridge(): void {
  window.dispatchEvent(new Event(TOGGLE_EVENT));
}

export function subscribeAgentRequests(
  listener: (request: StudioAgentRequest) => void,
): () => void {
  const handler = (event: Event) => {
    if (event instanceof CustomEvent) listener(event.detail);
  };
  window.addEventListener(REQUEST_EVENT, handler);
  return () => window.removeEventListener(REQUEST_EVENT, handler);
}

export function subscribeAgentToggle(listener: () => void): () => void {
  window.addEventListener(TOGGLE_EVENT, listener);
  return () => window.removeEventListener(TOGGLE_EVENT, listener);
}

export function subscribeAgentRefresh(listener: () => void): () => void {
  window.addEventListener(REFRESH_EVENT, listener);
  return () => window.removeEventListener(REFRESH_EVENT, listener);
}

export function setAgentRunActive(active: boolean): void {
  runActive = active;
}

export function finishAgentRun(): void {
  runActive = false;
  suppressRefreshUntil = Date.now() + 3000;
  window.dispatchEvent(new Event(REFRESH_EVENT));
}

export function shouldSuppressAgentRefresh(): boolean {
  return runActive || Date.now() < suppressRefreshUntil;
}

export function setAgentEditorDirty(dirty: boolean): void {
  editorDirty = dirty;
}

export function hasAgentEditorDirty(): boolean {
  return editorDirty;
}
