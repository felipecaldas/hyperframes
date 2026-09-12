import type { CanvasResolution } from "@hyperframes/parsers";
import type { RegistryItem } from "@hyperframes/core";
import type { LayoutMeasurement } from "./helpers/layoutProbe.js";

/** Resolved info about a single project. */
export interface ResolvedProject {
  id: string;
  dir: string;
  title?: string;
  sessionId?: string;
}

/** Observable render job state, polled by the SSE progress handler. */
export interface RenderJobState {
  id: string;
  status: "rendering" | "complete" | "failed" | "cancelled";
  progress: number;
  stage?: string;
  outputPath: string;
  error?: string;
  /**
   * Optional abort hook set by the adapter. The cancel route calls this to
   * stop an in-flight render; adapters that can't abort may omit it (the
   * route still marks the job cancelled so the SSE stream terminates).
   */
  cancel?: () => void;
}

export interface MediaProcessingJobState {
  id: string;
  status: "processing" | "complete" | "failed";
  progress: number;
  stage?: string;
  inputAssetPath: string;
  outputAssetPath: string;
  outputPath: string;
  backgroundOutputAssetPath?: string;
  backgroundOutputPath?: string;
  error?: string;
  provider?: string;
  framesProcessed?: number;
  durationSeconds?: number;
  avgMsPerFrame?: number;
}

/** Lint result from the core linter. */
export interface LintResult {
  findings: Array<{
    code?: string;
    severity: string;
    message: string;
    file?: string;
    fixHint?: string;
  }>;
}

export interface ProjectLintResult {
  results: Array<{ file: string; result: LintResult }>;
}

export interface StudioSelectionTextField {
  key: string;
  label: string;
  value: string;
  tagName: string;
  source: "self" | "child" | "text-node";
}

export interface StudioSelectionSnapshot {
  schemaVersion: 1;
  projectId: string;
  compositionPath: string;
  sourceFile: string;
  currentTime: number;
  target: {
    id?: string | null;
    hfId?: string;
    selector?: string;
    selectorIndex?: number;
  };
  label: string;
  tagName: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  textContent: string | null;
  dataAttributes: Record<string, string>;
  inlineStyles: Record<string, string>;
  computedStyles: Record<string, string>;
  textFields: StudioSelectionTextField[];
  capabilities: Record<string, boolean | string | undefined>;
  thumbnailUrl: string;
}

export interface StudioSelectionResponse {
  selection: StudioSelectionSnapshot | null;
  updatedAt: string | null;
}

/** One gating code out of a check report, flattened out of the report's sections. */
export interface RunCheckFinding {
  code: string;
  severity: "error" | "warning" | "info";
  /** Project-relative source file the finding is anchored to. */
  file: string;
  line?: number;
  message: string;
}

/**
 * What `run_check` answers with.
 *
 * `ran: false` is a first-class outcome, not an error to swallow: a check that
 * hit its deadline or could not start has to say so, because "no findings" and
 * "never looked" are the two results a report must never confuse.
 */
export type RunCheckResult =
  | { ran: true; findings: RunCheckFinding[] }
  | { ran: false; error: string; stderr_tail: string };

/**
 * What a picture-making tool answers with: a link, never bytes (D21).
 *
 * `width` and `height` are the composition's frame size — the size of a
 * screenshot, and the size of each cell's source frame in a contact sheet.
 * `pages` and `cellSeconds` are present for a contact sheet, where the interval
 * is derived from the composition's duration and belongs in the answer.
 */
export type ReceiptResult =
  | {
      ran: true;
      url: string;
      revision: string;
      width: number;
      height: number;
      pages?: number;
      /** Every page's URL when there is more than one, in order. */
      pageUrls?: string[];
      cellSeconds?: number;
    }
  | { ran: false; error: string };

/**
 * Adapter interface — injected by each consumer to handle host-specific behavior.
 * The shared API module calls these methods; each host (vite dev, CLI embedded)
 * provides its own implementation.
 */
export interface StudioApiAdapter {
  /**
   * Whether the hosting server is bound exclusively to loopback. Agent routes
   * remain request-host checked as well; adapters must set this to false for
   * hosted or LAN-bound instances.
   */
  agentBridgeEnabled?: boolean;

  /** List all available projects. */
  listProjects(): Promise<ResolvedProject[]> | ResolvedProject[];

  /** Resolve a project ID (or session ID) to its directory. Returns null if not found. */
  resolveProject(id: string): Promise<ResolvedProject | null> | ResolvedProject | null;

  /** Bundle a project directory into a single HTML string. Returns null if unavailable. */
  bundle(projectDir: string): Promise<string | null>;

  /** Optional: cached signature for project files that should invalidate preview frame caches. */
  getProjectSignature?: (projectDir: string) => string;

  /** Lint a single HTML string. */
  lint(html: string, opts?: { filePath?: string }): Promise<LintResult> | LintResult;

  /**
   * Lint the complete project, including relationships between files. Official
   * adapters provide this; the single-file method remains as a compatibility
   * fallback for third-party adapters compiled against older releases.
   */
  lintProject?: (projectDir: string) => Promise<ProjectLintResult> | ProjectLintResult;

  /** URL to the hyperframe runtime JS (injected into preview HTML). */
  runtimeUrl: string;

  /**
   * Optional: post-process preview HTML before Studio augments it.
   * Useful when preview must mirror render-time compilation steps.
   */
  transformPreviewHtml?: (opts: {
    html: string;
    project: ResolvedProject;
    activeCompositionPath: string;
  }) => Promise<string> | string;

  /** Directory where render output files are stored. */
  rendersDir(project: ResolvedProject): string;

  /**
   * Start a render job. The adapter owns the async execution and must
   * update the returned RenderJobState object reactively.
   */
  startRender(opts: {
    project: ResolvedProject;
    outputPath: string;
    format: "mp4" | "webm" | "mov";
    /**
     * Frame rate as an exact rational. The HTTP layer (POST
     * `/projects/:id/render`) accepts either a JSON number (integer fps,
     * `30`) or a JSON string (ffmpeg-style rational, `"30000/1001"`); the
     * route normalizes both into `Fps` before invoking the adapter, so
     * adapter implementations only ever see the rational form.
     */
    fps: import("@hyperframes/core").Fps;
    quality: string;
    jobId: string;
    /**
     * The triggering browser profile has telemetry disabled (localStorage
     * opt-out, DNT, dev build...). The CLI cannot observe any of that, so the
     * browser has to say so — without it the server emitted render outcomes
     * for a user who had opted out, under the CLI's own policy.
     */
    telemetryOptOut?: boolean;
    /**
     * Optional output resolution preset. See `resolveDeviceScaleFactor` in
     * the producer for the integer-scale + aspect + HDR constraints.
     */
    outputResolution?: CanvasResolution;
    /** Entry file relative to projectDir (e.g. "compositions/intro.html"). Defaults to index.html. */
    composition?: string;
    /**
     * Composition-variable overrides ({variableId: value}), forwarded to the
     * producer's RenderConfig.variables and injected as window.__hfVariables —
     * the same channel `hyperframes render --variables` uses.
     */
    variables?: Record<string, unknown>;
    /**
     * Telemetry id of the browser user who triggered the render. Lets the
     * adapter attribute the server-emitted render_complete/render_error to
     * that user so the studio render funnel is joinable. Undefined for older
     * clients → falls back to the install's anonymous id.
     */
    distinctId?: string;
  }): RenderJobState;

  startBackgroundRemoval?: (opts: {
    project: ResolvedProject;
    inputPath: string;
    inputAssetPath: string;
    outputPath: string;
    outputAssetPath: string;
    backgroundOutputPath?: string;
    backgroundOutputAssetPath?: string;
    quality: "fast" | "balanced" | "best";
    device?: "auto" | "cpu" | "coreml" | "cuda";
    jobId: string;
  }) => MediaProcessingJobState;

  /** Optional: generate a thumbnail at the route's explicit output dimensions. */
  generateThumbnail?: (opts: {
    project: ResolvedProject;
    compPath: string;
    seekTime: number;
    width: number;
    height: number;
    outputWidth: number;
    outputHeight: number;
    previewUrl: string;
    selector?: string;
    format?: "jpeg" | "png";
    selectorIndex?: number;
    signal: AbortSignal;
  }) => Promise<Buffer | null>;

  /**
   * Optional: measure what a composition actually lays out as (TAB-805).
   *
   * The agent needs this because lint cannot see layout. `projectDir` is
   * deliberately a bare directory rather than a `ResolvedProject`: the agent
   * measures its **staged** copy, which is not a registered project, and
   * measuring the live one instead would report on files the agent has not
   * written yet.
   *
   * An adapter without a browser must resolve to a measurement carrying
   * `unavailable` — never an empty element list that reads as "nothing wrong".
   */
  measureLayout?: (opts: {
    projectDir: string;
    /** Entry file relative to projectDir. Defaults to index.html. */
    composition?: string;
    selectors: string[];
    /** Timeline position in seconds to seek to before measuring. */
    seekTime?: number;
    signal?: AbortSignal;
  }) => Promise<LayoutMeasurement>;

  /**
   * Optional: run the real render gate over a staged project (TAB-1093).
   *
   * Lint proves the HTML parses and `measureLayout` reads one moment's boxes;
   * neither is the gate a render has to pass. This runs the same check pipeline
   * the CLI's `hyperframes check` runs, in process, and hands back the codes it
   * would have gated on.
   *
   * An adapter that cannot run it resolves `{ ran: false }` with the reason —
   * never an empty finding list, which reads as "nothing wrong".
   */
  runCheck?: (opts: { projectDir: string; signal?: AbortSignal }) => Promise<RunCheckResult>;

  /**
   * Optional: one PNG of the staged composition at `t` seconds (TAB-1093).
   *
   * The image is written to the receipts store and comes back as a URL. The
   * caller never gets bytes: the agent cannot see an image, and the person it
   * is talking to opens the link.
   */
  frameScreenshot?: (opts: {
    projectDir: string;
    /** Timeline position in seconds. */
    t: number;
    signal?: AbortSignal;
  }) => Promise<ReceiptResult>;

  /** Optional: four contact-sheet pages spanning the whole staged composition. */
  contactSheet?: (opts: { projectDir: string; signal?: AbortSignal }) => Promise<ReceiptResult>;

  /** Optional: resolve session ID to project (multi-project mode). */
  resolveSession?: (sessionId: string) => Promise<{ projectId: string; title: string } | null>;

  /** Optional: list all registry items (blocks + components) for the catalog. */
  listRegistryCatalog?(): Promise<RegistryItem[]>;

  /** Optional: install a registry item into a project directory. */
  installRegistryBlock?(opts: {
    project: ResolvedProject;
    blockName: string;
  }): Promise<{ written: string[]; block: RegistryItem }>;
}
