// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { openEventStream, MAX_STREAM_RETRIES } from "./eventStream";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

/**
 * A double, because the real `EventSource` decides `readyState` from a network
 * response and that is exactly the branch under test.
 */
class FakeSource {
  readyState = OPEN;
  closed = false;
  readonly listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = CLOSED;
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** A failure the browser has given up on — bad status, wrong content type. */
  fail(): void {
    this.readyState = CLOSED;
    for (const listener of this.listeners.get("error") ?? []) listener(new Event("error"));
  }

  /** A dropped connection the browser will retry on its own. */
  drop(): void {
    this.readyState = CONNECTING;
    for (const listener of this.listeners.get("error") ?? []) listener(new Event("error"));
  }
}

function open(overrides: Partial<Parameters<typeof openEventStream>[0]> = {}) {
  const sources: FakeSource[] = [];
  const onGiveUp = vi.fn();
  const messages: unknown[] = [];
  const handle = openEventStream({
    url: "/api/events",
    listeners: { "file-change": (event) => messages.push(JSON.parse(event.data)) },
    onGiveUp,
    createSource: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source as unknown as EventSource;
    },
    ...overrides,
  });
  const source = sources[0];
  if (!source) throw new Error("no source created");
  return { handle, source, onGiveUp, messages };
}

describe("openEventStream", () => {
  it("delivers events while the stream is healthy", () => {
    const { source, messages, onGiveUp } = open();
    source.emit("file-change", { path: "index.html" });
    expect(messages).toEqual([{ path: "index.html" }]);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  /**
   * TAB-798, reproduced. A 404 or 410 from a dead Studio session leaves the
   * stream CLOSED; retrying is what turned one wiped session table into
   * hundreds of requests in the network panel.
   */
  it("gives up at once on a fatal failure and never reopens", () => {
    const { source, onGiveUp } = open();
    source.fail();
    expect(onGiveUp).toHaveBeenCalledExactlyOnceWith("closed");
    expect(source.closed).toBe(true);
    // A second error after giving up must not report again.
    source.fail();
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it("tolerates a dropped connection, then gives up once the retries run out", () => {
    const { source, onGiveUp } = open();
    for (let attempt = 0; attempt < MAX_STREAM_RETRIES; attempt += 1) {
      source.drop();
      // Still hoping — the browser is reconnecting on its own.
      expect(onGiveUp).not.toHaveBeenCalled();
      expect(source.closed).toBe(false);
    }
    source.drop();
    expect(onGiveUp).toHaveBeenCalledExactlyOnceWith("retries");
    expect(source.closed).toBe(true);
  });

  it("stops delivering and stops reporting after close()", () => {
    const { handle, source, messages, onGiveUp } = open();
    handle.close();
    expect(source.closed).toBe(true);
    source.emit("file-change", { path: "index.html" });
    source.fail();
    expect(messages).toEqual([]);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it("counts retries per stream, not globally", () => {
    const { source, onGiveUp } = open({ maxRetries: 1 });
    source.drop();
    expect(onGiveUp).not.toHaveBeenCalled();
    source.drop();
    expect(onGiveUp).toHaveBeenCalledExactlyOnceWith("retries");
  });
});
