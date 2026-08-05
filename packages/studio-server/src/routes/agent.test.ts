// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioApi } from "../createStudioApi.js";
import type { StudioApiAdapter } from "../types.js";

const INITIAL_HTML = '<html data-composition-id="fixture"><body>before</body></html>\n';

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "hf-agent-api-"));
  const projectDir = join(root, "project");
  const binDir = join(root, "bin");
  const captureDir = join(root, "capture");
  mkdirSync(projectDir);
  mkdirSync(binDir);
  mkdirSync(captureDir);
  writeFileSync(join(projectDir, "index.html"), INITIAL_HTML);
  const fake = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("codex-cli 1.0"); process.exit(0); }
if (args[0] === "login" && args[1] === "status") { console.log("Logged in using fixture"); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  fs.appendFileSync(path.join(process.env.FAKE_CAPTURE_DIR, "args.jsonl"), JSON.stringify(args) + "\\n");
  fs.appendFileSync(path.join(process.env.FAKE_CAPTURE_DIR, "prompts.txt"), input + "\\n---\\n");
  if (input.includes("EARLY_UNSUPPORTED")) fs.writeFileSync("unexpected.bin", Buffer.from([1,2,3]));
  if (input.includes("HANG_AFTER_EDIT")) {
    fs.writeFileSync("index.html", '<html data-composition-id="fixture"><body>partial edit</body></html>\\n');
    setInterval(() => {}, 1000);
    return;
  }
  if (input.includes("NO_CHANGES")) {
    console.log(JSON.stringify({type:"thread.started",thread_id:"11111111-1111-4111-8111-111111111111"}));
    console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"I could not apply the requested edit."}}));
    return;
  }
  const finish = () => {
    if (input.includes("UNSUPPORTED")) fs.writeFileSync("unexpected.bin", Buffer.from([1,2,3]));
    else fs.writeFileSync("index.html", '<html data-composition-id="fixture"><body>' + input + '</body></html>\\n');
    console.log(JSON.stringify({type:"thread.started",thread_id:"11111111-1111-4111-8111-111111111111"}));
    console.log(JSON.stringify({type:"item.completed",item:{type:"command_execution",command:"edit index.html"}}));
    console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Fixture agent finished."}}));
  };
  if (input.includes("WAIT")) setTimeout(finish, 250); else finish();
});
`;
  writeFileSync(join(binDir, "codex"), fake);
  chmodSync(join(binDir, "codex"), 0o755);
  const fakeClaude = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("claude 1.0"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") { console.log('{"loggedIn":true}'); process.exit(0); }
console.log('{"type":"system","session_id":"22222222-2222-4222-8222-222222222222"}');
console.log('{"type":"result","result":"Claude fixture finished.","session_id":"22222222-2222-4222-8222-222222222222"}');
`;
  writeFileSync(join(binDir, "claude"), fakeClaude);
  chmodSync(join(binDir, "claude"), 0o755);
  return { root, projectDir, binDir, captureDir };
}

function makeAdapter(projectDir: string): StudioApiAdapter {
  return {
    listProjects: () => [{ id: "demo", dir: projectDir }],
    resolveProject: (id) => (id === "demo" ? { id, dir: projectDir } : null),
    bundle: async () => null,
    lint: (html) => ({
      findings: html.includes("LINT_ERROR")
        ? [{ severity: "error", message: "fixture lint error" }]
        : [],
    }),
    runtimeUrl: "/runtime.js",
    rendersDir: () => join(projectDir, "renders"),
    startRender: () => {
      throw new Error("not used");
    },
    installRegistryBlock: async ({ blockName }) => {
      const path = `compositions/${blockName}.html`;
      mkdirSync(join(projectDir, "compositions"), { recursive: true });
      writeFileSync(join(projectDir, path), `<html>${blockName}</html>`);
      return {
        written: [path],
        block: {
          name: blockName,
          title: blockName,
          description: "fixture",
          type: "hyperframes:block",
          files: [],
        },
      };
    },
  };
}

function requestHeaders(nonce?: string): Record<string, string> {
  return {
    Host: "localhost",
    Origin: "http://localhost",
    ...(nonce ? { "Content-Type": "application/json", "X-Hyperframes-Agent-Nonce": nonce } : {}),
  };
}

async function capabilities(app: ReturnType<typeof createStudioApi>) {
  const response = await app.request("http://localhost/projects/demo/agent/capabilities", {
    headers: requestHeaders(),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { enabled: boolean; nonce: string };
}

async function startRun(
  app: ReturnType<typeof createStudioApi>,
  nonce: string,
  prompt: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const response = await app.request("http://localhost/projects/demo/agent/runs", {
    method: "POST",
    headers: requestHeaders(nonce),
    body: JSON.stringify({ provider: "codex", kind: "chat", prompt, ...extra }),
  });
  expect(response.status).toBe(202);
  const body = (await response.json()) as { jobId: string };
  return body.jobId;
}

async function finishRun(app: ReturnType<typeof createStudioApi>, jobId: string): Promise<string> {
  const response = await app.request(`http://localhost/agent/runs/${jobId}/events`, {
    headers: requestHeaders(),
  });
  expect(response.status).toBe(200);
  return response.text();
}

function undoRun(app: ReturnType<typeof createStudioApi>, jobId: string, nonce: string) {
  return app.request(`http://localhost/agent/runs/${jobId}/undo`, {
    method: "POST",
    headers: requestHeaders(nonce),
    body: "{}",
  });
}

async function expectCodexThreadInvalidated(
  app: ReturnType<typeof createStudioApi>,
): Promise<void> {
  const threads = await app.request("http://localhost/projects/demo/agent/threads", {
    headers: requestHeaders(),
  });
  const body = (await threads.json()) as { threads: AgentThreadSummaryFixture[] };
  expect(body.threads.find((thread) => thread.provider === "codex")?.invalidated).toBe(true);
}

describe("Agent Bridge API", () => {
  const previousPath = process.env.PATH;
  const previousState = process.env.HYPERFRAMES_STATE_DIR;
  const previousCapture = process.env.FAKE_CAPTURE_DIR;
  const previousIdleTimeout = process.env.HYPERFRAMES_AGENT_IDLE_TIMEOUT_MS;
  const previousMaxRuntime = process.env.HYPERFRAMES_AGENT_MAX_RUNTIME_MS;
  let fixture: ReturnType<typeof makeFixture>;

  beforeEach(() => {
    fixture = makeFixture();
    process.env.PATH = `${fixture.binDir}:${previousPath ?? ""}`;
    process.env.HYPERFRAMES_STATE_DIR = join(fixture.root, "state");
    process.env.FAKE_CAPTURE_DIR = fixture.captureDir;
  });

  afterEach(() => {
    process.env.PATH = previousPath;
    process.env.HYPERFRAMES_STATE_DIR = previousState;
    process.env.FAKE_CAPTURE_DIR = previousCapture;
    if (previousIdleTimeout === undefined) delete process.env.HYPERFRAMES_AGENT_IDLE_TIMEOUT_MS;
    else process.env.HYPERFRAMES_AGENT_IDLE_TIMEOUT_MS = previousIdleTimeout;
    if (previousMaxRuntime === undefined) delete process.env.HYPERFRAMES_AGENT_MAX_RUNTIME_MS;
    else process.env.HYPERFRAMES_AGENT_MAX_RUNTIME_MS = previousMaxRuntime;
    vi.restoreAllMocks();
  });

  it("enforces loopback, same-origin, JSON, nonce, provider and prompt limits", async () => {
    const app = createStudioApi(makeAdapter(fixture.projectDir));
    const cap = await capabilities(app);
    expect(cap.enabled).toBe(true);

    const noNonce = await app.request("http://localhost/projects/demo/agent/runs", {
      method: "POST",
      headers: {
        Host: "localhost",
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider: "codex", kind: "chat", prompt: "hi" }),
    });
    expect(noNonce.status).toBe(403);

    const crossOrigin = await app.fetch(
      new Request("http://localhost/projects/demo/agent/threads/reset", {
        method: "POST",
        headers: {
          ...requestHeaders(cap.nonce),
          origin: "http://evil.example",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({ provider: "codex" }),
      }),
    );
    expect(crossOrigin.status, await crossOrigin.clone().text()).toBe(403);

    const oversized = await app.request("http://localhost/projects/demo/agent/runs", {
      method: "POST",
      headers: requestHeaders(cap.nonce),
      body: JSON.stringify({ provider: "codex", kind: "chat", prompt: "x".repeat(128 * 1024 + 1) }),
    });
    expect(oversized.status).toBe(413);

    const lan = await app.request("http://192.168.1.2/projects/demo/agent/capabilities", {
      headers: { Host: "192.168.1.2" },
    });
    expect((await lan.json()) as { enabled: boolean }).toMatchObject({ enabled: false });
  });

  it("stays unavailable when the hosting adapter is LAN-bound", async () => {
    const adapter = makeAdapter(fixture.projectDir);
    adapter.agentBridgeEnabled = false;
    const app = createStudioApi(adapter);

    const response = await app.request("http://localhost/projects/demo/agent/capabilities");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: false });

    const mutation = await app.request("http://localhost/projects/demo/agent/threads/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "codex" }),
    });
    expect(mutation.status).toBe(403);
  });

  it("streams a run, preserves prompt bytes, resumes its provider thread, and locks writes", async () => {
    const app = createStudioApi(makeAdapter(fixture.projectDir));
    const cap = await capabilities(app);
    const injection = "WAIT $(touch should-not-exist) LINT_ERROR";
    const jobId = await startRun(app, cap.nonce, injection);

    const locked = await app.request("http://localhost/projects/demo/files/index.html", {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "studio write",
    });
    expect(locked.status).toBe(423);

    const stream = await finishRun(app, jobId);
    expect(stream).toContain("event: assistant");
    expect(stream).toContain("event: changed-files");
    expect(stream).toContain("event: lint");
    expect(stream).toContain("event: complete");
    expect(existsSync(join(fixture.projectDir, "should-not-exist"))).toBe(false);
    expect(readFileSync(join(fixture.captureDir, "prompts.txt"), "utf-8")).toContain(injection);

    const secondId = await startRun(app, cap.nonce, "follow-up");
    await finishRun(app, secondId);
    const args = readFileSync(join(fixture.captureDir, "args.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(args[1]).toContain("resume");
    expect(args[1]).toContain('sandbox_mode="workspace-write"');
    expect(args[1]).toContain("11111111-1111-4111-8111-111111111111");
  });

  it("fails an edit-oriented run that exits without changing project files", async () => {
    const app = createStudioApi(makeAdapter(fixture.projectDir));
    const cap = await capabilities(app);
    const jobId = await startRun(app, cap.nonce, "NO_CHANGES", {
      kind: "storyboard-feedback",
    });

    const stream = await finishRun(app, jobId);
    expect(stream).toContain("event: assistant");
    expect(stream).toContain("I could not apply the requested edit.");
    expect(stream).toContain("event: lint");
    expect(stream).toContain("event: failure");
    expect(stream).toContain(
      "codex finished without changing project files for this storyboard-feedback request.",
    );
    expect(stream).not.toContain("event: complete");
    expect(readFileSync(join(fixture.projectDir, "index.html"), "utf-8")).toBe(INITIAL_HTML);

    const unlocked = await app.request("http://localhost/projects/demo/files/index.html", {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "studio write after no-op",
    });
    expect(unlocked.status).not.toBe(423);
  });

  it("treats registry installation and source edits as one byte-identical undo transaction", async () => {
    const app = createStudioApi(makeAdapter(fixture.projectDir));
    const cap = await capabilities(app);
    const jobId = await startRun(app, cap.nonce, "integrate neon accent", {
      kind: "catalog",
      registryItem: "neon-accent",
    });
    await finishRun(app, jobId);
    expect(existsSync(join(fixture.projectDir, "compositions/neon-accent.html"))).toBe(true);
    expect(readFileSync(join(fixture.projectDir, "index.html"), "utf-8")).not.toBe(INITIAL_HTML);

    const undo = await undoRun(app, jobId, cap.nonce);
    expect(undo.status).toBe(200);
    expect(readFileSync(join(fixture.projectDir, "index.html"), "utf-8")).toBe(INITIAL_HTML);
    expect(existsSync(join(fixture.projectDir, "compositions/neon-accent.html"))).toBe(false);

    await expectCodexThreadInvalidated(app);
  });

  it("returns 409 without restoring anything when a post-run file has changed", async () => {
    const app = createStudioApi(makeAdapter(fixture.projectDir));
    const cap = await capabilities(app);
    const jobId = await startRun(app, cap.nonce, "first edit");
    await finishRun(app, jobId);
    writeFileSync(join(fixture.projectDir, "index.html"), "concurrent user edit");
    const undo = await undoRun(app, jobId, cap.nonce);
    expect(undo.status).toBe(409);
    expect(readFileSync(join(fixture.projectDir, "index.html"), "utf-8")).toBe(
      "concurrent user edit",
    );
  });

  it("times out an inactive provider, unlocks the project, preserves Undo, and invalidates its thread", async () => {
    process.env.HYPERFRAMES_AGENT_IDLE_TIMEOUT_MS = "40";
    process.env.HYPERFRAMES_AGENT_MAX_RUNTIME_MS = "1000";
    const app = createStudioApi(makeAdapter(fixture.projectDir));
    const cap = await capabilities(app);
    const jobId = await startRun(app, cap.nonce, "HANG_AFTER_EDIT");

    const stream = await finishRun(app, jobId);
    expect(stream).toContain("event: failure");
    expect(stream).toContain("timed out after 40 ms without activity");
    expect(stream).toContain("event: changed-files");
    expect(stream).toContain("event: lint");
    expect(readFileSync(join(fixture.projectDir, "index.html"), "utf-8")).toContain("partial edit");

    const unlocked = await app.request("http://localhost/projects/demo/files/index.html", {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "studio write after timeout",
    });
    expect(unlocked.status).not.toBe(423);
    writeFileSync(
      join(fixture.projectDir, "index.html"),
      '<html data-composition-id="fixture"><body>partial edit</body></html>\n',
    );

    await expectCodexThreadInvalidated(app);

    const undo = await undoRun(app, jobId, cap.nonce);
    expect(undo.status).toBe(200);
    expect(readFileSync(join(fixture.projectDir, "index.html"), "utf-8")).toBe(INITIAL_HTML);
  });

  it("cancels partial work and reports unsupported changes as critical with no Undo claim", async () => {
    const app = createStudioApi(makeAdapter(fixture.projectDir));
    const cap = await capabilities(app);
    const cancelId = await startRun(app, cap.nonce, "WAIT cancellation");
    const cancel = await app.request(`http://localhost/agent/runs/${cancelId}/cancel`, {
      method: "POST",
      headers: requestHeaders(cap.nonce),
      body: "{}",
    });
    expect(cancel.status).toBe(200);
    expect(await finishRun(app, cancelId)).toContain("event: cancelled");

    const criticalCancelId = await startRun(app, cap.nonce, "EARLY_UNSUPPORTED WAIT cancellation");
    for (
      let attempt = 0;
      attempt < 20 && !existsSync(join(fixture.projectDir, "unexpected.bin"));
      attempt++
    ) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    const criticalCancel = await app.request(
      `http://localhost/agent/runs/${criticalCancelId}/cancel`,
      {
        method: "POST",
        headers: requestHeaders(cap.nonce),
        body: "{}",
      },
    );
    expect(criticalCancel.status).toBe(200);
    const criticalStream = await finishRun(app, criticalCancelId);
    expect(criticalStream).toContain("event: failure");
    expect(criticalStream).toContain('"critical":true');
    unlinkSync(join(fixture.projectDir, "unexpected.bin"));

    const unsupportedId = await startRun(app, cap.nonce, "UNSUPPORTED");
    const stream = await finishRun(app, unsupportedId);
    expect(stream).toContain("event: failure");
    expect(stream).toContain('"critical":true');
    const undo = await app.request(`http://localhost/agent/runs/${unsupportedId}/undo`, {
      method: "POST",
      headers: requestHeaders(cap.nonce),
      body: "{}",
    });
    expect(undo.status).toBe(409);
  });
});

interface AgentThreadSummaryFixture {
  provider: "codex" | "claude";
  invalidated: boolean;
}
