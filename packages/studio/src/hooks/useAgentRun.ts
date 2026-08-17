import { useCallback, useMemo, useRef, useState } from "react";
import type { AgentChangedFile, AgentProvider, AgentRunEvent } from "@hyperframes/studio-server";
import { finishAgentRun, setAgentRunActive, type StudioAgentRequest } from "../utils/agentBridge";

const EVENT_TYPES = [
  "status",
  "assistant",
  "tool",
  "changed-files",
  "lint",
  "complete",
  "cancelled",
  "failure",
] as const;

const TERMINAL_EVENTS = new Set<AgentRunEvent["type"]>(["complete", "cancelled", "failure"]);

type MutationErrorBody = { error?: string; conflicts?: string[] } | null;

/** An Undo hash conflict names the offending files; anything else is a plain error. */
function mutationErrorMessage(body: MutationErrorBody, action: string): string {
  if (body?.conflicts?.length) return `Undo conflict: ${body.conflicts.join(", ")}`;
  return body?.error ?? `${action} failed.`;
}

export interface AgentRunCapabilities {
  enabled: boolean;
  nonce?: string;
}

export interface UseAgentRunOptions {
  projectId: string;
  provider: AgentProvider;
  capabilities: AgentRunCapabilities | null;
  /** Whether the selected provider is installed and authenticated. */
  available: boolean;
  request: StudioAgentRequest | null;
  generatedPrompt: string;
  beforeRun: () => Promise<{ ok: boolean; message?: string }>;
  onRefresh: () => Promise<void> | void;
  loadThreads: () => Promise<void>;
  /** Clear the composer once its prompt has been handed to the agent. */
  onPromptConsumed: () => void;
  /** Drop the pending direct-action request after a thread reset. */
  onThreadReset: () => void;
}

/**
 * Owns one project's agent run: start, cancel/undo, new chat, and the SSE
 * stream feeding transcript/activity. Kept out of AgentDrawer so the drawer
 * stays presentational enough to read in one screen.
 */
export function useAgentRun(options: UseAgentRunOptions) {
  const {
    projectId,
    provider,
    capabilities,
    available,
    request,
    generatedPrompt,
    beforeRun,
    onRefresh,
    loadThreads,
    onPromptConsumed,
    onThreadReset,
  } = options;

  const [jobId, setJobId] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentRunEvent[]>([]);
  const [changedFiles, setChangedFiles] = useState<AgentChangedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  const activity = useMemo(
    () => events.filter((event) => event.type !== "assistant" && event.type !== "changed-files"),
    [events],
  );

  const closeStream = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  const refreshOnce = useCallback(async () => {
    finishAgentRun();
    await loadThreads();
    setEvents((current) => current.filter((event) => event.type !== "assistant"));
    await onRefresh();
  }, [loadThreads, onRefresh]);

  const nonceHeaders = useCallback(
    (nonce: string) => ({
      "Content-Type": "application/json",
      "X-Hyperframes-Agent-Nonce": nonce,
    }),
    [],
  );

  const subscribeToRun = useCallback(
    (id: string) => {
      const eventSource = new EventSource(`/api/agent/runs/${encodeURIComponent(id)}/events`);
      eventSourceRef.current = eventSource;
      for (const type of EVENT_TYPES) {
        eventSource.addEventListener(type, (raw) => {
          if (!(raw instanceof MessageEvent)) return;
          const event = JSON.parse(raw.data) as AgentRunEvent;
          setEvents((current) => [...current, event]);
          if (event.files) setChangedFiles(event.files);
          if (!TERMINAL_EVENTS.has(event.type)) return;
          if (event.type === "failure") setError(event.message ?? "Agent run failed.");
          closeStream();
          setBusy(false);
          void refreshOnce();
        });
      }
    },
    [closeStream, refreshOnce],
  );

  /** POST the run; resolves to the new job id or a display-ready error. */
  const submitRun = useCallback(
    async (nonce: string): Promise<{ jobId: string } | { error: string }> => {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/agent/runs`, {
        method: "POST",
        headers: nonceHeaders(nonce),
        body: JSON.stringify({
          provider,
          kind: request?.kind ?? "chat",
          prompt: generatedPrompt,
          ...(request?.registryItem ? { registryItem: request.registryItem } : {}),
        }),
      });
      if (response.ok) {
        const body = (await response.json()) as { jobId: string };
        return { jobId: body.jobId };
      }
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      return { error: body?.error ?? `Agent request failed (${response.status}).` };
    },
    [generatedPrompt, nonceHeaders, projectId, provider, request],
  );

  const startRun = useCallback(async () => {
    if (!generatedPrompt || busy) return;
    if (!available || !capabilities?.nonce) {
      setError("Tabario AI is unavailable. Please try again shortly.");
      return;
    }
    const ready = await beforeRun();
    if (!ready.ok) {
      setError(ready.message ?? "Save pending edits before starting the agent.");
      return;
    }
    setError(null);
    setEvents([]);
    setChangedFiles([]);
    setBusy(true);
    setAgentRunActive(true);

    const result = await submitRun(capabilities.nonce);
    if ("error" in result) {
      setBusy(false);
      setAgentRunActive(false);
      setError(result.error);
      return;
    }
    setJobId(result.jobId);
    onPromptConsumed();
    subscribeToRun(result.jobId);
  }, [
    available,
    beforeRun,
    busy,
    capabilities,
    generatedPrompt,
    onPromptConsumed,
    submitRun,
    subscribeToRun,
  ]);

  const mutateRun = useCallback(
    async (action: "cancel" | "undo") => {
      if (!jobId || !capabilities?.nonce) return;
      const response = await fetch(`/api/agent/runs/${encodeURIComponent(jobId)}/${action}`, {
        method: "POST",
        headers: nonceHeaders(capabilities.nonce),
        body: "{}",
      });
      const body = (await response.json().catch(() => null)) as MutationErrorBody;
      if (!response.ok) {
        setError(mutationErrorMessage(body, action));
        return;
      }
      if (action === "undo") await refreshOnce();
    },
    [capabilities, jobId, nonceHeaders, refreshOnce],
  );

  const newChat = useCallback(async () => {
    if (!capabilities?.nonce || busy) return;
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/agent/threads/reset`,
      {
        method: "POST",
        headers: nonceHeaders(capabilities.nonce),
        body: JSON.stringify({ provider }),
      },
    );
    if (!response.ok) return;
    onThreadReset();
    setEvents([]);
    setJobId(null);
    await loadThreads();
  }, [busy, capabilities, loadThreads, nonceHeaders, onThreadReset, projectId, provider]);

  return {
    activity,
    busy,
    changedFiles,
    closeStream,
    error,
    events,
    jobId,
    mutateRun,
    newChat,
    setError,
    startRun,
  };
}
