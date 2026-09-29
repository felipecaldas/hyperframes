import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createProjectSignature,
  fileContentVersion,
  HistoryBusyError,
  HistoryClosedError,
} from "@hyperframes/studio-server";
import { loadHyperframeRuntimeSource } from "@hyperframes/core";
import { AGENT_IDLE_TIMEOUT_MS } from "@hyperframes/studio-server";
import { loadRuntimeSource } from "./runtimeSource.js";
import { findFFmpeg, findFFprobe } from "../browser/ffmpeg.js";
import {
  CHECK_OPTIONS,
  CHECK_TIMEOUT_MS,
  CONTACT_SHEET_CELLS,
  CONTACT_SHEET_PAGE_CELLS,
  captureContactSheetReceipt,
  captureFrameReceipt,
  createStudioServer,
  runCheckUnderDeadline,
  runProjectCheck,
  type StudioServer,
} from "./studioServer.js";
import { ReceiptStore } from "./studioReceipts.js";
import { tailFrameTime } from "../commands/snapshot.js";
import type { CheckFinding, CheckOptions, CheckReport } from "../utils/checkTypes.js";
import type { ProjectDir } from "../utils/project.js";

// Forces loadStudioProducer() down its production import branch (real
// isDevMode() is true for a .ts test file, which instead throws a
// "requires bun" error before ever reaching executeRenderJob — see
// studioServer.ts's loadStudioProducer). Only startRender reads this.
vi.mock("../utils/env.js", () => ({ isDevMode: () => false }));

const producerState = vi.hoisted(() => ({
  // Set per-test to control when the render "finishes" so a shutdown that
  // races an in-flight render is observable instead of vacuous.
  executeRenderJob: (
    _job: unknown,
    _dir: string,
    _outputPath: string,
    _onProgress: unknown,
    _signal: AbortSignal,
  ): Promise<void> => Promise.resolve(),
}));
vi.mock("@hyperframes/producer", () => ({
  createRenderJob: (opts: Record<string, unknown>) => ({ ...opts, perfSummary: undefined }),
  executeRenderJob: (...args: Parameters<typeof producerState.executeRenderJob>) =>
    producerState.executeRenderJob(...args),
}));
const engineState = vi.hoisted(() => ({
  acquireBrowser: async (..._args: unknown[]): Promise<unknown> => {
    throw new Error("acquireBrowser called without a test double");
  },
  closeBrowserPool: async (): Promise<void> => {},
}));
vi.mock("@hyperframes/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hyperframes/engine")>()),
  acquireBrowser: (...args: unknown[]) => engineState.acquireBrowser(...args),
  buildChromeArgs: () => [],
  killTrackedProcesses: () => {},
  closeBrowserPool: () => engineState.closeBrowserPool(),
}));
vi.mock("../browser/gpuPolicy.js", () => ({
  resolveCaptureBrowserGpuMode: async () => "software",
  resolveLocalBrowserGpuMode: () => "software",
  compositionRequiresWebGpu: () => false,
  assertWebGpuAdapterAvailable: async () => {},
}));
vi.mock("../browser/preflight.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../browser/preflight.js")>()),
  resolveRenderBrowser: async () => ({ executablePath: "/fake/chrome", source: "system" }),
}));
vi.mock("../browser/manager.js", () => ({
  ensureBrowser: async () => ({ executablePath: undefined, source: "system" }),
}));

// Lets one test hold the project history in its opening; every other test opens the real one.
const historyState = vi.hoisted(() => ({
  open: null as null | ((...args: unknown[]) => Promise<unknown>),
}));
vi.mock("@hyperframes/studio-server", async (importOriginal) => {
  const original = await importOriginal<typeof import("@hyperframes/studio-server")>();
  return {
    ...original,
    createProjectSignature: vi.fn(original.createProjectSignature),
    openProjectHistory: (...args: Parameters<typeof original.openProjectHistory>) =>
      historyState.open ? historyState.open(...args) : original.openProjectHistory(...args),
  };
});

// Only `fs.watch` is replaced, so the SSE describe below can fire a file-change
// on demand; every other server test keeps reading and writing real files.
const mockWatcher = new EventEmitter() as EventEmitter & { close: () => void };
mockWatcher.close = vi.fn();

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  const watch = vi.fn(
    (_path: string, _options: unknown, onChange: (event: string, filename: string) => void) => {
      mockWatcher.on("change", onChange);
      return mockWatcher;
    },
  );
  return { ...original, default: { ...original, watch }, watch };
});

// Every server-backed describe below wants the same two things: a throwaway
// project directory, and a server whose watcher is closed afterwards. Three
// copies of that got out of step, so it lives here once.
const dirs: string[] = [];
let server: StudioServer | undefined;

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "hf-studio-server-test-"));
  dirs.push(dir);
  return dir;
}

const openReaders: ReadableStreamDefaultReader<Uint8Array>[] = [];

afterEach(async () => {
  await Promise.all(openReaders.splice(0).map((reader) => reader.cancel().catch(() => {})));
  mockWatcher.removeAllListeners();
  server?.watcher.close();
  server = undefined;
  delete process.env.HYPERFRAMES_FFMPEG_PATH;
  delete process.env.HYPERFRAMES_FFPROBE_PATH;
  delete process.env.HYPERFRAMES_STATE_DIR;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── run_check fixtures ──────────────────────────────────────────────────────
// The browser pass is the one part of `runCheckPipeline` a unit lane cannot
// afford (it launches Chrome and seeks a real composition), so these tests
// inject the pipeline and assert the two things the adapter actually owns: the
// options it bounds the pipeline with, and how it maps a report into findings.
// The pipeline's own behaviour is covered by check.test.ts against the real one.

function emptySection() {
  return { ok: true, errorCount: 0, warningCount: 0, infoCount: 0, findings: [] };
}

function planted(code: string, sourceFile = "index.html", line?: number): CheckFinding {
  return {
    code,
    severity: "error",
    message: `${code} planted by the test`,
    selector: "#caption-0",
    dataAttributes: {},
    sourceFile,
    bbox: { x: 0, y: 0, width: 320, height: 40 },
    time: 1.5,
    ...(line === undefined ? {} : { line }),
  };
}

/**
 * A report carrying a planted layout finding and planted lint findings, in the
 * sections the real pipeline would put them in: `text_box_overflow` comes from
 * the browser layout audit, and every `tabario_*` code is a lint rule
 * (packages/lint/src/rules/tabario.ts).
 */
function reportWith(lintCodes: string[], layoutCodes: string[]): CheckReport {
  return {
    ok: false,
    strict: false,
    lint: {
      ...emptySection(),
      ok: lintCodes.length === 0,
      errorCount: lintCodes.length,
      findings: lintCodes.map((code) => planted(code, "index.html", 42)),
      filesScanned: 1,
    },
    runtime: emptySection(),
    layout: {
      ...emptySection(),
      ok: layoutCodes.length === 0,
      errorCount: layoutCodes.length,
      findings: layoutCodes.map((code) => ({
        ...planted(code),
        rect: { left: 0, top: 0, right: 320, bottom: 40, width: 320, height: 40 },
      })),
      duration: 10,
      samples: [0, 5],
      transitionSamples: [2],
      transitionSamplesDropped: 0,
      tolerance: 2,
      totalIssueCount: layoutCodes.length,
      truncated: false,
    } as CheckReport["layout"],
    motion: { ...emptySection(), enabled: true, samples: 0 },
    contrast: { ...emptySection(), enabled: true, samples: [], checked: 0, passed: 0 },
    hdr: { autoPromotion: null, inspection: "available" },
    snapshots: { enabled: false, files: [], times: [], findingFiles: [] },
  };
}

function projectAt(dir: string): ProjectDir {
  return { dir, name: "demo", indexPath: join(dir, "index.html") };
}

describe("run_check runs the real check pipeline in process", () => {
  it("run_check maps a planted text_box_overflow into ran:true findings", async () => {
    const result = await runProjectCheck(projectAt(tmpProject()), {}, async () =>
      reportWith([], ["text_box_overflow"]),
    );

    expect(result.ran).toBe(true);
    if (!result.ran) throw new Error("unreachable");
    expect(result.findings.map((f) => f.code)).toContain("text_box_overflow");
    expect(result.findings[0]).toMatchObject({
      code: "text_box_overflow",
      severity: "error",
      file: "index.html",
    });
  });

  it("run_check reports the four tabario_ register codes by name", async () => {
    const codes = [
      "tabario_motion_ease_outside_register",
      "tabario_motion_transition_outside_register",
      "tabario_motion_accent_limit",
      "tabario_project_meta_malformed",
    ];

    const result = await runProjectCheck(projectAt(tmpProject()), {}, async () =>
      reportWith(codes, []),
    );

    if (!result.ran) throw new Error("expected the check to have run");
    expect(result.findings.map((f) => f.code)).toEqual(expect.arrayContaining(codes));
    expect(result.findings.find((f) => f.code === "tabario_motion_accent_limit")?.line).toBe(42);
  });

  it("run_check bounds the pipeline at transitions and forwards the caller's AbortSignal", async () => {
    let seen: { options: CheckOptions; signal?: AbortSignal } | null = null;
    const controller = new AbortController();

    await runProjectCheck(
      projectAt(tmpProject()),
      { signal: controller.signal },
      async (_project, options, signal) => {
        seen = { options, signal };
        return reportWith([], []);
      },
    );

    const call = seen as unknown as { options: CheckOptions; signal?: AbortSignal };
    expect(call.options.atTransitions).toBe(true);
    expect(call.options.maxTransitionSamples).toBeGreaterThan(0);
    expect(call.options.snapshots).toBe(false);
    expect(call.options.strict).toBe(false);
    // The pipeline owns its own browser, so its longest single wait has to sit
    // below the deadline that gives up on it.
    expect(call.options.timeout).toBeLessThan(CHECK_TIMEOUT_MS);
    expect(call.signal).toBe(controller.signal);
  });

  it("run_check returns ran:false with error 'deadline' rather than rejecting when the pipeline never resolves", async () => {
    // The deadline *resolves* with the expiry value, so this awaits a value
    // instead of expecting a rejection.
    const result = await runCheckUnderDeadline(new Promise(() => {}), 25);

    expect(result).toEqual({ ran: false, error: "deadline", stderr_tail: "" });
  });

  it("run_check gives up before the agent's idle timeout does", () => {
    expect(CHECK_TIMEOUT_MS).toBe(120_000);
    expect(CHECK_TIMEOUT_MS).toBeLessThan(AGENT_IDLE_TIMEOUT_MS);
    expect(CHECK_OPTIONS.timeout).toBeLessThanOrEqual(CHECK_TIMEOUT_MS - 10_000);
  });
});

// ── frame_screenshot / contact_sheet fixtures ───────────────────────────────
// Capture is injected for the same reason the check pipeline is: the real one
// launches Chrome over a bundled composition. What is asserted here is what the
// adapter decides — where it is allowed to read and write, how many frames it
// asks for and at what times, and that what comes back is a link rather than an
// image.

function stagedProject(stateDir: string, html: string): string {
  const dir = join(stateDir, "studio-agent", "key", "staging", "job-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
  return dir;
}

function composition(durationSeconds: number): string {
  return `<html><body><div data-composition-id="main" data-width="1080" data-height="1920">
  <div class="clip" data-start="0" data-duration="${durationSeconds}">Frame</div>
</div></body></html>`;
}

/** Records what the adapter asked for and writes bytes where it asked. */
function recordingCapture() {
  const calls: Array<{ at?: number[]; frames?: number; outputDir: string }> = [];
  return {
    calls,
    capture: {
      async capture(
        _projectDir: string,
        opts: { at?: number[]; frames?: number; outputDir: string },
      ) {
        calls.push(opts);
        mkdirSync(opts.outputDir, { recursive: true });
        const times = opts.at ?? [];
        return times.map((time, index) => {
          const path = join(opts.outputDir, `frame-${index}-at-${time.toFixed(2)}s.png`);
          writeFileSync(path, Buffer.from(`frame ${index}`, "utf-8"));
          return path;
        });
      },
      async sheet(snapshotsDir: string, outputPath: string) {
        const pages = Math.ceil((calls.at(-1)?.at?.length ?? 0) / CONTACT_SHEET_PAGE_CELLS);
        return Array.from({ length: pages }, (_, index) => {
          const path = outputPath.replace(/\.jpg$/, pages === 1 ? ".jpg" : `-${index + 1}.jpg`);
          writeFileSync(path, Buffer.from(`sheet ${index} of ${snapshotsDir}`, "utf-8"));
          return path;
        });
      },
    },
  };
}

describe("frame_screenshot and contact_sheet are receipts, not vision", () => {
  it("a screenshot at 2.0s carries the composition's dimensions, a revision and a URL", async () => {
    const stateDir = tmpProject();
    const projectDir = stagedProject(stateDir, composition(10));
    process.env.HYPERFRAMES_STATE_DIR = stateDir;
    const store = new ReceiptStore(join(stateDir, "studio-receipts"));
    const recorder = recordingCapture();

    const result = await captureFrameReceipt({ projectDir, t: 2 }, store, recorder.capture);

    if (!result.ran) throw new Error(`expected a receipt, got ${result.error}`);
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1920);
    expect(result.url.startsWith("/studio/receipts/")).toBe(true);
    expect(result.url).toContain(result.revision);
    expect(recorder.calls[0]?.at).toEqual([2]);
    // The bytes landed in the store, not in the staging dir the run deletes.
    expect(store.contains(join(store.rootDir, "anything"))).toBe(true);
  });

  it("a screenshot of a project path that climbs out of the staging root is refused", async () => {
    const stateDir = tmpProject();
    const projectDir = stagedProject(stateDir, composition(10));
    process.env.HYPERFRAMES_STATE_DIR = stateDir;
    const store = new ReceiptStore(join(stateDir, "studio-receipts"));

    const escaped = join(projectDir, "..", "..", "..", "..");
    const result = await captureFrameReceipt(
      { projectDir: escaped, t: 2 },
      store,
      recordingCapture().capture,
    );

    expect(result).toEqual({ ran: false, error: "path outside project" });
  });

  it("a contact sheet whose output would land outside the receipts root is refused", async () => {
    const stateDir = tmpProject();
    const projectDir = stagedProject(stateDir, composition(90));
    process.env.HYPERFRAMES_STATE_DIR = stateDir;
    const store = new ReceiptStore(join(stateDir, "studio-receipts"));
    const elsewhere = join(tmpProject(), "not-the-receipts-root");
    // Same store, asked to write somewhere it does not own — the second
    // containment rule, which the first cannot cover because the roots differ.
    const wanderingStore = {
      rootDir: store.rootDir,
      put: store.put.bind(store),
      contains: store.contains.bind(store),
      captureDir: () => elsewhere,
    };

    const result = await captureContactSheetReceipt(
      { projectDir },
      wanderingStore,
      recordingCapture().capture,
    );

    expect(result).toEqual({ ran: false, error: "path outside project" });
  });

  it("a contact sheet of a 90s composition spans it in four pages", async () => {
    const stateDir = tmpProject();
    const projectDir = stagedProject(stateDir, composition(90));
    process.env.HYPERFRAMES_STATE_DIR = stateDir;
    const store = new ReceiptStore(join(stateDir, "studio-receipts"));
    const recorder = recordingCapture();

    const result = await captureContactSheetReceipt({ projectDir }, store, recorder.capture);

    if (!result.ran) throw new Error(`expected a sheet, got ${result.error}`);
    // Four pages of nine cells is where 36 comes from, and 36 cells over 90s is
    // where the interval comes from — not a fixed interval that would cover the
    // first 18s and silently drop the rest.
    expect(CONTACT_SHEET_CELLS / CONTACT_SHEET_PAGE_CELLS).toBe(4);
    expect(result.pages).toBe(4);
    expect(result.pageUrls).toHaveLength(4);
    // 36 cells leave 35 gaps, so the interval it reports is 90/35, not 90/36.
    expect(result.cellSeconds).toBeCloseTo(90 / 35, 5);
    const times = recorder.calls[0]?.at ?? [];
    expect(times).toHaveLength(CONTACT_SHEET_CELLS);
    // A cell captures the readable tail, not the exact end. The runtime
    // unmounts a clip at its own end, so `tailFrameTime` backs off 3% of the
    // duration and a sample at 90.0 would come back blank. On a 90s film that
    // is 2.7s, wider than one cell, which is why this asserts the tail itself
    // rather than "within one cellSeconds of the end".
    expect(times).toContain(tailFrameTime(90));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBe(0);
    expect(result.durationSeconds).toBe(90);
    expect(result.framesPerPage).toBe(9);
    expect(result.frameCount).toBe(36);
    expect(result.pageFrameTimes).toHaveLength(4);
    expect(result.pageFrameTimes?.flat()).toEqual(times);
    for (const page of result.pageFrameTimes ?? []) expect(page).toHaveLength(9);
  });

  it("a short composition gets fewer cells rather than a sub-frame interval", async () => {
    const stateDir = tmpProject();
    const projectDir = stagedProject(stateDir, composition(3));
    process.env.HYPERFRAMES_STATE_DIR = stateDir;
    const store = new ReceiptStore(join(stateDir, "studio-receipts"));
    const recorder = recordingCapture();

    const result = await captureContactSheetReceipt({ projectDir }, store, recorder.capture);

    if (!result.ran) throw new Error(`expected a sheet, got ${result.error}`);
    expect(result.cellSeconds).toBe(0.5);
    expect(recorder.calls[0]?.at).toHaveLength(7);
    expect(result.pages).toBe(1);
    expect(result.pageFrameTimes).toEqual([recorder.calls[0]?.at]);
  });

  it("refuses to report requested timestamps when capture omitted a frame", async () => {
    const stateDir = tmpProject();
    const projectDir = stagedProject(stateDir, composition(3));
    process.env.HYPERFRAMES_STATE_DIR = stateDir;
    const recorder = recordingCapture();
    const result = await captureContactSheetReceipt(
      { projectDir },
      new ReceiptStore(join(stateDir, "studio-receipts")),
      {
        ...recorder.capture,
        capture: async (dir, opts) => (await recorder.capture.capture(dir, opts)).slice(1),
      },
    );
    expect(result).toEqual({
      ran: false,
      error: "snapshot count does not match requested timestamps",
    });
  });

  it("refuses to label missing sheet pages as complete coverage", async () => {
    const stateDir = tmpProject();
    const projectDir = stagedProject(stateDir, composition(90));
    process.env.HYPERFRAMES_STATE_DIR = stateDir;
    const recorder = recordingCapture();
    const result = await captureContactSheetReceipt(
      { projectDir },
      new ReceiptStore(join(stateDir, "studio-receipts")),
      {
        ...recorder.capture,
        sheet: async (dir, output) => (await recorder.capture.sheet(dir, output)).slice(1),
      },
    );
    expect(result).toEqual({
      ran: false,
      error: "contact sheet page count does not match captured frames",
    });
  });

  it("partial final pages report only their actual sample times", async () => {
    const stateDir = tmpProject();
    const projectDir = stagedProject(stateDir, composition(5));
    process.env.HYPERFRAMES_STATE_DIR = stateDir;
    const recorder = recordingCapture();
    const result = await captureContactSheetReceipt(
      { projectDir },
      new ReceiptStore(join(stateDir, "studio-receipts")),
      recorder.capture,
    );
    if (!result.ran) throw new Error(result.error);
    expect(result.pages).toBe(2);
    expect(result.frameCount).toBe(11);
    expect(result.pageFrameTimes?.map((times) => times.length)).toEqual([9, 2]);
    expect(result.pageFrameTimes?.flat()).toEqual(recorder.calls[0]?.at);
    expect(result.pageFrameTimes?.[1]).toEqual([4.5, 4.85]);
  });

  it("no screenshot or contact sheet result carries image bytes (D21)", async () => {
    const stateDir = tmpProject();
    const projectDir = stagedProject(stateDir, composition(90));
    process.env.HYPERFRAMES_STATE_DIR = stateDir;
    const store = new ReceiptStore(join(stateDir, "studio-receipts"));

    const shot = await captureFrameReceipt({ projectDir, t: 2 }, store, recordingCapture().capture);
    const sheet = await captureContactSheetReceipt(
      { projectDir },
      store,
      recordingCapture().capture,
    );

    for (const result of [shot, sheet]) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("base64");
      expect(serialized).not.toContain("data:image");
      expect(serialized.length).toBeLessThan(2_000);
    }
  });

  // The page size is `createSnapshotContactSheet`'s, not ours; a constant that
  // restates someone else's number goes stale silently, so this reads theirs.
  it("the contact sheet page size this adapter plans for is the one the sheet uses", () => {
    const source = readFileSync(
      new URL("../capture/contactSheet.ts", import.meta.url).pathname,
      "utf8",
    );
    expect(source).toContain(`pageSize: ${CONTACT_SHEET_PAGE_CELLS}`);
  });
});

describe("the receipts route serves a stored picture and nothing else", () => {
  it("serves a stored receipt and answers an unknown id exactly as an ill-formed one", async () => {
    const stateDir = tmpProject();
    process.env.HYPERFRAMES_STATE_DIR = stateDir;
    const projectDir = tmpProject();
    const store = new ReceiptStore(undefined, projectDir);
    const receipt = store.put("session-1", "rev-1", "frame.png", Buffer.from("bytes", "utf-8"));
    server = createStudioServer({ projectDir });

    const found = await server.app.request(receipt.url);
    const unknown = await server.app.request("/studio/receipts/session-1/rev-1/deadbeef.png");
    const malformed = await server.app.request("/studio/receipts/nope");

    expect(found.status).toBe(200);
    expect(found.headers.get("content-type")).toContain("image/png");
    expect(await found.text()).toBe("bytes");
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(await unknown.text()).toBe(await malformed.text());
    const foreign = createStudioServer({ projectDir: tmpProject() });
    try {
      const denied = await foreign.app.request(receipt.url);
      expect(denied.status).toBe(404);
      expect(await denied.text()).toBe("not found");
    } finally {
      foreign.watcher.close();
    }
  });
});

describe("loadRuntimeSource", () => {
  it("loads runtime source from the published core entrypoint", async () => {
    await expect(loadRuntimeSource()).resolves.toBe(loadHyperframeRuntimeSource());
  });
});

describe("Studio thumbnail GPU capture plumbing", () => {
  it("uses the shared auto probe, resolved launch mode, requirement guard, and completion-aware seek", () => {
    const source = readFileSync(new URL("./studioServer.ts", import.meta.url), "utf8");
    expect(source).toContain("resolveCaptureBrowserGpuMode");
    expect(source).toContain("{ browserGpuMode: resolvedGpuMode }");
    expect(source).toContain("assertWebGpuAdapterAvailable(page, requiresWebGpu)");
    expect(source).toContain("await seekCompositionTimeline(page, opts.seekTime");
  });
});

describe("createStudioServer project history (D-491)", () => {
  it("serves the project's history, and a change the watcher sees becomes an entry", async () => {
    const projectDir = tmpProject();
    writeFileSync(join(projectDir, "index.html"), "<html>before</html>");
    server = createStudioServer({ projectDir, historyRoot: tmpProject() });
    const historyUrl = `/api/projects/${encodeURIComponent(basename(projectDir))}/history`;
    const list = async () =>
      (await (await server!.app.request(historyUrl)).json()) as {
        entries: Array<{ who: { kind: string } }>;
        back: { label: string } | null;
      };
    expect(await list()).toMatchObject({ entries: [], back: null });

    writeFileSync(join(projectDir, "index.html"), "<html>agent</html>");
    mockWatcher.emit("change", "change", "index.html");

    // Writes with no window open group until 2 s of quiet.
    await vi.waitFor(async () => expect((await list()).entries).toHaveLength(1), {
      timeout: 5_000,
      interval: 200,
    });
    expect((await list()).entries[0]!.who.kind).toBe("outside");
    await server.shutdown();
  });

  it.each([
    ["another process was holding", new HistoryBusyError(1)],
    ["whose folder changed while it opened", new HistoryClosedError("now another project")],
  ])(
    "tries a history %s again on the next request, instead of turning it off",
    async (_, refusal) => {
      historyState.open = async () => {
        historyState.open = null;
        throw refusal;
      };
      const projectDir = tmpProject();
      server = createStudioServer({ projectDir, historyRoot: tmpProject() });
      const historyUrl = `/api/projects/${encodeURIComponent(basename(projectDir))}/history`;
      expect((await server.app.request(historyUrl)).status).toBe(404);
      expect((await server.app.request(historyUrl)).status).toBe(200);
      await server.shutdown();
    },
  );

  it("opens a new project's own history once it takes the folder's path", async () => {
    const projectDir = tmpProject();
    writeFileSync(join(projectDir, "index.html"), "<html>before</html>");
    server = createStudioServer({ projectDir, historyRoot: tmpProject() });
    const historyUrl = `/api/projects/${encodeURIComponent(basename(projectDir))}/history`;
    expect((await server.app.request(historyUrl)).status).toBe(200);
    renameSync(projectDir, `${projectDir}-moved`);
    dirs.push(`${projectDir}-moved`);
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "index.html"), "<html>new</html>");

    expect((await server.app.request(historyUrl)).status).toBe(200);
    expect(existsSync(join(projectDir, ".hyperframes", "history-id"))).toBe(true);
    await server.shutdown();
  });

  it("shutdown returns within preview's exit watchdog while the history is still opening", async () => {
    historyState.open = () => new Promise(() => {});
    try {
      const projectDir = tmpProject();
      server = createStudioServer({ projectDir, historyRoot: tmpProject() });
      void server.app.request(`/api/projects/${encodeURIComponent(basename(projectDir))}/history`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const started = Date.now();
      await server.shutdown();
      expect(Date.now() - started).toBeLessThan(2_900);
    } finally {
      historyState.open = null;
    }
  });
});

describe("createStudioServer autoProxy plumbing", () => {
  it("hyperframes.json media.autoProxy=false flows through to the adapter", () => {
    const projectDir = tmpProject();
    writeFileSync(
      join(projectDir, "hyperframes.json"),
      JSON.stringify({ media: { autoProxy: false } }),
    );

    server = createStudioServer({ projectDir });

    expect(server.adapter.autoProxy).toBe(false);
  });

  it("defaults the adapter to autoProxy=true when neither option nor config disables it", () => {
    server = createStudioServer({ projectDir: tmpProject() });
    expect(server.adapter.autoProxy).toBe(true);
  });

  it("an explicit option (the preview command's resolved --proxy flag) wins over config", () => {
    const projectDir = tmpProject();
    writeFileSync(
      join(projectDir, "hyperframes.json"),
      JSON.stringify({ media: { autoProxy: false } }),
    );

    server = createStudioServer({ projectDir, autoProxy: true });

    expect(server.adapter.autoProxy).toBe(true);
  });

  it("advertises the GPU policy used for thumbnail capture", async () => {
    const projectDir = tmpProject();
    server = createStudioServer({ projectDir, browserGpuMode: "software" });

    const response = await server.app.request("/__hyperframes_config");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ browserGpuMode: "software" });
  });
});

// A render that never reaches the executor (browser check refused, import failed) must fail with
// its reason, not hang until the suite timeout.
async function untilStarted(started: Promise<void>, state: { status: string; error?: string }) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const never = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `render never reached executeRenderJob: status=${state.status} error=${state.error}`,
          ),
        ),
      5_000,
    );
  });
  try {
    await Promise.race([started, never]);
  } finally {
    clearTimeout(timer);
  }
}

describe("createStudioServer shutdown", () => {
  function startRenderOpts(jobId: string, outputPath: string) {
    return {
      project: { id: "demo", dir: tmpProject(), title: "demo" },
      outputPath,
      format: "mp4" as const,
      fps: { num: 30, den: 1 },
      quality: "draft",
      jobId,
    };
  }

  it("cancels an in-flight render's signal and waits for it before draining the browser pool", async () => {
    const events: string[] = [];
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    producerState.executeRenderJob = (_job, _dir, _outputPath, _onProgress, signal) => {
      started();
      return new Promise((_resolve, reject) => {
        const onAbort = () =>
          setTimeout(() => {
            events.push("render-settled");
            reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
          }, 20);
        // A signal aborted before this executor ran would never fire a later
        // "abort" listener (edge-triggered, not level-triggered) — check the
        // already-aborted case too, same as real capture code must.
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort);
      });
    };

    server = createStudioServer({ projectDir: tmpProject() });
    const outputPath = join(tmpdir(), "shutdown-render.mp4");
    const state = server.adapter.startRender(startRenderOpts("job-1", outputPath));
    expect(state.status).toBe("rendering");

    // Wait until the render has actually reached executeRenderJob (several
    // microtask hops through loadStudioProducer/ensureBrowser) before racing
    // it against shutdown, or shutdown could abort a signal nothing is
    // listening on yet — a race in this test, not in the fix under test.
    await untilStarted(startedPromise, state);

    await server.shutdown();
    events.push("drain-and-shutdown-returned");

    expect(events).toEqual(["render-settled", "drain-and-shutdown-returned"]);
  });

  it("refuses a render started after shutdown has begun instead of launching a fresh browser", async () => {
    let releaseFirstRender: () => void = () => {};
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    producerState.executeRenderJob = () => {
      started();
      return new Promise<void>((resolve) => {
        releaseFirstRender = resolve;
      });
    };

    server = createStudioServer({ projectDir: tmpProject() });
    const first = server.adapter.startRender(startRenderOpts("job-1", join(tmpdir(), "a.mp4")));
    await untilStarted(startedPromise, first);

    const shutdownPromise = server.shutdown();
    // shuttingDown is set synchronously as shutdown()'s first statement, so a
    // render request arriving anywhere after that call has been made (even
    // before it resolves) must already see it.
    const late = server.adapter.startRender(startRenderOpts("job-2", join(tmpdir(), "b.mp4")));

    expect(late.status).toBe("failed");
    expect(late.error).toMatch(/shutting down/i);

    releaseFirstRender();
    await shutdownPromise;
  });

  const thumbnailOpts = () => ({
    project: { id: "demo", dir: tmpProject(), title: "demo" },
    compPath: "index.html",
    seekTime: 0.5,
    width: 640,
    height: 360,
    outputWidth: 640,
    outputHeight: 360,
    previewUrl: "http://localhost/preview",
    signal: new AbortController().signal,
  });

  it("does not launch a browser for a thumbnail request after shutdown has begun", async () => {
    const acquire = vi.fn();
    engineState.acquireBrowser = acquire;
    server = createStudioServer({ projectDir: tmpProject() });
    await server.shutdown();

    await expect(server.adapter.generateThumbnail?.(thumbnailOpts())).resolves.toBeNull();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("releases a thumbnail browser that finished launching after shutdown began", async () => {
    const release = vi.fn(async () => {});
    let launched!: () => void;
    const launchedPromise = new Promise<void>((resolve) => (launched = resolve));
    let finishLaunch: () => void = () => {};
    engineState.acquireBrowser = async () => {
      launched();
      await new Promise<void>((resolve) => (finishLaunch = resolve));
      return { browser: new EventEmitter(), release };
    };
    let reachedBrowserClose!: () => void;
    const reachedBrowserClosePromise = new Promise<void>(
      (resolve) => (reachedBrowserClose = resolve),
    );
    engineState.closeBrowserPool = async () => reachedBrowserClose();
    server = createStudioServer({ projectDir: tmpProject() });
    const thumbnail = server.adapter.generateThumbnail?.(thumbnailOpts());
    await launchedPromise;

    const shutdown = server.shutdown();
    // shutdown() starts the pool close alongside the thumbnail-browser close,
    // before it waits on renders: closing is the signal the close has begun
    // while the launch is still pending, without racing a fixed sleep.
    await reachedBrowserClosePromise;
    finishLaunch();
    await shutdown;

    await expect(thumbnail).resolves.toBeNull();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("closes browsers within a bounded timeout even when a render's done promise never settles", async () => {
    const closeBrowserPool = vi.fn(async () => {});
    engineState.closeBrowserPool = closeBrowserPool;
    const release = vi.fn(async () => {});
    let launched!: () => void;
    const launchedPromise = new Promise<void>((resolve) => (launched = resolve));
    let finishLaunch: () => void = () => {};
    engineState.acquireBrowser = async () => {
      launched();
      await new Promise<void>((resolve) => (finishLaunch = resolve));
      return { browser: new EventEmitter(), release };
    };

    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    producerState.executeRenderJob = () => {
      started();
      // Never settles, even once aborted -- the pathological case the CLI's
      // 3s exit watchdog exists to survive.
      return new Promise<void>(() => {});
    };

    server = createStudioServer({ projectDir: tmpProject() });
    const state = server.adapter.startRender(startRenderOpts("job-1", join(tmpdir(), "hang.mp4")));
    await untilStarted(startedPromise, state);

    const thumbnail = server.adapter.generateThumbnail?.(thumbnailOpts());
    await launchedPromise;
    finishLaunch();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const never = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("shutdown() did not resolve within its bound")),
        3_000,
      );
    });
    try {
      await Promise.race([server.shutdown(), never]);
    } finally {
      clearTimeout(timer);
    }

    expect(release).toHaveBeenCalledTimes(1);
    expect(closeBrowserPool).toHaveBeenCalledTimes(1);
    await expect(thumbnail).resolves.toBeNull();
  });

  it("does not hand an already-leased browser to a new caller once shutdown has begun", async () => {
    const release = vi.fn(async () => {});
    const newPage = vi.fn(async () => {
      throw new Error("no real page in this test double");
    });
    engineState.acquireBrowser = async () => ({
      browser: { connected: true, newPage, on: () => {} },
      release,
    });

    server = createStudioServer({ projectDir: tmpProject() });
    await server.adapter.generateThumbnail?.(thumbnailOpts());
    expect(newPage).toHaveBeenCalledTimes(1);

    const shutdownPromise = server.shutdown();
    // shuttingDown flips true synchronously as shutdown()'s first statement,
    // before its closeThumbnailBrowser() call runs -- this request lands in
    // that window and must not reuse the still-connected lease.
    const late = server.adapter.generateThumbnail?.(thumbnailOpts());

    await expect(late).resolves.toBeNull();
    expect(newPage).toHaveBeenCalledTimes(1);
    await shutdownPromise;
  });
});

describe("Studio thumbnail capture", () => {
  function fakePageBrowser(onEvaluate = () => {}) {
    const screenshot = vi.fn(async () => Buffer.from("jpeg"));
    const evaluate = vi.fn(async () => onEvaluate());
    const page = new Proxy(
      { screenshot, evaluate },
      {
        get: (target, key) =>
          key === "then"
            ? undefined
            : key in target
              ? target[key as keyof typeof target]
              : async () => {},
      },
    );
    engineState.acquireBrowser = async () => ({
      browser: { connected: true, newPage: async () => page, on: () => {} },
      release: async () => {},
    });
    return { screenshot };
  }
  const opts = (dir: string, signal = new AbortController().signal) => ({
    project: { id: "demo", dir, title: "demo" },
    compPath: "index.html",
    seekTime: 0.5,
    width: 640,
    height: 360,
    outputWidth: 640,
    outputHeight: 360,
    previewUrl: "http://localhost/preview",
    signal,
  });

  it("stops a thumbnail whose request is aborted before its screenshot", async () => {
    let abortOnEvaluate: AbortController | undefined;
    const { screenshot } = fakePageBrowser(() => abortOnEvaluate?.abort());
    const dir = tmpProject();
    server = createStudioServer({ projectDir: dir });
    await expect(server.adapter.generateThumbnail?.(opts(dir))).resolves.toBeInstanceOf(Buffer);
    expect(screenshot).toHaveBeenCalledTimes(1);

    const aborting = new AbortController();
    abortOnEvaluate = aborting;
    await expect(
      server.adapter.generateThumbnail?.(opts(dir, aborting.signal)),
    ).resolves.toBeNull();
    expect(screenshot).toHaveBeenCalledTimes(1);
  });

  it("reuses the cached project signature instead of walking the project per thumbnail", async () => {
    fakePageBrowser();
    const dir = tmpProject();
    server = createStudioServer({ projectDir: dir });
    await server.adapter.generateThumbnail?.(opts(dir));
    const walks = vi.mocked(createProjectSignature).mock.calls.length;
    for (let i = 0; i < 3; i++) await server.adapter.generateThumbnail?.(opts(dir));
    expect(vi.mocked(createProjectSignature).mock.calls.length).toBe(walks);
  });
});

describe("Studio project lint endpoint", () => {
  it("surfaces findings that require the complete project graph", async () => {
    const projectDir = tmpProject();
    mkdirSync(join(projectDir, "compositions"));
    mkdirSync(join(projectDir, "scenes"));
    writeFileSync(
      join(projectDir, "index.html"),
      `<html><body><div data-composition-id="main" data-width="1920" data-height="1080" data-start="0" data-duration="10"></div></body></html>`,
    );
    writeFileSync(
      join(projectDir, "compositions", "index.html"),
      `<html><body><div data-composition-id="authored" data-width="1920" data-height="1080" data-start="0" data-duration="5"><div class="clip" data-start="0" data-duration="5">Visible</div></div></body></html>`,
    );
    writeFileSync(join(projectDir, "scenes", "intro.html"), "<html><body>Intro</body></html>");
    server = createStudioServer({ projectDir, projectName: "demo" });

    const response = await server.app.request("http://localhost/api/projects/demo/lint");
    const payload = (await response.json()) as {
      findings?: Array<{ code?: string; file?: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.findings).toContainEqual(
      expect.objectContaining({ code: "blank_root_with_standalone_composition" }),
    );
    expect(payload.findings).toContainEqual(expect.objectContaining({ file: "scenes/intro.html" }));
    expect(payload.findings?.every((finding) => !finding.file?.startsWith(projectDir))).toBe(true);
  });
});

describe("host guarding on identity-bearing responses", () => {
  // NOTE: the SPA-injection branch itself is covered in telemetryIdentity.test.ts
  // via buildStudioHeadScriptsForHost. It cannot be asserted here: this route
  // only reaches the injection branch when packages/studio/dist is built,
  // which is true locally and false in the CI test lane, so a route-level
  // assertion on the returned HTML passes on a dev box and fails in CI.

  it("refuses the identity endpoint for a hostile Host", async () => {
    server = createStudioServer({ projectDir: tmpProject() });
    const res = await server.app.request("/api/telemetry-identity", {
      headers: { host: "evil.example.com" },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('distinctId":"');
  });

  it("serves the identity endpoint on a loopback Host", async () => {
    server = createStudioServer({ projectDir: tmpProject() });
    const res = await server.app.request("/api/telemetry-identity", {
      headers: { host: "127.0.0.1:5173" },
    });
    expect(res.status).toBe(200);
    // The seed is no longer served here at all — Studio gets decisions
    // injected instead, so nothing needs it over HTTP.
    expect(Object.keys((await res.json()) as object)).toEqual(["distinctId"]);
  });
});

// Studio asks this before it offers Export, so a machine without an encoder
// gets an install command up front instead of a 503 after the work is done.
describe("FFmpeg environment endpoint", () => {
  it("reports the cause and a pasteable command when FFmpeg is unusable", async () => {
    // A configured-but-missing override is the one "no FFmpeg" state a test can
    // force on a machine that does have FFmpeg installed.
    process.env.HYPERFRAMES_FFMPEG_PATH = join(tmpdir(), "hf-missing-ffmpeg");
    server = createStudioServer({ projectDir: tmpProject() });

    const res = await server.app.request("/api/environment/ffmpeg");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      title?: string;
      detail?: string;
      command?: string;
    };

    expect(body.ok).toBe(false);
    expect(body.title).toContain("not found");
    expect(body.detail).toBeTruthy();
    // Undefined only on platforms with no one-line install; CI runs none.
    expect(body.command).toBeTruthy();
  });

  // Needs a real FFmpeg: the check runs `-version` on whatever it resolves, so
  // a stand-in binary would only prove the stand-in works. Skipped rather than
  // faked on machines without one.
  it.skipIf(!findFFmpeg() || !findFFprobe())(
    "answers a plain ok when both binaries resolve",
    async () => {
      server = createStudioServer({ projectDir: tmpProject() });

      const res = await server.app.request("/api/environment/ffmpeg");

      expect(await res.json()).toEqual({ ok: true });
    },
  );
});

describe("Studio file-change SSE", () => {
  /** Opens `count` `/api/events` connections and waits for each to register its listener. */
  async function subscribe(count: number): Promise<ReadableStreamDefaultReader<Uint8Array>[]> {
    const responses = await Promise.all(
      Array.from({ length: count }, () => server!.app.request("/api/events")),
    );
    const streams = responses.map((response) => {
      const reader = response.body!.getReader();
      openReaders.push(reader);
      return reader;
    });
    // streamSSE runs its callback after the Response resolves, so the listener
    // each connection adds has to exist before the watcher fires.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return streams;
  }

  const nextEvent = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> =>
    new TextDecoder().decode((await reader.read()).value);

  /** The version as it appears inside the JSON-encoded SSE data line. */
  const encodedVersion = (content: string): string =>
    fileContentVersion(content).replaceAll('"', '\\"');

  /** A project whose preview has been loaded once, as an open Studio tab does on its first render. */
  async function previewedProject(): Promise<{ projectDir: string; projectUrl: string }> {
    const projectDir = tmpProject();
    mkdirSync(join(projectDir, "assets"));
    writeFileSync(join(projectDir, "assets", "logo.png"), "logo-v1");
    writeFileSync(
      join(projectDir, "index.html"),
      '<html><body><div data-composition-id="root"><img src="assets/logo.png"></div></body></html>',
    );
    server = createStudioServer({ projectDir });
    const projectUrl = `/api/projects/${encodeURIComponent(basename(projectDir))}`;
    expect((await server.app.request(`${projectUrl}/preview`)).status).toBe(200);
    expect((await server.app.request(`${projectUrl}/preview/assets/logo.png`)).status).toBe(200);
    return { projectDir, projectUrl };
  }

  it("marks a notes write as not affecting the preview, so the tab does not reload", async () => {
    const { projectDir } = await previewedProject();
    const [stream] = await subscribe(1);

    writeFileSync(join(projectDir, "notes.md"), "review notes");
    mockWatcher.emit("change", "rename", "notes.md");

    const payload = await nextEvent(stream!);
    expect(payload).toContain('"path":"notes.md"');
    expect(payload).toContain('"affectsPreview":false');
    expect(payload).toContain('"affectedCompositions":[]');
  });

  it("marks a write to an asset the preview loaded as affecting it", async () => {
    const { projectDir } = await previewedProject();
    const [stream] = await subscribe(1);

    writeFileSync(join(projectDir, "assets", "logo.png"), "logo-v2");
    mockWatcher.emit("change", "change", "assets/logo.png");

    expect(await nextEvent(stream!)).toContain('"affectsPreview":true');
  });

  it("reloads when a folder holding an asset the preview missed is moved in", async () => {
    const { projectDir, projectUrl } = await previewedProject();
    expect((await server!.app.request(`${projectUrl}/preview/media/clip.png`)).status).toBe(404);
    const [stream] = await subscribe(1);

    mkdirSync(join(projectDir, "media"));
    writeFileSync(join(projectDir, "media", "clip.png"), "clip");
    mockWatcher.emit("change", "rename", "media");

    const payload = await nextEvent(stream!);
    expect(payload).toContain('"path":"media"');
    expect(payload).toContain('"affectsPreview":true');
  });

  it("reloads when a folder holding an asset the preview loaded is moved out", async () => {
    const { projectDir } = await previewedProject();
    const [stream] = await subscribe(1);

    renameSync(join(projectDir, "assets"), join(tmpProject(), "assets"));
    mockWatcher.emit("change", "rename", "assets");

    expect(await nextEvent(stream!)).toContain('"affectsPreview":true');
  });

  it("still delivers a new file in a folder an old watchIgnore listed, for the file tree", async () => {
    const { projectDir } = await previewedProject();
    writeFileSync(
      join(projectDir, "hyperframes.json"),
      JSON.stringify({ preview: { watchIgnore: ["docs"] } }),
    );
    const [stream] = await subscribe(1);

    mkdirSync(join(projectDir, "docs"));
    writeFileSync(join(projectDir, "docs", "report.json"), "{}");
    mockWatcher.emit("change", "rename", "docs/report.json");

    const payload = await nextEvent(stream!);
    expect(payload).toContain('"path":"docs/report.json"');
    expect(payload).toContain('"affectsPreview":false');
  });

  it("counts every write as affecting the preview until the preview has loaded anything", async () => {
    const projectDir = tmpProject();
    writeFileSync(join(projectDir, "index.html"), "<html></html>");
    server = createStudioServer({ projectDir });
    const [stream] = await subscribe(1);

    writeFileSync(join(projectDir, "notes.md"), "notes");
    mockWatcher.emit("change", "rename", "notes.md");

    expect(await nextEvent(stream!)).toContain('"affectsPreview":true');
  });

  it("labels a Studio write for every open subscriber, not just the first", async () => {
    const projectDir = tmpProject();
    writeFileSync(join(projectDir, "index.html"), "<html>before</html>");
    server = createStudioServer({ projectDir });
    const streams = await subscribe(2);

    const written = "<html>after</html>";
    const write = await server.app.request(
      `/api/projects/${encodeURIComponent(basename(projectDir))}/files/index.html`,
      {
        method: "PUT",
        headers: {
          "If-Match": fileContentVersion("<html>before</html>"),
          "X-Hyperframes-Write-Token": "studio-write-1",
        },
        body: written,
      },
    );
    expect(write.status).toBe(200);
    mockWatcher.emit("change", "change", "index.html");

    for (const payload of await Promise.all(streams.map(nextEvent))) {
      expect(payload).toContain("studio-write-1");
      expect(payload).toContain(encodedVersion(written));
    }
  });

  it("still reports an external write with a version so subscribers can dedupe it", async () => {
    const projectDir = tmpProject();
    writeFileSync(join(projectDir, "index.html"), "<html>before</html>");
    server = createStudioServer({ projectDir });
    const streams = await subscribe(2);

    writeFileSync(join(projectDir, "index.html"), "<html>agent</html>");
    mockWatcher.emit("change", "change", "index.html");

    for (const payload of await Promise.all(streams.map(nextEvent))) {
      expect(payload).not.toContain("writeToken");
      expect(payload).toContain(encodedVersion("<html>agent</html>"));
    }
  });

  it("labels the deletion an undo from Studio makes with Studio's write token", async () => {
    const projectDir = tmpProject();
    writeFileSync(join(projectDir, "index.html"), "<html>before</html>");
    server = createStudioServer({ projectDir, historyRoot: tmpProject() });
    const history = `/api/projects/${encodeURIComponent(basename(projectDir))}/history`;
    const post = (path: string, body: object, headers: Record<string, string> = {}) =>
      server!.app.request(`${history}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    await server.app.request(history); // opens the history, as Studio's first load does
    writeFileSync(join(projectDir, "extra.html"), "<html>added</html>");
    await post("/claim", { label: "Added a section", paths: ["extra.html"] });
    const streams = await subscribe(1);

    await post("/step", { direction: "back" }, { "X-Hyperframes-Write-Token": "studio-undo-1" });
    expect(existsSync(join(projectDir, "extra.html"))).toBe(false);
    mockWatcher.emit("change", "rename", "extra.html");

    const [payload] = await Promise.all(streams.map(nextEvent));
    expect(payload).toContain("studio-undo-1");
  });

  // `/api/events` is one connection per SERVER, not per project: a tab left
  // open from a `preview` run whose port was later reused by a DIFFERENT
  // project shares this exact stream. Without `projectId` on the wire, that
  // stale tab cannot tell "my project changed" from "the other project this
  // server now serves changed" — see useExternalFileChangeCoordinator's
  // cross-project filter, which reads this field.
  it("labels every file-change with this server's project id", async () => {
    const projectDir = tmpProject();
    writeFileSync(join(projectDir, "index.html"), "<html>before</html>");
    server = createStudioServer({ projectDir, projectName: "demo-project" });
    const streams = await subscribe(1);

    writeFileSync(join(projectDir, "index.html"), "<html>agent</html>");
    mockWatcher.emit("change", "change", "index.html");

    const [payload] = await Promise.all(streams.map(nextEvent));
    expect(payload).toContain('"projectId":"demo-project"');
  });
});
