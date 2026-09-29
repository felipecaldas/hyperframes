/**
 * A bounded retry for the one call the whole run depends on (TAB-1196).
 *
 * `requestCompletion` used to make a single attempt. A 429 or a 503 from the
 * provider threw, the throw was caught in `AgentRuntime.execute`, and the
 * staging directory was discarded with everything the run had done in it. A
 * run twenty rounds deep lost all twenty to one bad second upstream.
 *
 * Three things keep this from becoming the opposite problem:
 *
 * - **Bounded per call.** `maxAttempts` counts the first try, so three means
 *   two retries.
 * - **Bounded per run.** A run makes up to 24 calls, and a provider that is
 *   down for a minute would otherwise be asked 72 times. `RetryAllowance` is
 *   the run's total, shared across its calls.
 * - **Only what waiting can fix.** 429 and 5xx. A 400 or a 401 says the same
 *   thing the second time, and repeating it spends the run's time for nothing.
 *
 * The delay is exponential with full jitter: a random point between zero and
 * the ceiling for that attempt. Every sandbox runs this same code, so a fixed
 * schedule would have them all come back at the same instant, which is the
 * load spike that caused the 429 in the first place.
 */

/** Attempts per call, the first one included. */
const DEFAULT_MAX_ATTEMPTS = 3;
/** The ceiling for the first retry's delay. It doubles from here. */
const DEFAULT_BASE_DELAY_MS = 500;
/** No single wait is longer than this, whatever the provider asks for. */
const DEFAULT_MAX_DELAY_MS = 8_000;
/** Retries a whole run may spend across all of its calls. */
const DEFAULT_MAX_RUN_RETRIES = 6;

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRunRetries: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveRetryPolicy(): RetryPolicy {
  return {
    maxAttempts: envInt("TABARIO_STUDIO_RETRY_ATTEMPTS", DEFAULT_MAX_ATTEMPTS),
    baseDelayMs: envInt("TABARIO_STUDIO_RETRY_BASE_MS", DEFAULT_BASE_DELAY_MS),
    maxDelayMs: envInt("TABARIO_STUDIO_RETRY_MAX_MS", DEFAULT_MAX_DELAY_MS),
    maxRunRetries: envInt("TABARIO_STUDIO_RUN_RETRY_BUDGET", DEFAULT_MAX_RUN_RETRIES),
  };
}

/** Worth asking again: the provider is busy or broken, not the request. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * `Retry-After` in milliseconds, or null when it is absent or unreadable.
 *
 * The header is either a number of seconds or an HTTP date. Both are read,
 * because a provider's gateway and the provider itself do not always agree on
 * which to send.
 */
export function retryAfterMs(header: string | null, now: number): number | null {
  const value = header?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/**
 * How long to wait before attempt `attempt + 1`, where `attempt` is the one
 * that just failed, counted from 1.
 *
 * A `Retry-After` the provider sent wins over the computed delay, and is still
 * capped: a header asking for ten minutes would otherwise hold the run past its
 * own idle timeout, and the run would be reported as timed out rather than as
 * what it was.
 */
export function retryDelayMs(
  attempt: number,
  policy: RetryPolicy,
  retryAfter: number | null,
  random: () => number,
): number {
  if (retryAfter !== null) return Math.min(retryAfter, policy.maxDelayMs);
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

/** The run's total of retries, shared by every call it makes. */
export interface RetryAllowance {
  /** Takes one retry from the run's total, or says there are none left. */
  take: () => boolean;
  used: () => number;
}

export function createRetryAllowance(limit: number): RetryAllowance {
  let spent = 0;
  return {
    take: () => {
      if (spent >= limit) return false;
      spent += 1;
      return true;
    },
    used: () => spent,
  };
}

/**
 * Waits, and gives up the wait the moment the run is cancelled.
 *
 * Without the abort a cancelled run would sit out its backoff before noticing,
 * and the user would watch "Cancelling…" for as long as the longest delay.
 */
export function sleepUnlessAborted(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolveSleep, rejectSleep) => {
    const cancelled = () => new DOMException("Tabario AI run cancelled.", "AbortError");
    if (signal.aborted) {
      rejectSleep(cancelled());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      rejectSleep(cancelled());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveSleep();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RetryOptions {
  policy: RetryPolicy;
  allowance: RetryAllowance;
  signal: AbortSignal;
  /** Called before each wait, so the run's idle timer knows it is alive. */
  onRetry?: (attempt: number, status: number, delayMs: number) => void;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

/** Whether the response just received should be asked for again. */
function shouldRetry(response: Response, attempt: number, options: RetryOptions): boolean {
  if (response.ok || !isRetryableStatus(response.status)) return false;
  if (attempt >= options.policy.maxAttempts) return false;
  return options.allowance.take();
}

/**
 * Sends the request, and sends it again while the answer is one waiting can
 * fix and there are attempts left.
 *
 * Returns the last response whatever it was. Deciding that a non-ok response
 * is an error stays with the caller, which already knows how to say so.
 */
export async function sendWithRetry(
  send: () => Promise<Response>,
  options: RetryOptions,
): Promise<Response> {
  const sleep = options.sleep ?? sleepUnlessAborted;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  for (let attempt = 1; ; attempt += 1) {
    const response = await send();
    if (!shouldRetry(response, attempt, options)) return response;
    const delay = retryDelayMs(
      attempt,
      options.policy,
      retryAfterMs(response.headers.get("retry-after"), now()),
      random,
    );
    // The body is never read on this path, and an unread body holds its
    // connection open until it is collected.
    await response.body?.cancel().catch(() => {});
    options.onRetry?.(attempt, response.status, delay);
    await sleep(delay, options.signal);
  }
}
