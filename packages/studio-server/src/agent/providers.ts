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
 */
function systemPrompt(kind: AgentRequestKind): string {
  return `You are Tabario AI inside Tabario Studio. You are editing one isolated HyperFrames project.
The user's request kind is ${kind}. Inspect the project before changing it. Use only the provided tools.

A HyperFrames project's timeline IS its HTML — reading the files is how you inspect the video:
- \`index.html\` is the host timeline. Every timed element carries \`data-start\` and \`data-duration\` in seconds, plus \`data-track-index\` for its layer.
- Scenes are mounted from \`compositions/*.html\` via \`data-composition-src\`; their own timings are relative to where the parent mounts them.
- Media live in \`assets/\` and are referenced by \`<video>\`, \`<img>\` and \`<audio>\` elements; captions are text elements on their own track.
- Motion is the GSAP block in \`index.html\`: \`tl.to\`, \`tl.fromTo\` and \`tl.set\` calls, each with a position in seconds.

So questions about what is on screen, when, for how long, or why something is missing are answerable from the source. To answer one, read \`index.html\` and any mounted compositions and reason over those attributes — give concrete element ids and time ranges. Never say you cannot see the timeline or the media; if something genuinely is not in the files, say what you looked at and what was absent.

Never invent file contents or paths. Never embed remote assets, secrets, or network calls in project code.
Preserve the existing template, media references, duration, captions, and voiceover unless the user asks to change them.
All edits are staged and linted before Studio applies them. Call validate_project after edits and repair lint errors.
For edit-oriented requests, make the requested source changes. For questions, answer without changing files.
End with a concise explanation of what changed or what you found.`;
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
  tool("search_files", "Search editable source files for literal text.", {
    type: "object",
    properties: { query: { type: "string" }, path: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  }),
  tool("write_file", "Create or replace an editable source file using optimistic hash locking.", {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      expected_hash: { type: ["string", "null"] },
    },
    required: ["path", "content", "expected_hash"],
    additionalProperties: false,
  }),
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

function writeFile(args: JsonRecord, options: TabarioModelOptions): unknown {
  const file = safeSourcePath(options.stagingDir, args.path);
  if (typeof args.content !== "string") throw new Error("content is required");
  if (Buffer.byteLength(args.content, "utf-8") > MAX_FILE_BYTES)
    throw new Error("file is too large");
  const current = hashFile(file.absolute);
  if ((args.expected_hash ?? null) !== current)
    throw new Error(`hash conflict for ${file.relative}; current hash is ${current ?? "null"}`);
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

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  list_files: listFiles,
  read_file: readFile,
  search_files: searchFiles,
  write_file: writeFile,
  delete_file: deleteFile,
  validate_project: validateProject,
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

async function executeToolCalls(
  calls: ToolCall[],
  messages: ChatMessage[],
  options: TabarioModelOptions,
): Promise<void> {
  for (const call of calls) {
    options.onTool(call.function.name);
    options.onActivity();
    let result: unknown;
    try {
      result = await executeTool(call, options);
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
  }
}

export async function runTabarioModel(options: TabarioModelOptions): Promise<TabarioModelResult> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("Tabario AI is not configured on this Studio server.");
  const model = modelName();
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(options.kind) },
    ...options.transcript.slice(-24).map((entry) => ({ role: entry.role, content: entry.text })),
  ];
  const fetchImpl = options.fetchImpl ?? fetch;
  let assistantText = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    if (options.signal.aborted) throw new DOMException("Tabario AI run cancelled.", "AbortError");
    options.onActivity();
    const completion = await requestCompletion(fetchImpl, apiKey, model, messages, options.signal);
    messages.push({
      role: "assistant",
      content: completion.content || null,
      tool_calls: completion.toolCalls,
    });
    if (completion.content) assistantText = completion.content;
    if (completion.toolCalls.length === 0) {
      if (assistantText) options.onAssistant(assistantText);
      return { assistantText, model };
    }
    await executeToolCalls(completion.toolCalls, messages, options);
  }
  throw new Error(`Tabario AI exceeded ${MAX_TOOL_ROUNDS} tool rounds.`);
}
