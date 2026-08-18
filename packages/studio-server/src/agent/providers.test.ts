// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
});
