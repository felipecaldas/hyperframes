// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
          call("write", "edit_file", {
            path: "index.html",
            old_string: "before",
            new_string: "after",
            expected_hash: hash,
          }),
        ]),
      )
      .mockImplementation(async () => completion("Updated the opening frame."));
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
          call("invent", "edit_file", {
            path: "compositions/scene-1.html",
            old_string: "assets/001_37ab941f_cfr24_h264.mp4",
            new_string: "assets/b-roll.mp4",
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
      '<video id="a" src="assets/001_37ab941f_cfr24_h264.mp4"></video>' +
      '<audio id="b" src="assets/voiceover.wav"></audio>' +
      '<video id="c" src="https://cdn.example.com/remote.mp4"></video>' +
      '<img id="d" src="data:image/png;base64,iVBORw0KGgo=">' +
      '<video id="e" src="${clipUrl}"></video>' +
      '<video id="f" src="assets/001_37ab941f_cfr24_h264.mp4?v=2#t=1"></video>';
    writeFileSync(join(root, "compositions/scene-1.html"), SCENE);
    const hash = createHash("sha256").update(SCENE).digest("hex");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("ok", "edit_file", {
            path: "compositions/scene-1.html",
            old_string:
              '<video id="scene-1-video" src="assets/001_37ab941f_cfr24_h264.mp4"></video>',
            new_string: mixed,
            expected_hash: hash,
          }),
        ]),
      )
      .mockImplementation(async () => completion("Done."));

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

    // The wrapper the edit did not name survives verbatim — that is the whole
    // point of an anchored replace, and it is what TAB-796 lost.
    expect(readFileSync(join(root, "compositions/scene-1.html"), "utf-8")).toBe(
      `<div>${mixed}</div>\n`,
    );
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

  /**
   * TAB-794, reproduced from the report.
   *
   * Told "the Caption Layer is too high", the model replied "I will adjust the
   * top CSS property…" and changed nothing. It was obeying: `useAgentRun` sends
   * `kind: request?.kind ?? "chat"`, so every typed message arrives as `chat`,
   * and the prompt mapped `chat` to "answer without changing files". A stated
   * problem was structurally incapable of producing an edit.
   *
   * Asserted on the request actually sent, so a refactor that drops the clauses
   * fails here rather than in a user's session.
   */
  it("tells the model to act on a stated problem rather than propose a plan", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(completion("Lowered them."));

    await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [
        {
          role: "user",
          text: 'The "Caption Layer" is too high',
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
    // The kind must stop standing in for intent.
    expect(system.content).toContain("transport label, not the user's intent");
    expect(system.content).toContain('does not need the words "fix it"');
    expect(system.content).toContain("make the change now, in this turn");
    expect(system.content).toContain("Never end a turn with a plan you have not carried out");
    // A real question must still be answerable without touching files.
    expect(system.content).toContain(
      "Answer without editing only when the message is genuinely a question",
    );
    // TAB-781's guidance has to survive this edit.
    expect(system.content).toContain("timeline IS its HTML");
  });

  /**
   * The other half of TAB-794: `chat` is no longer a read-only mode, so a run
   * that decides to edit must actually write. Applying the write is the
   * runtime's job; producing it is this module's.
   */
  it("writes on a chat-kind request when the user reported a problem", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const hash = createHash("sha256").update(HTML).digest("hex");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("write", "edit_file", {
            path: "index.html",
            old_string: "before",
            new_string: "after",
            expected_hash: hash,
          }),
        ]),
      )
      .mockImplementation(async () => completion("I moved the captions down."));

    const result = await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [
        { role: "user", text: "the captions are too high", at: new Date().toISOString() },
      ],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    expect(readFileSync(join(root, "index.html"), "utf-8")).toContain("after");
    expect(result.assistantText).toBe("I moved the captions down.");
  });

  /**
   * TAB-795, reproduced from the report.
   *
   * The same reply carried a fenced block of raw CSS, which Studio renders
   * verbatim — fence markers included — to someone editing a video. The prompt
   * says not to; the strip is what makes it true, because TAB-791 already
   * showed an instruction the model can decline is not a gate.
   */
  it("strips code out of the reply and says so in the prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const reply = [
      "You're right, the captions sit too high.",
      "",
      "```html",
      "    .hf-captions { top: 85%; font-size: 31.2px; }",
      "```",
      "",
      "I lowered the `Caption Layer` and it now fits on one line.",
    ].join("\n");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(completion(reply));
    const assistant: string[] = [];

    const result = await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [
        { role: "user", text: "the captions are too high", at: new Date().toISOString() },
      ],
      signal: new AbortController().signal,
      onAssistant: (text) => assistant.push(text),
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    expect(result.assistantText).toBe(
      "You're right, the captions sit too high.\n\nI lowered the Caption Layer and it now fits on one line.",
    );
    // Both paths out of this module carry the cleaned copy, not just one.
    expect(assistant).toEqual([result.assistantText]);
    expect(result.assistantText).not.toContain("```");
    expect(result.assistantText).not.toContain("hf-captions");
    expect(result.assistantText).not.toContain("`");

    const body = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit)?.body));
    const system = body.messages.find((message: { role: string }) => message.role === "system");
    expect(system.content).toContain(
      "you are talking to someone editing a video, not reading code",
    );
    expect(system.content).toContain("CSS selectors");
    expect(system.content).toContain("Fenced code blocks are removed from your reply");
  });

  it("never leaves an empty bubble when the reply was nothing but code", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const reply = ["```css", ".hf-captions { top: 85%; }", "```"].join("\n");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(completion(reply));

    const result = await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "lower the captions", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    expect(result.assistantText).toBe(
      "I've finished. Let me know if you'd like anything adjusted.",
    );
  });

  /**
   * An unterminated fence takes the rest of the message with it. Half a code
   * block is still a code block, and the model's own record must stay intact
   * either way — later turns have to reason about what it actually said.
   */
  it("drops an unclosed code block and leaves the model's own transcript raw", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const reply = ["I lowered the captions.", "```html", '<div class="hf-captions">'].join("\n");
    // The unclosed block is the *final* message, so the strip is what decides
    // what the user sees; put it mid-run and this test would pass either way.
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(completion(reply, [call("read", "read_file", { path: "index.html" })]))
      .mockResolvedValueOnce(completion(reply));

    const result = await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "lower the captions", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    expect(result.assistantText).toBe("I lowered the captions.");
    expect(result.assistantText).not.toContain("hf-captions");
    const second = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    const echoed = second.messages.find(
      (message: { role: string; content: string | null }) =>
        message.role === "assistant" && typeof message.content === "string",
    );
    expect(echoed.content).toBe(reply);
  });

  /**
   * TAB-796, reproduced from the live TAB-793 run.
   *
   * Asked only to move the caption layer, the model rewrote the whole file and
   * re-emitted an unrelated 4,363-character line, flipping one
   * `rotate(17.78deg)` to `-17.78`. Valid HTML, so lint and the TAB-780
   * introduced-errors gate both passed it.
   *
   * The assertion is byte-equality of every other line, not "the change I asked
   * for happened" — the run in the report did do what was asked. What it also
   * did is the bug.
   */
  const WIDE_HTML = [
    '<html data-composition-id="demo">',
    "  <style>.hf-captions { top: 46%; }</style>",
    '  <div id="arc" data-rot="a(17.78deg) b(-13.33deg) c(20.00deg)">HELENA&#39;S AGENCY</div>',
    "  <body>before</body>",
    "</html>",
    "",
  ].join("\n");

  it("changes only the named snippet and leaves every other line byte-identical", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), WIDE_HTML);
    const hash = createHash("sha256").update(WIDE_HTML).digest("hex");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("edit", "edit_file", {
            path: "index.html",
            old_string: ".hf-captions { top: 46%; }",
            new_string: ".hf-captions { top: 70%; }",
            expected_hash: hash,
          }),
        ]),
      )
      .mockImplementation(async () => completion("I moved the captions down."));

    await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [
        { role: "user", text: "the captions are too high", at: new Date().toISOString() },
      ],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    const before = WIDE_HTML.split("\n");
    const after = readFileSync(join(root, "index.html"), "utf-8").split("\n");
    expect(after.length).toBe(before.length);
    const changed = before.map((line, i) => i).filter((i) => before[i] !== after[i]);
    // Exactly one line differs, and it is the one that was named.
    expect(changed).toEqual([1]);
    expect(after[1]).toContain("top: 70%");
    // The line that got corrupted in the report is untouched, entity and all.
    expect(after[2]).toBe(before[2]);
    expect(after[2]).toContain("b(-13.33deg)");
    expect(after[2]).toContain("&#39;");
  });

  it("refuses to overwrite a file that already exists, and names the way to edit it", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const hash = createHash("sha256").update(HTML).digest("hex");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("clobber", "write_file", {
            path: "index.html",
            content: HTML.replace("before", "after"),
            expected_hash: hash,
          }),
        ]),
      )
      .mockResolvedValueOnce(completion("I used a targeted edit instead."));

    await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "change it", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    expect(readFileSync(join(root, "index.html"), "utf-8")).toBe(HTML);
    const second = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    const toolMessage = second.messages.find(
      (message: { tool_call_id?: string }) => message.tool_call_id === "clobber",
    );
    const { error } = JSON.parse(toolMessage.content);
    // The refusal has to be the answer, or the next turn just tries again.
    expect(error).toContain("already exists");
    expect(error).toContain("edit_file");
  });

  it("still creates files that do not exist yet", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("create", "write_file", {
            path: "compositions/scene-9.html",
            content: "<div>new scene</div>\n",
            expected_hash: null,
          }),
        ]),
      )
      .mockImplementation(async () => completion("Added the scene."));

    await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "timeline",
      transcript: [{ role: "user", text: "add a scene", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    expect(readFileSync(join(root, "compositions/scene-9.html"), "utf-8")).toBe(
      "<div>new scene</div>\n",
    );
  });

  /**
   * Cancelling used to wait for the whole batch. The round loop checks the
   * signal, but the batch it had already been handed did not — and a batch can
   * hold `validate_project`, which is a compile and a headless browser. Stop
   * therefore registered tens of seconds after it was pressed.
   */
  it("stops a tool batch as soon as the run is cancelled", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      completion("", [
        call("first", "write_file", {
          path: "compositions/scene-a.html",
          content: "<div>a</div>\n",
          expected_hash: null,
        }),
        call("second", "write_file", {
          path: "compositions/scene-b.html",
          content: "<div>b</div>\n",
          expected_hash: null,
        }),
      ]),
    );
    const started: string[] = [];

    await expect(
      runTabarioModel({
        adapter: adapter(),
        stagingDir: root,
        kind: "timeline",
        transcript: [{ role: "user", text: "add two scenes", at: new Date().toISOString() }],
        signal: controller.signal,
        onAssistant: () => {},
        // Cancelled while the first tool is being announced, which is squarely
        // inside the batch — exactly where the round-level check cannot see it.
        onTool: (name) => {
          started.push(name);
          controller.abort();
        },
        onActivity: () => {},
        fetchImpl,
      }),
    ).rejects.toThrow("cancelled");

    expect(started).toEqual(["write_file"]);
    // The call already under way is allowed to finish, so no file is left half
    // written...
    expect(readFileSync(join(root, "compositions/scene-a.html"), "utf-8")).toBe("<div>a</div>\n");
    // ...and nothing after it in the batch runs.
    expect(existsSync(join(root, "compositions/scene-b.html"))).toBe(false);
    // Nor is the model asked to continue a run the user has stopped.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  /**
   * A non-unique anchor is refused rather than resolved to "the first one" —
   * silently picking an occurrence is how a targeted edit lands in the wrong
   * place, which is the failure this tool exists to prevent.
   */
  it("refuses an ambiguous anchor and reports how many times it matched", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    const repeated = '<p class="x">hi</p>\n<p class="x">hi</p>\n';
    writeFileSync(join(root, "index.html"), repeated);
    const hash = createHash("sha256").update(repeated).digest("hex");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("ambiguous", "edit_file", {
            path: "index.html",
            old_string: '<p class="x">hi</p>',
            new_string: '<p class="x">bye</p>',
            expected_hash: hash,
          }),
        ]),
      )
      .mockResolvedValueOnce(completion("I need a more specific anchor."));

    await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "change the second one", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    expect(readFileSync(join(root, "index.html"), "utf-8")).toBe(repeated);
    const second = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    const toolMessage = second.messages.find(
      (message: { tool_call_id?: string }) => message.tool_call_id === "ambiguous",
    );
    expect(JSON.parse(toolMessage.content).error).toContain("appears 2 times");
  });

  /**
   * `String.replace` treats `$&` and `$1` in the replacement as substitution
   * patterns. In a composition they are ordinary characters — a template
   * placeholder or a price — so the replacement is applied as a function.
   */
  it("treats dollar patterns in the replacement as literal text", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    const source = "<div>PRICE</div>\n";
    writeFileSync(join(root, "index.html"), source);
    const hash = createHash("sha256").update(source).digest("hex");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("dollar", "edit_file", {
            path: "index.html",
            old_string: "PRICE",
            new_string: "$& $1 ${total}",
            expected_hash: hash,
          }),
        ]),
      )
      .mockImplementation(async () => completion("Done."));

    await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "set the price text", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    expect(readFileSync(join(root, "index.html"), "utf-8")).toBe("<div>$& $1 ${total}</div>\n");
  });

  /**
   * TAB-807, reproducing the live failure exactly.
   *
   * Asked to put a caption on one line, the model re-emitted `#caption-2`'s word
   * spans and copied three `data-hf-id` values off `#caption-0`. The words were
   * right; the ids were not. Studio resolves a user's manual edits by that id,
   * so the next edit to caption-2's words would have landed on caption-0's and
   * still looked like it worked.
   */
  it("refuses an edit that copies another element's data-hf-id", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    const source =
      '<html data-composition-id="demo"><body>\n' +
      '<div data-hf-id="hf-bvg5" id="caption-0"><span data-hf-id="hf-00u9" id="caption-0-w0">Helena\'s</span> <span data-hf-id="hf-o1v4" id="caption-0-w1">agency</span></div>\n' +
      '<div data-hf-id="hf-ci36" id="caption-2"><span data-hf-id="hf-kmog" id="caption-2-w0">solving her production bottleneck.</span></div>\n' +
      "</body></html>\n";
    writeFileSync(join(root, "index.html"), source);
    const hash = createHash("sha256").update(source).digest("hex");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("dupe", "edit_file", {
            path: "index.html",
            old_string:
              '<span data-hf-id="hf-kmog" id="caption-2-w0">solving her production bottleneck.</span>',
            new_string:
              '<span data-hf-id="hf-kmog" id="caption-2-w0">solving</span> <span data-hf-id="hf-o1v4" id="caption-2-w1">her production bottleneck.</span>',
            expected_hash: hash,
          }),
        ]),
      )
      .mockResolvedValueOnce(completion("I kept the original ids."));

    await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "put it on one line", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    expect(readFileSync(join(root, "index.html"), "utf-8")).toBe(source);
    const second = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    const toolMessage = second.messages.find(
      (message: { tool_call_id?: string }) => message.tool_call_id === "dupe",
    );
    const error = JSON.parse(toolMessage.content).error as string;
    expect(error).toContain("hf-o1v4");
    expect(error).toContain("data-hf-id");
  });

  /**
   * TAB-780's inherited-vs-introduced rule. The repro project is *already* on
   * disk carrying three duplicates, so a gate that refuses any file containing
   * one would make every later edit to it fail for a fault the edit did not
   * commit.
   */
  it("allows an edit to a file that already carried duplicate ids", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    const source =
      '<html data-composition-id="demo"><body>\n' +
      '<span data-hf-id="hf-dupe">one</span><span data-hf-id="hf-dupe">two</span>\n' +
      '<p data-hf-id="hf-solo">CHANGE ME</p>\n' +
      "</body></html>\n";
    writeFileSync(join(root, "index.html"), source);
    const hash = createHash("sha256").update(source).digest("hex");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("inherited", "edit_file", {
            path: "index.html",
            old_string: "CHANGE ME",
            new_string: "CHANGED",
            expected_hash: hash,
          }),
        ]),
      )
      .mockImplementation(async () => completion("Done."));

    await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "change the text", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    expect(readFileSync(join(root, "index.html"), "utf-8")).toContain("CHANGED");
  });

  /**
   * TAB-805. The measurement must be taken on the **staged** copy — the live
   * project does not have the agent's edits in it yet, so measuring that would
   * answer a question nobody asked.
   */
  it("measures the staged project and gives the model the numbers", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const measureLayout = vi.fn().mockResolvedValue({
      measured: true,
      seekTime: 5.5,
      frame: { width: 720, height: 720 },
      elements: [
        {
          selector: "#caption-2",
          box: { x: 157, y: 524, width: 405, height: 149 },
          lines: 3,
          overflows: false,
          visibility: "hidden",
          pinnedByManualEdit: { width: "405px", height: "149px" },
          text: "solving her production bottleneck.",
        },
      ],
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("m", "measure_layout", { selectors: ["#caption-2"], seek_time: 5.5 }),
        ]),
      )
      .mockResolvedValueOnce(completion("It is still on three lines."));

    await runTabarioModel({
      adapter: { ...adapter(), measureLayout },
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "is it one line yet?", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    expect(measureLayout).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: root, selectors: ["#caption-2"], seekTime: 5.5 }),
    );
    const second = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    const toolMessage = second.messages.find(
      (message: { tool_call_id?: string }) => message.tool_call_id === "m",
    );
    const result = JSON.parse(toolMessage.content);
    expect(result.measured).toBe(true);
    expect(result.elements[0].lines).toBe(3);
    expect(result.elements[0].pinnedByManualEdit.width).toBe("405px");
  });

  /**
   * A Studio server with no browser must say so. Returning an empty element
   * list would read as "measured, nothing wrong" — the precise mistake TAB-700
   * is about.
   */
  it("says it could not measure rather than implying nothing is wrong", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [call("m", "measure_layout", { selectors: ["#caption-2"] })]),
      )
      .mockResolvedValueOnce(completion("I could not measure it."));

    await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "is it one line yet?", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    const second = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    const toolMessage = second.messages.find(
      (message: { tool_call_id?: string }) => message.tool_call_id === "m",
    );
    const result = JSON.parse(toolMessage.content);
    expect(result.measured).toBe(false);
    expect(result.unavailable).toContain("no browser");
    expect(result.elements).toEqual([]);
  });

  /**
   * TAB-806. The prompt described `tl.set` under "motion", so a `set` at 0s
   * carrying width/height read as an animation rather than as the pinned box it
   * is. Asserted on the request actually sent, like the TAB-781 check above.
   */
  it("tells the model that a set at 0s is a pinned box, and that lint is not sight", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(completion("An answer."));

    await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [
        { role: "user", text: "this caption takes three lines", at: new Date().toISOString() },
      ],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    const body = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit)?.body));
    const system = body.messages.find((message: { role: string }) => message.role === "system");
    expect(system.content).toContain("not motion");
    expect(system.content).toContain("Lint is not sight");
    expect(system.content).toContain("measure_layout");
    // The tool has to actually be offered, not just described.
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toContain(
      "measure_layout",
    );
  });

  /**
   * TAB-805's gate. In a live run against the reported project the model changed
   * the caption's pinned box and then answered "it should now display
   * correctly" without measuring anything — the same unchecked claim, one cause
   * later. The prompt already asked it to measure; TAB-791 says an instruction
   * it can decline is not a gate. So the run asks once, at the only moment that
   * matters: when it tries to finish.
   */
  it("will not let a layout change be reported without measuring it", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    const source = '<html data-composition-id="demo"><body><p>WIDE</p></body></html>\n';
    writeFileSync(join(root, "index.html"), source);
    const hash = createHash("sha256").update(source).digest("hex");
    const measureLayout = vi.fn().mockResolvedValue({
      measured: true,
      seekTime: 0,
      elements: [{ selector: "p", box: { x: 0, y: 0, width: 100, height: 39 }, lines: 1 }],
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("e", "edit_file", {
            path: "index.html",
            old_string: "WIDE",
            new_string: "NARROW",
            expected_hash: hash,
          }),
        ]),
      )
      // Answers without measuring — this is the turn the gate refuses to accept.
      .mockResolvedValueOnce(completion("It should now display correctly."))
      .mockResolvedValueOnce(completion("", [call("m", "measure_layout", { selectors: ["p"] })]))
      .mockResolvedValueOnce(completion("It is one line now."));

    const result = await runTabarioModel({
      adapter: { ...adapter(), measureLayout },
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "make it one line", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    expect(measureLayout).toHaveBeenCalledOnce();
    expect(result.assistantText).toBe("It is one line now.");
    const third = JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body));
    const demand = third.messages[third.messages.length - 1];
    expect(demand.role).toBe("user");
    expect(demand.content).toContain("have not measured the result");
  });

  it("asks for a measurement once, then lets the answer stand", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    const source = '<html data-composition-id="demo"><body><p>WIDE</p></body></html>\n';
    writeFileSync(join(root, "index.html"), source);
    const hash = createHash("sha256").update(source).digest("hex");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("e", "edit_file", {
            path: "index.html",
            old_string: "WIDE",
            new_string: "NARROW",
            expected_hash: hash,
          }),
        ]),
      )
      .mockResolvedValueOnce(completion("Done."))
      .mockResolvedValueOnce(completion("Really done."));

    const result = await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "make it one line", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    // Three completions, not a loop: asked once, then the reply stands.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.assistantText).toBe("Really done.");
  });

  /**
   * A question that changed nothing must not be told to measure. The gate keys
   * on a write that actually landed, so a rejected edit does not trip it either.
   */
  it("does not demand a measurement when nothing was changed", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(completion("", [call("r", "read_file", { path: "index.html" })]))
      .mockResolvedValueOnce(completion("The caption runs from 5.2s to 7.3s."));

    const result = await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "when does it show?", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.assistantText).toBe("The caption runs from 5.2s to 7.3s.");
  });

  /**
   * Two live TAB-805 runs applied a real change and said nothing at all: the
   * model answered with tool calls and then stopped, so the drawer showed
   * changed files and no word about them. `assistantText` is only ever set from
   * a completion that carried content, and nothing covered the case where none
   * ever did. TAB-795 already ruled an empty bubble unacceptable.
   */
  it("never finishes silently, even when the model returns no text at all", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const said: string[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(completion("", [call("r", "read_file", { path: "index.html" })]))
      .mockResolvedValueOnce(completion(""));

    const result = await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "what is on screen?", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: (text) => said.push(text),
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    expect(result.assistantText).toBe(
      "I've finished. Let me know if you'd like anything adjusted.",
    );
    expect(said).toEqual([result.assistantText]);
  });
});
