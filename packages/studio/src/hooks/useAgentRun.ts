import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentChangedFile, AgentProvider, AgentRunEvent } from "@hyperframes/studio-server";
import { finishAgentRun, setAgentRunActive, type StudioAgentRequest } from "../utils/agentBridge";
import { openEventStream, type EventStreamHandle } from "../utils/eventStream";

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

/**
 * What each tool is doing, said the way the drawer says everything else.
 *
 * The Activity panel is free to print `read_file`; this feeds the bubble the
 * user actually watches for minutes, and TAB-795 already settled that the
 * agent's surface is written for someone editing a video.
 */
const TOOL_LABELS: Record<string, string> = {
  list_files: "Looking through the project…",
  read_file: "Reading the timeline…",
  list_media: "Checking the media…",
  search_files: "Searching the project…",
  edit_file: "Making the change…",
  write_file: "Adding a file…",
  delete_file: "Removing a file…",
  validate_project: "Checking the result…",
  measure_layout: "Measuring how it looks…",
};

/** A tool event as a person would say it; unknown tools degrade, never leak. */
export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? "Working on the project…";
}

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
  /** Put a typed prompt back in the composer when the run never started. */
  onPromptReturned: (prompt: string) => void;
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
    onPromptReturned,
  } = options;

  const [jobId, setJobId] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentRunEvent[]>([]);
  const [changedFiles, setChangedFiles] = useState<AgentChangedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The turn the user just sent, shown until the persisted thread carries it.
   *
   * TAB-797: the transcript renders `thread.transcript` plus live `assistant`
   * events, and the user's turn is only persisted server-side — `loadThreads`
   * runs solely on a terminal event. So for the whole run, which is minutes, the
   * message the user just typed existed in neither source and the chat looked
   * like it had swallowed it.
   */
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const streamRef = useRef<EventStreamHandle | null>(null);

  // A run has no progress bar to give — the honest substitute for "how much
  // longer" is how long it has already been.
  useEffect(() => {
    if (startedAt === null) return;
    setElapsedMs(Date.now() - startedAt);
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  /** The newest thing worth saying out loud, newest event first. */
  const latestStatus = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event) continue;
      if (event.type === "tool" && event.message) return toolLabel(event.message);
      if (event.type === "status" && event.message) return event.message;
    }
    return null;
  }, [events]);

  const activity = useMemo(
    () => events.filter((event) => event.type !== "assistant" && event.type !== "changed-files"),
    [events],
  );

  const closeStream = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
  }, []);

  const refreshOnce = useCallback(async () => {
    finishAgentRun();
    await loadThreads();
    // Only now, once the persisted thread is in hand — clearing any earlier
    // would blink the message out again, and clearing never would show it twice.
    setPendingPrompt(null);
    setStartedAt(null);
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
      const handle = (raw: MessageEvent) => {
        const event = JSON.parse(raw.data) as AgentRunEvent;
        setEvents((current) => [...current, event]);
        if (event.files) setChangedFiles(event.files);
        if (!TERMINAL_EVENTS.has(event.type)) return;
        if (event.type === "failure") setError(event.message ?? "Agent run failed.");
        closeStream();
        setBusy(false);
        void refreshOnce();
      };
      streamRef.current = openEventStream({
        url: `/api/agent/runs/${encodeURIComponent(id)}/events`,
        listeners: Object.fromEntries(EVENT_TYPES.map((type) => [type, handle])),
        onGiveUp: () => {
          // The run itself may well be fine — this says only that we can no
          // longer hear it, which is why the wording does not claim a failure.
          // `pendingPrompt` is deliberately left standing: dropping it here
          // would make the message vanish again, which is TAB-797's bug.
          streamRef.current = null;
          setBusy(false);
          setStartedAt(null);
          setAgentRunActive(false);
          setError(
            "Lost the connection to Tabario AI. Reload the page to reconnect — the run may still be finishing.",
          );
        },
      });
    },
    [closeStream, refreshOnce],
  );

  /** POST the run; resolves to the new job id or a display-ready error. */
  const submitRun = useCallback(
    async (nonce: string, prompt: string): Promise<{ jobId: string } | { error: string }> => {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/agent/runs`, {
        method: "POST",
        headers: nonceHeaders(nonce),
        body: JSON.stringify({
          provider,
          kind: request?.kind ?? "chat",
          prompt,
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
    [nonceHeaders, projectId, provider, request],
  );

  const startRun = useCallback(async () => {
    if (!generatedPrompt || busy) return;
    if (!available || !capabilities?.nonce) {
      setError("Tabario AI is unavailable. Please try again shortly.");
      return;
    }
    // Post the turn before anything that can await. `beforeRun` saves pending
    // edits and the POST is a round trip; doing this after either of them is
    // what made a chat message vanish for the length of a run (TAB-797).
    const prompt = generatedPrompt;
    setPendingPrompt(prompt);
    setStartedAt(Date.now());
    onPromptConsumed();
    const returnPrompt = () => {
      setPendingPrompt(null);
      setStartedAt(null);
      onPromptReturned(prompt);
    };

    const ready = await beforeRun();
    if (!ready.ok) {
      returnPrompt();
      setError(ready.message ?? "Save pending edits before starting the agent.");
      return;
    }
    setError(null);
    setEvents([]);
    setChangedFiles([]);
    setBusy(true);
    setAgentRunActive(true);

    const result = await submitRun(capabilities.nonce, prompt);
    if ("error" in result) {
      setBusy(false);
      setAgentRunActive(false);
      // A run that never started must not eat the text the user typed.
      returnPrompt();
      setError(result.error);
      return;
    }
    setJobId(result.jobId);
    subscribeToRun(result.jobId);
  }, [
    available,
    beforeRun,
    busy,
    capabilities,
    generatedPrompt,
    onPromptConsumed,
    onPromptReturned,
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
    setPendingPrompt(null);
    setStartedAt(null);
    await loadThreads();
  }, [busy, capabilities, loadThreads, nonceHeaders, onThreadReset, projectId, provider]);

  return {
    activity,
    busy,
    changedFiles,
    closeStream,
    elapsedMs,
    error,
    events,
    jobId,
    latestStatus,
    mutateRun,
    newChat,
    pendingPrompt,
    setError,
    startRun,
  };
}
