import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";
import { lintProject } from "../helpers/projectLint.js";
import {
  diffAgentFiles,
  readLedger,
  snapshotAgentFiles,
  undoAgentFiles,
  writeLedger,
  type AgentRunLedger,
} from "./files.js";
import { detectProvider, startProviderRun, type ProviderProcess } from "./providers.js";
import type {
  AgentProvider,
  AgentProviderCapability,
  AgentRunEvent,
  AgentRunRequest,
  AgentThreadSummary,
} from "./types.js";

const MAX_RUN_LEDGERS = 20;
const DEFAULT_IDLE_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_MAX_RUNTIME_MS = 15 * 60_000;
const UNSUPPORTED_FILES_FAILURE =
  "The agent changed unsupported project files; complete Undo coverage is unavailable.";

interface PersistedThread extends AgentThreadSummary {
  updatedAt: string;
}

interface AgentRunJob {
  id: string;
  project: ResolvedProject;
  request: AgentRunRequest;
  ledgerPath: string;
  events: AgentRunEvent[];
  listeners: Set<() => void>;
  process: ProviderProcess | null;
  terminal: boolean;
  cancelled: boolean;
}

function agentStateRoot(): string {
  const override = process.env.HYPERFRAMES_STATE_DIR?.trim();
  return override
    ? resolve(override, "studio-agent")
    : join(homedir(), ".hyperframes", "studio-agent");
}

function projectKey(projectDir: string): string {
  return createHash("sha256").update(resolve(projectDir)).digest("hex").slice(0, 24);
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value))
      : null;
  } catch {
    return null;
  }
}

function readTranscript(value: unknown): AgentThreadSummary["transcript"] {
  if (!Array.isArray(value)) return [];
  const transcript: AgentThreadSummary["transcript"] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const item = Object.fromEntries(Object.entries(entry));
    if (
      (item.role === "user" || item.role === "assistant") &&
      typeof item.text === "string" &&
      typeof item.at === "string"
    ) {
      transcript.push({ role: item.role, text: item.text, at: item.at });
    }
  }
  return transcript;
}

function readThread(path: string, provider: AgentProvider): PersistedThread {
  const value = readJsonObject(path);
  return {
    provider,
    sessionId: typeof value?.sessionId === "string" ? value.sessionId : null,
    invalidated: value?.invalidated === true,
    transcript: readTranscript(value?.transcript),
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
  };
}

function createLedger(job: AgentRunJob, before: AgentRunLedger["before"]): AgentRunLedger {
  return {
    version: 1,
    jobId: job.id,
    projectId: job.project.id,
    projectDir: resolve(job.project.dir),
    provider: job.request.provider,
    createdAt: new Date().toISOString(),
    status: "running",
    undoCovered: true,
    before,
    changedFiles: [],
  };
}

/**
 * An edit-oriented request that exits cleanly without touching a file is a
 * failure, not a completed edit. Chat requests are exempt.
 */
function emptyEditFailure(job: AgentRunJob, changedFileCount: number): string | null {
  if (job.cancelled || job.request.kind === "chat" || changedFileCount > 0) return null;
  return `${job.request.provider} finished without changing project files for this ${job.request.kind} request.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timeoutFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 10 ? value : fallback;
}

function durationLabel(milliseconds: number): string {
  return milliseconds % 60_000 === 0
    ? `${milliseconds / 60_000} minute${milliseconds === 60_000 ? "" : "s"}`
    : `${milliseconds} ms`;
}

export class AgentRuntime {
  readonly nonce = randomBytes(24).toString("base64url");
  private readonly jobs = new Map<string, AgentRunJob>();
  private readonly locks = new Map<string, string>();
  private capabilityCache:
    | { at: number; value: Record<AgentProvider, AgentProviderCapability> }
    | undefined;

  constructor(private readonly adapter: StudioApiAdapter) {}

  isProjectLocked(projectId: string): boolean {
    return this.locks.has(projectId);
  }

  getJob(jobId: string): AgentRunJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  async capabilities(): Promise<Record<AgentProvider, AgentProviderCapability>> {
    if (this.capabilityCache && Date.now() - this.capabilityCache.at < 10_000) {
      return this.capabilityCache.value;
    }
    const [codex, claude] = await Promise.all([detectProvider("codex"), detectProvider("claude")]);
    const value = { codex, claude };
    this.capabilityCache = { at: Date.now(), value };
    return value;
  }

  threadPath(projectDir: string, provider: AgentProvider): string {
    return join(agentStateRoot(), projectKey(projectDir), "threads", `${provider}.json`);
  }

  ledgerPath(projectDir: string, jobId: string): string {
    return join(agentStateRoot(), projectKey(projectDir), "runs", `${jobId}.json`);
  }

  threads(project: ResolvedProject): AgentThreadSummary[] {
    return (["codex", "claude"] as const).map((provider) => {
      const thread = readThread(this.threadPath(project.dir, provider), provider);
      return {
        provider,
        sessionId: thread.sessionId,
        invalidated: thread.invalidated,
        transcript: thread.transcript,
      };
    });
  }

  resetThread(project: ResolvedProject, provider: AgentProvider): AgentThreadSummary {
    const thread: PersistedThread = {
      provider,
      sessionId: null,
      invalidated: false,
      transcript: [],
      updatedAt: new Date().toISOString(),
    };
    this.writeThread(project.dir, thread);
    return thread;
  }

  start(project: ResolvedProject, request: AgentRunRequest): AgentRunJob {
    if (this.locks.has(project.id))
      throw new Error("An agent run is already active for this project.");
    const jobId = randomUUID();
    const ledgerPath = this.ledgerPath(project.dir, jobId);
    const job: AgentRunJob = {
      id: jobId,
      project,
      request,
      ledgerPath,
      events: [],
      listeners: new Set(),
      process: null,
      terminal: false,
      cancelled: false,
    };
    this.jobs.set(jobId, job);
    this.locks.set(project.id, jobId);
    this.emit(job, { type: "status", message: "Snapshotting project sources…" });
    void this.execute(job);
    return job;
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.terminal) return false;
    job.cancelled = true;
    this.emit(job, { type: "status", message: "Cancelling agent…" });
    job.process?.cancel();
    return true;
  }

  subscribe(jobId: string, listener: () => void): () => void {
    const job = this.jobs.get(jobId);
    if (!job) return () => {};
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  async undo(
    jobId: string,
  ): Promise<{ conflicts: string[]; findings?: Awaited<ReturnType<typeof lintProject>> }> {
    const job = this.jobs.get(jobId);
    const ledgerPath = job?.ledgerPath;
    if (!job || !ledgerPath || !job.terminal) throw new Error("Run is not ready to undo.");
    const ledger = readLedger(ledgerPath);
    if (!ledger) throw new Error("Run ledger is unavailable.");
    if (!ledger.undoCovered)
      throw new Error("Undo is unavailable because unsupported files changed.");
    const conflicts = undoAgentFiles(job.project.dir, ledger);
    if (conflicts.length > 0) return { conflicts };
    ledger.status = "undone";
    writeLedger(ledgerPath, ledger);
    this.invalidateThread(job.project.dir, job.request.provider);
    const findings = await lintProject(this.adapter, job.project.dir);
    this.emit(job, { type: "lint", findings });
    this.emit(job, { type: "status", message: "Agent changes were undone." });
    return { conflicts: [], findings };
  }

  private writeThread(projectDir: string, thread: PersistedThread): void {
    const path = this.threadPath(projectDir, thread.provider);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(thread, null, 2)}\n`, "utf-8");
  }

  private invalidateThread(projectDir: string, provider: AgentProvider): void {
    const path = this.threadPath(projectDir, provider);
    const thread = readThread(path, provider);
    this.writeThread(projectDir, {
      ...thread,
      sessionId: null,
      invalidated: true,
      updatedAt: new Date().toISOString(),
    });
  }

  private emit(job: AgentRunJob, event: Omit<AgentRunEvent, "id" | "at">): void {
    job.events.push({ ...event, id: job.events.length + 1, at: new Date().toISOString() });
    for (const listener of job.listeners) listener();
  }

  private async execute(job: AgentRunJob): Promise<void> {
    const before = snapshotAgentFiles(job.project.dir);
    const ledger = createLedger(job, before);
    writeLedger(job.ledgerPath, ledger);

    const thread = this.prepareThread(job);
    const run = await this.runProvider(job, thread);
    const failure = await this.verifyAfterRun(job, before, ledger, run.failure);
    this.finishRun(job, ledger, failure, run.timedOutMessage);
  }

  /** Load or reset the provider thread and append this run's user turn. */
  private prepareThread(job: AgentRunJob): PersistedThread {
    let thread = readThread(
      this.threadPath(job.project.dir, job.request.provider),
      job.request.provider,
    );
    if (job.request.newThread || thread.invalidated) {
      thread = this.resetThread(job.project, job.request.provider) as PersistedThread;
    }
    thread.transcript.push({
      role: "user",
      text: job.request.prompt,
      at: new Date().toISOString(),
      kind: job.request.kind,
    });
    this.writeThread(job.project.dir, thread);
    return thread;
  }

  /**
   * Idle and absolute-runtime timers for one provider run. A timeout records its
   * message once, tells Studio the process is stopping, and cancels it; further
   * timeouts and post-cancellation activity are ignored.
   */
  private createRunTimeouts(job: AgentRunJob) {
    const idleTimeoutMs = timeoutFromEnv(
      "HYPERFRAMES_AGENT_IDLE_TIMEOUT_MS",
      DEFAULT_IDLE_TIMEOUT_MS,
    );
    const maxRuntimeMs = timeoutFromEnv("HYPERFRAMES_AGENT_MAX_RUNTIME_MS", DEFAULT_MAX_RUNTIME_MS);
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let maxTimer: ReturnType<typeof setTimeout> | null = null;
    let timedOutMessage: string | null = null;

    const timeOut = (message: string) => {
      if (timedOutMessage || job.cancelled) return;
      timedOutMessage = message;
      this.emit(job, {
        type: "status",
        message: `${job.request.provider} timed out; stopping the process…`,
      });
      job.process?.cancel();
    };

    return {
      idleTimeoutMs,
      timedOutMessage: () => timedOutMessage,
      touchActivity: () => {
        if (timedOutMessage || job.cancelled) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () =>
            timeOut(
              `${job.request.provider} timed out after ${durationLabel(idleTimeoutMs)} without activity. Supported partial source changes remain visible and can be undone.`,
            ),
          idleTimeoutMs,
        );
      },
      startMaxTimer: () => {
        maxTimer = setTimeout(
          () =>
            timeOut(
              `${job.request.provider} timed out after the ${durationLabel(maxRuntimeMs)} maximum runtime. Supported partial source changes remain visible and can be undone.`,
            ),
          maxRuntimeMs,
        );
      },
      clear: () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (maxTimer) clearTimeout(maxTimer);
      },
    };
  }

  private async installRegistryItem(job: AgentRunJob): Promise<void> {
    if (!job.request.registryItem) return;
    if (!this.adapter.installRegistryBlock) {
      throw new Error("Registry installation is unavailable.");
    }
    this.emit(job, {
      type: "status",
      message: `Installing registry item ${job.request.registryItem}…`,
    });
    await this.adapter.installRegistryBlock({
      project: job.project,
      blockName: job.request.registryItem,
    });
  }

  private recordSession(job: AgentRunJob, thread: PersistedThread, sessionId: string): void {
    thread.sessionId = sessionId;
    thread.invalidated = false;
    thread.updatedAt = new Date().toISOString();
    this.writeThread(job.project.dir, thread);
  }

  private recordAssistantTurn(job: AgentRunJob, thread: PersistedThread, text: string): void {
    this.emit(job, { type: "assistant", text });
    thread.transcript.push({ role: "assistant", text, at: new Date().toISOString() });
    thread.updatedAt = new Date().toISOString();
    this.writeThread(job.project.dir, thread);
  }

  /** Registry install (when requested) plus the provider process itself. */
  private async runProvider(
    job: AgentRunJob,
    thread: PersistedThread,
  ): Promise<{ failure: string | null; timedOutMessage: string | null }> {
    const timeouts = this.createRunTimeouts(job);
    let failure: string | null = null;
    try {
      await this.installRegistryItem(job);
      if (!job.cancelled) {
        failure = await this.runProviderProcess(job, thread, timeouts);
      }
    } catch (error) {
      failure = errorMessage(error);
    }
    return { failure, timedOutMessage: timeouts.timedOutMessage() };
  }

  private async runProviderProcess(
    job: AgentRunJob,
    thread: PersistedThread,
    timeouts: ReturnType<AgentRuntime["createRunTimeouts"]>,
  ): Promise<string | null> {
    this.emit(job, { type: "status", message: `Starting ${job.request.provider}…` });
    job.process = startProviderRun({
      provider: job.request.provider,
      projectDir: job.project.dir,
      prompt: job.request.prompt,
      sessionId: thread.sessionId,
      onSession: (sessionId) => {
        timeouts.touchActivity();
        this.recordSession(job, thread, sessionId);
      },
      onAssistant: (text) => {
        timeouts.touchActivity();
        this.recordAssistantTurn(job, thread, text);
      },
      onTool: (message) => {
        timeouts.touchActivity();
        this.emit(job, { type: "tool", message });
      },
      onDiagnostic: (message) => {
        timeouts.touchActivity();
        this.emit(job, { type: "status", message });
      },
    });
    timeouts.touchActivity();
    timeouts.startMaxTimer();
    this.emit(job, {
      type: "status",
      message: `${job.request.provider} will stop after ${durationLabel(timeouts.idleTimeoutMs)} without activity.`,
    });
    const result = await job.process.done;
    timeouts.clear();

    const timedOut = timeouts.timedOutMessage();
    if (timedOut) {
      this.invalidateThread(job.project.dir, job.request.provider);
      return timedOut;
    }
    if (!job.cancelled && result.code !== 0) {
      return result.stderr.trim() || `${job.request.provider} exited with code ${result.code}.`;
    }
    return null;
  }

  /**
   * Diff the project against its pre-run snapshot, then lint. Returns the
   * failure that should be reported — an unsupported-file change always wins,
   * and an edit request that changed nothing is itself a failure.
   */
  private async verifyAfterRun(
    job: AgentRunJob,
    before: AgentRunLedger["before"],
    ledger: AgentRunLedger,
    runFailure: string | null,
  ): Promise<string | null> {
    let failure = runFailure;
    try {
      const diff = diffAgentFiles(job.project.dir, before);
      ledger.changedFiles = diff.changedFiles;
      ledger.undoCovered = diff.undoCovered;
      ledger.completedAt = new Date().toISOString();
      if (diff.changedFiles.length > 0) {
        this.emit(job, { type: "changed-files", files: diff.changedFiles });
      }
      failure ??= emptyEditFailure(job, diff.changedFiles.length);
      if (!diff.undoCovered) failure = UNSUPPORTED_FILES_FAILURE;
      this.emit(job, {
        type: "status",
        message: diff.changedFiles.length > 0 ? "Linting changed project…" : "Linting project…",
      });
      const findings = await lintProject(this.adapter, job.project.dir);
      this.emit(job, { type: "lint", findings });
      return failure;
    } catch (error) {
      return failure ?? `Post-run verification failed: ${errorMessage(error)}`;
    }
  }

  private emitTerminalEvent(
    job: AgentRunJob,
    ledger: AgentRunLedger,
    failure: string | null,
    timedOutMessage: string | null,
  ): void {
    if (!ledger.undoCovered) {
      ledger.status = "failed";
      this.emit(job, {
        type: "failure",
        message: failure ?? UNSUPPORTED_FILES_FAILURE,
        critical: true,
      });
      return;
    }
    if (timedOutMessage) {
      ledger.status = "failed";
      this.emit(job, { type: "failure", message: timedOutMessage });
      return;
    }
    if (job.cancelled) {
      ledger.status = "cancelled";
      this.emit(job, {
        type: "cancelled",
        message: "Agent cancelled; partial changes remain undoable.",
      });
      return;
    }
    if (failure) {
      ledger.status = "failed";
      this.emit(job, { type: "failure", message: failure, critical: !ledger.undoCovered });
      return;
    }
    ledger.status = "complete";
    this.emit(job, { type: "complete", message: "Agent run complete." });
  }

  private finishRun(
    job: AgentRunJob,
    ledger: AgentRunLedger,
    failure: string | null,
    timedOutMessage: string | null,
  ): void {
    this.emitTerminalEvent(job, ledger, failure, timedOutMessage);
    writeLedger(job.ledgerPath, ledger);
    job.terminal = true;
    this.locks.delete(job.project.id);
    for (const listener of job.listeners) listener();
    this.pruneLedgers(job.project.dir);
  }

  private pruneLedgers(projectDir: string): void {
    const dir = dirname(this.ledgerPath(projectDir, "placeholder"));
    if (!existsSync(dir)) return;
    const ledgers = readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => ({ file, path: join(dir, file), ledger: readLedger(join(dir, file)) }))
      .sort((a, b) => (b.ledger?.createdAt ?? "").localeCompare(a.ledger?.createdAt ?? ""));
    for (const old of ledgers.slice(MAX_RUN_LEDGERS)) {
      try {
        unlinkSync(old.path);
      } catch {
        // Retention cleanup is best effort.
      }
    }
  }
}
