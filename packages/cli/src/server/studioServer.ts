/**
 * Embedded studio server for `hyperframes preview` outside the monorepo.
 *
 * Uses the shared studio API module from @hyperframes/core/studio-api,
 * providing a CLI-specific adapter for single-project, in-process rendering.
 */

import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join, basename, isAbsolute, relative } from "node:path";
import { readBundleFile } from "./readBundleFile.js";
import {
  createProjectWatcher,
  shouldWatchProjectFile,
  type ProjectWatcher,
} from "./fileWatcher.js";
import {
  hashSignatureParts,
  loadRuntimeSource,
  loadRuntimeSourceSignature,
} from "./runtimeSource.js";
import { VERSION as version } from "../version.js";
import {
  buildStudioHeadScriptsForHost,
  identityAllowed,
  refreshTelemetryPosture,
  resolveCliTelemetryDistinctId,
} from "./telemetryIdentity.js";
import { emitStudioRenderComplete, emitStudioRenderError } from "./studioRenderTelemetry.js";
import { isDevMode } from "../utils/env.js";
import {
  agentStateRoot,
  createStudioManualEditsRenderBodyScript,
  createStudioApi,
  createProjectSignature,
  createBackgroundRemovalJob,
  identifyFileWrite,
  fileContentVersion,
  getMimeType,
  affectsProjectSignature,
  type PreviewApiAdapter,
  thumbnailDeviceScaleFactor,
  type ResolvedProject,
  type RenderJobState,
  type BackgroundRemovalRender,
  type LayoutMeasurement,
  type ReceiptResult,
  type RunCheckFinding,
  type RunCheckResult,
  measureInPage,
  classifyLayoutProbe,
  unavailableMeasurement,
} from "@hyperframes/studio-server";
import { resolveAutoProxy } from "../utils/projectConfig.js";
import { resolveProject, type ProjectDir } from "../utils/project.js";
import type { CheckOptions, CheckReport } from "../utils/checkTypes.js";
import {
  ReceiptStore,
  RECEIPTS_URL_PREFIX,
  parseReceiptPath,
  receiptSessionId,
  type ReceiptWriter,
} from "./studioReceipts.js";
import { getElementScreenshotClip } from "@hyperframes/studio-server/screenshot-clip";
import type { ScreenshotClip } from "@hyperframes/studio-server/screenshot-clip";
import type { RenderJob } from "@hyperframes/producer";
import { seekCompositionTimeline } from "../capture/captureCompositionFrame.js";
import type { StaticProjectServer } from "../utils/staticProjectServer.js";
import {
  assertWebGpuAdapterAvailable,
  compositionRequiresWebGpu,
  resolveCaptureBrowserGpuMode,
  resolveLocalBrowserGpuMode,
  type BrowserGpuMode,
  type ResolvedBrowserGpuMode,
} from "../browser/gpuPolicy.js";

const STUDIO_MANUAL_EDITS_PATH = ".hyperframes/studio-manual-edits.json";

// Vite emits only content-hashed files under dist/assets; hand-authored
// public/ files land at the dist root. The route is the signal because the
// filename is not: rollup's base64url hash may itself contain a hyphen.
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

const REMOTE_GIF_IMG_SRC_RE =
  /<img\b[^>]*?\bsrc\s*=\s*["'](https?:\/\/[^"']+\.gif(?:[?#][^"']*)?)["'][^>]*>/gi;

async function loadStudioProducer() {
  if (!isDevMode()) return await import("@hyperframes/producer");
  // The producer's SOURCE uses the TS convention of `.js` specifiers naming
  // `.ts` files, which bun resolves and Node does not. Node 22 strips TS types
  // natively, so a Node-hosted dev server boots fine and only dies here, as
  // `Cannot find module .../renderOrchestrator.js` with no other context.
  // Vite's own shebang is `#!/usr/bin/env node` and it hosts this API
  // in-process, so `vite` without `bun --bun` lands exactly here.
  if (!process.versions.bun) {
    throw new Error(
      "Studio dev-mode rendering requires bun (the producer is loaded from TypeScript source, " +
        "which Node cannot resolve). Restart the studio with `bun run studio`.",
    );
  }
  return await import("../../../producer/src/index.js");
}

// ── Path resolution ─────────────────────────────────────────────────────────

function resolveDistDir(): string {
  return resolveStudioBundle().dir;
}

export interface StudioBundleResolution {
  dir: string;
  indexPath: string;
  available: boolean;
  checkedPaths: string[];
}

export function resolveStudioBundle(): StudioBundleResolution {
  const builtPath = resolve(__dirname, "studio");
  const builtIndex = resolve(builtPath, "index.html");
  if (existsSync(builtIndex)) {
    return { dir: builtPath, indexPath: builtIndex, available: true, checkedPaths: [builtIndex] };
  }
  const devPath = resolve(__dirname, "..", "..", "..", "studio", "dist");
  const devIndex = resolve(devPath, "index.html");
  if (existsSync(devIndex)) {
    return {
      dir: devPath,
      indexPath: devIndex,
      available: true,
      checkedPaths: [builtIndex, devIndex],
    };
  }
  return {
    dir: builtPath,
    indexPath: builtIndex,
    available: false,
    checkedPaths: [builtIndex, devIndex],
  };
}

function resolveRuntimePath(): string {
  const builtPath = resolve(__dirname, "hyperframe-runtime.js");
  if (existsSync(builtPath)) return builtPath;
  const iifePath = resolve(__dirname, "hyperframe.runtime.iife.js");
  if (existsSync(iifePath)) return iifePath;
  const devPath = resolve(
    __dirname,
    "..",
    "..",
    "..",
    "core",
    "dist",
    "hyperframe.runtime.iife.js",
  );
  if (existsSync(devPath)) return devPath;
  return builtPath;
}

function readStudioManualEditManifestContent(projectDir: string): string {
  const manifestPath = join(projectDir, STUDIO_MANUAL_EDITS_PATH);
  if (!existsSync(manifestPath)) return "";
  try {
    return readFileSync(manifestPath, "utf-8");
  } catch {
    return "";
  }
}

async function applyStudioManualEditsToThumbnailPage(
  page: import("puppeteer-core").Page,
  manifestContent: string,
  activeCompositionPath: string,
): Promise<void> {
  const script = createStudioManualEditsRenderBodyScript(manifestContent, {
    activeCompositionPath,
  });
  if (!script) return;
  await page.addScriptTag({ content: script });
}

async function reapplyStudioManualEditsToThumbnailPage(
  page: import("puppeteer-core").Page,
): Promise<void> {
  await page.evaluate(() => {
    const apply = (window as Window & { __hfStudioManualEditsApply?: () => number })
      .__hfStudioManualEditsApply;
    if (typeof apply === "function") apply();
  });
}

function collectRemoteGifImageSources(html: string): string[] {
  const urls = new Set<string>();
  const re = new RegExp(REMOTE_GIF_IMG_SRC_RE.source, REMOTE_GIF_IMG_SRC_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    if (match[1]) urls.add(match[1]);
  }
  return [...urls];
}

async function downloadRemoteGifImageSources(
  html: string,
  downloadDir: string,
  downloadToTemp: (url: string, destDir: string) => Promise<string>,
): Promise<Map<string, string>> {
  const sourceAssets = new Map<string, string>();
  await Promise.all(
    collectRemoteGifImageSources(html).map(async (url) => {
      try {
        sourceAssets.set(url, await downloadToTemp(url, downloadDir));
      } catch (err) {
        console.warn(
          "[Studio] Remote animated GIF prep skipped:",
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );
  return sourceAssets;
}

// ── Shared thumbnail browser (pool-backed) ──────────────────────────────────
// Uses the engine's browser pool so the thumbnail browser and render workers
// share a single Chrome process instead of running two independent ones.

let _thumbnailBrowserLease: import("@hyperframes/engine").BrowserLease | null = null;
let _thumbnailBrowserInitializing: Promise<ThumbnailBrowserSession | null> | null = null;
let _thumbnailBrowserModes: {
  requested: BrowserGpuMode;
  resolved: ResolvedBrowserGpuMode;
} | null = null;

interface ThumbnailBrowserSession {
  browser: import("puppeteer-core").Browser;
  requestedGpuMode: BrowserGpuMode;
  resolvedGpuMode: ResolvedBrowserGpuMode;
}

/** How long one layout measurement may take before it gives up and says so. */
const MEASURE_TIMEOUT_MS = Number(process.env.HYPERFRAMES_MEASURE_TIMEOUT_MS) || 45_000;

/**
 * Resolve to whichever comes first: the work, or an honest timeout.
 *
 * The losing promise is left to settle on its own — the caller's `finally`
 * still closes the page and the server, so nothing is leaked by not awaiting it.
 *
 * The deadline **resolves** with `onExpiry()`, it does not reject, so every
 * caller gets a value describing what happened rather than an exception a
 * `catch` has to re-describe. TAB-1093 generalised it from the one measurement
 * shape it started as; `onExpiry` is a closure rather than a value so nothing
 * builds an expiry result the fast path then throws away.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, onExpiry: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((resolveExpired) => {
    timer = setTimeout(() => resolveExpired(onExpiry()), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** How long one `run_check` may take before it gives up and says so. */
export const CHECK_TIMEOUT_MS = 120_000;

/** How long one screenshot or contact sheet may take before it gives up. */
const SNAPSHOT_TIMEOUT_MS = 60_000;

/**
 * What `run_check` bounds the pipeline with.
 *
 * Spelled out rather than spread over `DEFAULT_CHECK_OPTIONS`, because the
 * agent's budget is not the CLI's: `atTransitions` samples the seams where
 * transient overlaps live, the cap keeps a long film from sampling itself to
 * death, and `snapshots: false` keeps the pipeline from writing PNGs into the
 * staging dir that the run is about to delete.
 *
 * `timeout` is the pipeline's own render-ready and navigation ceiling
 * (`check.ts` describes it, 10s floor), and it sits a clear 10s below
 * `CHECK_TIMEOUT_MS` on purpose: `runCheckPipeline` owns the browser it
 * launches, so the deadline must never be the first thing to fire while a
 * Chrome is still waiting on a page.
 */
export const CHECK_OPTIONS: CheckOptions = {
  samples: 9,
  atTransitions: true,
  maxTransitionSamples: 24,
  maxIssues: 80,
  collapseStatic: true,
  tolerance: 2,
  timeout: CHECK_TIMEOUT_MS - 10_000,
  contrast: true,
  strict: false,
  snapshots: false,
};

/** The pipeline seam. The default runs the real thing; tests inject a report. */
type CheckRunner = (
  project: ProjectDir,
  options: CheckOptions,
  signal?: AbortSignal,
) => Promise<CheckReport>;

const runRealCheckPipeline: CheckRunner = async (project, options, signal) => {
  const { runCheckPipeline } = await import("../utils/checkPipeline.js");
  if (signal?.aborted) throw new Error("cancelled before the check started");
  return runCheckPipeline(project, options);
};

/** Every section's findings, in the order a reader would read the report. */
function flattenCheckFindings(report: CheckReport): RunCheckFinding[] {
  const sections = [report.lint, report.runtime, report.layout, report.motion, report.contrast];
  return sections.flatMap((section) =>
    section.findings.map((finding) => {
      // A layout or motion finding is an `AnchoredLayoutIssue`, which carries no
      // line number at all — the browser found it, not the parser. Ask before
      // reading rather than declaring a line the section cannot have.
      const line = "line" in finding ? finding.line : undefined;
      return {
        code: finding.code,
        severity: finding.severity,
        file: finding.sourceFile,
        ...(line === undefined ? {} : { line }),
        message: finding.message,
      };
    }),
  );
}

const STDERR_TAIL_BYTES = 2_048;

/**
 * Keep the last 2 KB the pipeline wrote to stderr, so a failure can say what it
 * printed on the way down instead of only naming its exception.
 *
 * The patch is scoped to one call and passes every write through to the real
 * stream, so nothing is swallowed and nothing survives the `finally`.
 */
async function withStderrTail<T>(work: (tail: () => string) => Promise<T>): Promise<T> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  const tail = () => captured.slice(-STDERR_TAIL_BYTES);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    captured = (captured + String(chunk)).slice(-STDERR_TAIL_BYTES);
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    return await work(tail);
  } finally {
    process.stderr.write = original;
  }
}

/**
 * Run the check pipeline over one project and answer in the agent's shape.
 *
 * Exported for the tests, which inject `runPipeline` — the browser pass is the
 * one part a unit lane cannot run, and the adapter's own job is the options it
 * bounds the pipeline with and the report it flattens.
 */
export async function runProjectCheck(
  project: ProjectDir,
  opts: { signal?: AbortSignal },
  runPipeline: CheckRunner = runRealCheckPipeline,
): Promise<RunCheckResult> {
  return withStderrTail(async (tail) => {
    try {
      const report = await runPipeline(project, CHECK_OPTIONS, opts.signal);
      return { ran: true, findings: flattenCheckFindings(report) };
    } catch (error) {
      return {
        ran: false,
        error: error instanceof Error ? error.message : String(error),
        stderr_tail: tail(),
      };
    }
  });
}

/** The check's deadline, and the value it resolves with when it fires. */
export async function runCheckUnderDeadline(
  work: Promise<RunCheckResult>,
  ms: number = CHECK_TIMEOUT_MS,
): Promise<RunCheckResult> {
  return withDeadline(work, ms, () => ({
    ran: false as const,
    error: "deadline",
    stderr_tail: "",
  }));
}

// ── Receipts: a picture for the person the agent is talking to ──────────────

/** Cells per contact-sheet page — `createSnapshotContactSheet`'s own `pageSize`. */
export const CONTACT_SHEET_PAGE_CELLS = 9;

/**
 * How many frames one contact sheet captures: four pages of nine.
 *
 * The cap is on pages, not on the interval, and that distinction is the whole
 * point. A fixed half-second cell over four pages covers eighteen seconds and
 * drops the rest of a ninety-second film without saying so, so the interval is
 * derived from the duration instead and four pages always span the whole thing.
 */
export const CONTACT_SHEET_CELLS = CONTACT_SHEET_PAGE_CELLS * 4;

/** The shortest cell worth looking at; below this, neighbouring frames repeat. */
const MIN_CELL_SECONDS = 0.5;

/**
 * How many cells to capture, and the interval between them.
 *
 * `cells - 1`, not `cells`, because `computeSnapshotTimes` spaces n frames from
 * 0 to the end, so n frames leave n-1 gaps. Reporting `duration / cells` would
 * understate the interval it tells the founder by one cell's worth.
 *
 * The half-second floor shortens the sheet rather than the truth: a three-second
 * film gets seven cells half a second apart, not thirty-six cells eighty
 * milliseconds apart with "0.5s" printed beside them.
 */
function planContactSheetCells(duration: number): { cells: number; cellSeconds: number } {
  if (!(duration > 0)) return { cells: 1, cellSeconds: MIN_CELL_SECONDS };
  const cellsAtFloor = Math.floor(duration / MIN_CELL_SECONDS) + 1;
  const cells = Math.max(2, Math.min(CONTACT_SHEET_CELLS, cellsAtFloor));
  return { cells, cellSeconds: duration / (cells - 1) };
}

/** The capture seam. The default runs the real CLI functions, in process. */
interface SnapshotCapture {
  capture: (
    projectDir: string,
    opts: { at?: number[]; frames?: number; outputDir: string; includeEnd?: boolean },
  ) => Promise<string[]>;
  sheet: (snapshotsDir: string, outputPath: string) => Promise<string[]>;
}

const REAL_SNAPSHOT_CAPTURE: SnapshotCapture = {
  async capture(projectDir, opts) {
    const { captureSnapshots } = await import("../commands/snapshot.js");
    return captureSnapshots(projectDir, opts);
  },
  async sheet(snapshotsDir, outputPath) {
    const { createSnapshotContactSheet } = await import("../capture/contactSheet.js");
    return createSnapshotContactSheet(snapshotsDir, outputPath);
  },
};

const PATH_REFUSED: ReceiptResult = { ran: false, error: "path outside project" };

/**
 * The composition's frame, read off the file rather than out of a browser.
 *
 * `data-width`, `data-height` and the timed children's extents are what the
 * runtime itself lays the stage out from, so a screenshot of this project comes
 * back at exactly this size — no launch needed to say so.
 */
async function readCompositionFrame(
  projectDir: string,
): Promise<{ width: number; height: number; duration: number } | null> {
  const indexPath = join(projectDir, "index.html");
  if (!existsSync(indexPath)) return null;
  const { ensureDOMParser } = await import("../utils/dom.js");
  const { parseCompositions } = await import("../commands/compositions.js");
  ensureDOMParser();
  const [host] = parseCompositions(readFileSync(indexPath, "utf-8"), projectDir);
  if (!host) return null;
  return { width: host.width, height: host.height, duration: host.duration };
}

/**
 * Rule one of two: a project input has to be a staging copy the agent asked
 * about. The staging root is where those live, and a path anywhere else is a
 * request to point a browser at some other part of this disk.
 *
 * Checked before the project is read, so an escape is refused as an escape
 * rather than as "no composition there" — the second message would tell a caller
 * which paths exist.
 */
function isStagedProject(projectDir: string): boolean {
  const rel = relative(resolve(agentStateRoot()), resolve(projectDir));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** One PNG of the staged composition at `t` seconds, stored and linked. */
export async function captureFrameReceipt(
  opts: { projectDir: string; t: number; signal?: AbortSignal },
  store: ReceiptWriter,
  capture: SnapshotCapture = REAL_SNAPSHOT_CAPTURE,
): Promise<ReceiptResult> {
  if (!isStagedProject(opts.projectDir)) return PATH_REFUSED;
  const frame = await readCompositionFrame(opts.projectDir);
  if (!frame) return { ran: false, error: "no composition to screenshot" };
  const session = receiptSessionId(opts.projectDir);
  const revision = createProjectSignature(opts.projectDir);
  // Rule two of two: the output has to be inside the receipts store, which D44
  // deliberately puts *outside* staging — so one "must start with the staging
  // dir" rule would refuse the very write this is for.
  const outputDir = store.captureDir(session, revision);
  if (!store.contains(outputDir)) return PATH_REFUSED;

  return withDeadline(
    (async (): Promise<ReceiptResult> => {
      try {
        const time = Math.max(0, opts.t);
        const files = await capture.capture(opts.projectDir, {
          at: [time],
          includeEnd: false,
          outputDir,
        });
        const first = files[0];
        if (!first) return { ran: false, error: "no frame was captured" };
        const stored = store.put(session, revision, basename(first), readFileSync(first));
        return {
          ran: true,
          url: stored.url,
          revision,
          width: frame.width,
          height: frame.height,
        };
      } catch (error) {
        return { ran: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        rmSync(outputDir, { recursive: true, force: true });
      }
    })(),
    SNAPSHOT_TIMEOUT_MS,
    () => ({ ran: false, error: "deadline" }),
  );
}

/** Four contact-sheet pages spanning the whole staged composition. */
export async function captureContactSheetReceipt(
  opts: { projectDir: string; signal?: AbortSignal },
  store: ReceiptWriter,
  capture: SnapshotCapture = REAL_SNAPSHOT_CAPTURE,
): Promise<ReceiptResult> {
  if (!isStagedProject(opts.projectDir)) return PATH_REFUSED;
  const frame = await readCompositionFrame(opts.projectDir);
  if (!frame) return { ran: false, error: "no composition to sheet" };
  const session = receiptSessionId(opts.projectDir);
  const revision = createProjectSignature(opts.projectDir);
  const outputDir = store.captureDir(session, revision);
  if (!store.contains(outputDir)) return PATH_REFUSED;

  return withDeadline(
    (async (): Promise<ReceiptResult> => {
      try {
        const { cells, cellSeconds } = planContactSheetCells(frame.duration);
        const { computeSnapshotTimes } = await import("../commands/snapshot.js");
        const { times } = computeSnapshotTimes(frame.duration, { frames: cells });
        const snapshots = await capture.capture(opts.projectDir, {
          at: times,
          includeEnd: false,
          outputDir,
        });
        if (snapshots.length !== times.length) {
          return { ran: false, error: "snapshot count does not match requested timestamps" };
        }
        const pages = await capture.sheet(outputDir, join(outputDir, "contact-sheet.jpg"));
        if (pages.length === 0) return { ran: false, error: "no contact sheet was produced" };
        if (pages.length !== Math.ceil(times.length / CONTACT_SHEET_PAGE_CELLS)) {
          return { ran: false, error: "contact sheet page count does not match captured frames" };
        }
        const urls = pages.map(
          (page) => store.put(session, revision, basename(page), readFileSync(page)).url,
        );
        return {
          ran: true,
          url: urls[0] as string,
          revision,
          width: frame.width,
          height: frame.height,
          pages: urls.length,
          pageUrls: urls,
          cellSeconds,
          durationSeconds: frame.duration,
          framesPerPage: CONTACT_SHEET_PAGE_CELLS,
          frameCount: times.length,
          pageFrameTimes: pages.map((_, index) =>
            times.slice(index * CONTACT_SHEET_PAGE_CELLS, (index + 1) * CONTACT_SHEET_PAGE_CELLS),
          ),
        };
      } catch (error) {
        return { ran: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        rmSync(outputDir, { recursive: true, force: true });
      }
    })(),
    SNAPSHOT_TIMEOUT_MS,
    () => ({ ran: false, error: "deadline" }),
  );
}

/**
 * Let the page's own font-dependent layout work finish before reading it
 * (TAB-1064).
 *
 * A compiled Tabario project shrinks each overflowing caption to one line in a
 * `document.fonts.ready.then(...)` callback. `waitForCompositionFonts` returns
 * as soon as the font status is not "loading", which can be before that
 * promise has settled and before its callbacks have run. Measured on a live
 * project: Caption 0 read 52px on two lines at that moment and 23.22px on one
 * line a few frames later, which is what the user sees. Awaiting the same
 * promise from here runs after every callback the page chained on it, and the
 * frame after that lets the resulting style land in layout. Bounded, so a page
 * whose fonts never settle still gets measured.
 */
async function settleFontDependentLayout(page: import("puppeteer-core").Page): Promise<void> {
  await page
    .evaluate(
      () =>
        new Promise<void>((resolve) => {
          const deadline = setTimeout(resolve, 1_500);
          const ready = document.fonts?.ready ?? Promise.resolve();
          Promise.resolve(ready).then(() =>
            requestAnimationFrame(() => {
              clearTimeout(deadline);
              resolve();
            }),
          );
        }),
    )
    .catch(() => {});
}

/**
 * One measurement: bundle, serve, seek, read. Owns its page and its server and
 * always releases both, whether it succeeded, failed, or lost the race to
 * `withDeadline`.
 *
 * The runtime is live here, so a clip that is off screen at `seekTime` really
 * has no layout — that comes back as unmeasurable with the reason, never as a
 * zero-size box that reads like a clean result.
 */
async function runLayoutMeasurement(
  browser: import("puppeteer-core").Browser,
  entry: string,
  composition: string,
  seekTime: number,
  opts: { projectDir: string; selectors: string[]; signal?: AbortSignal },
): Promise<LayoutMeasurement> {
  let page: import("puppeteer-core").Page | null = null;
  let server: StaticProjectServer | null = null;
  const closePage = () => void page?.close().catch(() => {});
  opts.signal?.addEventListener("abort", closePage, { once: true });
  try {
    const { bundleToSingleHtml } = await import("@hyperframes/core/compiler");
    const { serveStaticProjectHtml } = await import("../utils/staticProjectServer.js");
    const html = await bundleToSingleHtml(opts.projectDir, { entryFile: composition });
    server = await serveStaticProjectHtml(
      opts.projectDir,
      html,
      "Failed to bind the layout measurement server",
      [],
      // Proxy transcoding off, explicitly. A layout measurement wants geometry,
      // not a playable codec, and leaving the project's `autoProxy` on made the
      // browser request `?hf-proxy=` variants that spawn ffmpeg and write into
      // the very staging directory the run deletes on its way out.
      false,
    );

    // The frame is what every percentage position resolves against, so a wrong
    // viewport silently changes every measurement taken in it.
    const source = readFileSync(entry, "utf-8");
    const width = Number(/data-width="(\d+)"/.exec(source)?.[1]) || 1920;
    const height = Number(/data-height="(\d+)"/.exec(source)?.[1]) || 1080;

    page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(server.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page
      .waitForFunction(
        () => {
          const w = window as Window & { __timelines?: Record<string, unknown> };
          return !!(w.__timelines && Object.keys(w.__timelines).length > 0);
        },
        { timeout: 5_000 },
      )
      .catch(() => {
        // A composition with no timeline still lays out. Measure it anyway.
      });
    await seekCompositionTimeline(page, seekTime, {
      fallbackToBridgeAndTimelines: true,
      waitForPreferredSeekTargetMs: 500,
      animationFrameSettle: "double",
      waitForFontsMs: 500,
    });
    await settleFontDependentLayout(page);
    const raw = await page.evaluate(measureInPage, opts.selectors);
    return classifyLayoutProbe(raw, seekTime);
  } catch (err) {
    return unavailableMeasurement(
      `the measurement failed: ${err instanceof Error ? err.message : String(err)}`,
      seekTime,
    );
  } finally {
    opts.signal?.removeEventListener("abort", closePage);
    await page?.close().catch(() => {});
    await server?.close().catch(() => {});
  }
}

async function getThumbnailBrowser(
  requestedGpuMode: BrowserGpuMode,
): Promise<ThumbnailBrowserSession | null> {
  if (
    _thumbnailBrowserLease?.browser.connected &&
    _thumbnailBrowserModes?.requested === requestedGpuMode
  ) {
    return {
      browser: _thumbnailBrowserLease.browser,
      requestedGpuMode: _thumbnailBrowserModes.requested,
      resolvedGpuMode: _thumbnailBrowserModes.resolved,
    };
  }
  if (_thumbnailBrowserInitializing) {
    const session = await _thumbnailBrowserInitializing;
    if (session?.requestedGpuMode === requestedGpuMode) return session;
  }
  if (_thumbnailBrowserLease) await closeThumbnailBrowser();

  _thumbnailBrowserInitializing = (async () => {
    try {
      const { ensureBrowser } = await import("../browser/manager.js");
      const { acquireBrowser, buildChromeArgs } = await import("@hyperframes/engine");
      let executablePath: string | undefined;

      try {
        const b = await ensureBrowser({ preferManagedChrome: true });
        executablePath = b.executablePath;
        if (b.executablePath && !process.env.PRODUCER_HEADLESS_SHELL_PATH) {
          process.env.PRODUCER_HEADLESS_SHELL_PATH = b.executablePath;
        }
      } catch {
        /* continue — acquireBrowser will try its own resolution */
      }

      const resolvedGpuMode = await resolveCaptureBrowserGpuMode(requestedGpuMode, executablePath);
      const acquired = await acquireBrowser(
        buildChromeArgs(
          { width: 1920, height: 1080, captureMode: "screenshot" },
          { browserGpuMode: resolvedGpuMode },
        ),
        { forceScreenshot: true },
      );
      _thumbnailBrowserLease = acquired;
      _thumbnailBrowserModes = { requested: requestedGpuMode, resolved: resolvedGpuMode };
      acquired.browser.on("disconnected", () => {
        if (_thumbnailBrowserLease !== acquired) return;
        _thumbnailBrowserLease = null;
        _thumbnailBrowserModes = null;
        _thumbnailBrowserInitializing = null;
      });
      return { browser: acquired.browser, requestedGpuMode, resolvedGpuMode };
    } catch (err) {
      console.warn(
        "[Studio] Failed to launch thumbnail browser:",
        err instanceof Error ? err.message : err,
      );
      _thumbnailBrowserInitializing = null;
      return null;
    }
  })();

  return _thumbnailBrowserInitializing;
}

export async function closeThumbnailBrowser(): Promise<void> {
  if (!_thumbnailBrowserLease) return;
  const lease = _thumbnailBrowserLease;
  _thumbnailBrowserLease = null;
  _thumbnailBrowserModes = null;
  _thumbnailBrowserInitializing = null;
  await lease.release().catch(() => {});
}

// ── Server factory ──────────────────────────────────────────────────────────

export interface StudioServerOptions {
  projectDir: string;
  /** Display name for the project. Defaults to basename of projectDir. */
  projectName?: string;
  /**
   * Auto-transcode browser-hostile video codecs to a cached H.264 preview
   * proxy. The preview command passes its resolved `--proxy`/`--no-proxy` +
   * `hyperframes.json` value; when omitted, the project's `media.autoProxy`
   * config (default true) applies.
   */
  autoProxy?: boolean | undefined;
  /** GPU policy used by Studio thumbnails and frame capture. */
  browserGpuMode?: BrowserGpuMode;
}

export interface StudioServer {
  app: Hono;
  watcher: ProjectWatcher;
  /** Exposed for tests: the adapter handed to the shared studio API (carries
   * the resolved `autoProxy` flag the preview routes read). */
  adapter: PreviewApiAdapter;
}

export async function loadPreviewServerBuildSignature(): Promise<string> {
  const runtimeSignature = await loadRuntimeSourceSignature();
  const studioBundle = resolveStudioBundle();
  const studioIndex = studioBundle.available
    ? (readBundleFile(studioBundle.indexPath)?.toString("utf-8") ?? "")
    : "";
  return hashSignatureParts([
    version,
    runtimeSignature,
    studioIndex,
    createStudioServer.toString(),
    createStudioApi.toString(),
    createProjectSignature.toString(),
    getMimeType.toString(),
    getElementScreenshotClip.toString(),
  ]);
}

// Rewrite the viewport meta + inline width/height in every written .html to the
// host composition's dimensions, so an installed fragment matches the host
// canvas. Applies to ALL written files — including any .html a dependency ships,
// not just the requested block's — which is intentional. No-op when the host
// index.html is absent or carries no dimensions.
function rewriteWrittenToHostViewport(projectDir: string, written: string[]): void {
  const indexPath = join(projectDir, "index.html");
  if (!existsSync(indexPath)) return;
  const indexHtml = readFileSync(indexPath, "utf-8");
  const hostW = indexHtml.match(/data-width="(\d+)"/)?.[1];
  const hostH = indexHtml.match(/data-height="(\d+)"/)?.[1];
  if (!hostW || !hostH) return;

  for (const absPath of written) {
    if (!absPath.endsWith(".html")) continue;
    let content = readFileSync(absPath, "utf-8");
    content = content.replace(
      /(<meta\s+name="viewport"\s+content="width=)\d+(,\s*height=)\d+/i,
      `$1${hostW}$2${hostH}`,
    );
    content = content.replace(
      /(\bwidth:\s*)\d+(px;\s*\n?\s*height:\s*)\d+(px;)/g,
      (match, pre, mid, post) => {
        if (match.includes("1920") || match.includes("1080")) {
          return `${pre}${hostW}${mid}${hostH}${post}`;
        }
        return match;
      },
    );
    writeFileSync(absPath, content, "utf-8");
  }
}

export function createStudioServer(options: StudioServerOptions): StudioServer {
  const { projectDir, projectName } = options;
  const projectId = projectName || basename(projectDir);
  const browserGpuMode = options.browserGpuMode ?? resolveLocalBrowserGpuMode();
  const studioDir = resolveDistDir();
  const runtimePath = resolveRuntimePath();
  const watcher = createProjectWatcher(projectDir);

  // ── CLI adapter for the shared studio API ──────────────────────────────

  const project: ResolvedProject = { id: projectId, dir: projectDir, title: projectId };
  // Receipts outlive the run that made them, so something has to end them:
  // sweeping once per server start keeps a week of pictures rather than a disk
  // full of them (T-08-04), and costs one directory walk.
  // The owner is the published project, never the temporary agent staging dir.
  // Persist it outside staging so the compositor can authorize a receipt before
  // forwarding, and another project's loopback server also refuses the bytes.
  const receiptStore = new ReceiptStore(undefined, projectDir);
  try {
    receiptStore.sweep();
  } catch (error) {
    console.warn(
      "[Studio] could not sweep old receipts:",
      error instanceof Error ? error.message : error,
    );
  }
  let cachedProjectSignature: string | null = null;
  watcher.addListener((changedPath) => {
    if (affectsProjectSignature(projectDir, join(projectDir, changedPath))) {
      cachedProjectSignature = null;
    }
  });

  const adapter: PreviewApiAdapter = {
    agentBridgeEnabled: ["localhost", "127.0.0.1", "::1"].includes(
      process.env.HYPERFRAMES_PREVIEW_HOST?.trim().toLowerCase() || "127.0.0.1",
    ),

    // Explicit option wins (preview's resolved --proxy/--no-proxy + config);
    // otherwise honor the project's hyperframes.json media.autoProxy so every
    // createStudioServer caller (e.g. the background preview child) gets the
    // configured behavior without its own plumbing.
    autoProxy: options.autoProxy ?? resolveAutoProxy(projectDir, undefined),

    listProjects: () => [project],

    resolveProject: (id: string) => (id === projectId ? project : null),

    async bundle(dir: string): Promise<string | null> {
      try {
        const { bundleToSingleHtml } = await import("@hyperframes/core/compiler");
        // Studio dev server: ask the bundler for an empty `src=""` placeholder so
        // we can point it at our hot-reloadable local runtime endpoint. Inlining
        // ~150 KB of runtime body on every preview render would defeat browser
        // caching across composition edits.
        let html = await bundleToSingleHtml(dir, {
          runtime: "placeholder",
          inlineColorGradingLuts: false,
        });
        html = html.replace(
          'data-hyperframes-preview-runtime="1" src=""',
          'data-hyperframes-preview-runtime="1" src="/api/runtime.js"',
        );
        return html;
      } catch (err) {
        console.error("[studio] Bundle failed:", err);
        return null;
      }
    },

    async transformPreviewHtml({ html, project }) {
      const { injectDeterministicFontFaces } =
        await import("../../../producer/src/services/deterministicFonts.js");
      const { prepareAnimatedGifInputs } =
        await import("../../../producer/src/services/animatedGifPrep.js");
      const { downloadToTemp, writeUrlDownloadTelemetry } =
        await import("../../../producer/src/utils/urlDownloader.js");
      const gifOutputDir = join(project.dir, ".hyperframes", "prepared-assets", "gif");
      const gifDownloadDir = join(project.dir, ".hyperframes", "prepared-assets", "downloads");
      const prepared = await prepareAnimatedGifInputs(html, {
        projectDir: project.dir,
        downloadDir: gifDownloadDir,
        outputDir: gifOutputDir,
        outputSrcPrefix: ".hyperframes/prepared-assets/gif",
        cacheDir: gifOutputDir,
        sourceAssets: await downloadRemoteGifImageSources(html, gifDownloadDir, (url, destDir) =>
          downloadToTemp(url, destDir, undefined, undefined, undefined, {
            onTelemetry: writeUrlDownloadTelemetry,
          }),
        ),
      });
      return injectDeterministicFontFaces(prepared.html);
    },

    getProjectSignature(dir: string): string {
      if (resolve(dir) !== resolve(projectDir)) return createProjectSignature(dir);
      cachedProjectSignature ??= createProjectSignature(projectDir);
      return cachedProjectSignature;
    },

    async lint(html: string, opts?: { filePath?: string; isSubComposition?: boolean }) {
      const { lintHyperframeHtml } = await import("@hyperframes/lint");
      return await lintHyperframeHtml(html, { ...opts, host: "studio" });
    },

    async lintProject(dir: string) {
      const { lintProject } = await import("@hyperframes/lint");
      return await lintProject(dir, undefined, { host: "studio" });
    },

    runtimeUrl: "/api/runtime.js",

    rendersDir: () => join(projectDir, "renders"),

    startRender(opts): RenderJobState {
      // The render POST is a request boundary like any other. Without this an
      // already-open Studio tab keeps rendering under the posture cached when
      // the server booted.
      refreshTelemetryPosture();
      const abortController = new AbortController();
      const state: RenderJobState = {
        id: opts.jobId,
        status: "rendering",
        progress: 0,
        outputPath: opts.outputPath,
        cancel: () => abortController.abort(),
      };

      // Run render asynchronously, mutating the state object
      const startTime = Date.now();
      (async () => {
        let renderJob: RenderJob | undefined;
        const removeCancelledOutput = () => {
          // User-initiated cancel: not a failure. Remove any output so the
          // cancelled job doesn't resurrect in the render history.
          state.status = "cancelled";
          for (const suffix of ["", ".meta.json"]) {
            const fp = suffix
              ? opts.outputPath.replace(/\.(mp4|webm|mov)$/, suffix)
              : opts.outputPath;
            try {
              if (existsSync(fp)) unlinkSync(fp);
            } catch {
              /* ignore */
            }
          }
        };
        try {
          const { createRenderJob, executeRenderJob } = await loadStudioProducer();
          const { ensureBrowser } = await import("../browser/manager.js");

          try {
            const browser = await ensureBrowser({ preferManagedChrome: true });
            if (browser.executablePath && !process.env.PRODUCER_HEADLESS_SHELL_PATH) {
              process.env.PRODUCER_HEADLESS_SHELL_PATH = browser.executablePath;
            }
          } catch {
            // Continue without — acquireBrowser will try its own resolution
          }

          const manifestContent = readStudioManualEditManifestContent(opts.project.dir);
          const manualEditsRenderScript = createStudioManualEditsRenderBodyScript(manifestContent);
          const job = createRenderJob({
            // opts.fps is already an Fps rational — see vite-config-studio
            // adapter for the same convention.
            fps: opts.fps,
            quality: opts.quality as "draft" | "standard" | "high",
            format: opts.format,
            outputResolution: opts.outputResolution,
            ...(manualEditsRenderScript ? { renderBodyScripts: [manualEditsRenderScript] } : {}),
            ...(opts.composition ? { entryFile: opts.composition } : {}),
            ...(opts.variables ? { variables: opts.variables } : {}),
          });
          renderJob = job;
          const onProgress = (j: { progress: number; currentStage?: string }) => {
            state.progress = j.progress;
            if (j.currentStage) state.stage = j.currentStage;
          };
          await executeRenderJob(
            job,
            opts.project.dir,
            opts.outputPath,
            onProgress,
            abortController.signal,
          );
          if (abortController.signal.aborted) {
            // Cancel landed just as the render finished: honor the cancel the
            // route already reported instead of resurrecting a completed job.
            removeCancelledOutput();
            return;
          }
          state.status = "complete";
          state.progress = 100;
          const metaPath = opts.outputPath.replace(/\.(mp4|webm|mov)$/, ".meta.json");
          writeFileSync(
            metaPath,
            JSON.stringify({ status: "complete", durationMs: Date.now() - startTime }),
          );
          // Refreshed HERE, not just at render start: a render can run for
          // minutes, and `hyperframes telemetry disable` during one must be
          // honoured by the event that reports it. Studio never polls
          // /api/telemetry-identity, so this process would otherwise keep its
          // startup-cached posture for the life of the preview server.
          refreshTelemetryPosture();
          emitStudioRenderComplete(opts, Date.now() - startTime, job.perfSummary);
        } catch (err) {
          if (abortController.signal.aborted) {
            removeCancelledOutput();
            return;
          }
          state.status = "failed";
          state.error = err instanceof Error ? err.message : String(err);
          // fallow-ignore-next-line code-duplication
          refreshTelemetryPosture();
          emitStudioRenderError(opts, Date.now() - startTime, state.stage, err, renderJob);
          try {
            const metaPath = opts.outputPath.replace(/\.(mp4|webm|mov)$/, ".meta.json");
            writeFileSync(metaPath, JSON.stringify({ status: "failed" }));
          } catch {
            /* ignore */
          }
        }
      })();

      return state;
    },

    startBackgroundRemoval(opts) {
      return createBackgroundRemovalJob(opts, async (renderOpts) => {
        const sourcePipelinePath = "../background-removal/pipeline.ts";
        const pipeline = (await import("../background-removal/pipeline.js").catch(
          () => import(sourcePipelinePath),
        )) as { render: BackgroundRemovalRender };
        return pipeline.render(renderOpts);
      });
    },

    async generateThumbnail(opts): Promise<Buffer | null> {
      const session = await getThumbnailBrowser(browserGpuMode);
      if (!session) {
        console.warn("[Studio] Thumbnail: no browser available — Chrome may not be installed");
        return null;
      }
      const sourcePath = join(opts.project.dir, opts.compPath);
      // The shared browser launches once, before any composition is known,
      // so it can't gain a WebGPU flag it didn't start with. Checked live
      // below, against this page, after navigation — see assertWebGpuAdapterAvailable.
      const requiresWebGpu = existsSync(sourcePath)
        ? compositionRequiresWebGpu(readFileSync(sourcePath, "utf-8"))
        : false;
      let page: import("puppeteer-core").Page | null = null;
      const closePage = () => void page?.close().catch(() => {});
      opts.signal.addEventListener("abort", closePage, { once: true });
      try {
        page = await session.browser.newPage();
        if (opts.signal.aborted) return null;
        const width = opts.width || 1920;
        const height = opts.height || 1080;
        await page.setViewport({
          width,
          height,
          deviceScaleFactor: thumbnailDeviceScaleFactor(opts),
        });
        await page.goto(opts.previewUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
        await assertWebGpuAdapterAvailable(page, requiresWebGpu);
        await page
          .waitForFunction(
            () => {
              const w = window as Window & {
                __timelines?: Record<string, unknown>;
              };
              return !!(w.__timelines && Object.keys(w.__timelines).length > 0);
            },
            { timeout: 5000 },
          )
          .catch(() => {});
        await seekCompositionTimeline(page, opts.seekTime, {
          fallbackToBridgeAndTimelines: true,
          waitForPreferredSeekTargetMs: 500,
          animationFrameSettle: "double",
          waitForFontsMs: 500,
        });
        const manifestContent = readStudioManualEditManifestContent(opts.project.dir);
        await applyStudioManualEditsToThumbnailPage(page, manifestContent, opts.compPath);
        await page.evaluate(() => {
          void document.fonts?.ready;
          const body = document.body;
          if (body && getComputedStyle(body).backgroundColor === "rgba(0, 0, 0, 0)") {
            body.style.backgroundColor = "#1c2028";
          }
        });
        await new Promise((r) => setTimeout(r, 200));
        await reapplyStudioManualEditsToThumbnailPage(page);
        let clip: ScreenshotClip | undefined;
        if (opts.selector) {
          clip = await page.evaluate(getElementScreenshotClip, opts.selector, opts.selectorIndex);
        }
        const screenshot = (await page.screenshot(
          opts.format === "png"
            ? {
                type: "png",
                ...(clip ? { clip } : {}),
              }
            : {
                type: "jpeg",
                quality: 80,
                ...(clip ? { clip } : {}),
              },
        )) as Buffer;
        return screenshot;
      } catch (err) {
        if (!opts.signal.aborted) {
          console.warn(
            "[Studio] Thumbnail generation failed:",
            err instanceof Error ? err.message : err,
          );
        }
        return null;
      } finally {
        opts.signal.removeEventListener("abort", closePage);
        await page?.close().catch(() => {});
      }
    },

    /**
     * Measure a staged project's real layout (TAB-805).
     *
     * Bundled and served the same way `hyperframes check` audits layout, rather
     * than opened off disk: `bundleToSingleHtml` inlines every
     * `data-composition-src` scene and the runtime IIFE, and the static server
     * gives assets a real origin with Range support. Opening the file directly
     * would leave scene slots empty and report every element inside one as
     * missing.
     *
     * What gets measured is the **staged** copy, never the live project — the
     * agent's edits are not in the live one, so measuring that would answer a
     * question nobody asked.
     */
    async measureLayout(opts) {
      const seekTime = opts.seekTime ?? 0;
      const composition = opts.composition ?? "index.html";
      const entry = join(opts.projectDir, composition);
      if (!existsSync(entry))
        return unavailableMeasurement(`${composition} does not exist in the project.`, seekTime);

      const session = await getThumbnailBrowser(browserGpuMode);
      if (!session)
        return unavailableMeasurement(
          "no browser is available to this Studio server, so nothing could be measured.",
          seekTime,
        );

      return withDeadline(
        runLayoutMeasurement(session.browser, entry, composition, seekTime, opts),
        MEASURE_TIMEOUT_MS,
        () =>
          unavailableMeasurement(
            `the measurement did not finish within ${Math.round(MEASURE_TIMEOUT_MS / 1000)}s, so nothing was measured.`,
            seekTime,
          ),
      );
    },

    /**
     * Run the render gate over the staged project (TAB-1093).
     *
     * In process, not as a subprocess: `runCheckPipeline` is a function, the
     * agent's staged copy is already on this disk, and a spawn would depend on a
     * built `dist` that the compositor image does not carry.
     */
    async runCheck(opts) {
      let project: ProjectDir;
      try {
        project = resolveProject(opts.projectDir);
      } catch (error) {
        return {
          ran: false,
          error: error instanceof Error ? error.message : String(error),
          stderr_tail: "",
        };
      }
      return runCheckUnderDeadline(runProjectCheck(project, opts));
    },

    /**
     * One PNG of the staged composition, for the person the agent is talking to.
     *
     * The agent gets a link and nothing else (D21). It cannot see an image, and a
     * reply that claimed to have looked at one would be the exact failure the
     * `measure_layout` rules exist to stop.
     */
    async frameScreenshot(opts) {
      return captureFrameReceipt(opts, receiptStore);
    },

    /** Four contact-sheet pages spanning the whole staged composition. */
    async contactSheet(opts) {
      return captureContactSheetReceipt(opts, receiptStore);
    },

    async listRegistryCatalog() {
      const { listRegistryItems, loadAllItems } = await import("../registry/resolver.js");
      const entries = await listRegistryItems();
      const blockAndComponentEntries = entries.filter(
        (e) => e.type === "hyperframes:block" || e.type === "hyperframes:component",
      );
      return loadAllItems(blockAndComponentEntries);
    },

    async installRegistryBlock(opts) {
      const { resolveItemWithDependencies } = await import("../registry/resolver.js");
      const { installItem } = await import("../registry/installer.js");
      const { gateRegistryItemsCompatibility } = await import("../registry/compatibility.js");
      // Resolve transitive registryDependencies and install them first so a
      // block that depends on other registry items installs completely.
      const items = await resolveItemWithDependencies(opts.blockName);
      // Compatibility-gate the whole set before writing anything (same gate as
      // `hyperframes add`), so an incompatible block or dep aborts cleanly.
      const warnings = gateRegistryItemsCompatibility(items);
      for (const warning of warnings) {
        process.stderr.write(`hyperframes:registry ${warning}\n`);
      }
      const written: string[] = [];
      for (const dep of items) {
        const result = await installItem(dep, { destDir: opts.project.dir });
        written.push(...result.written);
      }
      const item = items[items.length - 1]!;

      rewriteWrittenToHostViewport(opts.project.dir, written);

      const relativePaths = written.map((abs) => {
        const rel = abs.startsWith(opts.project.dir) ? abs.slice(opts.project.dir.length + 1) : abs;
        return rel;
      });
      return { written: relativePaths, block: item };
    },
  };

  // ── Build the Hono app ─────────────────────────────────────────────────

  const app = new Hono();

  // Config probe endpoint — used by port detection to identify existing
  // HyperFrames instances and reuse them instead of spawning duplicates.
  // See portUtils.ts detectHyperframesServer() for the consumer.
  app.get("/__hyperframes_config", (c) => {
    const serve = async () => {
      const serverBuildSignature = await loadPreviewServerBuildSignature();
      return c.json({
        isHyperframes: true,
        pid: process.pid,
        projectName: projectId,
        projectDir: projectDir,
        serverBuildSignature,
        browserGpuMode,
        version,
      });
    };
    return serve();
  });

  // CLI-specific routes (before shared API)
  app.get("/api/runtime.js", (c) => {
    const serve = async () => {
      const runtimeSource =
        (await loadRuntimeSource()) ?? readBundleFile(runtimePath)?.toString("utf-8") ?? null;
      if (!runtimeSource) return c.text("runtime not available", 404);
      return c.body(runtimeSource, 200, {
        "Content-Type": "text/javascript",
        "Cache-Control": "no-store",
      });
    };
    return serve();
  });

  // CLI → Studio telemetry identity endpoint (Layer 1). Studio reads the
  // injected `window.__HF_CLI_DISTINCT_ID` first; this GET is a fallback for
  // clients that can't rely on the injected global. Returns the CLI's anonymous
  // distinct id (no PII) so the browser session can join the CLI's PostHog
  // person, or `{ distinctId: null }` when CLI telemetry is disabled.
  //
  // Deliberately does NOT serve `bucketSeed`. Studio gets its canary answers
  // from the injected `window.__HF_CLI_CANARY_DECISIONS` (booleans, not the
  // value cohorts derive from), so nothing needs the seed over HTTP — and an
  // unauthenticated local endpoint is a strictly worse place for it than an
  // inline script scoped to Studio's own document.
  //
  // Host-guarded against DNS rebinding: a remote page can point a hostname it
  // controls at 127.0.0.1 and read this response as same-origin. Pinning the
  // Host header to a loopback name means such a request (which carries the
  // attacker's hostname) is refused. Same-origin Studio traffic always
  // presents the bound loopback host.
  app.get("/api/telemetry-identity", (c) => {
    if (!identityAllowed(c.req.header("host"))) {
      return c.json({ error: "forbidden" }, 403);
    }
    // Same request-boundary refresh the head-script route does: this endpoint
    // is polled by a long-lived Studio tab, so a cached posture here outlives
    // an opt-out run in another terminal just as visibly.
    refreshTelemetryPosture();
    return c.json({ distinctId: resolveCliTelemetryDistinctId() });
  });

  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      const listener = (path: string) => {
        const absPath = resolve(projectDir, path);
        let version: string | null = null;
        try {
          version = fileContentVersion(readFileSync(absPath));
        } catch {
          // A deletion has no current bytes to match against an API write receipt.
        }
        // `version` ships even when no receipt matches: it is the client's only
        // identity for an unlabelled change, and without it every duplicate
        // delivery of one watcher event drains and reloads again.
        const receipt = version ? identifyFileWrite(absPath, version) : null;
        stream
          .writeSSE({ event: "file-change", data: JSON.stringify({ path, version, ...receipt }) })
          .catch(() => {});
      };
      // Re-applied here because the watcher now also emits the signature
      // manifest files, which must not trigger a browser reload.
      const wrappedListener = (changedPath: string) => {
        if (shouldWatchProjectFile(changedPath)) listener(changedPath);
      };
      watcher.addListener(wrappedListener);
      stream.onAbort(() => watcher.removeListener(wrappedListener));
      try {
        while (true) {
          await stream.sleep(30000);
        }
      } finally {
        watcher.removeListener(wrappedListener);
      }
    });
  });

  // ── Encoder availability, asked before Export is offered ────────────────
  // The render route below already refuses without FFmpeg, but discovering at
  // export time that the encoder was never installed is the worst possible
  // moment: the user has already built the whole composition. Studio asks here
  // when the Render panel opens so it can say so up front, with the same
  // per-platform install command `doctor` prints.
  //
  // Only a passing result is cached. A user who reads the prompt, installs
  // FFmpeg and hits Recheck has to get a fresh answer, or the fix they just
  // applied is invisible until they restart Studio.
  let ffmpegReady = false;
  app.get("/api/environment/ffmpeg", async (c) => {
    if (ffmpegReady) return c.json({ ok: true });
    const [{ runEnvironmentChecks }, { getFFmpegInstallCommand }] = await Promise.all([
      import("../browser/preflight.js"),
      import("../browser/ffmpeg.js"),
    ]);
    // With every optional check off this is exactly the FFmpeg and ffprobe
    // pair — the same two `doctor` runs. ffprobe matters on its own: it ships
    // with FFmpeg but is a separate binary, and a project with any media asset
    // fails at probe time without it.
    const { outcomes } = await runEnvironmentChecks();
    const failed = outcomes.find((outcome) => !outcome.ok);
    if (!failed) {
      ffmpegReady = true;
      return c.json({ ok: true });
    }
    return c.json({
      ok: false,
      title: failed.title ?? `${failed.name} not found`,
      detail: failed.detail,
      hint: failed.hint,
      command: getFFmpegInstallCommand(),
    });
  });

  // ── Pre-flight checks for render ────────────────────────────────────────
  // Intercept render requests before they reach the shared API so we can
  // fail fast with an actionable hint instead of burning through the entire
  // capture pipeline before hitting "spawn ffmpeg ENOENT" at encode.
  let cachedFFmpegPath: string | undefined;
  app.post("/api/projects/:id/render", async (c, next) => {
    const { findFFmpeg, getFFmpegInstallHint } = await import("../browser/ffmpeg.js");
    if (!cachedFFmpegPath) {
      cachedFFmpegPath = findFFmpeg();
    }
    if (!cachedFFmpegPath) {
      return c.json({ error: "FFmpeg not found", hint: getFFmpegInstallHint() }, 503);
    }
    return next();
  });

  // Receipts — the pictures Tabario AI makes for the person it is talking to.
  //
  // The compositor authenticates the caller and verifies the persisted owner
  // before forwarding. This server also confines reads to its bound project:
  // knowing an unguessable URL must not let another project's server read it.
  // Missing ownership metadata (including legacy receipts) fails closed.
  app.get(`${RECEIPTS_URL_PREFIX}/*`, (c) => {
    const parsed = parseReceiptPath(c.req.path.slice(RECEIPTS_URL_PREFIX.length));
    const bytes = parsed ? receiptStore.get(parsed.session, parsed.revision, parsed.file) : null;
    if (!parsed || !bytes) return c.text("not found", 404);
    // Hono's body() takes a Uint8Array over a plain ArrayBuffer; a Node Buffer's
    // backing store is typed loosely enough to include SharedArrayBuffer, so
    // hand it a view it will accept.
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": getMimeType(parsed.file),
      "Cache-Control": "no-store",
    });
  });

  // Mount the shared studio API at /api.
  // Use fetch() forwarding (not .route()) so the sub-app sees paths without
  // the /api prefix — the shared module's path extraction uses c.req.path.
  const api = createStudioApi(adapter);
  app.all("/api/*", async (c) => {
    const url = new URL(c.req.url);
    url.pathname = url.pathname.slice(4); // Strip "/api" prefix
    const forwardReq = new Request(url.toString(), {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.raw.body,
      // @ts-expect-error -- Node needs duplex for streaming bodies
      duplex: "half",
    });
    return api.fetch(forwardReq);
  });

  // Studio SPA static files
  const serveStudioStaticFile = (cacheControl: string) => (c: Context) => {
    const filePath = resolve(studioDir, c.req.path.slice(1));
    const content = readBundleFile(filePath);
    if (content === null) return c.text("not found", 404);
    return new Response(content, {
      headers: { "Content-Type": getMimeType(filePath), "Cache-Control": cacheControl },
    });
  };
  app.get("/assets/*", serveStudioStaticFile(IMMUTABLE_CACHE_CONTROL));
  app.get("/icons/*", serveStudioStaticFile("no-store"));
  app.get("/favicon.svg", serveStudioStaticFile("no-store"));

  // ── Runtime env injection ───────────────────────────────────────────────
  // When the studio is served as a pre-built SPA, Vite `VITE_STUDIO_*` env
  // vars were baked at build time. Collect any such vars from the current
  // process.env and inject them as `window.__HF_STUDIO_ENV__` so the client
  // can pick them up at runtime, overriding the baked defaults.
  function buildRuntimeEnvScript(): string {
    const overrides: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("VITE_STUDIO_") && value !== undefined) {
        overrides[key] = value;
      }
    }
    if (Object.keys(overrides).length === 0) return "";
    return `<script>window.__HF_STUDIO_ENV__=${JSON.stringify(overrides)};</script>`;
  }

  // SPA fallback
  app.get("*", (c) => {
    const indexPath = resolve(studioDir, "index.html");
    const indexContent = readBundleFile(indexPath);
    if (indexContent === null) {
      return c.html(
        `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tabario Studio unavailable</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0d0f14;
        color: #eef2f7;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(560px, calc(100vw - 48px));
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px;
        padding: 28px;
        background: #151923;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 22px;
        line-height: 1.2;
      }
      p {
        margin: 0 0 18px;
        color: #aab3c2;
        line-height: 1.5;
      }
      code {
        display: block;
        padding: 12px 14px;
        border-radius: 6px;
        background: #090b10;
        color: #8ff0c2;
        overflow-wrap: anywhere;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Studio bundle missing</h1>
      <p>The preview server started, but this CLI build does not contain the Studio assets.</p>
      <code>bun run build</code>
    </main>
  </body>
</html>`,
        500,
      );
    }
    let html = indexContent.toString("utf-8");
    // Inject before the studio bundle runs. Identity script first (see
    // buildStudioHeadScripts) so the CLI distinct id is on `window` by the time
    // telemetry init reads it.
    //
    // Host-guarded for the same reason /api/telemetry-identity is, and it has
    // to be checked HERE too: guarding only the endpoint leaves this route as
    // an open side door, since a rebound origin can simply fetch `/` and read
    // the same distinct id and seed out of the returned HTML.
    //
    // Only IDENTITY is withheld from an untrusted Host. The canary decisions
    // map still goes out — it is non-identifying, and a LAN/remote Studio
    // (`HYPERFRAMES_PREVIEW_HOST=0.0.0.0`) needs it to stay in agreement with
    // the CLI. See buildStudioHeadScriptsForHost.
    const headScript = buildStudioHeadScriptsForHost(buildRuntimeEnvScript(), c.req.header("host"));
    if (headScript) {
      html = html.replace("<head>", `<head>${headScript}`);
    }
    // The shell names the current hashed bundle, so it always revalidates.
    // `no-cache` not `no-store`: same refetch without an ETag, but `no-store`
    // would blocklist the document from Chrome's bfcache.
    return c.html(html, 200, { "Cache-Control": "no-cache" });
  });

  return { app, watcher, adapter };
}
