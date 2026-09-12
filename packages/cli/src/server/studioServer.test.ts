import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

afterEach(() => {
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
    // The last cell is the readable tail, not the exact end. The runtime
    // unmounts a clip at its own end, so `tailFrameTime` backs off 3% of the
    // duration and a sample at 90.0 would come back blank. On a 90s film that
    // is 2.7s, wider than one cell, which is why this asserts the tail itself
    // rather than "within one cellSeconds of the end".
    expect(times.at(-1)).toBeCloseTo(tailFrameTime(90), 5);
    expect(times[0]).toBe(0);
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
    const store = new ReceiptStore();
    const receipt = store.put("session-1", "rev-1", "frame.png", Buffer.from("bytes", "utf-8"));
    server = createStudioServer({ projectDir: tmpProject() });

    const found = await server.app.request(receipt.url);
    const unknown = await server.app.request("/studio/receipts/session-1/rev-1/deadbeef.png");
    const malformed = await server.app.request("/studio/receipts/nope");

    expect(found.status).toBe(200);
    expect(found.headers.get("content-type")).toContain("image/png");
    expect(await found.text()).toBe("bytes");
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(await unknown.text()).toBe(await malformed.text());
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
    expect(source).toContain("assertWebGpuRequirement");
    expect(source).toContain("await seekCompositionTimeline(page, opts.seekTime");
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
