import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProvider, startProviderRun } from "./providers.js";

describe("agent provider adapters", () => {
  const oldPath = process.env.PATH;
  const oldCapture = process.env.FAKE_PROVIDER_CAPTURE;
  const oldAuth = process.env.FAKE_CLAUDE_AUTH;
  const oldMode = process.env.FAKE_CLAUDE_MODE;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hf-agent-provider-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("claude 1.0"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({loggedIn: process.env.FAKE_CLAUDE_AUTH !== "false"})); process.exit(0); }
fs.writeFileSync(process.env.FAKE_PROVIDER_CAPTURE, JSON.stringify(args));
if (process.env.FAKE_CLAUDE_MODE === "failure") { console.error("fixture failure"); process.exit(7); }
if (process.env.FAKE_CLAUDE_MODE === "wait") { setInterval(() => {}, 1000); return; }
console.log("not-json");
console.log(JSON.stringify({type:"system",session_id:"33333333-3333-4333-8333-333333333333"}));
console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"hello"},{type:"tool_use",name:"Edit"}]}}));
console.log(JSON.stringify({type:"result",result:"done",session_id:"33333333-3333-4333-8333-333333333333"}));
`;
    writeFileSync(join(bin, "claude"), script);
    chmodSync(join(bin, "claude"), 0o755);
    writeFileSync(join(bin, "codex"), script);
    chmodSync(join(bin, "codex"), 0o755);
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    process.env.FAKE_PROVIDER_CAPTURE = join(root, "args.json");
    delete process.env.FAKE_CLAUDE_AUTH;
    delete process.env.FAKE_CLAUDE_MODE;
  });

  afterEach(() => {
    process.env.PATH = oldPath;
    process.env.FAKE_PROVIDER_CAPTURE = oldCapture;
    process.env.FAKE_CLAUDE_AUTH = oldAuth;
    process.env.FAKE_CLAUDE_MODE = oldMode;
  });

  it("detects install/auth state without retaining account details", async () => {
    expect(await detectProvider("claude")).toMatchObject({
      installed: true,
      authenticated: true,
      available: true,
    });
    process.env.FAKE_CLAUDE_AUTH = "false";
    expect(await detectProvider("claude")).toMatchObject({
      installed: true,
      authenticated: false,
      available: false,
    });
  });

  it("uses stream JSON, deny-by-default narrow tools, isolated settings, resume ids, stdin prompts, and normalized events", async () => {
    const sessions: string[] = [];
    const assistant: string[] = [];
    const tools: string[] = [];
    const diagnostics: string[] = [];
    const run = startProviderRun({
      provider: "claude",
      projectDir: root,
      prompt: "literal $(touch nope)",
      sessionId: "44444444-4444-4444-8444-444444444444",
      onSession: (id) => sessions.push(id),
      onAssistant: (text) => assistant.push(text),
      onTool: (summary) => tools.push(summary),
      onDiagnostic: (message) => diagnostics.push(message),
    });
    expect((await run.done).code).toBe(0);
    const args = JSON.parse(readFileSync(process.env.FAKE_PROVIDER_CAPTURE!, "utf-8")) as string[];
    expect(args).toContain("stream-json");
    expect(args).toContain("dontAsk");
    expect(args).toContain("--setting-sources");
    expect(args).toContain("project");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain('{"mcpServers":{}}');
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--resume");
    expect(args).not.toContain("literal $(touch nope)");
    expect(args.join(" ")).not.toContain("bypassPermissions");
    expect(sessions).toContain("33333333-3333-4333-8333-333333333333");
    expect(assistant).toEqual(["hello", "done"]);
    expect(tools).toEqual(["Edit"]);
    expect(diagnostics).toContain("Claude emitted malformed stream JSON output.");
  });

  it("keeps Codex in workspace-write mode on first and resumed runs", async () => {
    const callbacks = {
      onSession: () => {},
      onAssistant: () => {},
      onTool: () => {},
      onDiagnostic: () => {},
    };
    const first = startProviderRun({
      provider: "codex",
      projectDir: root,
      prompt: "first prompt",
      sessionId: null,
      ...callbacks,
    });
    expect((await first.done).code).toBe(0);
    const firstArgs = JSON.parse(
      readFileSync(process.env.FAKE_PROVIDER_CAPTURE!, "utf-8"),
    ) as string[];
    expect(firstArgs).toContain("--sandbox");
    expect(firstArgs).toContain("workspace-write");
    expect(firstArgs).not.toContain("first prompt");

    const resumed = startProviderRun({
      provider: "codex",
      projectDir: root,
      prompt: "follow-up prompt",
      sessionId: "55555555-5555-4555-8555-555555555555",
      ...callbacks,
    });
    expect((await resumed.done).code).toBe(0);
    const resumedArgs = JSON.parse(
      readFileSync(process.env.FAKE_PROVIDER_CAPTURE!, "utf-8"),
    ) as string[];
    expect(resumedArgs).toContain("resume");
    expect(resumedArgs).toContain('sandbox_mode="workspace-write"');
    expect(resumedArgs).toContain("55555555-5555-4555-8555-555555555555");
    expect(resumedArgs).not.toContain("follow-up prompt");
    expect(resumedArgs.join(" ")).not.toContain("dangerously-bypass");
  });

  it("surfaces process failure and cancels a live process", async () => {
    process.env.FAKE_CLAUDE_MODE = "failure";
    const failed = startProviderRun({
      provider: "claude",
      projectDir: root,
      prompt: "fail",
      sessionId: null,
      onSession: () => {},
      onAssistant: () => {},
      onTool: () => {},
      onDiagnostic: () => {},
    });
    expect(await failed.done).toMatchObject({
      code: 7,
      stderr: expect.stringContaining("fixture failure"),
    });

    process.env.FAKE_CLAUDE_MODE = "wait";
    const waiting = startProviderRun({
      provider: "claude",
      projectDir: root,
      prompt: "wait",
      sessionId: null,
      onSession: () => {},
      onAssistant: () => {},
      onTool: () => {},
      onDiagnostic: () => {},
    });
    waiting.cancel();
    expect((await waiting.done).code).not.toBe(0);
  });
});
