import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";
import { lintProject } from "../helpers/projectLint.js";
import {
  applyStagedAgentFiles,
  createAgentStagingProject,
  diffAgentFiles,
  readLedger,
  snapshotAgentFiles,
  undoAgentFiles,
  writeLedger,
  type AgentFileSnapshot,
  type AgentRunLedger,
} from "./files.js";
import { detectProvider, runTabarioModel } from "./providers.js";
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
const PROVIDER: AgentProvider = "tabario";

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
  controller: AbortController;
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

function readThread(path: string): PersistedThread {
  const value = readJsonObject(path);
  return {
    provider: PROVIDER,
    sessionId: null,
    invalidated: false,
    transcript: readTranscript(value?.transcript),
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
  };
}

function createLedger(job: AgentRunJob, before: AgentFileSnapshot): AgentRunLedger {
  return {
    version: 1,
    jobId: job.id,
    projectId: job.project.id,
    projectDir: resolve(job.project.dir),
    provider: PROVIDER,
    createdAt: new Date().toISOString(),
    status: "running",
    undoCovered: true,
    before,
    changedFiles: [],
  };
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

function isEditRequest(job: AgentRunJob): boolean {
  return job.request.kind !== "chat";
}

export class AgentRuntime {
  readonly nonce = randomBytes(24).toString("base64url");
  private readonly jobs = new Map<string, AgentRunJob>();
  private readonly locks = new Map<string, string>();

  constructor(private readonly adapter: StudioApiAdapter) {}

  isProjectLocked(projectId: string): boolean {
    return this.locks.has(projectId);
  }

  getJob(jobId: string): AgentRunJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  capabilities(): Record<AgentProvider, AgentProviderCapability> {
    return { tabario: detectProvider() };
  }

  threadPath(projectDir: string): string {
    return join(agentStateRoot(), projectKey(projectDir), "threads", "tabario.json");
  }

  ledgerPath(projectDir: string, jobId: string): string {
    return join(agentStateRoot(), projectKey(projectDir), "runs", `${jobId}.json`);
  }

  threads(project: ResolvedProject): AgentThreadSummary[] {
    const thread = readThread(this.threadPath(project.dir));
    return [thread];
  }

  resetThread(project: ResolvedProject): AgentThreadSummary {
    const thread: PersistedThread = {
      provider: PROVIDER,
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
      throw new Error("Tabario AI is already working on this project.");
    const id = randomUUID();
    const job: AgentRunJob = {
      id,
      project,
      request,
      ledgerPath: this.ledgerPath(project.dir, id),
      events: [],
      listeners: new Set(),
      controller: new AbortController(),
      terminal: false,
      cancelled: false,
    };
    this.jobs.set(id, job);
    this.locks.set(project.id, id);
    this.emit(job, { type: "status", message: "Preparing an isolated project transaction…" });
    void this.execute(job);
    return job;
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.terminal) return false;
    job.cancelled = true;
    this.emit(job, { type: "status", message: "Cancelling Tabario AI…" });
    job.controller.abort();
    return true;
  }

  subscribe(jobId: string, listener: () => void): () => void {
    const job = this.jobs.get(jobId);
    if (!job) return () => {};
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  async undo(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job || !job.terminal) throw new Error("Run is not ready to undo.");
    if (this.locks.has(job.project.id))
      throw new Error("Tabario AI is already working on this project.");
    const ledger = readLedger(job.ledgerPath);
    if (!ledger || ledger.status !== "complete")
      throw new Error("Completed run ledger is unavailable.");
    this.locks.set(job.project.id, `${job.id}:undo`);
    try {
      const conflicts = undoAgentFiles(job.project.dir, ledger);
      if (conflicts.length > 0) return { conflicts };
      ledger.status = "undone";
      writeLedger(job.ledgerPath, ledger);
      const findings = await lintProject(this.adapter, job.project.dir);
      this.emit(job, { type: "lint", findings });
      this.emit(job, { type: "status", message: "Tabario AI changes were undone." });
      return { conflicts: [], findings };
    } finally {
      this.locks.delete(job.project.id);
    }
  }

  private writeThread(projectDir: string, thread: PersistedThread): void {
    const path = this.threadPath(projectDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(thread, null, 2)}\n`, "utf-8");
  }

  private emit(job: AgentRunJob, event: Omit<AgentRunEvent, "id" | "at">): void {
    job.events.push({ ...event, id: job.events.length + 1, at: new Date().toISOString() });
    for (const listener of job.listeners) listener();
  }

  private prepareThread(job: AgentRunJob): PersistedThread {
    let thread = readThread(this.threadPath(job.project.dir));
    if (job.request.newThread) thread = this.resetThread(job.project) as PersistedThread;
    thread.transcript.push({
      role: "user",
      text: job.request.prompt,
      at: new Date().toISOString(),
      kind: job.request.kind,
    });
    thread.updatedAt = new Date().toISOString();
    this.writeThread(job.project.dir, thread);
    return thread;
  }

  private recordAssistant(job: AgentRunJob, thread: PersistedThread, text: string): void {
    if (!text) return;
    this.emit(job, { type: "assistant", text });
    thread.transcript.push({ role: "assistant", text, at: new Date().toISOString() });
    thread.updatedAt = new Date().toISOString();
    this.writeThread(job.project.dir, thread);
  }

  private createTimeouts(job: AgentRunJob) {
    const idleMs = timeoutFromEnv("HYPERFRAMES_AGENT_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS);
    const maxMs = timeoutFromEnv("HYPERFRAMES_AGENT_MAX_RUNTIME_MS", DEFAULT_MAX_RUNTIME_MS);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let reason: string | null = null;
    const stop = (message: string) => {
      if (reason || job.cancelled) return;
      reason = message;
      job.controller.abort();
    };
    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () =>
          stop(
            `Tabario AI timed out after ${durationLabel(idleMs)} without activity. No staged changes were applied.`,
          ),
        idleMs,
      );
    };
    const maxTimer = setTimeout(
      () =>
        stop(
          `Tabario AI exceeded the ${durationLabel(maxMs)} maximum runtime. No staged changes were applied.`,
        ),
      maxMs,
    );
    touch();
    return {
      touch,
      reason: () => reason,
      clear: () => {
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(maxTimer);
      },
    };
  }

  private async installRegistryItem(job: AgentRunJob, stagingDir: string): Promise<void> {
    if (!job.request.registryItem) return;
    if (!this.adapter.installRegistryBlock)
      throw new Error("Registry installation is unavailable.");
    this.emit(job, { type: "status", message: `Staging ${job.request.registryItem}…` });
    await this.adapter.installRegistryBlock({
      project: { ...job.project, dir: stagingDir },
      blockName: job.request.registryItem,
    });
  }

  private async execute(job: AgentRunJob): Promise<void> {
    const before = snapshotAgentFiles(job.project.dir);
    const ledger = createLedger(job, before);
    writeLedger(job.ledgerPath, ledger);
    const thread = this.prepareThread(job);
    const stagingRoot = join(agentStateRoot(), projectKey(job.project.dir), "staging");
    mkdirSync(stagingRoot, { recursive: true });
    const stagingDir = mkdtempSync(join(stagingRoot, `${job.id}-`));
    let failure: string | null = null;
    let assistantText = "";
    const timeouts = this.createTimeouts(job);

    try {
      createAgentStagingProject(job.project.dir, stagingDir);
      await this.installRegistryItem(job, stagingDir);
      this.emit(job, { type: "status", message: "Tabario AI is inspecting the timeline…" });
      const result = await runTabarioModel({
        adapter: this.adapter,
        stagingDir,
        kind: job.request.kind,
        transcript: thread.transcript,
        signal: job.controller.signal,
        onAssistant: (text) => {
          assistantText = text;
        },
        onTool: (message) => this.emit(job, { type: "tool", message }),
        onActivity: timeouts.touch,
      });
      assistantText ||= result.assistantText;
      if (!job.cancelled && !timeouts.reason()) {
        failure = await this.validateAndApply(job, before, ledger, stagingDir);
      }
    } catch (error) {
      if (!job.cancelled) failure = timeouts.reason() ?? errorMessage(error);
    } finally {
      timeouts.clear();
      rmSync(stagingDir, { recursive: true, force: true });
    }

    this.recordAssistant(job, thread, assistantText);
    this.finishRun(job, ledger, failure, timeouts.reason());
  }

  private async validateAndApply(
    job: AgentRunJob,
    before: AgentFileSnapshot,
    ledger: AgentRunLedger,
    stagingDir: string,
  ): Promise<string | null> {
    const staged = diffAgentFiles(stagingDir, before);
    if (!staged.undoCovered)
      return "Tabario AI staged an unsupported file change; nothing was applied.";
    if (isEditRequest(job) && staged.changedFiles.length === 0) {
      return `Tabario AI finished without changing project files for this ${job.request.kind} request.`;
    }
    this.emit(job, { type: "status", message: "Linting the staged project…" });
    const findings = await lintProject(this.adapter, stagingDir);
    this.emit(job, { type: "lint", findings });
    if (findings.some((finding) => finding.severity.toLowerCase() === "error")) {
      return "Staged changes failed lint and were not applied.";
    }
    if (job.cancelled || job.controller.signal.aborted) return null;
    if (staged.changedFiles.length === 0) return null;
    this.emit(job, { type: "status", message: "Applying the validated timeline transaction…" });
    const conflicts = applyStagedAgentFiles(
      job.project.dir,
      stagingDir,
      before,
      staged.changedFiles,
    );
    if (conflicts.length > 0)
      return `Project changed while Tabario AI was working: ${conflicts.join(", ")}`;
    ledger.changedFiles = staged.changedFiles;
    ledger.completedAt = new Date().toISOString();
    this.emit(job, { type: "changed-files", files: staged.changedFiles });
    return null;
  }

  private finishRun(
    job: AgentRunJob,
    ledger: AgentRunLedger,
    failure: string | null,
    timeout: string | null,
  ): void {
    if (job.cancelled) {
      ledger.status = "cancelled";
      this.emit(job, {
        type: "cancelled",
        message: "Tabario AI cancelled. No staged changes were applied.",
      });
    } else if (timeout || failure) {
      ledger.status = "failed";
      this.emit(job, { type: "failure", message: timeout ?? failure ?? "Tabario AI failed." });
    } else {
      ledger.status = "complete";
      this.emit(job, { type: "complete", message: "Tabario AI finished." });
    }
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
      .map((file) => ({ path: join(dir, file), ledger: readLedger(join(dir, file)) }))
      .sort((a, b) => (b.ledger?.createdAt ?? "").localeCompare(a.ledger?.createdAt ?? ""));
    for (const old of ledgers.slice(MAX_RUN_LEDGERS)) {
      try {
        unlinkSync(old.path);
      } catch {
        /* best effort */
      }
    }
  }
}
