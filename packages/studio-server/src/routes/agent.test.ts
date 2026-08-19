// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioApi } from "../createStudioApi.js";
import type { StudioApiAdapter } from "../types.js";

const INITIAL_HTML = '<html data-composition-id="fixture"><body>before</body></html>\n';
/** A project that already fails lint, as every real one does (TAB-780). */
const INHERITED_HTML =
  '<html data-composition-id="fixture"><body>INHERITED_ERROR before</body></html>\n';

function completion(content: string, toolCalls: unknown[] = []): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content, tool_calls: toolCalls } }] }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tabario-agent-api-"));
  const projectDir = join(root, "project");
  mkdirSync(join(projectDir, "compositions"), { recursive: true });
  writeFileSync(join(projectDir, "index.html"), INITIAL_HTML);
  return { root, projectDir };
}

/**
 * Seed the shared fixture project with HTML of our choosing.
 *
 * TAB-780's cases need a project that *already* fails lint before the run, which
 * is the situation in production — sub-compositions are linted without the
 * parent that supplies their runtime, so every real project starts non-clean.
 */
function seedProject(setupDir: string, html: string): string {
  writeFileSync(join(setupDir, "index.html"), html);
  return createHash("sha256").update(html).digest("hex");
}

function adapter(projectDir: string): StudioApiAdapter {
  return {
    listProjects: () => [{ id: "demo", dir: projectDir }],
    resolveProject: (id) => (id === "demo" ? { id, dir: projectDir } : null),
    bundle: () => null,
    lint: (html) => ({
      // INHERITED_ERROR stands in for a lint error the project already had —
      // in production that is every `compositions/scene-N.html`, which reports
      // "uses GSAP but no GSAP script is loaded" because sub-compositions are
      // linted without the parent that supplies their runtime.
      findings: [
        ...(html.includes("LINT_ERROR")
          ? [{ severity: "error", message: "fixture lint error" }]
          : []),
        ...(html.includes("INHERITED_ERROR")
          ? [{ severity: "error", message: "pre-existing fixture error" }]
          : []),
      ],
    }),
    runtimeUrl: "/runtime.js",
    rendersDir: () => join(projectDir, "renders"),
    startRender: () => {
      throw new Error("unused");
    },
    installRegistryBlock: async ({ project, blockName }) => {
      const path = `compositions/${blockName}.html`;
      mkdirSync(join(project.dir, "compositions"), { recursive: true });
      writeFileSync(join(project.dir, path), `<html>${blockName}</html>\n`);
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

function headers(nonce?: string): Record<string, string> {
  return {
    Host: "localhost",
    Origin: "http://localhost",
    ...(nonce ? { "Content-Type": "application/json", "X-Hyperframes-Agent-Nonce": nonce } : {}),
  };
}

async function nonce(app: ReturnType<typeof createStudioApi>): Promise<string> {
  const response = await app.request("http://localhost/projects/demo/agent/capabilities", {
    headers: headers(),
  });
  const body = (await response.json()) as {
    enabled: boolean;
    nonce: string;
    providers: { tabario: { available: boolean } };
  };
  expect(body).toMatchObject({ enabled: true, providers: { tabario: { available: true } } });
  return body.nonce;
}

async function start(
  app: ReturnType<typeof createStudioApi>,
  token: string,
  prompt: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const response = await app.request("http://localhost/projects/demo/agent/runs", {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ provider: "tabario", kind: "chat", prompt, ...extra }),
  });
  expect(response.status, await response.clone().text()).toBe(202);
  return ((await response.json()) as { jobId: string }).jobId;
}

async function events(app: ReturnType<typeof createStudioApi>, jobId: string): Promise<string> {
  const response = await app.request(`http://localhost/agent/runs/${jobId}/events`, {
    headers: headers(),
  });
  expect(response.status).toBe(200);
  return response.text();
}

describe("Tabario AI API", () => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  const oldState = process.env.HYPERFRAMES_STATE_DIR;
  let setup: ReturnType<typeof fixture>;

  beforeEach(() => {
    setup = fixture();
    process.env.OPENROUTER_API_KEY = "fixture-key";
    process.env.HYPERFRAMES_STATE_DIR = join(setup.root, "state");
  });

  afterEach(() => {
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
    if (oldState === undefined) delete process.env.HYPERFRAMES_STATE_DIR;
    else process.env.HYPERFRAMES_STATE_DIR = oldState;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("enforces loopback, same-origin JSON mutations, nonce, provider, and prompt limits", async () => {
    const app = createStudioApi(adapter(setup.projectDir));
    const token = await nonce(app);
    const noNonce = await app.request("http://localhost/projects/demo/agent/runs", {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "tabario", kind: "chat", prompt: "hi" }),
    });
    expect(noNonce.status).toBe(403);
    const crossOrigin = await app.request("http://localhost/projects/demo/agent/threads/reset", {
      method: "POST",
      headers: {
        ...headers(token),
        Origin: "https://evil.example",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ provider: "tabario" }),
    });
    expect(crossOrigin.status).toBe(403);
    const oversized = await app.request("http://localhost/projects/demo/agent/runs", {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({
        provider: "tabario",
        kind: "chat",
        prompt: "x".repeat(128 * 1024 + 1),
      }),
    });
    expect(oversized.status).toBe(413);
    const wrongProvider = await app.request("http://localhost/projects/demo/agent/runs", {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ provider: "codex", kind: "chat", prompt: "hi" }),
    });
    expect(wrongProvider.status).toBe(400);
  });

  it("lints in staging, applies one transaction, persists chat, refreshes, and undoes", async () => {
    const hash = createHash("sha256").update(INITIAL_HTML).digest("hex");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          completion("", [
            toolCall("write", "write_file", {
              path: "index.html",
              content: INITIAL_HTML.replace("before", "after"),
              expected_hash: hash,
            }),
          ]),
        )
        .mockResolvedValueOnce(completion("Updated the timeline.")),
    );
    const app = createStudioApi(adapter(setup.projectDir));
    const token = await nonce(app);
    const jobId = await start(app, token, "Change the opening", { kind: "timeline" });
    const stream = await events(app, jobId);

    expect(stream).toContain("event: changed-files");
    expect(stream).toContain("event: lint");
    expect(stream).toContain("event: complete");
    expect(readFileSync(join(setup.projectDir, "index.html"), "utf-8")).toContain("after");

    const threadResponse = await app.request("http://localhost/projects/demo/agent/threads", {
      headers: headers(),
    });
    const threadBody = (await threadResponse.json()) as {
      threads: Array<{ provider: string; transcript: unknown[] }>;
    };
    expect(threadBody.threads[0]).toMatchObject({ provider: "tabario" });
    expect(threadBody.threads[0].transcript).toHaveLength(2);

    const undo = await app.request(`http://localhost/agent/runs/${jobId}/undo`, {
      method: "POST",
      headers: headers(token),
      body: "{}",
    });
    expect(undo.status).toBe(200);
    expect(readFileSync(join(setup.projectDir, "index.html"), "utf-8")).toBe(INITIAL_HTML);
  });

  it("blocks lint errors without exposing partial live changes", async () => {
    const hash = createHash("sha256").update(INITIAL_HTML).digest("hex");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          completion("", [
            toolCall("write", "write_file", {
              path: "index.html",
              content: INITIAL_HTML.replace("before", "LINT_ERROR"),
              expected_hash: hash,
            }),
          ]),
        )
        .mockResolvedValueOnce(completion("Made the requested change.")),
    );
    const app = createStudioApi(adapter(setup.projectDir));
    const token = await nonce(app);
    const jobId = await start(app, token, "Break it", { kind: "timeline" });
    const stream = await events(app, jobId);

    expect(stream).toContain("event: failure");
    expect(stream).toContain("introduced lint errors and were not applied");
    // The message names what it introduced, so the user is not left to guess
    // which of the project's errors stopped their edit.
    expect(stream).toContain("fixture lint error");
    expect(readFileSync(join(setup.projectDir, "index.html"), "utf-8")).toBe(INITIAL_HTML);
  });

  /**
   * TAB-780. The gate compared the staged tree against nothing, so any error the
   * project already carried held it permanently shut. In production that was six
   * of them on an untouched project — Tabario AI could not apply anything, ever.
   */
  it("applies an edit to a project that already fails lint", async () => {
    const hash = seedProject(setup.projectDir, INHERITED_HTML);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          completion("", [
            toolCall("write", "write_file", {
              path: "index.html",
              content: INHERITED_HTML.replace("before", "after"),
              expected_hash: hash,
            }),
          ]),
        )
        .mockResolvedValueOnce(completion("Made the requested change.")),
    );
    const app = createStudioApi(adapter(setup.projectDir));
    const token = await nonce(app);
    const jobId = await start(app, token, "Change it", { kind: "timeline" });
    const stream = await events(app, jobId);

    expect(stream).not.toContain("event: failure");
    expect(readFileSync(join(setup.projectDir, "index.html"), "utf-8")).toContain("after");
  });

  it("still refuses an edit that adds a new error to an already-failing project", async () => {
    const hash = seedProject(setup.projectDir, INHERITED_HTML);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          completion("", [
            toolCall("write", "write_file", {
              path: "index.html",
              content: INHERITED_HTML.replace("before", "LINT_ERROR"),
              expected_hash: hash,
            }),
          ]),
        )
        .mockResolvedValueOnce(completion("Made the requested change.")),
    );
    const app = createStudioApi(adapter(setup.projectDir));
    const token = await nonce(app);
    const jobId = await start(app, token, "Break it", { kind: "timeline" });
    const stream = await events(app, jobId);

    expect(stream).toContain("event: failure");
    // Read the failure message itself rather than the whole stream: the `lint`
    // event legitimately reports every finding it saw, including inherited ones.
    // What matters is that the *refusal* names only what this run introduced,
    // so the user is not sent chasing an error that was already there.
    const failure = stream
      .split("\n")
      .filter((line) => line.startsWith("data:") && line.includes('"type":"failure"'))
      .join("");
    expect(failure).toContain("fixture lint error");
    expect(failure).not.toContain("pre-existing fixture error");
    expect(readFileSync(join(setup.projectDir, "index.html"), "utf-8")).toContain("before");
  });

  it("does not report a staged-changes failure for a question that stages nothing", async () => {
    seedProject(setup.projectDir, INHERITED_HTML);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(completion("There is no video between 4s and 7s because …")),
    );
    const app = createStudioApi(adapter(setup.projectDir));
    const token = await nonce(app);
    const jobId = await start(app, token, "Why is there a gap?", { kind: "chat" });
    const stream = await events(app, jobId);

    expect(stream).not.toContain("were not applied");
    expect(stream).not.toContain("event: failure");
  });

  /**
   * TAB-794. `chat` is what every message typed into Studio's chat arrives as,
   * so it can no longer mean "read-only" — a reported problem has to end in an
   * applied edit. `isEditRequest` still calls this kind a non-edit, which is
   * only about the wording of the no-op message; the transaction itself must
   * commit exactly as any other kind does.
   */
  it("applies a chat-kind run that edited in response to a reported problem", async () => {
    const hash = seedProject(setup.projectDir, INITIAL_HTML);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          completion("", [
            toolCall("write", "write_file", {
              path: "index.html",
              content: INITIAL_HTML.replace("before", "after"),
              expected_hash: hash,
            }),
          ]),
        )
        .mockResolvedValueOnce(completion("I moved the captions down.")),
    );
    const app = createStudioApi(adapter(setup.projectDir));
    const token = await nonce(app);
    const jobId = await start(app, token, 'The "Caption Layer" is too high', { kind: "chat" });
    const stream = await events(app, jobId);

    expect(stream).toContain("event: changed-files");
    expect(stream).not.toContain("event: failure");
    expect(readFileSync(join(setup.projectDir, "index.html"), "utf-8")).toContain("after");
  });

  it("cancels an in-flight model call without applying staged work", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("cancelled", "AbortError")),
              { once: true },
            );
          }),
      ),
    );
    const app = createStudioApi(adapter(setup.projectDir));
    const token = await nonce(app);
    const jobId = await start(app, token, "Wait for me");
    const cancel = await app.request(`http://localhost/agent/runs/${jobId}/cancel`, {
      method: "POST",
      headers: headers(token),
      body: "{}",
    });
    expect(cancel.status).toBe(200);
    const stream = await events(app, jobId);
    expect(stream).toContain("event: cancelled");
    expect(stream).toContain("No staged changes were applied");
    expect(readFileSync(join(setup.projectDir, "index.html"), "utf-8")).toBe(INITIAL_HTML);
  });

  it("refuses Undo while another transaction owns the project lock", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(completion("No changes needed."))
        .mockImplementationOnce(
          (_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("cancelled", "AbortError")),
                { once: true },
              );
            }),
        ),
    );
    const app = createStudioApi(adapter(setup.projectDir));
    const token = await nonce(app);
    const completedJob = await start(app, token, "Inspect the timeline");
    expect(await events(app, completedJob)).toContain("event: complete");

    const activeJob = await start(app, token, "Keep inspecting");
    const undo = await app.request(`http://localhost/agent/runs/${completedJob}/undo`, {
      method: "POST",
      headers: headers(token),
      body: "{}",
    });
    expect(undo.status).toBe(409);
    expect(await undo.text()).toContain("already working on this project");

    await app.request(`http://localhost/agent/runs/${activeJob}/cancel`, {
      method: "POST",
      headers: headers(token),
      body: "{}",
    });
    expect(await events(app, activeJob)).toContain("event: cancelled");
  });

  it("stages registry installation inside the same undoable transaction", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion("Added the registry component.")));
    const app = createStudioApi(adapter(setup.projectDir));
    const token = await nonce(app);
    const jobId = await start(app, token, "Add the accent", {
      kind: "catalog",
      registryItem: "accent",
    });
    const stream = await events(app, jobId);
    expect(stream).toContain("event: complete");
    expect(existsSync(join(setup.projectDir, "compositions/accent.html"))).toBe(true);
    await app.request(`http://localhost/agent/runs/${jobId}/undo`, {
      method: "POST",
      headers: headers(token),
      body: "{}",
    });
    expect(existsSync(join(setup.projectDir, "compositions/accent.html"))).toBe(false);
  });
});
