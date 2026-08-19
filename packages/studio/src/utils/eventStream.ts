/**
 * One `EventSource`, with an end to it (TAB-798).
 *
 * `EventSource` reconnects on its own and never gives up, and Studio's agent and
 * file-change streams handled `error` not at all. When a compositor deploy wiped
 * the in-memory Studio session table (TAB-789), a browser still holding a
 * validly-signed cookie produced hundreds of 404s in the network panel — and,
 * since TAB-797, an agent spinner that ticked forever, because only a terminal
 * event ever cleared `busy`.
 *
 * The distinction that decides it is `readyState`:
 *
 * - **CLOSED** — the browser already failed the connection for good: a bad
 *   status or a non-`text/event-stream` content type. A 404 or 410 from a dead
 *   session lands here. Retrying cannot help.
 * - **CONNECTING** — the connection dropped and the browser is retrying by
 *   itself. Worth tolerating a few times, and no more.
 *
 * Giving up is reported rather than swallowed, because a stream that quietly
 * stops is how "no feedback to the user" happens twice.
 */

/** `EventSource.CLOSED`, spelled out — the constant is absent from some test doubles. */
const CLOSED = 2;

export const MAX_STREAM_RETRIES = 3;

export type StreamGiveUpReason = "closed" | "retries";

export interface EventStreamOptions {
  url: string;
  /** Event name → handler. Handlers stop firing once the stream is closed. */
  listeners: Record<string, (event: MessageEvent) => void>;
  /** Called at most once, when the stream is abandoned. Never after `close()`. */
  onGiveUp: (reason: StreamGiveUpReason) => void;
  maxRetries?: number;
  /** Seam for tests; defaults to the global `EventSource`. */
  createSource?: (url: string) => EventSource;
}

export interface EventStreamHandle {
  close: () => void;
}

export function openEventStream(options: EventStreamOptions): EventStreamHandle {
  const create = options.createSource ?? ((url: string) => new EventSource(url));
  const maxRetries = options.maxRetries ?? MAX_STREAM_RETRIES;
  const source = create(options.url);
  let done = false;
  let retries = 0;

  const close = () => {
    if (done) return;
    done = true;
    source.close();
  };

  for (const [type, listener] of Object.entries(options.listeners)) {
    source.addEventListener(type, (event) => {
      // A late delivery after close() would resurrect state the caller has
      // already torn down.
      if (done || !(event instanceof MessageEvent)) return;
      listener(event);
    });
  }

  source.addEventListener("error", () => {
    if (done) return;
    const fatal = source.readyState === CLOSED;
    if (!fatal && (retries += 1) <= maxRetries) return;
    close();
    options.onGiveUp(fatal ? "closed" : "retries");
  });

  return { close };
}
