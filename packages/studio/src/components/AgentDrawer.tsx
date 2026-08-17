import { useCallback, useEffect, useState } from "react";
import { Robot, X, ArrowCounterClockwise, Stop, Plus } from "@phosphor-icons/react";
import type {
  AgentChangedFile,
  AgentProvider,
  AgentProviderCapability,
  AgentRunEvent,
  AgentThreadSummary,
} from "@hyperframes/studio-server";
import {
  subscribeAgentRequests,
  subscribeAgentToggle,
  type StudioAgentRequest,
} from "../utils/agentBridge";
import { useAgentRun } from "../hooks/useAgentRun";

interface Capabilities {
  enabled: boolean;
  nonce?: string;
  reason?: string;
  providers: Partial<Record<AgentProvider, AgentProviderCapability>>;
}

interface AgentDrawerProps {
  projectId: string;
  beforeRun: () => Promise<{ ok: boolean; message?: string }>;
  onRefresh: () => Promise<void> | void;
}

function lintSummary(findings: NonNullable<AgentRunEvent["findings"]>): string {
  const counts = findings.reduce<Record<string, number>>((result, finding) => {
    const severity = finding.severity.toLowerCase();
    result[severity] = (result[severity] ?? 0) + 1;
    return result;
  }, {});
  const breakdown = ["error", "warning", "info"]
    .filter((severity) => counts[severity])
    .map((severity) => `${counts[severity]} ${severity}${counts[severity] === 1 ? "" : "s"}`)
    .join(" · ");
  return `${findings.length} lint finding${findings.length === 1 ? "" : "s"}${breakdown ? ` · ${breakdown}` : ""}`;
}

function LintActivity({ findings }: { findings: NonNullable<AgentRunEvent["findings"]> }) {
  return (
    <details className="mt-1 rounded border border-neutral-800/80 p-1.5">
      <summary className="cursor-pointer text-neutral-400">{lintSummary(findings)}</summary>
      <div className="mt-1 space-y-1">
        {findings.map((finding, index) => (
          <div
            key={`${finding.file ?? "project"}-${finding.message}-${index}`}
            className="ml-1 border-l border-neutral-800 pl-2 text-neutral-400"
          >
            <span className="uppercase">{finding.severity}</span>
            {finding.file ? ` · ${finding.file}` : ""}: {finding.message}
            {finding.fixHint ? ` — ${finding.fixHint}` : ""}
          </div>
        ))}
      </div>
    </details>
  );
}

/** Persisted thread turns followed by this run's live assistant output. */
function AgentTranscript({
  thread,
  events,
}: {
  thread: AgentThreadSummary | undefined;
  events: AgentRunEvent[];
}) {
  return (
    <>
      {thread?.transcript.map((entry, index) => (
        <div
          key={`${entry.at}-${index}`}
          className={`rounded-lg p-2 text-xs ${entry.role === "user" ? "ml-5 bg-neutral-800 text-neutral-200" : "mr-5 bg-neutral-900 text-neutral-300"}`}
        >
          <div className="mb-1 text-[9px] uppercase text-neutral-600">{entry.role}</div>
          <div className="whitespace-pre-wrap break-words">{entry.text}</div>
        </div>
      ))}
      {events
        .filter((event) => event.type === "assistant")
        .map((event) => (
          <div
            key={event.id}
            className="mr-5 rounded-lg bg-neutral-900 p-2 text-xs text-neutral-300 whitespace-pre-wrap"
          >
            {event.text}
          </div>
        ))}
    </>
  );
}

function AgentActivityPanel({ activity, busy }: { activity: AgentRunEvent[]; busy: boolean }) {
  if (activity.length === 0) return null;
  return (
    <details open={busy} className="rounded border border-neutral-800 bg-neutral-900/50 p-2">
      <summary className="cursor-pointer text-[10px] uppercase text-neutral-500">Activity</summary>
      <div className="mt-2 space-y-1 text-[10px] text-neutral-500">
        {activity.map((event) => (
          <div key={event.id}>
            {event.findings ? (
              <LintActivity findings={event.findings} />
            ) : (
              <div>{event.message ?? event.type}</div>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

function AgentChangedFilesPanel({ changedFiles }: { changedFiles: AgentChangedFile[] }) {
  if (changedFiles.length === 0) return null;
  return (
    <details open className="rounded border border-neutral-800 p-2">
      <summary className="cursor-pointer text-[10px] uppercase text-neutral-500">
        Changed files ({changedFiles.length})
      </summary>
      {changedFiles.map((file) => (
        <div key={file.path} className="mt-1 font-mono text-[10px] text-neutral-400">
          {file.change} · {file.path}
        </div>
      ))}
    </details>
  );
}

function AgentNotices({
  capabilities,
  provider,
  available,
}: {
  capabilities: Capabilities | null;
  provider: AgentProvider;
  available: boolean;
}) {
  if (!capabilities?.enabled) {
    return <Notice>{capabilities?.reason ?? "Checking Tabario AI…"}</Notice>;
  }
  if (available) return null;
  return (
    <Notice>{capabilities.providers[provider]?.guidance ?? `${provider} is unavailable.`}</Notice>
  );
}

interface AgentComposerProps {
  request: StudioAgentRequest | null;
  chat: string;
  onChatChange: (value: string) => void;
  busy: boolean;
  available: boolean;
  generatedPrompt: string;
  showUndo: boolean;
  onStart: () => void;
  onMutate: (action: "cancel" | "undo") => void;
  onClearRequest: () => void;
}

/** Prompt composer plus the run/cancel/undo actions. */
function AgentComposer(props: AgentComposerProps) {
  const { request, chat, onChatChange, busy, available } = props;
  return (
    <footer className="space-y-2 border-t border-neutral-800 p-3">
      {!request && (
        <textarea
          value={chat}
          onChange={(event) => onChatChange(event.target.value)}
          placeholder="Ask the agent to change this project…"
          className="h-20 w-full resize-none rounded border border-neutral-800 bg-neutral-900 p-2 text-xs text-neutral-200 outline-none focus:border-studio-accent"
        />
      )}
      <div className="flex gap-2">
        {busy ? (
          <button
            onClick={() => props.onMutate("cancel")}
            className="flex flex-1 items-center justify-center gap-1 rounded bg-red-500/15 py-2 text-xs text-red-300"
          >
            <Stop size={13} /> Cancel
          </button>
        ) : (
          <button
            onClick={props.onStart}
            disabled={!props.generatedPrompt}
            className="flex flex-1 items-center justify-center gap-1 rounded bg-studio-accent py-2 text-xs font-medium text-neutral-950 disabled:opacity-40"
          >
            <Robot size={13} /> {available ? "Send" : "Unavailable"}
          </button>
        )}
        {props.showUndo && (
          <button
            onClick={() => props.onMutate("undo")}
            className="flex items-center gap-1 rounded bg-neutral-800 px-3 text-xs text-neutral-300"
          >
            <ArrowCounterClockwise size={13} /> Undo
          </button>
        )}
      </div>
      {request && (
        <button
          onClick={props.onClearRequest}
          className="text-[10px] text-neutral-500 hover:text-neutral-300"
        >
          Clear generated context
        </button>
      )}
    </footer>
  );
}

export function AgentDrawer({ projectId, beforeRun, onRefresh }: AgentDrawerProps) {
  const [open, setOpen] = useState(false);
  const provider: AgentProvider = "tabario";
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [threads, setThreads] = useState<AgentThreadSummary[]>([]);
  const [request, setRequest] = useState<StudioAgentRequest | null>(null);
  const [chat, setChat] = useState("");

  const loadThreads = useCallback(async () => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/agent/threads`);
    if (!response.ok) return;
    const body = (await response.json()) as { threads?: AgentThreadSummary[] };
    setThreads(body.threads ?? []);
  }, [projectId]);

  useEffect(() => {
    setCapabilities(null);
    setThreads([]);
    fetch(`/api/projects/${encodeURIComponent(projectId)}/agent/capabilities`)
      .then((response) => response.json())
      .then((body: Capabilities) => setCapabilities(body))
      .catch(() =>
        setCapabilities({
          enabled: false,
          reason: "Tabario AI server unavailable.",
          providers: {},
        }),
      );
    void loadThreads();
  }, [loadThreads, projectId]);

  useEffect(() => subscribeAgentToggle(() => setOpen((value) => !value)), []);

  const thread = threads.find((candidate) => candidate.provider === provider);
  const available = Boolean(capabilities?.enabled && capabilities.providers[provider]?.available);
  const generatedPrompt = request?.prompt ?? chat.trim();

  const clearChat = useCallback(() => setChat(""), []);
  const clearRequest = useCallback(() => setRequest(null), []);

  const {
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
  } = useAgentRun({
    projectId,
    provider,
    capabilities,
    available,
    request,
    generatedPrompt,
    beforeRun,
    onRefresh,
    loadThreads,
    onPromptConsumed: clearChat,
    onThreadReset: clearRequest,
  });

  // Declared after useAgentRun so setError is initialised before the deps run.
  useEffect(
    () =>
      subscribeAgentRequests((next) => {
        setRequest(next);
        setOpen(true);
        setError(null);
      }),
    [setError],
  );
  useEffect(() => closeStream, [closeStream]);

  if (!open) return null;
  return (
    <aside className="fixed right-0 top-10 bottom-0 z-[95] flex w-[400px] flex-col border-l border-neutral-800 bg-neutral-950 shadow-2xl">
      <header className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <Robot size={17} className="text-studio-accent" />
        <strong className="text-xs text-neutral-200">Tabario AI</strong>
        <div className="ml-auto flex items-center gap-1">
          <button
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800"
            onClick={newChat}
            title="New chat"
          >
            <Plus size={15} />
          </button>
          <button
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800"
            onClick={() => setOpen(false)}
            aria-label="Close Agent drawer"
          >
            <X size={15} />
          </button>
        </div>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        <AgentNotices capabilities={capabilities} provider={provider} available={available} />
        <AgentTranscript thread={thread} events={events} />
        <AgentActivityPanel activity={activity} busy={busy} />
        <AgentChangedFilesPanel changedFiles={changedFiles} />
        {request && (
          <details className="rounded border border-neutral-800 p-2">
            <summary className="cursor-pointer text-[10px] uppercase text-neutral-500">
              Generated context · {request.title ?? request.kind}
            </summary>
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words text-[10px] text-neutral-500">
              {request.prompt}
            </pre>
          </details>
        )}
        {error && (
          <div className="rounded border border-red-900/60 bg-red-950/30 p-2 text-xs text-red-300">
            {error}
          </div>
        )}
      </div>
      <AgentComposer
        request={request}
        chat={chat}
        onChatChange={setChat}
        busy={busy}
        available={available}
        generatedPrompt={generatedPrompt}
        showUndo={Boolean(jobId) && !busy && changedFiles.length > 0}
        onStart={() => void startRun()}
        onMutate={(action) => void mutateRun(action)}
        onClearRequest={clearRequest}
      />
    </aside>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded border border-amber-900/50 bg-amber-950/20 p-2 text-xs text-amber-200">
      {children}
    </div>
  );
}
