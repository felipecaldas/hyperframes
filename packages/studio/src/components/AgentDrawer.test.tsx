// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDrawer } from "./AgentDrawer";
import { openAgentBridge, toggleAgentBridge } from "../utils/agentBridge";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  readyState = 1;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback =
      typeof listener === "function" ? listener : (event: Event) => listener.handleEvent(event);
    const wrapped = (event: MessageEvent) => callback(event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), wrapped]);
  }

  close(): void {
    this.readyState = 2;
  }

  emit(type: string, payload: object): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: JSON.stringify(payload) }));
    }
  }
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${text}`);
  return button;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  FakeEventSource.instances = [];
  vi.restoreAllMocks();
});

describe("AgentDrawer", () => {
  it("restores provider selection, inspects exact context, and keeps Copy Prompt fallback", async () => {
    localStorage.setItem("hyperframes:agent-provider:demo", "claude");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("capabilities")) {
          return new Response(
            JSON.stringify({
              enabled: true,
              nonce: "nonce",
              providers: {
                codex: {
                  installed: false,
                  authenticated: false,
                  available: false,
                  guidance: "Install Codex",
                },
                claude: { installed: true, authenticated: true, available: true },
              },
            }),
          );
        }
        return new Response(JSON.stringify({ threads: [] }));
      }),
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <AgentDrawer
          projectId="demo"
          beforeRun={async () => ({ ok: true })}
          onRefresh={() => {}}
        />,
      );
    });
    await settle();
    act(() => toggleAgentBridge());
    expect(buttonByText(host, "claude").className).toContain("bg-neutral-200");

    const prompt = "context\nUser addition stays exact";
    act(() => openAgentBridge({ kind: "catalog", prompt, title: "Neon", registryItem: "neon" }));
    expect(host.textContent).toContain("Generated context · Neon");
    expect(host.textContent).toContain(prompt);
    act(() => buttonByText(host, "codex").click());
    expect(localStorage.getItem("hyperframes:agent-provider:demo")).toBe("codex");
    await act(async () => buttonByText(host, "Copy Prompt").click());
    expect(writeText).toHaveBeenCalledWith(prompt);
    act(() => root.unmount());
  });

  it("streams activity and changed files, refreshes once, supports Undo and New chat", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("capabilities")) {
        return new Response(
          JSON.stringify({
            enabled: true,
            nonce: "nonce",
            providers: {
              codex: { installed: true, authenticated: true, available: true },
              claude: { installed: true, authenticated: true, available: true },
            },
          }),
        );
      }
      if (url.endsWith("/agent/threads") && !init?.method) {
        return new Response(JSON.stringify({ threads: [] }));
      }
      if (url.endsWith("/agent/runs"))
        return new Response(JSON.stringify({ jobId: "job-1" }), { status: 202 });
      if (url.endsWith("/undo"))
        return new Response(JSON.stringify({ undone: true, findings: [] }));
      if (url.endsWith("/threads/reset")) return new Response(JSON.stringify({ thread: {} }));
      return new Response(JSON.stringify({ threads: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const beforeRun = vi.fn().mockResolvedValue({ ok: true });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<AgentDrawer projectId="demo" beforeRun={beforeRun} onRefresh={onRefresh} />);
    });
    await settle();
    act(() => toggleAgentBridge());
    act(() => openAgentBridge({ kind: "chat", prompt: "change the title" }));
    await act(async () => buttonByText(host, "Send to codex").click());
    expect(beforeRun).toHaveBeenCalledOnce();
    const source = FakeEventSource.instances[0];
    if (!source) throw new Error("event source missing");
    await act(async () => {
      source.emit("status", { id: 1, type: "status", at: "now", message: "working" });
      source.emit("changed-files", {
        id: 2,
        type: "changed-files",
        at: "now",
        files: [
          {
            path: "index.html",
            change: "modified",
            beforeHash: "a",
            afterHash: "b",
            supported: true,
          },
        ],
      });
      source.emit("lint", {
        id: 3,
        type: "lint",
        at: "now",
        findings: [
          {
            severity: "warning",
            file: "index.html",
            message: "Missing label",
            fixHint: "Add aria-label",
          },
          {
            severity: "error",
            file: "scene.html",
            message: "Missing runtime",
          },
        ],
      });
      source.emit("complete", { id: 4, type: "complete", at: "now", message: "done" });
      await Promise.resolve();
    });
    expect(host.textContent).toContain("modified · index.html");
    expect(host.textContent).toContain("2 lint findings · 1 error · 1 warning");
    expect(host.textContent).toContain("warning · index.html: Missing label — Add aria-label");
    const lintDetails = [...host.querySelectorAll("details")].find((details) =>
      details.querySelector("summary")?.textContent?.includes("2 lint findings"),
    );
    expect(lintDetails?.open).toBe(false);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await act(async () => buttonByText(host, "Undo").click());
    expect(onRefresh).toHaveBeenCalledTimes(2);
    const newChatButton = host.querySelector('button[title="New chat"]');
    if (!(newChatButton instanceof HTMLButtonElement)) throw new Error("New chat button missing");
    await act(async () => newChatButton.click());
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/threads/reset"))).toBe(true);
    act(() => root.unmount());
  });
});
