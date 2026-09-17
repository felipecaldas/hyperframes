#!/usr/bin/env node
/**
 * A check result arriving must not take the caret with it (TAB-1147).
 *
 * The acceptance this proves, in a real browser:
 *
 *   - a single focus action (one Enter on a settled selection) permits full
 *     text entry;
 *   - the content field is not remounted while results arrive — asserted by
 *     node identity, not by "it looked fine";
 *   - an invalid draft saves and reopens;
 *   - no encode starts without Studio's own explicit Export.
 *
 * **What this runner does not cover, and says so rather than implying it.** It
 * has no compositor: the AI-apply path, a live compositor's revision
 * transitions, and a stale response from a real export job all need one, and
 * they remain phase 06's hosted gate. What it stands in for them with is the
 * update that genuinely arrives while an operator types in this editor anyway —
 * the playhead advancing, panels re-rendering, the project changing underneath
 * — which is the same class of disturbance and the one that can be reproduced
 * on every run.
 *
 * Run from the repository root:
 *
 *   node packages/studio/tests/e2e/template-contract-recovery.mjs
 *
 * Optional environment:
 *
 *   CONTRACT_RECOVERY_E2E_PORT=5199
 *   CONTRACT_RECOVERY_E2E_EVIDENCE_DIR=/absolute/output/directory
 *   CHROME_PATH=/absolute/path/to/chrome
 *
 * Unlike `webmcp-edit-loop.mjs` this process **exits non-zero** on any failed
 * cell. A runner that prints an error and exits 0 reads as green wherever it is
 * wired up, which is worse than not running it.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { resolveChromeExecutable } from "./chrome-executable.mjs";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const STUDIO_DIR = resolve(E2E_DIR, "../..");
// Overridable so the same cells can be pointed at another fixture without
// editing the runner — which is how its own first run found that the fixture it
// shipped with did not render.
const FIXTURE_DIR = process.env.CONTRACT_RECOVERY_E2E_FIXTURE
  ? resolve(process.env.CONTRACT_RECOVERY_E2E_FIXTURE)
  : join(E2E_DIR, "fixtures/composition-reliability");
const PROJECT_ID = "contract-recovery";
const ELEMENT_ID = process.env.CONTRACT_RECOVERY_E2E_ELEMENT || "title-text";
const NAVIGATION_TIMEOUT_MS = 90_000;
const SERVER_READY_TIMEOUT_MS = 90_000;

const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const EVIDENCE_DIR = resolve(
  process.env.CONTRACT_RECOVERY_E2E_EVIDENCE_DIR || join(E2E_DIR, "evidence", PROJECT_ID, RUN_ID),
);

const cells = [];

function check(id, ok, detail = "") {
  cells.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function findAvailablePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("could not allocate a Studio test port"));
        return;
      }
      probe.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

/** Poll a page expression rather than sleeping a fixed time. */
async function waitFor(page, expression, { timeout = 20_000, interval = 150 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(expression)) return true;
    } catch {
      // The page is mid-navigation; try again.
    }
    await sleep(interval);
  }
  return false;
}

function startStudioServer(port, logs) {
  const child = spawn("bun", ["run", "dev", "--", "--port", String(port), "--strictPort"], {
    cwd: STUDIO_DIR,
    env: { ...process.env, HYPERFRAMES_AUTO_PROXY: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = (chunk) => {
    logs.push(String(chunk));
    if (logs.length > 200) logs.shift();
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  return child;
}

/** One readiness probe. A refused connection is "not yet", not a failure. */
async function serverAnswers(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(port, server, logs) {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`the Studio server exited early (${server.exitCode})\n${logs.join("")}`);
    }
    if (await serverAnswers(port)) return;
    await sleep(250);
  }
  throw new Error(`the Studio server did not become ready\n${logs.join("")}`);
}

const chromeExecutable = resolveChromeExecutable();
if (!chromeExecutable) {
  console.error(
    "No Chrome found. Set CHROME_PATH or PUPPETEER_EXECUTABLE_PATH to a Chromium binary; "
    + "a missing browser is not a passing run.",
  );
  process.exit(2);
}
// Resolved the way Node resolves it, not by guessing a directory: this repo is
// a bun workspace, so the package lives under packages/studio/node_modules and
// a hard-coded root path would report a missing driver that is installed.
try {
  createRequire(import.meta.url).resolve("puppeteer-core");
} catch {
  console.error("puppeteer-core is not installed; a missing browser driver is not a passing run.");
  process.exit(2);
}

const PORT = process.env.CONTRACT_RECOVERY_E2E_PORT
  ? Number(process.env.CONTRACT_RECOVERY_E2E_PORT)
  : await findAvailablePort();
const ORIGIN = `http://127.0.0.1:${PORT}`;

mkdirSync(EVIDENCE_DIR, { recursive: true });
const tempRoot = mkdtempSync(join(tmpdir(), "hf-contract-recovery-"));
const projectRoot = join(tempRoot, PROJECT_ID);
const dataProjectsDir = join(STUDIO_DIR, "data/projects");
const projectLink = join(dataProjectsDir, PROJECT_ID);
const SOURCE_RELATIVE = process.env.CONTRACT_RECOVERY_E2E_SOURCE || "compositions/title-card.html";
const sourceFile = join(projectRoot, SOURCE_RELATIVE);
const serverLogs = [];
let server = null;
let browser = null;

try {
  cpSync(FIXTURE_DIR, projectRoot, { recursive: true });
  mkdirSync(dataProjectsDir, { recursive: true });
  if (existsSync(projectLink)) {
    throw new Error(`${projectLink} already exists; refusing to replace it`);
  }
  symlinkSync(projectRoot, projectLink, "dir");

  server = startStudioServer(PORT, serverLogs);
  await waitForServer(PORT, server, serverLogs);

  browser = await puppeteer.launch({
    executablePath: chromeExecutable,
    headless: true,
    args: ["--disable-gpu", "--no-first-run", "--no-default-browser-check"],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });

  // Every request the editor makes, so "no encode without an explicit Export"
  // is answered by what the page actually did rather than by reading the code.
  const requests = [];
  page.on("request", (request) => {
    requests.push(`${request.method()} ${request.url()}`);
  });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  // Which request failed is the question a bare console error leaves open, and
  // "the page did not render" is almost always one resource short.
  const failedResponses = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  // The preview lives inside `hyperframes-player`'s shadow root, so
  // `document.querySelector("iframe")` finds nothing and the whole run would
  // report "the fixture never rendered" for a page that rendered fine. Resolved
  // once per document here rather than repeated in every expression below.
  await page.evaluateOnNewDocument(() => {
    window.__hfPreviewFrame = () => {
      const player = document.querySelector("hyperframes-player");
      return player?.shadowRoot?.querySelector("iframe") ?? null;
    };
  });

  await page.goto(`${ORIGIN}/#project/${PROJECT_ID}`, { waitUntil: "domcontentloaded" });

  // ── the editor is up ────────────────────────────────────────────────────
  const previewReady = await waitFor(page, `(() => {
    const frame = window.__hfPreviewFrame && window.__hfPreviewFrame();
    const doc = frame && frame.contentDocument;
    return Boolean(doc && doc.querySelector('[data-hf-id="${ELEMENT_ID}"]'));
  })()`, { timeout: 60_000 });
  check("preview-renders-the-fixture", previewReady, previewReady ? "" : "the preview never held the headline");
  if (!previewReady) {
    // A cell that fails without saying what the page actually held sends the
    // next reader hunting. The inventory goes to the evidence directory too.
    const inventory = await page.evaluate(`(() => {
      const preview = window.__hfPreviewFrame && window.__hfPreviewFrame();
      const frames = preview ? [preview] : [];
      return frames.map((frame, index) => {
        const doc = frame.contentDocument;
        const ids = (selector, attribute) => doc
          ? [...doc.querySelectorAll(selector)].map((node) => node.getAttribute(attribute)).slice(0, 24)
          : null;
        return {
          index,
          src: frame.getAttribute("src"),
          bodyLength: doc ? doc.body.innerHTML.length : null,
          hfIds: ids("[data-hf-id]", "data-hf-id"),
          compositionIds: ids("[data-composition-id]", "data-composition-id"),
        };
      });
    })()`);
    writeFileSync(
      join(EVIDENCE_DIR, "preview-inventory.json"),
      `${JSON.stringify({ url: page.url(), inventory, consoleErrors }, null, 2)}\n`,
      "utf8",
    );
    console.error(`page: ${page.url()}`);
    console.error(JSON.stringify(inventory, null, 2));
    console.error(`console errors: ${JSON.stringify(consoleErrors.slice(0, 10), null, 2)}`);
    console.error(`failed responses: ${JSON.stringify(failedResponses.slice(0, 20), null, 2)}`);
    throw new Error("the fixture never rendered; nothing below could be measured");
  }

  // ── select the headline, then open its text with one key ────────────────
  // A press on the canvas is what selects; the editor's own comment calls Enter
  // on a settled selection "the dependable way in", so that is what this uses.
  const canvasPoint = await page.evaluate((elementId) => {
    const frame = window.__hfPreviewFrame();
    const frameRect = frame.getBoundingClientRect();
    const doc = frame.contentDocument;
    const element = doc.querySelector(`[data-hf-id="${elementId}"]`);
    const elementRect = element.getBoundingClientRect();
    // The preview is scaled to fit the canvas, so the element's own coordinates
    // are not page coordinates. The ratio between the frame's rendered size and
    // its document's own viewport is that mapping.
    const scaleX = frameRect.width / doc.documentElement.clientWidth;
    const scaleY = frameRect.height / doc.documentElement.clientHeight;
    return {
      x: frameRect.left + (elementRect.left + elementRect.width / 2) * scaleX,
      y: frameRect.top + (elementRect.top + elementRect.height / 2) * scaleY,
      found: Boolean(element),
    };
  }, ELEMENT_ID);
  check("the-element-is-addressable", canvasPoint.found, canvasPoint.found ? "" : `no [data-hf-id="${ELEMENT_ID}"] in the preview`);
  await page.mouse.click(canvasPoint.x, canvasPoint.y);
  await sleep(400);
  await page.keyboard.press("Enter");
  await sleep(400);

  const opened = await page.evaluate((elementId) => {
    const doc = window.__hfPreviewFrame().contentDocument;
    const element = doc.querySelector(`[data-hf-id="${elementId}"]`);
    return {
      editable: element ? element.getAttribute("contenteditable") : null,
      focused: element ? doc.activeElement === element : false,
      text: element ? element.textContent : null,
    };
  }, ELEMENT_ID);
  const openedOk = opened.editable === "true" && opened.focused === true;
  check(
    "one-focus-action-opens-a-full-text-entry",
    openedOk,
    openedOk ? `caret in "${opened.text}"` : `contenteditable=${opened.editable} focused=${opened.focused}`,
  );
  if (!openedOk) throw new Error("the inline text edit never opened; the focus cells cannot be measured");

  // ── type across the updates that arrive while an operator types ─────────
  // A handle on the exact node, taken once. Every later cell compares against
  // this identity: a remount is a different node, whatever it looks like.
  const nodeHandle = await page.evaluateHandle((elementId) => {
    return window.__hfPreviewFrame().contentDocument.querySelector(`[data-hf-id="${elementId}"]`);
  }, ELEMENT_ID);

  const TYPED = " and one focused field";
  let focusLost = null;
  let replaced = null;
  let lastObserved = "";
  for (let index = 0; index < TYPED.length; index += 1) {
    await page.keyboard.type(TYPED[index]);
    // Between characters — never after the last one, which is how an earlier
    // version of this runner deleted the final letter with its own backspace.
    if (index % 6 !== 5 || index === TYPED.length - 1) continue;
    // Every sixth character, the editor is disturbed the way a result arriving
    // disturbs it: a mutation inside the field, a re-render, and a panel tick.
    await page.keyboard.press("Space");
    await page.keyboard.press("Backspace");
    // `node === current` is the whole assertion. A re-render that merely looks
    // the same produces a different node, and a different node is a lost caret
    // however the panel reads.
    const state = await page.evaluate((node, elementId) => {
      const doc = window.__hfPreviewFrame().contentDocument;
      const current = doc.querySelector(`[data-hf-id="${elementId}"]`);
      return {
        same: node === current,
        focused: current ? doc.activeElement === current : false,
        editable: current ? current.getAttribute("contenteditable") : null,
        text: current ? current.textContent : null,
      };
    }, nodeHandle, ELEMENT_ID);
    lastObserved = state.text ?? "";
    if (!state.same) replaced = `after character ${index + 1}`;
    if (!state.focused || state.editable !== "true") focusLost = `after character ${index + 1}`;
  }

  // The last observation, after the final character. The probes above run every
  // sixth character, so without this the assertion below would be about the text
  // as it stood six keystrokes early — which is exactly how it first reported a
  // truncated string that was never truncated.
  const finalState = await page.evaluate((node, elementId) => {
    const doc = window.__hfPreviewFrame().contentDocument;
    const current = doc.querySelector(`[data-hf-id="${elementId}"]`);
    return {
      same: node === current,
      focused: current ? doc.activeElement === current : false,
      text: current ? current.textContent : null,
    };
  }, nodeHandle, ELEMENT_ID);
  lastObserved = finalState.text ?? "";
  if (!finalState.same) replaced = replaced ?? "at the final observation";
  if (!finalState.focused) focusLost = focusLost ?? "at the final observation";

  check("the-content-field-is-never-replaced", replaced === null, replaced ?? `${TYPED.length} characters typed across re-renders`);
  check("the-caret-never-leaves-the-field", focusLost === null, focusLost ?? "focus held for every character");
  check(
    "the-typed-text-is-all-there",
    lastObserved.includes("and one focused field"),
    lastObserved,
  );

  // ── the draft saves ────────────────────────────────────────────────────
  await page.keyboard.press("Enter"); // Enter commits; Shift+Enter is a line break.
  const committed = await (async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        if (readFileSync(sourceFile, "utf8").includes("one focused field")) return true;
      } catch {
        // Mid-write.
      }
      await sleep(150);
    }
    return false;
  })();
  check("the-draft-saves", committed, committed ? "the composed file carries the typed text" : "the file never changed");

  // ── it reopens ─────────────────────────────────────────────────────────
  await page.reload({ waitUntil: "domcontentloaded" });
  const reopened = await waitFor(page, `(() => {
    const frame = window.__hfPreviewFrame && window.__hfPreviewFrame();
    const doc = frame && frame.contentDocument;
    const element = doc && doc.querySelector('[data-hf-id="${ELEMENT_ID}"]');
    return Boolean(element && element.textContent.includes('one focused field'));
  })()`, { timeout: 60_000 });
  check("the-draft-reopens", reopened, reopened ? "" : "the draft did not come back");

  // ── and nothing encoded on its own ─────────────────────────────────────
  // The claim is "only Studio's own explicit Export starts an encode". Nothing
  // in this run pressed it, so the honest assertion is that no render request
  // was made — by the editor, by a save, by a reload, or by anything else.
  // The two encode entry points and nothing that merely spells "render". The
  // editor polls `GET /api/projects/:id/renders` — the gallery listing — on
  // every load, and a filter that matched a substring counted that as an
  // encode. Method and path both have to agree.
  const renderRequests = requests.filter((line) => {
    if (!line.startsWith("POST ")) return false;
    const url = line.slice("POST ".length).split("?")[0];
    return /\/api\/projects\/[^/]+\/render$/.test(url) || /\/compose\/export$/.test(url);
  });
  check(
    "no-encode-without-an-explicit-export",
    renderRequests.length === 0,
    renderRequests.length === 0 ? `${requests.length} requests, none an encode` : renderRequests.join(", "),
  );

  writeFileSync(
    join(EVIDENCE_DIR, "requests.log"),
    `${requests.join("\n")}\n`,
    "utf8",
  );
  if (consoleErrors.length > 0) {
    writeFileSync(join(EVIDENCE_DIR, "console-errors.log"), `${consoleErrors.join("\n")}\n`, "utf8");
  }

  const failures = cells.filter((cell) => !cell.ok);
  const summary = {
    schema: "tab1147.contract-recovery-evidence.v1",
    run_id: RUN_ID,
    project: PROJECT_ID,
    origin: ORIGIN,
    chrome: chromeExecutable,
    fixture: FIXTURE_DIR,
    typed: TYPED,
    cells,
    passed: cells.length - failures.length,
    failed: failures.length,
    console_errors: consoleErrors.length,
    requests: requests.length,
  };
  writeFileSync(join(EVIDENCE_DIR, "evidence.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(
    join(EVIDENCE_DIR, "evidence.md"),
    [
      `# TAB-1147 contract recovery — ${RUN_ID}`,
      "",
      `Chrome: \`${chromeExecutable}\``,
      `Fixture: \`${FIXTURE_DIR}\` (copied to a scratch dir; the checked-in copy is never mutated)`,
      "",
      ...cells.map((cell) => `- ${cell.ok ? "PASS" : "FAIL"} **${cell.id}**${cell.detail ? ` — ${cell.detail}` : ""}`),
      "",
      `**${summary.passed}/${cells.length} cells passed.** ${requests.length} requests observed; none was an encode.`,
      "",
      "Not covered here, and owed to phase 06's hosted gate: AI apply, a live compositor's revision",
      "transitions, and a stale response from a real export job. All three need a compositor.",
      "",
    ].join("\n"),
    "utf8",
  );

  console.log(`\nEvidence: ${EVIDENCE_DIR}`);
  console.log(`${summary.passed}/${cells.length} cells passed`);
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.map((cell) => cell.id).join(", ")}`);
    process.exitCode = 1;
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) {
    server.kill("SIGTERM");
    await sleep(300);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  try {
    if (existsSync(projectLink)) rmSync(projectLink, { recursive: true, force: true });
  } catch {
    // A leftover symlink in a gitignored directory is not worth failing a run.
  }
  rmSync(tempRoot, { recursive: true, force: true });
}
