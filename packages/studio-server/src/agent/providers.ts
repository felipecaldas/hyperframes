import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentProvider, AgentProviderCapability } from "./types.js";

export interface ProviderRunOptions {
  provider: AgentProvider;
  projectDir: string;
  prompt: string;
  sessionId: string | null;
  onSession: (sessionId: string) => void;
  onAssistant: (text: string) => void;
  onTool: (summary: string) => void;
  onDiagnostic: (message: string) => void;
}

export interface ProviderProcess {
  process: ChildProcessWithoutNullStreams;
  done: Promise<{ code: number | null; stderr: string }>;
  cancel: () => void;
}

type SpawnProcess = typeof spawn;

const PROVIDER_EXECUTABLES: Record<AgentProvider, string> = {
  codex: "codex",
  claude: "claude",
};

function runProbe(
  executable: string,
  args: string[],
  spawnProcess: SpawnProcess,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveProbe) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawnProcess(executable, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolveProbe({ code, stdout, stderr });
    };
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", () => finish(null));
    child.on("close", finish);
    setTimeout(() => {
      if (!settled) child.kill("SIGTERM");
    }, 5000).unref();
  });
}

export async function detectProvider(
  provider: AgentProvider,
  spawnProcess: SpawnProcess = spawn,
): Promise<AgentProviderCapability> {
  const executable = PROVIDER_EXECUTABLES[provider];
  const version = await runProbe(executable, ["--version"], spawnProcess);
  if (version.code !== 0) {
    return {
      installed: false,
      authenticated: false,
      available: false,
      guidance: `Install the ${provider === "codex" ? "Codex" : "Claude Code"} CLI, then restart Preview.`,
    };
  }
  const auth = await runProbe(
    executable,
    provider === "codex" ? ["login", "status"] : ["auth", "status", "--json"],
    spawnProcess,
  );
  const authenticated =
    provider === "codex"
      ? auth.code === 0 && /logged in/i.test(`${auth.stdout}\n${auth.stderr}`)
      : auth.code === 0 && /"loggedIn"\s*:\s*true/.test(auth.stdout);
  return {
    installed: true,
    authenticated,
    available: authenticated,
    ...(authenticated
      ? {}
      : {
          guidance: `Run \`${provider === "codex" ? "codex login" : "claude auth login"}\` in a terminal.`,
        }),
  };
}

function codexArgs(sessionId: string | null): string[] {
  if (sessionId) {
    return [
      "exec",
      "resume",
      "-c",
      'sandbox_mode="workspace-write"',
      "--json",
      "--skip-git-repo-check",
      sessionId,
      "-",
    ];
  }
  return ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-"];
}

function claudeArgs(sessionId: string | null): string[] {
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--allowedTools",
    "Read,Glob,Grep,Edit,Write,Bash(npx hyperframes lint:*),Bash(npx hyperframes check:*)",
    ...(sessionId ? ["--resume", sessionId] : []),
  ];
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function extractClaudeText(value: unknown): string[] {
  const record = objectRecord(value);
  const message = objectRecord(record?.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const texts: string[] = [];
  for (const item of content) {
    const block = objectRecord(item);
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  return texts;
}

/**
 * Parse one line of a provider's stream, reporting malformed output through
 * onDiagnostic. Returns null for both malformed JSON and non-object payloads.
 */
function parseProviderLine(
  line: string,
  malformedMessage: string,
  opts: ProviderRunOptions,
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    opts.onDiagnostic(malformedMessage);
    return null;
  }
  return objectRecord(parsed);
}

function emitCodexCompletedItem(item: Record<string, unknown>, opts: ProviderRunOptions): void {
  if (item.type === "agent_message" && typeof item.text === "string") {
    opts.onAssistant(item.text);
    return;
  }
  if (item.type === "command_execution") {
    const command = typeof item.command === "string" ? item.command : "command";
    opts.onTool(command.slice(0, 500));
  }
}

function handleCodexLine(line: string, opts: ProviderRunOptions): void {
  const event = parseProviderLine(line, "Codex emitted malformed JSONL output.", opts);
  if (!event) return;
  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    opts.onSession(event.thread_id);
  }
  const item = objectRecord(event.item);
  if (event.type === "item.completed" && item) emitCodexCompletedItem(item, opts);
}

function emitClaudeToolUses(event: Record<string, unknown>, opts: ProviderRunOptions): void {
  const message = objectRecord(event.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const item of content) {
    const block = objectRecord(item);
    if (block?.type === "tool_use" && typeof block.name === "string") opts.onTool(block.name);
  }
}

function handleClaudeLine(line: string, opts: ProviderRunOptions): void {
  const event = parseProviderLine(line, "Claude emitted malformed stream JSON output.", opts);
  if (!event) return;
  if (typeof event.session_id === "string") opts.onSession(event.session_id);
  if (event.type === "assistant") {
    for (const text of extractClaudeText(event)) opts.onAssistant(text);
    emitClaudeToolUses(event, opts);
    return;
  }
  if (event.type === "result" && typeof event.result === "string" && event.result.trim()) {
    opts.onAssistant(event.result);
  }
}

export function startProviderRun(
  opts: ProviderRunOptions,
  spawnProcess: SpawnProcess = spawn,
): ProviderProcess {
  const executable = PROVIDER_EXECUTABLES[opts.provider];
  const args = opts.provider === "codex" ? codexArgs(opts.sessionId) : claudeArgs(opts.sessionId);
  const child = spawnProcess(executable, args, {
    cwd: opts.projectDir,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(opts.prompt);

  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    if (opts.provider === "codex") handleCodexLine(line, opts);
    else handleClaudeLine(line, opts);
  });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-16_384);
  });
  const done = new Promise<{ code: number | null; stderr: string }>((resolveDone) => {
    child.on("error", (error) => resolveDone({ code: null, stderr: error.message }));
    child.on("close", (code) => resolveDone({ code, stderr }));
  });
  const cancel = () => {
    if (child.exitCode !== null || child.killed) return;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 3000).unref();
  };
  return { process: child, done, cancel };
}
