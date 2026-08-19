import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { StudioApiAdapter } from "../types.js";
import { lintProject } from "../helpers/projectLint.js";
import { unavailableMeasurement } from "../helpers/layoutProbe.js";
import { isSupportedAgentSource, snapshotAgentFiles } from "./files.js";
import type { AgentProviderCapability, AgentRequestKind, AgentThreadSummary } from "./types.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-2.5-flash";
const MAX_TOOL_ROUNDS = 24;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_READ_CHARS = 48_000;

type JsonRecord = Record<string, unknown>;
type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};
type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export interface TabarioModelOptions {
  adapter: StudioApiAdapter;
  stagingDir: string;
  kind: AgentRequestKind;
  transcript: AgentThreadSummary["transcript"];
  signal: AbortSignal;
  onAssistant: (text: string) => void;
  onTool: (summary: string) => void;
  onActivity: () => void;
  fetchImpl?: typeof fetch;
}

export interface TabarioModelResult {
  assistantText: string;
  model: string;
}

export function detectProvider(): AgentProviderCapability {
  const enabled = process.env.TABARIO_STUDIO_AI_ENABLED !== "false";
  const configured = Boolean(process.env.OPENROUTER_API_KEY?.trim());
  return {
    installed: enabled,
    authenticated: configured,
    available: enabled && configured,
    ...(!enabled
      ? { guidance: "Tabario AI is disabled for this Studio server." }
      : !configured
        ? { guidance: "Tabario AI is not configured on this Studio server." }
        : {}),
  };
}

function modelName(): string {
  return (
    process.env.TABARIO_STUDIO_MODEL?.trim() ||
    process.env.OPENROUTER_MODEL?.trim() ||
    DEFAULT_MODEL
  );
}

/**
 * TAB-781: say what the files *are*, not just that they can be read.
 *
 * Asked why there was no video between 4s and 7s, the model answered that its
 * "capabilities are limited to file operations and project validation" and that
 * it had no access to timeline or media information. Every tool it needed was
 * already in its hands, and this prompt already told it to answer questions —
 * but a tool list of read/write/search reads as a *domain* of file management
 * unless something says otherwise. It declined a question it could have
 * answered with one `read_file`.
 *
 * So the project's structure is stated outright. Nothing here widens what the
 * agent may write; it only removes the reason it had to believe it could not
 * look.
 *
 * TAB-794: the request kind must stop deciding intent. `useAgentRun` sends
 * `kind: request?.kind ?? "chat"`, so *every* message typed into Studio's chat
 * arrives as `chat` — and this prompt used to end "For questions, answer
 * without changing files". Told "the Caption Layer is too high", the model
 * dutifully replied with a plan in future tense and changed nothing. It was
 * obeying: a typed request was, by construction, a question. So `chat` now
 * means *decide from what the user said*; the explicit kinds stay as they were.
 *
 * TAB-795: and say it like a person. The same reply carried a fenced block of
 * raw CSS, which Studio renders verbatim — fence markers and all — to someone
 * who is editing a video, not a stylesheet. The prompt constrained the reply's
 * content and never its register.
 */
function systemPrompt(kind: AgentRequestKind): string {
  return `You are Tabario AI inside Tabario Studio. You are editing one isolated HyperFrames project.
The user's request kind is ${kind}. Inspect the project before changing it. Use only the provided tools.

A HyperFrames project's timeline IS its HTML — reading the files is how you inspect the video:
- \`index.html\` is the host timeline. Every timed element carries \`data-start\` and \`data-duration\` in seconds, plus \`data-track-index\` for its layer.
- Scenes are mounted from \`compositions/*.html\` via \`data-composition-src\`; their own timings are relative to where the parent mounts them.
- Media live in \`assets/\` and are referenced by \`<video>\`, \`<img>\` and \`<audio>\` elements; captions are text elements on their own track.
- Motion is the GSAP block in \`index.html\`: \`tl.to\`, \`tl.fromTo\` and \`tl.set\` calls, each with a position in seconds.
- Layout overrides are \`gsap.set("#id", {…})\` and \`tl.set("#id", {…}, 0)\` calls carrying \`x\`, \`y\`, \`width\` or \`height\`. These are **not motion**. They are the box a manual drag or resize in Studio left behind, they apply at time 0, and they override the element's CSS rule for that element only. When something wraps onto too many lines, overflows, sits too high or is too narrow, this is the first place to look — before its markup. Widening a pinned box, or removing the pin, is usually the change; re-typing the words inside it never is.

So questions about what is on screen, when, for how long, or why something is missing are answerable from the source. To answer one, read \`index.html\` and any mounted compositions and reason over those attributes — give concrete layer names and time ranges. Never say you cannot see the timeline or the media; if something genuinely is not in the files, say what you looked at and what was absent.

Never invent file contents or paths. Never embed remote assets, secrets, or network calls in project code.
Media filenames cannot be guessed — call list_media to see what the project actually contains, and reference only those. A write whose src points at a file the project does not have is rejected, and the rejection lists the files that do exist.
Change an existing file with edit_file, never by rewriting it whole: name the exact snippet you are replacing and everything else is left untouched. write_file only creates files that do not exist yet. This matters because re-typing a file you were asked to make one change to is how unrelated lines get silently altered.
Preserve the existing template, media references, duration, captions, and voiceover unless the user asks to change them.
All edits are staged and linted before Studio applies them. Call validate_project after edits and repair lint errors.
Lint is not sight. \`validate_project\` only proves the HTML parses — it cannot tell you how many lines a caption takes, whether an element overflows its box, or where it sits in the frame. \`measure_layout\` renders the staged project and measures it. Use it to check any claim about how something looks, and use it again after a layout change, before you say it worked. If it reports an element as unmeasurable, that is not "nothing wrong" — say what you could not measure.

Act on the request — do not merely describe what you would do. The request kind above is a transport label, not the user's intent: everything typed into Studio's chat arrives as \`chat\`, so decide from what the user actually said.
- If they report a problem, say something looks wrong, or ask for a change, and you understand what they mean, then make the change now, in this turn, with the write tools. "The captions are too high" is a request to move them; it does not need the words "fix it".
- Answer without editing only when the message is genuinely a question about the project, or when you cannot proceed without something only the user can tell you — in that case ask exactly one specific question and stop.
- Never end a turn with a plan you have not carried out. Do not say what you "will" do; do it, then say what you did.

How to reply — you are talking to someone editing a video, not reading code:
- Plain language only. Never include code, markup, CSS, JavaScript, diffs, class names, CSS selectors, style property names, or file paths. Fenced code blocks are removed from your reply before it reaches the user, so anything you put in one is simply lost.
- Name things as the user sees them on the timeline: the layer's name, the words on screen, the time it appears. Fall back to an internal id only when nothing user-visible identifies the element.
- Two to four sentences — what was wrong, what you changed, and what they will see now. Past tense once it is done.
- Never report a visual change as done when the measurement does not show it. If the numbers still disagree with what was asked, say what it is now and what you could not achieve.`;
}

const tools = [
  tool(
    "list_files",
    "List editable project source files and their hashes — index.html is the host timeline, compositions/*.html are the scenes it mounts.",
    {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  ),
  tool(
    "read_file",
    "Read an editable source file. This is how you inspect the timeline: element timings, media references, captions and GSAP motion all live in the project HTML.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: MAX_READ_CHARS },
      },
      required: ["path"],
      additionalProperties: false,
    },
  ),
  tool(
    "list_media",
    "List the video, audio and image files the project actually contains. These are not editable, " +
      "but they are the only media you may reference from a src attribute. Call this before adding " +
      "or changing any <video>, <audio> or <img> src — filenames cannot be guessed.",
    { type: "object", properties: {}, additionalProperties: false },
  ),
  tool("search_files", "Search editable source files for literal text.", {
    type: "object",
    properties: { query: { type: "string" }, path: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  }),
  tool(
    "edit_file",
    "Change part of an existing source file by replacing an exact snippet. This is how you edit: " +
      "old_string must appear exactly once, so include enough surrounding text to make it unique. " +
      "Every line you do not name is left byte-for-byte untouched.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        expected_hash: { type: ["string", "null"] },
      },
      required: ["path", "old_string", "new_string", "expected_hash"],
      additionalProperties: false,
    },
  ),
  tool(
    "write_file",
    "Create a NEW editable source file. It cannot overwrite a file that already exists — use " +
      "edit_file for that.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        expected_hash: { type: ["string", "null"] },
      },
      required: ["path", "content", "expected_hash"],
      additionalProperties: false,
    },
  ),
  tool("delete_file", "Delete an editable source file using optimistic hash locking.", {
    type: "object",
    properties: { path: { type: "string" }, expected_hash: { type: "string" } },
    required: ["path", "expected_hash"],
    additionalProperties: false,
  }),
  tool("validate_project", "Lint every HTML composition in the staged project.", {
    type: "object",
    properties: {},
    additionalProperties: false,
  }),
  tool(
    "measure_layout",
    "Measure what the staged project actually lays out as: each element's box in pixels, how many " +
      "rendered lines its text takes, and whether its content overflows its box. This is the only " +
      "way to check a claim about how something looks — lint sees HTML, not layout. Name elements " +
      'by CSS selector (e.g. "#caption-2"). Scenes are mounted, so pass seek_time to measure at ' +
      "a moment the element is actually on screen — its data-start is a good choice.",
    {
      type: "object",
      properties: {
        selectors: { type: "array", items: { type: "string" } },
        composition: { type: "string" },
        seek_time: { type: "number" },
      },
      required: ["selectors"],
      additionalProperties: false,
    },
  ),
];

function tool(name: string, description: string, parameters: JsonRecord) {
  return { type: "function", function: { name, description, parameters } };
}

function hashFile(path: string): string | null {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requiredPath(candidate: unknown): string {
  if (typeof candidate !== "string" || !candidate.trim()) throw new Error("path is required");
  return candidate;
}

function assertNoSymlinks(root: string, relativePath: string): void {
  let current = resolve(root);
  for (const part of relativePath.split(sep)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error("symbolic-link paths are not editable by Tabario AI");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/**
 * Media the agent may reference but may not edit (TAB-791).
 *
 * `list_files` reports only `isSupportedAgentSource` paths, which is every text
 * source and **no** media at all. The agent was therefore blind to `assets/`:
 * asked to put a b-roll in a slot it had no way to learn that
 * `001_37ab941f_cfr24_h264.mp4` existed, so it invented `assets/b-roll.mp4` and
 * reported success. The preview 404'd and the real reference was lost.
 */
const MEDIA_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".webm",
  ".m4v",
  ".ogv",
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".flac",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".avif",
  ".svg",
]);

/** Mirrors the tags @hyperframes/lint's `missing_local_asset` rule scans, plus <audio>. */
const MEDIA_SRC_RE = /<(?:video|audio|img|source)\b[^>]*?\bsrc\s*=\s*["']([^"']*)["']/gi;

function isMediaPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && MEDIA_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/**
 * Every media file in the project, as project-root-relative paths.
 *
 * Reuses `snapshotAgentFiles` rather than walking again: it already skips
 * ignored directories and symlinks, and `list_files` already pays this cost per
 * call, so this stays consistent with the existing tool rather than inventing a
 * second notion of "the project's files".
 */
function mediaInventory(root: string): string[] {
  return Object.keys(snapshotAgentFiles(root).files).filter(isMediaPath).sort();
}

/** A src the project ships nothing for, and cannot: remote, inline, or templated. */
function isNonLocalSrc(src: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src) || /\$\{|\{\{|<%/.test(src);
}

/**
 * Does `src` resolve to a file that exists?
 *
 * Both interpretations count. A composition under `compositions/` writes
 * `src="assets/x.mp4"` meaning **project-root**-relative, while a root-level
 * document means file-relative — and `@hyperframes/lint` resolves the same
 * ambiguity the same way. Accepting either is what keeps this from rejecting
 * edits that are perfectly correct.
 */
function mediaSrcResolves(root: string, fileRelative: string, src: string): boolean {
  const clean = (src.split("?")[0] ?? "").split("#")[0] ?? "";
  // An empty src is `media_missing_src`'s business, not this guard's.
  if (!clean) return true;
  const rootDir = resolve(root);
  return [resolve(rootDir, dirname(fileRelative), clean), resolve(rootDir, clean)].some(
    (candidate) => {
      const rel = relative(rootDir, candidate);
      // Outside the project is unservable by the preview, so it is missing even
      // when it exists on disk.
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) return false;
      return existsSync(candidate);
    },
  );
}

/**
 * Refuse a write that points media at a file the project does not have.
 *
 * This is deliberately a **gate, not an instruction**. The system prompt already
 * said "Never invent file contents or paths" and the model did it anyway, then
 * skipped the `validate_project` call that would have caught it — so the only
 * thing that reliably stops a hallucinated path is a check the model does not
 * get to opt out of.
 *
 * The error carries the real inventory, so the refusal is also the answer: the
 * next turn can pick a filename that exists instead of guessing again.
 */
function assertMediaSrcsResolve(root: string, fileRelative: string, content: string): void {
  if (!fileRelative.toLowerCase().endsWith(".html")) return;

  const missing: string[] = [];
  const re = new RegExp(MEDIA_SRC_RE.source, MEDIA_SRC_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const src = match[1] ?? "";
    if (isNonLocalSrc(src)) continue;
    if (mediaSrcResolves(root, fileRelative, src)) continue;
    if (!missing.includes(src)) missing.push(src);
  }
  if (missing.length === 0) return;

  const available = mediaInventory(root);
  throw new Error(
    `${fileRelative} references media the project does not contain: ${missing.join(", ")}. ` +
      "The renderer and the preview both 404 on these, so the edit would leave a blank region. " +
      (available.length
        ? `Use one of the files that exist: ${available.join(", ")}.`
        : "This project contains no media files at all.") +
      " Media cannot be created by editing HTML — reference an existing asset.",
  );
}

function safeSourcePath(root: string, candidate: unknown): { relative: string; absolute: string } {
  const requested = requiredPath(candidate);
  const absolute = resolve(root, requested);
  const rel = relative(resolve(root), absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error("path is outside project");
  const normalized = rel.split(sep).join("/");
  if (!isSupportedAgentSource(normalized))
    throw new Error("file type is not editable by Tabario AI");
  assertNoSymlinks(root, rel);
  return { relative: normalized, absolute };
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}

function parseArguments(call: ToolCall): JsonRecord {
  try {
    return record(JSON.parse(call.function.arguments));
  } catch {
    throw new Error(`invalid JSON arguments for ${call.function.name}`);
  }
}

function sourceRows(root: string) {
  const snapshot = snapshotAgentFiles(root);
  return Object.entries(snapshot.files)
    .filter(([, file]) => file.supported)
    .map(([path, file]) => ({ path, hash: file.hash, bytes: statSync(join(root, path)).size }));
}

type ToolHandler = (args: JsonRecord, options: TabarioModelOptions) => Promise<unknown> | unknown;

function listFiles(args: JsonRecord, options: TabarioModelOptions): unknown {
  const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
  const limit = typeof args.limit === "number" ? Math.min(200, Math.max(1, args.limit)) : 100;
  return sourceRows(options.stagingDir)
    .filter((file) => !query || file.path.toLowerCase().includes(query))
    .slice(0, limit);
}

function listMedia(_args: JsonRecord, options: TabarioModelOptions): unknown {
  const files = mediaInventory(options.stagingDir);
  return { files, count: files.length };
}

function readFile(args: JsonRecord, options: TabarioModelOptions): unknown {
  const file = safeSourcePath(options.stagingDir, args.path);
  if (!existsSync(file.absolute)) throw new Error("file does not exist");
  const content = readFileSync(file.absolute, "utf-8");
  const offset = typeof args.offset === "number" ? args.offset : 0;
  const limit = typeof args.limit === "number" ? args.limit : MAX_READ_CHARS;
  return {
    path: file.relative,
    hash: hashFile(file.absolute),
    content: content.slice(offset, offset + limit),
    truncated: offset + limit < content.length,
  };
}

function searchFiles(args: JsonRecord, options: TabarioModelOptions): unknown {
  if (typeof args.query !== "string" || !args.query) throw new Error("query is required");
  const query = args.query.toLowerCase();
  const prefix = typeof args.path === "string" ? args.path.replace(/^\/+/, "") : "";
  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const file of sourceRows(options.stagingDir)) {
    if (prefix && !file.path.startsWith(prefix)) continue;
    const lines = readFileSync(join(options.stagingDir, file.path), "utf-8").split("\n");
    lines.forEach((text, index) => {
      if (matches.length < 80 && text.toLowerCase().includes(query))
        matches.push({ path: file.path, line: index + 1, text: text.slice(0, 500) });
    });
  }
  return matches;
}

/**
 * Refuse a write that would leave two elements sharing one `data-hf-id` (TAB-807).
 *
 * TAB-796 made edits *targeted*, so the model can no longer corrupt lines
 * outside the region it names. Nothing checked what it re-types *inside* that
 * region. Asked to put a caption on one line, the model re-emitted
 * `#caption-2`'s four word spans and copied three `data-hf-id` values off
 * `#caption-0` — the words were right, the ids were not.
 *
 * That is worse than it looks. `data-hf-id` is the key Studio's edit
 * persistence resolves an element by, and a duplicate makes the next manual
 * edit land on the *other* element while looking like it worked. It is the same
 * failure `assertUniqueAnchor` exists to prevent, one layer down.
 *
 * Introduced-only, per TAB-780: a file that already carried duplicates must not
 * make every later edit fail. The message names the ids so the next turn can
 * put the originals back rather than guess at new ones.
 */
const HF_ID_RE = /\bdata-hf-id="([^"]*)"/g;

function duplicateHfIds(content: string): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const match of content.matchAll(HF_ID_RE)) {
    const id = match[1];
    if (!id) continue;
    if (seen.has(id)) duplicated.add(id);
    else seen.add(id);
  }
  return [...duplicated];
}

function assertNoNewDuplicateHfIds(before: string, after: string, relative: string): void {
  if (!relative.toLowerCase().endsWith(".html")) return;
  const inherited = new Set(duplicateHfIds(before));
  const introduced = duplicateHfIds(after).filter((id) => !inherited.has(id));
  if (introduced.length === 0) return;
  throw new Error(
    `${relative} would end up with two elements sharing ${
      introduced.length === 1 ? "the data-hf-id" : "the data-hf-ids"
    } ${introduced.join(", ")}. Studio resolves a user's edits by that id, so a repeated one sends ` +
      "their next edit to the wrong element and still looks like it worked. This happens when ids " +
      "are copied from a nearby element while re-typing. Keep every element's existing data-hf-id " +
      "exactly as it already was, and never invent or reuse one.",
  );
}

/** Literal (non-regex) occurrence count, for the uniqueness requirement. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Change one region of a file and leave every other byte alone (TAB-796).
 *
 * `write_file` used to accept whole-file content, so every edit re-typed the
 * entire document. Asked only to move the caption layer, the model also
 * re-emitted an unrelated 4,363-character line and flipped one `rotate(17.78deg)`
 * to `-17.78`, silently rotating a glyph of the title the wrong way. That is
 * valid HTML, so `validate_project` passed and the TAB-780 introduced-errors
 * gate saw nothing. The bigger the file, the more untouched content was put at
 * risk on every single edit.
 *
 * Requiring a unique `old_string` is what makes the change *targeted*: the model
 * has to name the region it means, and everything it does not name is copied
 * rather than retyped. A non-unique anchor is refused rather than guessed at,
 * because picking "the first one" is exactly how an edit lands in the wrong
 * place.
 */
/** The two strings an edit needs, or a message saying which one is wrong. */
function editStrings(args: JsonRecord): { oldString: string; newString: string } {
  const oldString = args.old_string;
  const newString = args.new_string;
  if (typeof oldString !== "string" || oldString === "")
    throw new Error("old_string is required and cannot be empty");
  if (typeof newString !== "string") throw new Error("new_string is required");
  if (oldString === newString) throw new Error("old_string and new_string are identical");
  return { oldString, newString };
}

/**
 * Refuse anything but exactly one match.
 *
 * Resolving an ambiguous anchor to "the first one" is how a targeted edit lands
 * in the wrong place — the failure this whole tool exists to prevent — so the
 * count is reported back and the model is made to narrow it itself.
 */
function assertUniqueAnchor(content: string, oldString: string, relative: string): void {
  const occurrences = countOccurrences(content, oldString);
  if (occurrences === 1) return;
  throw new Error(
    occurrences === 0
      ? `old_string does not appear in ${relative}. Read the file and copy the snippet exactly, whitespace included.`
      : `old_string appears ${occurrences} times in ${relative}; include enough surrounding text to identify exactly one.`,
  );
}

function editFile(args: JsonRecord, options: TabarioModelOptions): unknown {
  const file = safeSourcePath(options.stagingDir, args.path);
  if (!existsSync(file.absolute))
    throw new Error(`${file.relative} does not exist; use write_file to create it`);
  const { oldString, newString } = editStrings(args);

  const current = hashFile(file.absolute);
  if ((args.expected_hash ?? null) !== current)
    throw new Error(`hash conflict for ${file.relative}; current hash is ${current ?? "null"}`);

  const before = readFileSync(file.absolute, "utf-8");
  assertUniqueAnchor(before, oldString, file.relative);

  // Replace via a function so `$&`, `$1` and friends inside new_string stay
  // literal — they are content here, not substitution patterns.
  const after = before.replace(oldString, () => newString);
  if (Buffer.byteLength(after, "utf-8") > MAX_FILE_BYTES) throw new Error("file is too large");
  assertMediaSrcsResolve(options.stagingDir, file.relative, after);
  assertNoNewDuplicateHfIds(before, after, file.relative);
  writeFileSync(file.absolute, after, "utf-8");
  return { path: file.relative, hash: hashFile(file.absolute) };
}

/**
 * Create a file that does not exist yet.
 *
 * Overwriting is refused outright rather than discouraged: TAB-791 established
 * that an instruction the model can decline is not a gate, and "rewrite the
 * whole file" is precisely the operation that corrupted untouched lines in
 * TAB-796. `delete_file` remains available for a genuine wholesale replacement,
 * which at least makes the intent explicit in the ledger.
 */
function writeFile(args: JsonRecord, options: TabarioModelOptions): unknown {
  const file = safeSourcePath(options.stagingDir, args.path);
  if (typeof args.content !== "string") throw new Error("content is required");
  if (Buffer.byteLength(args.content, "utf-8") > MAX_FILE_BYTES)
    throw new Error("file is too large");
  const current = hashFile(file.absolute);
  if (current !== null)
    throw new Error(
      `${file.relative} already exists — use edit_file to change part of it. Rewriting a whole file re-types every line, and lines you were not asked to touch get altered that way. To replace it wholesale, delete_file first.`,
    );
  if ((args.expected_hash ?? null) !== null)
    throw new Error(`hash conflict for ${file.relative}; current hash is null`);
  assertMediaSrcsResolve(options.stagingDir, file.relative, args.content);
  assertNoNewDuplicateHfIds("", args.content, file.relative);
  mkdirSync(dirname(file.absolute), { recursive: true });
  writeFileSync(file.absolute, args.content, "utf-8");
  return { path: file.relative, hash: hashFile(file.absolute) };
}

function deleteFile(args: JsonRecord, options: TabarioModelOptions): unknown {
  const file = safeSourcePath(options.stagingDir, args.path);
  const current = hashFile(file.absolute);
  if (typeof args.expected_hash !== "string" || args.expected_hash !== current)
    throw new Error(`hash conflict for ${file.relative}; current hash is ${current ?? "null"}`);
  unlinkSync(file.absolute);
  return { path: file.relative, deleted: true };
}

async function validateProject(_args: JsonRecord, options: TabarioModelOptions): Promise<unknown> {
  const findings = await lintProject(options.adapter, options.stagingDir);
  return {
    valid: !findings.some((finding) => finding.severity.toLowerCase() === "error"),
    findings,
  };
}

/** How many elements one measurement may name. A request is a handful, not a sweep. */
const MAX_MEASURE_SELECTORS = 12;

/**
 * Measure the staged project, or say plainly that it could not be measured.
 *
 * The staging dir is what gets measured, never the live project: the agent's
 * edits are not in the live one yet, so measuring it would report on a file the
 * agent did not write and quietly answer the wrong question.
 */
async function measureLayoutTool(args: JsonRecord, options: TabarioModelOptions): Promise<unknown> {
  const selectors = (Array.isArray(args.selectors) ? args.selectors : [])
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .slice(0, MAX_MEASURE_SELECTORS);
  if (selectors.length === 0)
    throw new Error('selectors is required — name at least one element, e.g. "#caption-2"');

  const requested = args.seek_time;
  const seekTime =
    typeof requested === "number" && Number.isFinite(requested) ? Math.max(0, requested) : 0;

  if (!options.adapter.measureLayout)
    return unavailableMeasurement(
      "This Studio server cannot measure layout — no browser is available to it. Do not report a " +
        "visual result you were unable to check; say that you could not measure it.",
      seekTime,
    );

  const composition =
    typeof args.composition === "string" && args.composition.trim() ? args.composition : undefined;
  // Confine the measured file to the staging dir, for the same reason every
  // other tool is confined to it.
  if (composition) safeSourcePath(options.stagingDir, composition);

  return options.adapter.measureLayout({
    projectDir: options.stagingDir,
    composition,
    selectors,
    seekTime,
    signal: options.signal,
  });
}

const WRITE_TOOLS = new Set(["edit_file", "write_file"]);

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  list_files: listFiles,
  list_media: listMedia,
  read_file: readFile,
  search_files: searchFiles,
  edit_file: editFile,
  write_file: writeFile,
  delete_file: deleteFile,
  validate_project: validateProject,
  measure_layout: measureLayoutTool,
};

async function executeTool(call: ToolCall, options: TabarioModelOptions): Promise<unknown> {
  const handler = TOOL_HANDLERS[call.function.name];
  if (!handler) throw new Error(`unknown tool: ${call.function.name}`);
  return handler(parseArguments(call), options);
}

function completionMessage(payload: unknown): { content: string; toolCalls: ToolCall[] } {
  const body = record(payload);
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const first = record(choices[0]);
  const message = record(first.message);
  const content = typeof message.content === "string" ? message.content : "";
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((value) => record(value) as unknown as ToolCall)
    : [];
  return { content, toolCalls };
}

async function requestCompletion(
  fetchImpl: typeof fetch,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const response = await fetchImpl(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://studio.tabario.com",
      "X-Title": "Tabario Studio",
    },
    body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature: 0.1 }),
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 800);
    throw new Error(`Tabario AI request failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return completionMessage(await response.json());
}

/** What a round of tools did, for the gate that runs when the model tries to finish. */
interface ToolRunState {
  /** A write to a file whose layout can be measured actually landed. */
  changedRenderable: boolean;
  /** `measure_layout` was called — whether or not it could measure. */
  measured: boolean;
}

function isRenderable(path: unknown): boolean {
  return typeof path === "string" && /\.(html|css)$/i.test(path);
}

async function executeToolCalls(
  calls: ToolCall[],
  messages: ChatMessage[],
  options: TabarioModelOptions,
  state: ToolRunState,
): Promise<void> {
  for (const call of calls) {
    // Cancelling stops the batch here rather than at the next round. A round's
    // tool calls can be several, and one of them can be `validate_project` — a
    // compile and a headless browser — so running the batch out first left the
    // user watching "Cancelling…" for tens of seconds. Stopping between calls
    // rather than mid-call keeps a tool's own writes whole.
    if (options.signal.aborted) throw new DOMException("Tabario AI run cancelled.", "AbortError");
    options.onTool(call.function.name);
    options.onActivity();
    let result: unknown;
    try {
      result = await executeTool(call, options);
      // Only a write that survived every gate counts as a change worth
      // measuring; a rejected edit left the project exactly as it was.
      if (WRITE_TOOLS.has(call.function.name) && isRenderable(parseArguments(call).path))
        state.changedRenderable = true;
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    if (call.function.name === "measure_layout") state.measured = true;
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
  }
}

/**
 * What the run says to the model when it changed the look of something and then
 * tried to answer without checking. One nudge, never a loop: if it still does
 * not measure, the turn ends and the reply stands on its own.
 */
const MEASURE_BEFORE_ANSWERING =
  "You changed the project but have not measured the result, so you do not yet know whether it " +
  "worked. Call measure_layout now on the elements you changed, seeking to a time when they are " +
  "on screen, and compare the numbers with what was asked. Then reply, in the same plain language " +
  "as always: say what you changed and what the measurement shows. If the numbers do not match " +
  "what was asked, either change what the measurement points at or say plainly what it is now and " +
  "what you could not achieve. Always end with a reply — never finish silently.";

/** Said when stripping code leaves nothing at all — never an empty bubble. */
const NOTHING_LEFT_TO_SAY = "I've finished. Let me know if you'd like anything adjusted.";

/**
 * The reply as the user should see it (TAB-795).
 *
 * The system prompt now forbids code in a reply, but TAB-791 already proved
 * that an instruction the model can decline is not a gate — it invented a
 * filename while the prompt said "Never invent file contents or paths". So the
 * outward-facing copy is stripped too.
 *
 * Only what reaches the user is cleaned. The `messages` array keeps the raw
 * completion, because that is the model's own record of what it said and
 * rewriting it would make later turns reason about a conversation that did not
 * happen.
 *
 * An unterminated fence swallows the rest of the message on purpose: half a
 * code block is still a code block, and the fallback below is a better thing to
 * show than the back half of a stylesheet.
 */
function presentableAssistantText(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      // A fence closes only on its own character, and never on a shorter run.
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) fence = marker;
    else kept.push(line);
  }
  const cleaned = kept
    .join("\n")
    // Unwrap inline code, then drop any stray backtick, so no code formatting
    // survives to suggest the user is looking at source.
    .replace(/`+([^`\n]*)`+/g, "$1")
    .replace(/`/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || NOTHING_LEFT_TO_SAY;
}

function requireApiKey(): string {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("Tabario AI is not configured on this Studio server.");
  return apiKey;
}

function initialMessages(options: TabarioModelOptions): ChatMessage[] {
  return [
    { role: "system", content: systemPrompt(options.kind) },
    ...options.transcript.slice(-24).map((entry) => ({ role: entry.role, content: entry.text })),
  ];
}

/**
 * Whether the model may end the turn, or has to go and look first.
 *
 * True only when a write actually landed on something whose layout can be
 * measured, nothing was measured, and it has not already been asked once.
 */
function mustMeasureFirst(state: ToolRunState, alreadyAsked: boolean): boolean {
  return state.changedRenderable && !state.measured && !alreadyAsked;
}

export async function runTabarioModel(options: TabarioModelOptions): Promise<TabarioModelResult> {
  const apiKey = requireApiKey();
  const model = modelName();
  const messages = initialMessages(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  let assistantText = "";
  const state: ToolRunState = { changedRenderable: false, measured: false };
  let measurementDemanded = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    if (options.signal.aborted) throw new DOMException("Tabario AI run cancelled.", "AbortError");
    options.onActivity();
    const completion = await requestCompletion(fetchImpl, apiKey, model, messages, options.signal);
    messages.push({
      role: "assistant",
      content: completion.content || null,
      tool_calls: completion.toolCalls,
    });
    if (completion.content) assistantText = presentableAssistantText(completion.content);
    if (completion.toolCalls.length === 0) {
      // The gate, not the instruction (TAB-791). The prompt already tells the
      // model to measure after a layout change, and in a live run against the
      // reported project it changed the caption's pinned box and then answered
      // "it should now display correctly" without ever measuring — which is the
      // same unchecked claim TAB-805 exists to stop, one cause later. Asked
      // once, at the only moment that matters: when it tries to finish.
      if (mustMeasureFirst(state, measurementDemanded)) {
        measurementDemanded = true;
        messages.push({ role: "user", content: MEASURE_BEFORE_ANSWERING });
        continue;
      }
      // Never finish silently. `assistantText` is only ever set from a
      // completion that carried content, and a model that answers with tool
      // calls alone and then stops leaves the drawer showing changed files and
      // no word about them — which is what two live TAB-805 runs did. TAB-795
      // already decided an empty bubble is not acceptable; this is the same
      // rule applied to the turn as a whole rather than to one stripped reply.
      const reply = assistantText || NOTHING_LEFT_TO_SAY;
      options.onAssistant(reply);
      return { assistantText: reply, model };
    }
    await executeToolCalls(completion.toolCalls, messages, options, state);
  }
  throw new Error(`Tabario AI exceeded ${MAX_TOOL_ROUNDS} tool rounds.`);
}
