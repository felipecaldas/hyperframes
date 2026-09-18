// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProvider, runTabarioModel } from "./providers.js";
import type { StudioApiAdapter } from "../types.js";

const HTML = '<html data-composition-id="demo"><body>before</body></html>\n';

/**
 * A compiled project's `FRAME.md`, in the shape TAB-1086's `renderFrameMd`
 * writes it: brand tokens, the motion register, the bans, the TAB-1070 cut rules
 * in prose, and a word table generated from the register.
 *
 * The values are the seeded `punchy_creator` register. Nothing in this file
 * asserts the document's content, and that is deliberate: the prompt reacts to
 * the file existing and tells the agent to read it. Inlining the table would put
 * the register in two places and make a template change a prompt change, which
 * is the one thing D34 rules out.
 */
const FRAME_MD = `# Frame

## Brand tokens

| Token | Value |
|---|---|
| accent | #FF3366 |
| ink | #101014 |
| display | Archivo Black |

## Motion register

| Field | Value |
|---|---|
| primary transition | circle_iris |
| accent transitions | none |
| accent limit | 2 |
| durations | fast 0.2s, medium 0.4s, slow 0.6s |
| allowed eases | none, power1.in, power1.out, power1.inOut, power2.out, power2.inOut, power3.out |

## Bans

- no idle motion
- no overshoot past 1.04
- a relocation is a cut

## Cuts

A relocation is a cut. When an element moves from one place in the frame to
another, it leaves on one frame and arrives on the next. Nothing tweens across
the boundary.

## Words

| Word | Duration | Ease |
|---|---|---|
| fast | 0.2 | power3.out |
| medium | 0.4 | power2.out |
| slow | 0.6 | power2.inOut |
| snappy | 0.2 | power3.out |
| smooth | 0.4 | power2.out |
`;

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

/**
 * The first round of a run that looked before it spoke. Since TAB-1063 a run
 * that calls no tool at all is sent back once to read the project, so a test
 * about the reply alone scripts this read ahead of it.
 */
function readIndexFirst(): Response {
  return completion("", [call("r0", "read_file", { path: "index.html" })]);
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

  it("refuses a write until this run reads FRAME.md, even with prior register discussion", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-register-first-"));
    writeFileSync(join(root, "index.html"), HTML);
    writeFileSync(join(root, "FRAME.md"), FRAME_MD);
    const hash = createHash("sha256").update(HTML).digest("hex");
    const edit = {
      path: "index.html",
      old_string: "before",
      new_string: "after",
      expected_hash: hash,
    };
    const results: string[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(completion("", [call("blocked", "edit_file", edit)]))
      .mockImplementationOnce(async () => {
        expect(readFileSync(join(root, "index.html"), "utf8")).toBe(HTML);
        return completion("", [
          call("frame", "read_file", { path: "FRAME.md" }),
          call("allowed", "edit_file", edit),
        ]);
      })
      .mockImplementation(async () => completion("Updated."));
    await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [
        {
          role: "assistant",
          text: "I read the register in the last turn.",
          at: new Date().toISOString(),
        },
        { role: "user", text: "Make the title snappier", at: new Date().toISOString() },
      ],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      onToolResult: (entry) => {
        results.push(entry.result);
      },
      fetchImpl,
    });
    expect(results[0]).toContain("read FRAME.md in this run");
    expect(readFileSync(join(root, "index.html"), "utf8")).toContain("after");
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.messages[0].content).toContain(
      "snappier means the snappy ease AND the fast duration",
    );
    expect(body.messages[0].content).toContain("already matches");
    expect(body.messages[0].content).not.toContain("power3.out");
  });

  /**
   * TAB-1171. A live run on the deployed Studio tried the edit before reading
   * FRAME.md, was refused by the gate, told the user it needed FRAME.md — and
   * ended the turn. The run was recorded `complete` with **zero changed files**
   * and a reply that read as though it were still mid-task, so the user's
   * change was never made and nothing said so.
   *
   * The refusal is recoverable inside the run, so the finish gate now names the
   * next step instead of letting the turn end. Modelled on the real transcript:
   * read index.html, try the edit, get refused, try to stop.
   */
  it("sends a run the frame gate refused back to FRAME.md, and the retry lands", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-frame-retry-"));
    writeFileSync(join(root, "index.html"), HTML);
    writeFileSync(join(root, "FRAME.md"), FRAME_MD);
    const hash = createHash("sha256").update(HTML).digest("hex");
    const edit = {
      path: "index.html",
      old_string: "before",
      new_string: "after",
      expected_hash: hash,
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      // The refusal, then the reply that tries to end the turn on it.
      .mockResolvedValueOnce(completion("", [call("blocked", "edit_file", edit)]))
      .mockResolvedValueOnce(completion("I need to read the FRAME.md file first."))
      // Nudged: read the register, then make the same edit again.
      .mockResolvedValueOnce(
        completion("", [
          call("frame", "read_file", { path: "FRAME.md" }),
          call("allowed", "edit_file", edit),
        ]),
      )
      .mockImplementation(async () => completion("Updated."));

    const result = await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "Make the title snappier", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    // The demand rides on the request that follows the reply-the-refusal.
    const nudged = JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body));
    const demand = nudged.messages.at(-1);
    expect(demand.role).toBe("user");
    expect(demand.content).toContain("FRAME.md has not been read in this run");
    expect(demand.content).toContain("make the same edit again");
    // The point of the nudge: the edit the gate refused actually lands.
    expect(readFileSync(join(root, "index.html"), "utf8")).toContain("after");
    expect(result.assistantText).toBe("Updated.");
  });

  /**
   * The bound, matching the other three demands: asked once, never looped. A
   * model that ignores the nudge still finishes, and its reply stands.
   */
  it("asks for the frame read once, then lets the answer stand", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-frame-once-"));
    writeFileSync(join(root, "index.html"), HTML);
    writeFileSync(join(root, "FRAME.md"), FRAME_MD);
    const hash = createHash("sha256").update(HTML).digest("hex");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("blocked", "edit_file", {
            path: "index.html",
            old_string: "before",
            new_string: "after",
            expected_hash: hash,
          }),
        ]),
      )
      .mockResolvedValueOnce(completion("I need FRAME.md."))
      .mockResolvedValueOnce(completion("Still not reading it."));

    const result = await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "Make the title snappier", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.assistantText).toBe("Still not reading it.");
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe(HTML);
  });

  /**
   * The other side of the gate: with no FRAME.md there is nothing to read, so
   * `assertFrameRead` never fires and this demand must stay silent. The edit
   * is expected to land, and the run then meets the pre-existing measure
   * demand — which is what proves this branch is not interfering.
   */
  it("does not demand a frame read when the project has no FRAME.md", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-no-frame-"));
    writeFileSync(join(root, "index.html"), HTML);
    const hash = createHash("sha256").update(HTML).digest("hex");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("allowed", "edit_file", {
            path: "index.html",
            old_string: "before",
            new_string: "after",
            expected_hash: hash,
          }),
        ]),
      )
      .mockImplementation(async () => completion("Updated."));

    const result = await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "Make the title snappier", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    const bodies = fetchImpl.mock.calls.map((c) => String((c[1] as RequestInit)?.body));
    expect(bodies.some((b) => b.includes("has not been read in this run"))).toBe(false);
    expect(readFileSync(join(root, "index.html"), "utf8")).toContain("after");
    expect(result.assistantText).toBe("Updated.");
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
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readIndexFirst())
      .mockResolvedValueOnce(completion("An answer."));

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
    // TAB-812: the caption rules that prevent the TAB-804/TAB-791 regression
    // modes — the model merging/splitting word spans or rewriting the shared
    // highlight loop instead of editing a span's text or data attributes.
    expect(system.content).toContain("data-hf-atomic");
    expect(system.content).toContain("Never rewrite, duplicate or inline the highlight loop");
    expect(system.content).toContain("never merge or split word spans");
    expect(system.content).toContain("never copy a `data-hf-id`");
    // TAB-1163, correcting TAB-1064. This assertion used to pin the sentence
    // "remove `data-caption-base-px` from that caption element only" — the
    // instruction that caused the defect, because removing the attribute stops
    // the shrink and the container still cannot wrap, so the caption grows and
    // overflows. It was a prompt test asserting the bug rather than catching it.
    // Now it pins the correction and the edit that actually works.
    expect(system.content).toContain("data-caption-base-px");
    expect(system.content).toContain("does NOT make a one-line caption wrap");
    // The edit that works on an EXISTING project, which is the only case the
    // agent can act on: Studio has no compile step, so a project built before
    // the caption style field existed will never gain the `.hf-caption-break`
    // rule. The first cut of this correction taught that class anyway, which
    // would have done nothing there. These pin the parts that do not depend on
    // a stylesheet the project may not have.
    expect(system.content).toContain("flex-wrap: wrap");
    expect(system.content).toContain("flex-basis:100%;height:0");
    // TAB-1173, reframing what TAB-1163 added. That correction taught the edit,
    // and then told the model to size the font until the longest line fitted —
    // and the tool it was told to measure with returned a line *count* and no
    // width, so the instruction named a number nothing produced. The live run
    // that motivated this is what that looks like: the model could see it had
    // three lines, could not see how far the third reached, and guessed a size.
    //
    // The size is the template's now, so what is pinned is the prohibition. The
    // bare word "font-size" is deliberately not the assertion: the instruction
    // being replaced contained it too, so a test for the word alone passed
    // against the very sentence it needed to catch.
    expect(system.content).toContain("do not set a `font-size`");
    expect(system.content).toContain("not yours to change");
    expect(system.content).not.toContain("is a measurement, not a guess");
    // And the check that replaced it names a number the measurement now returns,
    // rather than the "measure the longest line" it could not answer.
    expect(system.content).toContain(
      "widest rendered line against the element's content-box width",
    );
    // TAB-1170. The caption compiler stopped emitting a sizing script at all,
    // so the prompt cannot keep saying the project's own script sizes every
    // caption: on a project compiled since, nothing does. An agent told
    // otherwise will look for a script that is not in the file, and — the
    // TAB-1158 lesson — will report having fixed a sizing problem that no
    // longer has a mechanism.
    expect(system.content).toContain("no sizing script at all");
    expect(system.content).toContain("nothing reads any more");
    // Where a line ends is now decided by width, in the compiler. "After the
    // fourth word for four words per line" is the rule TAB-1170 removed, so it
    // must not return to the prompt as the instruction for a manual break.
    expect(system.content).not.toContain("after the fourth word");
    // The line-count bullet must not read as "you have no per-caption reach"
    // while the bullet above teaches a per-caption edit — an agent that believes
    // both will refuse work it can do, which is the TAB-781/TAB-1063 failure
    // mode. It says which of the two routes it is describing instead.
    expect(system.content).not.toContain("not a per-caption setting");
    expect(system.content).toContain("manual edit above is the only per-caption route");
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
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readIndexFirst())
      .mockResolvedValueOnce(completion("Lowered them."));

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
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readIndexFirst())
      .mockResolvedValueOnce(completion(reply));
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
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readIndexFirst())
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
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readIndexFirst())
      .mockResolvedValueOnce(completion("An answer."));

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
   * The system message of a run over `root`, read off the request the provider
   * actually sent. `systemPrompt` is not exported and stays that way: a test that
   * reads a constant proves the constant, not what the model was told.
   */
  async function systemMessageFor(root: string): Promise<string> {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readIndexFirst())
      .mockResolvedValueOnce(completion("An answer."));

    await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [
        { role: "user", text: "what ease does this film use?", at: new Date().toISOString() },
      ],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    const body = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit)?.body));
    return body.messages.find((message: { role: string }) => message.role === "system").content;
  }

  /**
   * TAB-1087. The prompt taught project layout, timing attributes, caption rules
   * and "lint is not sight", and never named an ease, a duration or a transition
   * type. So the model had nothing to be right about: asked for something
   * snappier it picked whatever ease it liked, and the lint codes TAB-1086 added
   * then reported the result.
   *
   * After TAB-1086 the answer is in the project. The prompt points at
   * `FRAME.md` and carries none of its data (D34), so a template that changes
   * its register changes no code here. `power2.out` appears in the fixture above
   * and must not appear in the prompt: an implementation that read the file and
   * pasted its table in would fail this.
   */
  it("tells the model to read FRAME.md first and to keep every tween in the register", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    writeFileSync(join(root, "FRAME.md"), FRAME_MD);

    const system = await systemMessageFor(root);

    expect(system).toContain("read FRAME.md at the project root");
    expect(system).toContain("quoting the line");
    expect(system).toContain("uses an ease from allowed_eases");
    expect(system).toContain("if a word is not in the table, ask, do not guess");
    expect(system).toContain("Never add a transition type the register does not list");
    // The register lives in the file, so no ease name is written here.
    expect(system).not.toContain("power2.out");
    expect(system).not.toContain("power3.out");
  });

  /**
   * A project compiled before TAB-1086, or one a person assembled by hand, has
   * no register to obey. Telling the model to read a file that is not there
   * invites it to invent the table instead, which is worse than saying nothing:
   * an invented register reads exactly like a real one.
   *
   * So the rules are gated on the file and their absence is stated out loud.
   */
  it("says the register is missing rather than naming a file the project does not have", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);

    const system = await systemMessageFor(root);

    expect(system).toContain("this project has no FRAME.md; keep today's eases");
    expect(system).not.toContain("read FRAME.md at the project root");
    expect(system).not.toContain("uses an ease from allowed_eases");
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
      .mockResolvedValueOnce(completion("It is one line now."))
      // TAB-1061: a measured change gets its numbers quoted back once more.
      .mockResolvedValueOnce(completion("It is one line now, measured."));

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
    expect(result.assistantText).toBe("It is one line now, measured.");
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
    // Nothing renderable changed, so there is no measurement to owe.
    expect(result.verification).toBeNull();
  });

  /**
   * TAB-1063. The first run after the TAB-1061 deploy was asked to put caption
   * 0 on two lines and replied "What is the exact text of caption 0?" having
   * called no tool at all. The text was in index.html. The prompt permits one
   * question to the user, and the model took that path without the read the
   * prompt also asks for, so the read is now demanded at the finish, once.
   */
  it("sends a run that called nothing back to read the project, once", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(completion("What is the exact text of caption 0?"))
      .mockResolvedValueOnce(completion("", [call("r", "read_file", { path: "index.html" })]))
      .mockResolvedValueOnce(completion("Caption 0 says: before."));
    const tools: string[] = [];

    const result = await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [
        { role: "user", text: "Caption 0 should be two lines", at: new Date().toISOString() },
      ],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: (name) => tools.push(name),
      onActivity: () => {},
      fetchImpl,
    });

    const second = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    const demand = second.messages.at(-1);
    expect(demand.role).toBe("user");
    expect(demand.content).toContain("You have not looked at the project");
    expect(demand.content).toContain("data-hf-label");
    expect(tools).toEqual(["read_file"]);
    expect(result.assistantText).toBe("Caption 0 says: before.");
  });

  it("lets a run that still calls nothing finish on its second answer", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(completion("Hello!"))
      .mockResolvedValueOnce(completion("Hello again."));

    const result = await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "hi", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    // Asked once, never looped.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.assistantText).toBe("Hello again.");
    expect(result.verification).toBeNull();
  });

  /**
   * The other half of TAB-1063: the name the user types is an attribute the
   * model can search for, and a selected element travels with the message. The
   * drawer shows the user's words alone; the model reads the selection first.
   */
  it("names data-hf-label in the prompt and puts the selection ahead of the user's words", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readIndexFirst())
      .mockResolvedValueOnce(completion("Done."));

    await runTabarioModel({
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [
        {
          role: "user",
          text: "make this two lines",
          at: new Date().toISOString(),
          context:
            'Selected on the timeline: "Caption 0", the element with id "caption-0" in index.html, on screen from 0.0s to 3.2s.',
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
    expect(system.content).toContain("data-hf-label");
    expect(system.content).toContain("Never ask the user what an element says");
    const user = body.messages.find((message: { role: string }) => message.role === "user");
    expect(user.content).toBe(
      'Selected on the timeline: "Caption 0", the element with id "caption-0" in index.html, on screen from 0.0s to 3.2s.\n\nmake this two lines',
    );
  });

  /**
   * TAB-1061. A live run measured a caption three times, read `lines: 1` each
   * time, and replied "It is now two lines, as you requested." The gate had
   * checked that measure_layout was called, and it had been. So the numbers
   * are put in front of the model once more at the moment it tries to finish,
   * and the same numbers go to the user as a receipt it cannot rewrite.
   */
  it("quotes the measurement back before the model may finish, then lets the answer stand", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    const source =
      '<html data-composition-id="demo"><body><p id="caption-0">WIDE</p></body></html>\n';
    writeFileSync(join(root, "index.html"), source);
    const hash = createHash("sha256").update(source).digest("hex");
    const measureLayout = vi.fn().mockResolvedValue({
      measured: true,
      seekTime: 0,
      frame: { width: 720, height: 1280 },
      elements: [
        {
          selector: "#caption-0",
          box: { x: 58, y: 947, width: 604, height: 86 },
          lines: 1,
          overflows: false,
          text: "seven words that fit on one line",
        },
      ],
    });
    const transcript: Array<{ name: string; result: string }> = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("e", "edit_file", {
            path: "index.html",
            old_string: "WIDE",
            new_string: "WIDER",
            expected_hash: hash,
          }),
        ]),
      )
      .mockResolvedValueOnce(
        completion("", [call("m", "measure_layout", { selectors: ["#caption-0"] })]),
      )
      // The claim the live run made, against a reading of one line.
      .mockResolvedValueOnce(completion("It is now two lines, as you requested."))
      .mockResolvedValueOnce(completion("It is still on one line; I could not make it wrap."));

    const result = await runTabarioModel({
      adapter: { ...adapter(), measureLayout },
      stagingDir: root,
      kind: "chat",
      transcript: [
        { role: "user", text: "make caption 0 two lines", at: new Date().toISOString() },
      ],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      onToolResult: (entry) => transcript.push({ name: entry.name, result: entry.result }),
      fetchImpl,
    });

    // Four completions: asked once with the numbers, then the reply stands.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(result.assistantText).toBe("It is still on one line; I could not make it wrap.");
    const fourth = JSON.parse(String(fetchImpl.mock.calls[3]?.[1]?.body));
    const demand = fourth.messages[fourth.messages.length - 1];
    expect(demand.role).toBe("user");
    expect(demand.content).toContain("#caption-0: 1 line, box 604 x 86");
    expect(demand.content).toContain("Do not report a result these numbers do not show");

    // The receipt is the probe's reading, not the model's sentence.
    expect(result.verification?.measurement?.elements[0]?.lines).toBe(1);

    // And the ledger can now say what the tools returned.
    expect(transcript.map((entry) => entry.name)).toEqual(["edit_file", "measure_layout"]);
    expect(JSON.parse(transcript[1]!.result).elements[0].lines).toBe(1);
  });

  /**
   * TAB-1173. The width, in the string the model actually reads.
   *
   * The caption instruction told the model to fit a caption by measuring the
   * longest line — and `measure_layout` reported a line *count* and no width, so
   * the number it was told to consult was one the tool never took. Adding the
   * field to the probe is only half the fix: the number has to reach the model,
   * and this is the assertion that says it does. Without it, a later edit could
   * drop the clause from `describeMeasuredElement` and every test would still
   * pass while the instruction went back to naming a number nothing produces.
   */
  it("quotes the widest line and the content box it had to fit (TAB-1173)", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    const source =
      '<html data-composition-id="demo"><body><p id="caption-0">WIDE</p></body></html>\n';
    writeFileSync(join(root, "index.html"), source);
    const hash = createHash("sha256").update(source).digest("hex");
    // A caption two lines deep whose second line runs past its content box —
    // the exact shape the founder reported, and the one the model could not see.
    const measureLayout = vi.fn().mockResolvedValue({
      measured: true,
      seekTime: 0,
      frame: { width: 720, height: 720 },
      elements: [
        {
          selector: "#caption-2",
          box: { x: 58, y: 947, width: 604, height: 208 },
          lines: 2,
          widestLinePx: 641,
          contentBoxPx: 604,
          overflows: false,
          text: "bottleneck without adding more people",
        },
      ],
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("e", "edit_file", {
            path: "index.html",
            old_string: "WIDE",
            new_string: "WIDER",
            expected_hash: hash,
          }),
        ]),
      )
      .mockResolvedValueOnce(
        completion("", [call("m", "measure_layout", { selectors: ["#caption-2"] })]),
      )
      .mockResolvedValueOnce(completion("It is on two lines now."))
      .mockResolvedValueOnce(completion("It is on two lines."));

    await runTabarioModel({
      adapter: { ...adapter(), measureLayout },
      stagingDir: root,
      kind: "chat",
      transcript: [
        { role: "user", text: "make caption 2 two lines", at: new Date().toISOString() },
      ],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      onToolResult: () => {},
      fetchImpl,
    });

    const last = JSON.parse(String(fetchImpl.mock.calls[3]?.[1]?.body));
    const demand = last.messages[last.messages.length - 1];
    expect(demand.content).toContain("widest line 641px in a 604px content box, 37px too wide");
  });

  it("says a line is within its content box rather than reporting a width alone", async () => {
    // The other half of the same sentence, and the reason it is a comparison
    // rather than two numbers: "widest line 600px" answers nothing on its own.
    // A model given the two figures side by side can see the fit; one given a
    // width has to be told the box as well and do the subtraction itself.
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    const source =
      '<html data-composition-id="demo"><body><p id="caption-0">WIDE</p></body></html>\n';
    writeFileSync(join(root, "index.html"), source);
    const hash = createHash("sha256").update(source).digest("hex");
    const measureLayout = vi.fn().mockResolvedValue({
      measured: true,
      seekTime: 0,
      elements: [
        {
          selector: "#caption-0",
          box: { x: 0, y: 0, width: 600, height: 100 },
          lines: 1,
          widestLinePx: 512,
          contentBoxPx: 600,
          text: "short",
        },
      ],
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        completion("", [
          call("e", "edit_file", {
            path: "index.html",
            old_string: "WIDE",
            new_string: "WIDER",
            expected_hash: hash,
          }),
        ]),
      )
      .mockResolvedValueOnce(
        completion("", [call("m", "measure_layout", { selectors: ["#caption-0"] })]),
      )
      .mockResolvedValueOnce(completion("Done."))
      .mockResolvedValueOnce(completion("Done."));

    await runTabarioModel({
      adapter: { ...adapter(), measureLayout },
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "check caption 0", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      onToolResult: () => {},
      fetchImpl,
    });

    const last = JSON.parse(String(fetchImpl.mock.calls[3]?.[1]?.body));
    const demand = last.messages[last.messages.length - 1];
    expect(demand.content).toContain("widest line 512px in a 600px content box, within it");
    expect(demand.content).not.toContain("too wide");
  });

  /**
   * TAB-1061's second hole. The old flag never reset, so measure, write,
   * finish passed on a reading older than the change. A write now clears it.
   */
  it("does not let a measurement taken before the change stand in for one after it", async () => {
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
      .mockResolvedValueOnce(completion("", [call("m", "measure_layout", { selectors: ["p"] })]))
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
      .mockResolvedValueOnce(completion("It should now display correctly."))
      .mockResolvedValueOnce(completion("I have not checked it."));

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

    const fourth = JSON.parse(String(fetchImpl.mock.calls[3]?.[1]?.body));
    const demand = fourth.messages[fourth.messages.length - 1];
    expect(demand.content).toContain("have not measured the result");
    expect(result.assistantText).toBe("I have not checked it.");
    // A change happened and nothing measured it afterwards: the receipt says so.
    expect(result.verification).toEqual({ measurement: null });
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

  // ── The gate, and the pictures (TAB-1093) ────────────────────────────────

  /** The tool result for `id` out of the request the provider sent next. */
  function toolResultFrom(fetchImpl: ReturnType<typeof vi.fn>, round: number, id: string): unknown {
    const body = JSON.parse(String((fetchImpl.mock.calls[round]?.[1] as RequestInit)?.body));
    const message = body.messages.find(
      (entry: { tool_call_id?: string }) => entry.tool_call_id === id,
    );
    return JSON.parse(message.content);
  }

  async function runWithCall(
    toolCall: ReturnType<typeof call>,
    extraAdapter: Partial<StudioApiAdapter> = {},
  ) {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(completion("", [toolCall]))
      .mockResolvedValueOnce(completion("Done."));

    await runTabarioModel({
      adapter: { ...adapter(), ...extraAdapter },
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "check it please", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    return { fetchImpl, root };
  }

  it("offers run_check, frame_screenshot and contact_sheet on every run", async () => {
    const root = mkdtempSync(join(tmpdir(), "tabario-provider-"));
    writeFileSync(join(root, "index.html"), HTML);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(readIndexFirst())
      .mockResolvedValueOnce(completion("An answer."));

    await runTabarioModel({
      // Deliberately the bare adapter, with none of the three methods: the tool
      // list is the same either way, and a tool that vanished when the server
      // could not run it would teach the model nothing.
      adapter: adapter(),
      stagingDir: root,
      kind: "chat",
      transcript: [{ role: "user", text: "check it", at: new Date().toISOString() }],
      signal: new AbortController().signal,
      onAssistant: () => {},
      onTool: () => {},
      onActivity: () => {},
      fetchImpl,
    });

    const body = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit)?.body));
    const names = body.tools.map((t: { function: { name: string } }) => t.function.name);
    expect(names).toContain("run_check");
    expect(names).toContain("frame_screenshot");
    expect(names).toContain("contact_sheet");
    const system = body.messages.find((message: { role: string }) => message.role === "system");
    expect(system.content).toContain("check is not lint");
    expect(system.content).toContain("run_check");
    expect(system.content).toContain("you get a link and you give them the link");
    expect(system.content).toContain("report sampled page ranges only from `pageFrameTimes`");
    expect(system.content).toContain("If exact timestamps are absent");
    const sheet = body.tools.find(
      (t: { function: { name: string } }) => t.function.name === "contact_sheet",
    );
    expect(sheet.function.description).toContain("Use pageFrameTimes");
    expect(sheet.function.description).toContain("never infer page ranges from cellSeconds");
  });

  it("passes a ran:false check result through verbatim rather than smoothing it", async () => {
    const runCheck = vi
      .fn()
      .mockResolvedValue({ ran: false, error: "deadline", stderr_tail: "chrome went away\n" });

    const { fetchImpl } = await runWithCall(call("k", "run_check", {}), { runCheck });

    expect(toolResultFrom(fetchImpl, 1, "k")).toEqual({
      ran: false,
      error: "deadline",
      stderr_tail: "chrome went away\n",
    });
  });

  it("hands the check the staged copy, never the live project", async () => {
    const runCheck = vi.fn().mockResolvedValue({ ran: true, findings: [] });

    const { fetchImpl, root } = await runWithCall(call("k", "run_check", {}), { runCheck });

    expect(runCheck).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: root, signal: expect.anything() }),
    );
    expect(toolResultFrom(fetchImpl, 1, "k")).toEqual({ ran: true, findings: [] });
  });

  it("says this Studio server cannot run check rather than dropping the tool", async () => {
    const { fetchImpl } = await runWithCall(call("k", "run_check", {}));

    const result = toolResultFrom(fetchImpl, 1, "k") as { ran: boolean; error: string };
    expect(result.ran).toBe(false);
    expect(result.error).toContain("This Studio server cannot run check");
  });

  it("says this Studio server cannot make a picture rather than dropping the tool", async () => {
    const shot = await runWithCall(call("s", "frame_screenshot", { t: 2 }));
    const sheet = await runWithCall(call("c", "contact_sheet", {}));

    for (const [run, id] of [
      [shot, "s"],
      [sheet, "c"],
    ] as const) {
      const result = toolResultFrom(run.fetchImpl, 1, id) as { ran: boolean; error: string };
      expect(result.ran).toBe(false);
      expect(result.error).toContain("This Studio server cannot");
    }
  });

  it("passes exact contact sheet timestamps to the model unchanged", async () => {
    const receipt = {
      ran: true,
      url: "/studio/receipts/abc/def/0123456789abcdef0123456789abcdef.jpg",
      revision: "def",
      width: 720,
      height: 720,
      pages: 1,
      pageUrls: ["/studio/receipts/abc/def/0123456789abcdef0123456789abcdef.jpg"],
      cellSeconds: 0.5,
      durationSeconds: 3,
      framesPerPage: 9,
      frameCount: 7,
      pageFrameTimes: [[0, 0.5, 1, 1.5, 2, 2.5, 2.91]],
    };
    const contactSheet = vi.fn().mockResolvedValue(receipt);
    const { fetchImpl, root } = await runWithCall(call("c", "contact_sheet", {}), { contactSheet });
    expect(contactSheet).toHaveBeenCalledWith(expect.objectContaining({ projectDir: root }));
    expect(toolResultFrom(fetchImpl, 1, "c")).toEqual(receipt);
  });

  it("gives the model a receipt URL and no bytes", async () => {
    const frameScreenshot = vi.fn().mockResolvedValue({
      ran: true,
      url: "/studio/receipts/abc/def/0123456789abcdef0123456789abcdef.png",
      revision: "def",
      width: 1080,
      height: 1920,
    });

    const { fetchImpl } = await runWithCall(call("s", "frame_screenshot", { t: 2.5 }), {
      frameScreenshot,
    });

    expect(frameScreenshot).toHaveBeenCalledWith(expect.objectContaining({ t: 2.5 }));
    const result = toolResultFrom(fetchImpl, 1, "s");
    expect(JSON.stringify(result)).not.toContain("base64");
    expect(result).toMatchObject({ ran: true, revision: "def", width: 1080 });
  });
});
