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

function composer(host: HTMLElement): HTMLTextAreaElement {
  const textarea = host.querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("composer missing");
  return textarea;
}

/** Type as a user does — React listens for `input`, not for `.value =`. */
function typeInto(textarea: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, text);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressEnter(textarea: HTMLTextAreaElement, shiftKey = false): void {
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey, bubbles: true }));
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
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
  it("shows one Tabario AI interface, preserves exact context, and has no local-provider fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("capabilities")) {
          return new Response(
            JSON.stringify({
              enabled: true,
              nonce: "nonce",
              providers: {
                tabario: {
                  installed: true,
                  authenticated: false,
                  available: false,
                  guidance: "Tabario AI is not configured",
                },
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
    expect(host.textContent).toContain("Tabario AI");
    expect(host.textContent).toContain("Tabario AI is not configured");
    expect(host.textContent).not.toContain("Codex");
    expect(host.textContent).not.toContain("Claude");

    const prompt = "context\nUser addition stays exact";
    act(() => openAgentBridge({ kind: "catalog", prompt, title: "Neon", registryItem: "neon" }));
    expect(host.textContent).toContain("Generated context · Neon");
    expect(host.textContent).toContain(prompt);
    await act(async () => buttonByText(host, "Unavailable").click());
    expect(host.textContent).toContain("Tabario AI is unavailable");
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
              tabario: { installed: true, authenticated: true, available: true },
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
    await act(async () => buttonByText(host, "Send").click());
    expect(beforeRun).toHaveBeenCalledOnce();
    const runCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/agent/runs"));
    expect(JSON.parse(String(runCall?.[1]?.body))).toMatchObject({ provider: "tabario" });
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

  /**
   * TAB-797, reproduced from the report.
   *
   * The transcript renders `thread.transcript` plus live `assistant` events. The
   * user's turn is persisted server-side, but `loadThreads` runs only on a
   * terminal event — so for the whole run, which is minutes, the message the
   * user had just typed was in neither source and the chat looked like it had
   * eaten it.
   */
  function runFixture(threadsAfterRun: object[]) {
    let completed = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("capabilities")) {
        return new Response(
          JSON.stringify({
            enabled: true,
            nonce: "nonce",
            providers: { tabario: { installed: true, authenticated: true, available: true } },
          }),
        );
      }
      if (url.endsWith("/agent/runs"))
        return new Response(JSON.stringify({ jobId: "job-1" }), { status: 202 });
      if (url.endsWith("/agent/threads") && !init?.method) {
        return new Response(
          JSON.stringify({
            threads: completed
              ? [
                  {
                    provider: "tabario",
                    sessionId: null,
                    invalidated: false,
                    transcript: threadsAfterRun,
                  },
                ]
              : [],
          }),
        );
      }
      return new Response(JSON.stringify({ threads: [] }));
    });
    return { fetchMock, complete: () => void (completed = true) };
  }

  async function mountDrawer(fetchMock: ReturnType<typeof vi.fn>) {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", fetchMock);
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
    return { host, root };
  }

  it("keeps the sent message on screen for the whole run, then does not double it", async () => {
    const message = "The Caption Layer is too high";
    const { fetchMock, complete } = runFixture([
      { role: "user", text: message, at: "2026-08-19T00:00:00.000Z" },
      { role: "assistant", text: "I moved it down.", at: "2026-08-19T00:01:00.000Z" },
    ]);
    const { host, root } = await mountDrawer(fetchMock);

    const textarea = composer(host);
    await act(async () => typeInto(textarea, message));
    await act(async () => pressEnter(textarea));
    await settle();

    // Enter alone sent it — no Send click anywhere in this test.
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/agent/runs"))).toBe(true);
    // On screen immediately, and the box is empty again.
    expect(host.textContent).toContain(message);
    expect(textarea.value).toBe("");
    // And something is visibly happening, before any server event has arrived.
    expect(host.textContent).toContain("Starting…");
    expect(host.querySelector(".animate-spin")).not.toBeNull();

    const source = FakeEventSource.instances[0];
    if (!source) throw new Error("event source missing");
    await act(async () => {
      source.emit("tool", { id: 1, type: "tool", at: "now", message: "read_file" });
    });
    // The waiting bubble speaks the way the rest of the agent does (TAB-795).
    expect(host.textContent).toContain("Reading the timeline…");
    expect(host.textContent).not.toContain("read_file");
    // Still there, mid-run — this is the whole bug.
    expect(host.textContent).toContain(message);

    complete();
    await act(async () => {
      source.emit("complete", { id: 2, type: "complete", at: "now", message: "done" });
      await Promise.resolve();
    });
    await settle();

    // The persisted turn replaced the optimistic one rather than joining it.
    expect(occurrences(host.textContent ?? "", message)).toBe(1);
    expect(host.textContent).toContain("I moved it down.");
    expect(host.querySelector(".animate-spin")).toBeNull();
    act(() => root.unmount());
  });

  it("treats Shift+Enter as a newline rather than a send", async () => {
    const { fetchMock } = runFixture([]);
    const { host, root } = await mountDrawer(fetchMock);
    const textarea = composer(host);
    await act(async () => typeInto(textarea, "first line"));
    await act(async () => pressEnter(textarea, true));
    await settle();

    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/agent/runs"))).toBe(false);
    expect(textarea.value).toBe("first line");
    act(() => root.unmount());
  });

  it("gives the text back when the run never starts", async () => {
    const message = "lower the captions";
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("capabilities")) {
        return new Response(
          JSON.stringify({
            enabled: true,
            nonce: "nonce",
            providers: { tabario: { installed: true, authenticated: true, available: true } },
          }),
        );
      }
      if (url.endsWith("/agent/runs"))
        return new Response(JSON.stringify({ error: "Tabario AI is already working." }), {
          status: 409,
        });
      return new Response(JSON.stringify({ threads: [] }));
    });
    const { host, root } = await mountDrawer(fetchMock);
    const textarea = composer(host);
    await act(async () => typeInto(textarea, message));
    await act(async () => pressEnter(textarea));
    await settle();

    expect(host.textContent).toContain("Tabario AI is already working.");
    // Losing what the user typed would be a worse bug than the one being fixed.
    expect(composer(host).value).toBe(message);
    expect(host.querySelector(".animate-spin")).toBeNull();
    act(() => root.unmount());
  });
});
