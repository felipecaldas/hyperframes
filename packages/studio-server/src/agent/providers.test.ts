// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProvider, runTabarioModel } from "./providers.js";
import type { StudioApiAdapter } from "../types.js";

const HTML = '<html data-composition-id="demo"><body>before</body></html>\n';

function completion(content: string, toolCalls: unknown[] = []): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content, tool_calls: toolCalls } }] }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function adapter(): StudioApiAdapter {
  return {
    listProjects: () => [],
    resolveProject: () => null,
    bundle: () => null,
    lint: (html) => ({
      findings: html.includes("BROKEN") ? [{ severity: "error", message: "broken" }] : [],
    }),
    runtimeUrl: "/runtime.js",
    rendersDir: () => "renders",
    startRender: () => {
      throw new Error("unused");
    },
  };
}

describe("Tabario AI provider", () => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  const oldEnabled = process.env.TABARIO_STUDIO_AI_ENABLED;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
    delete process.env.TABARIO_STUDIO_AI_ENABLED;
  });

  afterEach(() => {
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
    if (oldEnabled === undefined) delete process.env.TABARIO_STUDIO_AI_ENABLED;
    else process.env.TABARIO_STUDIO_AI_ENABLED = oldEnabled;
    vi.restoreAllMocks();
  });

  it("reports server-side OpenRouter configuration without probing local CLIs", () => {
    expect(detectProvider()).toMatchObject({
      installed: true,
      authenticated: true,
      available: true,
    });
    delete process.env.OPENROUTER_API_KEY;
    expect(detectProvider()).toMatchObject({
      installed: true,
      authenticated: false,
      available: false,
    });
  });

  /**
   * TAB-781. The model refused a timeline question — "my capabilities are
   * limited to file operations" — while holding every tool needed to answer it.
   * The prompt permitted questions but never said the HTML *is* the timeline, so
   * a tool list of read/write/search read as a domain of file management.
   *
   * Asserted on the request actually sent, not on a constant, so a refactor that
   * stops sending the guidance fails here rather than in a user's session.
   */
  it("tells the model that the project HTML is the timeline", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(completion("An answer."));

    await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [
        {
          role: "user",
          text: "why is there no video between 4 and 7 seconds?",
          at: new Date().toISOString(),
        },
      ],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    const body = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit)?.body));
    const system = body.messages.find((message: { role: string }) => message.role === "system");
    expect(system.content).toContain("timeline IS its HTML");
    // The attributes a timing question is actually answered from.
    expect(system.content).toContain("data-start");
    expect(system.content).toContain("data-duration");
    expect(system.content).toContain("data-composition-src");
    // And the explicit instruction not to plead blindness.
    expect(system.content).toContain("Never say you cannot see the timeline");
  });

  it("edits only through source tools and returns the final assistant response", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const hash = createHash("sha256").update(HTML).digest("hex");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("read", "read_file", { path: "index.html" }),
          call("write", "write_file", {
            path: "index.html",
            content: HTML.replace("before", "after"),
            expected_hash: hash,
          }),
        ]),
      )
      .mockResolvedValueOnce(completion("Updated the opening frame."));
    const assistant: string[] = [];

    const result = await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "timeline",
      transcript: [{ role: "user", text: "Change before to after", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: (text) => assistant.push(text),
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    expect(readFileSync(join(root, "index.html"), "utf-8")).toContain("after");
    expect(result.assistantText).toBe("Updated the opening frame.");
    expect(assistant).toEqual(["Updated the opening frame."]);
    const secondRequest = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(secondRequest.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "tool", tool_call_id: "write" })]),
    );
  });

  it("returns tool errors to the model and never writes outside the project", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("escape", "write_file", {
            path: "../escape.html",
            content: "bad",
            expected_hash: null,
          }),
        ]),
      )
      .mockResolvedValueOnce(completion("I could not make that unsafe change."));

    await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "escape", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    const secondRequest = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    const toolMessage = secondRequest.messages.find(
      (message: { tool_call_id?: string }) => message.tool_call_id === "escape",
    );
    expect(JSON.parse(toolMessage.content).error).toMatch(/outside project/);
    expect(readFileSync(join(root, "index.html"), "utf-8")).toBe(HTML);
  });

  /**
   * TAB-791, reproduced from the report.
   *
   * Asked to put a b-roll in a slot, the model wrote `src="assets/b-roll.mp4"` —
   * a filename nothing in the project ever had — over a working reference, and
   * said it had succeeded. `list_files` shows only editable source, so the model
   * could not see that `001_37ab941f_cfr24_h264.mp4` was sitting right there.
   *
   * The prompt already said "Never invent file contents or paths", so the fix
   * cannot be another sentence: this asserts the *write* is refused.
   */
  function projectWithMedia(): string {
    const root = mkdtempSync(join(tmpdir(), "tabario-media-"));
    mkdirSync(join(root, "assets"), { recursive: true });
    mkdirSync(join(root, "compositions"), { recursive: true });
    writeFileSync(join(root, "assets/001_37ab941f_cfr24_h264.mp4"), "video-bytes");
    writeFileSync(join(root, "assets/voiceover.wav"), "audio-bytes");
    writeFileSync(join(root, "index.html"), HTML);
    return root;
  }

  const SCENE =
    '<div><video id="scene-1-video" src="assets/001_37ab941f_cfr24_h264.mp4"></video></div>\n';

  it("refuses a write whose media src names a file the project does not have", async () => {
    const root = projectWithMedia();
    writeFileSync(join(root, "compositions/scene-1.html"), SCENE);
    const hash = createHash("sha256").update(SCENE).digest("hex");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("invent", "write_file", {
            path: "compositions/scene-1.html",
            content: SCENE.replace("assets/001_37ab941f_cfr24_h264.mp4", "assets/b-roll.mp4"),
            expected_hash: hash,
          }),
        ]),
      )
      .mockResolvedValueOnce(completion("I used the asset that exists."));

    await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "timeline",
      transcript: [
        { role: "user", text: "we need a b-roll in that slot", at: new Date().toISOString() },
      ],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    // The working reference survives. Losing it was half the damage in the report.
    expect(readFileSync(join(root, "compositions/scene-1.html"), "utf-8")).toBe(SCENE);

    const second = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    const toolMessage = second.messages.find(
      (message: { tool_call_id?: string }) => message.tool_call_id === "invent",
    );
    const { error } = JSON.parse(toolMessage.content);
    expect(error).toContain("assets/b-roll.mp4");
    // The refusal has to be the answer too, or the next turn guesses again.
    expect(error).toContain("assets/001_37ab941f_cfr24_h264.mp4");
  });

  /**
   * The false-positive case, which matters more than the happy path: a guard
   * that rejected any of these would block ordinary editing outright.
   *
   * `compositions/scene-1.html` writing `src="assets/…"` means *project-root*
   * relative, not relative to `compositions/` — resolving only one way would
   * reject every real composition in every Tabario project.
   */
  it("allows srcs that resolve, remote URLs, data URIs and unresolved template values", async () => {
    const root = projectWithMedia();
    const mixed =
      "<div>" +
      '<video id="a" src="assets/001_37ab941f_cfr24_h264.mp4"></video>' +
      '<audio id="b" src="assets/voiceover.wav"></audio>' +
      '<video id="c" src="https://cdn.example.com/remote.mp4"></video>' +
      '<img id="d" src="data:image/png;base64,iVBORw0KGgo=">' +
      '<video id="e" src="${clipUrl}"></video>' +
      '<video id="f" src="assets/001_37ab941f_cfr24_h264.mp4?v=2#t=1"></video>' +
      "</div>\n";
    writeFileSync(join(root, "compositions/scene-1.html"), SCENE);
    const hash = createHash("sha256").update(SCENE).digest("hex");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("ok", "write_file", {
            path: "compositions/scene-1.html",
            content: mixed,
            expected_hash: hash,
          }),
        ]),
      )
      .mockResolvedValueOnce(completion("Done."));

    await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "timeline",
      transcript: [{ role: "user", text: "rebuild the scene", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    expect(readFileSync(join(root, "compositions/scene-1.html"), "utf-8")).toBe(mixed);
  });

  it("lets the model enumerate the media it may reference, and only the media", async () => {
    const root = projectWithMedia();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(completion("", [call("media", "list_media", {})]))
      .mockResolvedValueOnce(completion("There are two assets."));

    await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "what b-roll do I have?", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    const second = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    const toolMessage = second.messages.find(
      (message: { tool_call_id?: string }) => message.tool_call_id === "media",
    );
    const payload = JSON.parse(toolMessage.content);
    expect(payload.files).toEqual(["assets/001_37ab941f_cfr24_h264.mp4", "assets/voiceover.wav"]);
    // Source files are `list_files`' job; mixing them would re-blur the line
    // between what is editable and what is merely referenceable.
    expect(payload.files).not.toContain("index.html");
  });
});
