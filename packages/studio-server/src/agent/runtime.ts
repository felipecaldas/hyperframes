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
  compareAgentSnapshots,
  createAgentStagingProject,
  diffAgentFiles,
  readLedger,
  snapshotAgentFiles,
  undoAgentFiles,
  writeLedger,
  type AgentFileSnapshot,
  type AgentRunLedger,
} from "./files.js";
import { assertNoIntroducedEgress } from "./guardrails/egress.js";
import { GuardrailRefusal } from "./guardrails/refusal.js";
import { reviewChange, spentWithReview, type ReviewResult } from "./guardrails/review.js";
import { decideVerdict } from "./guardrails/verdict.js";
import { detectProvider, runTabarioModel, type TabarioModelResult } from "./providers.js";
import { describeSelectedElement } from "./selection.js";
import type {
  AgentChangedFile,
  AgentProvider,
  AgentProviderCapability,
  AgentRefusal,
  AgentRunEvent,
  AgentRunRequest,
  AgentThreadSummary,
} from "./types.js";

const MAX_RUN_LEDGERS = 20;
/**
 * How many finished runs stay in memory (TAB-1196).
 *
 * Every run was kept for the life of the process, with every event it ever
 * emitted, and a Studio session lives for as long as someone keeps editing.
 * The same number as `MAX_RUN_LEDGERS` on purpose: Undo needs the job and the
 * ledger both, so keeping a job whose ledger has been pruned holds memory for
 * something that can no longer be undone.
 */
const MAX_FINISHED_JOBS = 20;
/**
 * How long a run may go without activity before it is abandoned.
 *
 * Exported because a tool that blocks the run has to give up before this does,
 * and the CLI's `run_check` deadline is the first one that comes close. Leaving
 * the relationship in prose meant nothing noticed when either number moved, so
 * the CLI asserts against this constant instead of restating 180000.
 */
export const AGENT_IDLE_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_MAX_RUNTIME_MS = 15 * 60_000;
const PROVIDER: AgentProvider = "tabario";

interface PersistedThread extends AgentThreadSummary {
  updatedAt: string;
}

/** The trees a run is judged against, and where it staged its work. */
interface RunTrees {
  /** The project as it was when the run started. */
  before: AgentFileSnapshot;
  /** The tree the model started in: the project, plus a catalog item when one was asked for. */
  baseline: AgentFileSnapshot;
  /**
   * What the lint said about `baseline` before the model ran, when a catalog
   * item was staged (TAB-1223). Null otherwise: the baseline is then the
   * project, which is linted only if the staged tree has errors to compare.
   */
  lintBaseline: LintFinding[] | null;
  stagingDir: string;
}

interface LintFinding {
  severity: string;
  message: string;
  file?: string;
}

/**
 * The staged tree, read once, and what the check made of it (TAB-1222).
 *
 * `diff` is null when the tree was not read: the run was cancelled, or reading
 * it failed and `error` says how. Nothing is applied from a tree that was not
 * read, so a null here can never become a change that skipped the check.
 */
interface StagedChange {
  diff: ReturnType<typeof diffAgentFiles> | null;
  review: ReviewResult | null;
  error: string | null;
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

/**
 * Everything one agent run writes lives under here: threads, ledgers, and the
 * staging copies of projects.
 *
 * Exported because the CLI adapter has to answer "is this directory a staging
 * copy the agent asked me about, or somewhere else on the disk" before it runs
 * a browser over it, and the honest way to answer is to ask this function
 * rather than to restate the path. Read at call time, so a test can point
 * `HYPERFRAMES_STATE_DIR` at a temp dir and have both sides agree.
 */
export function agentStateRoot(): string {
  const override = process.env.HYPERFRAMES_STATE_DIR?.trim();
  return override
    ? resolve(override, "studio-agent")
    : join(homedir(), ".hyperframes", "studio-agent");
}

function projectKey(projectDir: string): string {
  return createHash("sha256").update(resolve(projectDir)).digest("hex").slice(0, 24);
}

/**
 * A prompt's fingerprint, for the durable usage row (TAB-1193).
 *
 * The prompt itself never leaves the session sandbox. This is enough to spot
 * the same request being replayed against a ceiling and nothing more.
 */
function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 32);
}

/**
 * Everything a request said, for the fingerprint (TAB-1221).
 *
 * A request from a Studio panel now has few words of its own, and they are the
 * same words for every element, so the prompt alone would give every such
 * request one fingerprint. A request with no material hashes as it always did.
 */
function requestText(request: AgentRunRequest): string {
  return request.material ? `${request.prompt}\n\n${request.material}` : request.prompt;
}

/**
 * What the model is told alongside the user's words, or null when nothing is
 * (TAB-1194, TAB-1221).
 *
 * A typed message carries the element selected on the timeline. A request
 * built by a Studio panel carries what the panel gathered. Neither is
 * something the user typed, so both are kept off the turn's text.
 */
function turnContext(request: AgentRunRequest): string | null {
  const parts = [
    request.selection ? describeSelectedElement(request.selection) : "",
    request.material?.trim() ?? "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : null;
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

type TranscriptEntry = AgentThreadSummary["transcript"][number];

/** One persisted turn, or null when the record is not one. */
function readTranscriptEntry(entry: unknown): TranscriptEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const item = Object.fromEntries(Object.entries(entry));
  if (item.role !== "user" && item.role !== "assistant") return null;
  if (typeof item.text !== "string" || typeof item.at !== "string") return null;
  return {
    role: item.role,
    text: item.text,
    at: item.at,
    ...(typeof item.context === "string" ? { context: item.context } : {}),
  };
}

function readTranscript(value: unknown): AgentThreadSummary["transcript"] {
  if (!Array.isArray(value)) return [];
  return value.map(readTranscriptEntry).filter((entry) => entry !== null);
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

/** A finding's identity for baseline comparison — file, severity and message. */
function findingKey(finding: { severity: string; message: string; file?: string }): string {
  return `${finding.file ?? ""}::${finding.severity.toLowerCase()}::${finding.message}`;
}

/**
 * The `error` findings present after the run that were not present before it.
 *
 * Counted by identity rather than by tally: an edit that fixes one inherited
 * error and introduces a different one nets to zero, and a count would wave it
 * through. Duplicates of the same message in one file are matched
 * one-for-one, so going from one occurrence to three still reports two.
 *
 * `baseline` is what the lint said about the tree the model started in. On a
 * catalog run that tree holds the staged item, whose own findings are then
 * inherited and not introduced (TAB-1223).
 */
export function introducedErrors(baseline: LintFinding[], staged: LintFinding[]): LintFinding[] {
  const stagedErrors = staged.filter((finding) => finding.severity.toLowerCase() === "error");
  if (stagedErrors.length === 0) return [];

  const remaining = new Map<string, number>();
  for (const finding of baseline) {
    if (finding.severity.toLowerCase() !== "error") continue;
    const key = findingKey(finding);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }

  const introduced: LintFinding[] = [];
  for (const finding of stagedErrors) {
    const key = findingKey(finding);
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else introduced.push(finding);
  }
  return introduced;
}

/**
 * The egress a run introduced, judged on the staged tree as a whole (TAB-1195).
 *
 * `edit_file` and `write_file` already refuse this one change at a time, where
 * the model can still repair it. This is the same question asked once more at
 * the only point every write has to pass, so a path into the staging tree that
 * is not one of those two tools cannot carry a remote URL past the gate.
 *
 * `baseline` is the tree the model started from, which is the project plus
 * whatever registry block the request asked for. A block the user chose to
 * install is not something the agent introduced.
 */
function egressAtApply(
  changedFiles: AgentChangedFile[],
  baseline: AgentFileSnapshot,
  stagingDir: string,
): AgentRefusal | null {
  for (const file of changedFiles) {
    if (file.change === "deleted") continue;
    // A file with no source snapshot is a binary, and a binary in the staged
    // tree is a catalog asset: Studio put it there and the model cannot write
    // one. Its bytes read as text would be scanned for URLs they do not carry.
    if (!file.supported) continue;
    const before = Buffer.from(baseline.sourceContents[file.path] ?? "", "base64").toString(
      "utf-8",
    );
    const after = readFileSync(join(stagingDir, file.path), "utf-8");
    try {
      assertNoIntroducedEgress(before, after, file.path, "apply");
    } catch (error) {
      if (!(error instanceof GuardrailRefusal)) throw error;
      return {
        ...error.refusal,
        message: `Staged changes were not applied. ${error.refusal.message}`,
      };
    }
  }
  return null;
}

function isEditRequest(job: AgentRunJob): boolean {
  return job.request.kind !== "chat";
}

/**
 * The reply for a turn whose changes never reached the project (TAB-1201).
 *
 * The model cannot know it was refused. The apply gate runs after its last
 * completion, so its closing text describes what it *staged* and reads as a
 * report of what it did — "I have updated Caption 11", when `index.html` was
 * never touched. Delivered unchanged that text simply *is* the answer, and the
 * refusal lands underneath it as one more Activity line, which is how a user
 * came to be told twice that a caption had been fixed that never was.
 *
 * Two things follow from that, and the second is the expensive one:
 *
 *  - The correction has to **lead**. Appended to the end of a confident
 *    paragraph it reads as a caveat to a success rather than a contradiction of
 *    one. The drawer renders plain text in a `whitespace-pre-wrap` bubble, so
 *    there is no emphasis to lean on — order is the whole of the signal.
 *  - It has to go into the transcript, not only onto the stream, because
 *    `execute` feeds `thread.transcript` back to the model. Left alone, the
 *    false claim becomes the next turn's premise: the follow-up run opened by
 *    asserting it had already fixed both captions and spent 260k tokens
 *    building on that.
 *
 * A turn that applied cleanly has no reason, and is returned untouched.
 */
/**
 * Remove a run's staging clone, and never let that decide whether the run gets
 * to report itself.
 *
 * A throw here would skip `recordAssistant` and `finishRun` both, so the user
 * would see changed files, no reply and no completion, while the ledger sat on
 * "running" for ever. That is exactly what a TAB-805 measurement caused: its
 * static server inherited the project's `autoProxy`, so the browser triggered
 * transcodes that wrote into this directory while it was being removed, and
 * `rmSync` raised on the moving target.
 */
function discardStagingDir(stagingDir: string): void {
  try {
    rmSync(stagingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[Studio] could not remove agent staging dir: ${errorMessage(error)}`);
  }
}

/** A tree that was not read was not checked, and is not applied. */
function stagedOrThrow(change: StagedChange): ReturnType<typeof diffAgentFiles> {
  if (!change.diff) throw new Error(change.error ?? "The staged changes could not be read.");
  return change.diff;
}

/** What a run that staged nothing is told: an edit is told so, a question is not. */
function nothingChanged(job: AgentRunJob): string | null {
  return isEditRequest(job)
    ? `Tabario AI finished without changing project files for this ${job.request.kind} request.`
    : null;
}

export function unappliedReply(assistantText: string, reason: string | null): string {
  if (!reason) return assistantText;
  const lead = `Nothing in your project changed.\n\nWhy: ${reason}`;
  if (!assistantText) return lead;
  return `${lead}\n\nWhat Tabario AI said about the turn follows. It describes what was attempted, not what was changed:\n\n${assistantText}`;
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
    const context = turnContext(job.request);
    thread.transcript.push({
      role: "user",
      text: job.request.prompt,
      at: new Date().toISOString(),
      kind: job.request.kind,
      ...(context ? { context } : {}),
    });
    thread.updatedAt = new Date().toISOString();
    this.writeThread(job.project.dir, thread);
    // Said on the stream as well as kept on the thread (TAB-1194). The thread
    // is only re-read when the run ends, and a run is minutes long, so without
    // this the drawer could not show what the model was told until it no longer
    // mattered.
    if (context) this.emit(job, { type: "context", message: context });
    return thread;
  }

  private recordAssistant(job: AgentRunJob, thread: PersistedThread, text: string): void {
    if (!text) return;
    // `text` has already been through `unappliedReply`, so a refused turn
    // carries its own refusal into the transcript as well as onto the stream.
    // Both halves matter and the second one is the quiet half: `execute` feeds
    // `thread.transcript` straight back to the model, so a claim recorded here
    // is a claim the next turn reasons from.
    this.emit(job, { type: "assistant", text });
    thread.transcript.push({ role: "assistant", text, at: new Date().toISOString() });
    thread.updatedAt = new Date().toISOString();
    this.writeThread(job.project.dir, thread);
  }

  private createTimeouts(job: AgentRunJob) {
    const idleMs = timeoutFromEnv("HYPERFRAMES_AGENT_IDLE_TIMEOUT_MS", AGENT_IDLE_TIMEOUT_MS);
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

  /**
   * Build the tree the model works in, and say what it started from
   * (TAB-1195).
   *
   * Only a registry install makes that differ from the project, so only then
   * is the staging tree read a second time, and only then is it linted before
   * the model runs (TAB-1223). A catalog block is a fragment and a component
   * has no root composition, so the item Studio staged always carries a lint
   * error of its own. Judged against the project, that error read as the
   * model's, and no catalog item could ever be applied.
   */
  private async stageProject(
    job: AgentRunJob,
    stagingDir: string,
    before: AgentFileSnapshot,
  ): Promise<Pick<RunTrees, "baseline" | "lintBaseline">> {
    createAgentStagingProject(job.project.dir, stagingDir);
    await this.installRegistryItem(job, stagingDir);
    if (!job.request.registryItem) return { baseline: before, lintBaseline: null };
    return {
      baseline: snapshotAgentFiles(stagingDir),
      lintBaseline: await lintProject(this.adapter, stagingDir),
    };
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
    // Counted here rather than in the model loop: `onTool` is already the one
    // callback every tool call passes through, and the loop has no reason to
    // carry a tally it never reads.
    const tools: Record<string, number> = {};

    try {
      const { baseline, lintBaseline } = await this.stageProject(job, stagingDir, before);
      this.emit(job, { type: "status", message: "Tabario AI is inspecting the timeline…" });
      const result = await runTabarioModel({
        adapter: this.adapter,
        stagingDir,
        kind: job.request.kind,
        transcript: thread.transcript,
        signal: job.controller.signal,
        principal: projectKey(job.project.dir),
        onAssistant: (text) => {
          assistantText = text;
        },
        onTool: (message) => {
          tools[message] = (tools[message] ?? 0) + 1;
          this.emit(job, { type: "tool", message });
        },
        onActivity: timeouts.touch,
        onToolResult: (entry) => {
          (ledger.transcript ??= []).push(entry);
        },
        onRefusal: (refusal) => {
          this.refuse(job, ledger, refusal);
        },
      });
      assistantText ||= result.assistantText;
      if (result.verification) ledger.verification = result.verification;
      const trees: RunTrees = { before, baseline, lintBaseline, stagingDir };
      const staged = await this.checkStaged(job, thread, trees, timeouts.touch);
      this.recordMeter(job, ledger, result, tools, staged.review);
      if (!job.cancelled && !timeouts.reason()) {
        failure = await this.validateAndApply(job, ledger, trees, staged);
      }
    } catch (error) {
      if (!job.cancelled) failure = timeouts.reason() ?? errorMessage(error);
    } finally {
      timeouts.clear();
      discardStagingDir(stagingDir);
    }

    // Same precedence `finishRun` uses below, so the sentence the user reads
    // and the event that closes the run cannot name different reasons. A
    // cancelled run passes null on both counts — `stop()` and the catch each
    // decline to set a reason once `job.cancelled` is true — and its own
    // terminal event already says no staged changes were applied.
    const stopped = timeouts.reason() ?? failure;
    this.recordAssistant(job, thread, unappliedReply(assistantText, stopped));
    this.finishRun(job, ledger, failure, timeouts.reason());
  }

  /**
   * Reads the staged tree once and has the change checked against what the
   * user asked for (TAB-1222).
   *
   * Ahead of the meter, so a run reports what the check cost whether or not the
   * change lands. And never throwing, for the same reason: a throw from here
   * would skip the meter, and the money was spent.
   */
  private async checkStaged(
    job: AgentRunJob,
    thread: PersistedThread,
    trees: RunTrees,
    touch: () => void,
  ): Promise<StagedChange> {
    if (job.cancelled || job.controller.signal.aborted)
      return { diff: null, review: null, error: null };
    try {
      const diff = diffAgentFiles(trees.stagingDir, trees.before, trees.baseline);
      const review = await this.reviewStaged(job, thread, trees.baseline, diff, touch);
      return { diff, review, error: null };
    } catch (error) {
      return { diff: null, review: null, error: errorMessage(error) };
    }
  }

  /**
   * The check's ruling on what the model changed, or null when the model
   * changed nothing that reaches it.
   *
   * Measured from `baseline` and not from the project. A catalog item's own
   * files were put there by Studio because the user picked the item, and they
   * are not something the model did.
   */
  private async reviewStaged(
    job: AgentRunJob,
    thread: PersistedThread,
    baseline: AgentFileSnapshot,
    diff: ReturnType<typeof diffAgentFiles>,
    touch: () => void,
  ): Promise<ReviewResult | null> {
    // An unsupported change is refused at apply for being one. There is
    // nothing to gain from paying to read it first.
    if (!diff.undoCovered) return null;
    const changedFiles = compareAgentSnapshots(baseline, diff.after);
    if (changedFiles.length === 0) return null;
    this.emit(job, {
      type: "status",
      message: "Checking the change against what you asked for…",
    });
    touch();
    return reviewChange({
      kind: job.request.kind,
      ...(job.request.registryItem ? { registryItem: job.request.registryItem } : {}),
      transcript: thread.transcript,
      changedFiles,
      baseline,
      staged: diff.after,
      signal: job.controller.signal,
      onActivity: touch,
      principal: projectKey(job.project.dir),
    });
  }

  /**
   * What the run spent, recorded before the apply gate runs and unconditionally.
   *
   * The money was spent whether or not the change lands, so a run that is about
   * to be refused still has to report what it cost — a meter that only fires on
   * success is exactly the blind spot that lets a failing loop bill. Both live
   * runs behind TAB-1201 were refused, and between them they cost $0.14.
   */
  private recordMeter(
    job: AgentRunJob,
    ledger: AgentRunLedger,
    result: TabarioModelResult,
    tools: Record<string, number>,
    review: ReviewResult | null,
  ): void {
    const spent = spentWithReview(result.meter, review?.meter);
    ledger.meter = {
      model: result.model,
      promptTokens: spent.promptTokens,
      completionTokens: spent.completionTokens,
      totalTokens: spent.totalTokens,
      costUsd: spent.costUsd,
      costSource: result.meter.costSource,
      costConfidence: result.meter.costConfidence,
      costEnforceable: result.meter.costEnforceable,
      rounds: result.meter.rounds,
      tools,
      stopReason: result.stopReason,
      promptHash: hashPrompt(requestText(job.request)),
      ...(review ? { review: review.meter } : {}),
    };
    this.emit(job, { type: "metered", meter: ledger.meter });
  }

  /**
   * A gate said no: keep it, say it, and hand back the sentence (TAB-1196).
   *
   * A refusal used to be nothing but the text of a failure, so the ledger
   * recorded a refused change and a provider outage as the same thing. The
   * record goes on the ledger and down the stream before the terminal event,
   * which is what lets the verdict say `refused` rather than `failed`.
   */
  private refuse(job: AgentRunJob, ledger: AgentRunLedger, refusal: AgentRefusal): string {
    (ledger.refusals ??= []).push(refusal);
    this.emit(job, { type: "refusal", message: refusal.message, refusal });
    return refusal.message;
  }

  private async validateAndApply(
    job: AgentRunJob,
    ledger: AgentRunLedger,
    trees: RunTrees,
    change: StagedChange,
  ): Promise<string | null> {
    const staged = stagedOrThrow(change);
    if (!staged.undoCovered)
      return this.refuse(job, ledger, {
        gate: "unsupported-change",
        stage: "apply",
        message: "Tabario AI staged an unsupported file change; nothing was applied.",
      });
    // Ahead of the lint gate, and for every request kind — not only edits.
    // A question stages nothing, and falling through from here used to report
    // "Staged changes failed lint" about changes that did not exist, next to an
    // answer that had changed nothing. There is also nothing to lint.
    if (staged.changedFiles.length === 0) return nothingChanged(job);
    // The check's ruling first. It was made before the meter was recorded, and
    // a change that was not asked for is recorded as that, whatever the lint
    // would have gone on to say about it.
    const refusal =
      change.review?.refusal ?? (await this.stagedRefusal(job, staged.changedFiles, trees));
    if (refusal) return this.refuse(job, ledger, refusal);
    if (job.cancelled || job.controller.signal.aborted) return null;
    return this.applyChecked(job, ledger, trees, staged.changedFiles);
  }

  /** Lands a change every gate has passed, as one transaction. */
  private applyChecked(
    job: AgentRunJob,
    ledger: AgentRunLedger,
    trees: RunTrees,
    changedFiles: AgentChangedFile[],
  ): string | null {
    this.emit(job, { type: "status", message: "Applying the validated timeline transaction…" });
    const conflicts = applyStagedAgentFiles(
      job.project.dir,
      trees.stagingDir,
      trees.before,
      changedFiles,
    );
    if (conflicts.length > 0)
      return this.refuse(job, ledger, {
        gate: "conflict",
        stage: "apply",
        message: `Project changed while Tabario AI was working: ${conflicts.join(", ")}`,
      });
    ledger.changedFiles = changedFiles;
    ledger.completedAt = new Date().toISOString();
    this.emitApplied(job, ledger, changedFiles);
    return null;
  }

  /**
   * What the gates make of the staged tree: the first refusal, or null.
   *
   * Egress is asked first. A change that reaches the network is refused for
   * that whatever else is wrong with it, and the lint is the expensive half.
   */
  private async stagedRefusal(
    job: AgentRunJob,
    changedFiles: AgentChangedFile[],
    trees: RunTrees,
  ): Promise<AgentRefusal | null> {
    const { baseline, lintBaseline, stagingDir } = trees;
    const egress = egressAtApply(changedFiles, baseline, stagingDir);
    if (egress) return egress;
    this.emit(job, { type: "status", message: "Linting the staged project…" });
    const findings = await lintProject(this.adapter, stagingDir);
    this.emit(job, { type: "lint", findings });
    // Gate on what this run *introduced*, never on what it inherited.
    //
    // `lintProject` lints each HTML file on its own, so a mounted
    // sub-composition is judged without the parent that supplies its runtime:
    // every `compositions/scene-N.html` reports "uses GSAP but no GSAP script is
    // loaded" while whole-project `hyperframes check` passes with zero errors.
    // Comparing against nothing therefore held the gate permanently shut — six
    // inherited errors on an untouched project meant Tabario AI could never
    // apply anything to any project with scenes.
    //
    // The baseline is the tree the model started in, linted before it ran
    // (TAB-1223), or the pre-run project when nothing was staged ahead of the
    // model. Never the staged tree after the run: that already contains the
    // change being judged and would absorb the very error this is meant to
    // catch. And only linted when there is an error to compare, since the
    // lint is the expensive half.
    const hasErrors = findings.some((finding) => finding.severity.toLowerCase() === "error");
    if (!hasErrors) return null;
    const baselineFindings = lintBaseline ?? (await lintProject(this.adapter, job.project.dir));
    const introduced = introducedErrors(baselineFindings, findings);
    if (introduced.length === 0) return null;
    const summary = introduced
      .map((finding) => `${finding.file ?? "project"}: ${finding.message}`)
      .join("; ");
    return {
      gate: "lint",
      stage: "apply",
      message: `Staged changes introduced lint errors and were not applied — ${summary}`,
    };
  }

  /**
   * The change has landed: say which files, then what the probe read
   * (TAB-1061). The receipt goes out only here, once the apply succeeded, so
   * its numbers describe the project the user is now looking at and never a
   * staging dir that was thrown away.
   */
  private emitApplied(job: AgentRunJob, ledger: AgentRunLedger, files: AgentChangedFile[]): void {
    this.emit(job, { type: "changed-files", files });
    if (ledger.verification)
      this.emit(job, { type: "measurement", measurement: ledger.verification });
  }

  /**
   * The run's one verdict, written to the ledger and carried on the event that
   * closes the run (TAB-1196).
   *
   * On the terminal event and not on `metered`, where the epic's first sketch
   * of the contract put it. `metered` is emitted before the apply gate so that
   * a refused run still reports what it cost, and a verdict decided there
   * would be decided before the one thing that most often changes it.
   */
  private recordVerdict(
    job: AgentRunJob,
    ledger: AgentRunLedger,
    failure: string | null,
    timeout: string | null,
  ): Pick<AgentRunEvent, "verdict" | "verdictReason"> {
    const receipt = decideVerdict({
      cancelled: job.cancelled,
      timeout,
      failure,
      refusals: ledger.refusals ?? [],
      changedFiles: ledger.changedFiles.length,
      verification: ledger.verification,
      stopReason: ledger.meter?.stopReason ?? null,
    });
    ledger.verdict = receipt.verdict;
    ledger.verdictReason = receipt.reason;
    return { verdict: receipt.verdict, verdictReason: receipt.reason };
  }

  private finishRun(
    job: AgentRunJob,
    ledger: AgentRunLedger,
    failure: string | null,
    timeout: string | null,
  ): void {
    const verdict = this.recordVerdict(job, ledger, failure, timeout);
    if (job.cancelled) {
      ledger.status = "cancelled";
      this.emit(job, {
        type: "cancelled",
        message: "Tabario AI cancelled. No staged changes were applied.",
        ...verdict,
      });
    } else if (timeout || failure) {
      ledger.status = "failed";
      this.emit(job, {
        type: "failure",
        message: timeout ?? failure ?? "Tabario AI failed.",
        ...verdict,
      });
    } else {
      ledger.status = "complete";
      this.emit(job, { type: "complete", message: "Tabario AI finished.", ...verdict });
    }
    writeLedger(job.ledgerPath, ledger);
    job.terminal = true;
    this.locks.delete(job.project.id);
    for (const listener of job.listeners) listener();
    this.pruneLedgers(job.project.dir);
    this.pruneJobs();
  }

  /**
   * Forget the oldest finished runs once there are more than the limit
   * (TAB-1196).
   *
   * Only finished runs are counted and only finished runs are dropped, so a
   * run in flight cannot be forgotten however many finish around it. A stream
   * still reading a dropped run is unaffected: the route holds the job itself,
   * not its id, and reads it to the end. `Map` iterates in insertion order,
   * which is the order the runs started in.
   */
  private pruneJobs(): void {
    const finished = [...this.jobs.values()].filter((job) => job.terminal);
    for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS)))
      this.jobs.delete(job.id);
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
