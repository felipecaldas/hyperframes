// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  isRetryableStatus,
  createRetryAllowance,
  retryAfterMs,
  retryDelayMs,
  sendWithRetry,
  sleepUnlessAborted,
  type RetryPolicy,
} from "./retry.js";

const POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRunRetries: 6,
};

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 200 ? "{}" : "busy", { status, headers });
}

function options(overrides: Partial<Parameters<typeof sendWithRetry>[1]> = {}) {
  return {
    policy: POLICY,
    allowance: createRetryAllowance(POLICY.maxRunRetries),
    signal: new AbortController().signal,
    sleep: vi.fn(async () => {}),
    random: () => 0.5,
    now: () => 0,
    ...overrides,
  };
}

describe("retry (TAB-1196)", () => {
  it.each([429, 500, 502, 503, 504, 599])("retries a %i", (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  it.each([200, 400, 401, 403, 404, 422])("does not retry a %i", (status) => {
    expect(isRetryableStatus(status)).toBe(false);
  });

  it("doubles the delay ceiling per attempt and picks a point under it", () => {
    expect(retryDelayMs(1, POLICY, null, () => 0.5)).toBe(250);
    expect(retryDelayMs(2, POLICY, null, () => 0.5)).toBe(500);
    expect(retryDelayMs(3, POLICY, null, () => 0.5)).toBe(1000);
  });

  it("never waits longer than the maximum, however many attempts came before", () => {
    expect(retryDelayMs(30, POLICY, null, () => 0.999)).toBeLessThan(POLICY.maxDelayMs);
  });

  it("reads Retry-After as seconds and as a date", () => {
    expect(retryAfterMs("2", 0)).toBe(2000);
    expect(retryAfterMs("Thu, 01 Jan 1970 00:00:05 GMT", 1000)).toBe(4000);
    expect(retryAfterMs("soon", 0)).toBeNull();
    expect(retryAfterMs(null, 0)).toBeNull();
    expect(retryAfterMs("-1", 0)).toBeNull();
  });

  it("honours Retry-After and caps a header that asks for too long", () => {
    expect(retryDelayMs(1, POLICY, 2000, () => 0)).toBe(2000);
    expect(retryDelayMs(1, POLICY, 600_000, () => 0)).toBe(POLICY.maxDelayMs);
  });

  it("returns the first good response after a 429 and a 503", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200));
    const opts = options();
    const result = await sendWithRetry(send, opts);
    expect(result.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(3);
    expect(opts.sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up after the last attempt and hands back the failing response", async () => {
    const send = vi.fn(async () => response(503));
    const result = await sendWithRetry(send, options());
    expect(result.status).toBe(503);
    expect(send).toHaveBeenCalledTimes(POLICY.maxAttempts);
  });

  it("makes one attempt at a request waiting cannot fix", async () => {
    const send = vi.fn(async () => response(401));
    const opts = options();
    expect((await sendWithRetry(send, opts)).status).toBe(401);
    expect(send).toHaveBeenCalledTimes(1);
    expect(opts.sleep).not.toHaveBeenCalled();
  });

  it("stops retrying once the run has spent its allowance, across calls", async () => {
    const allowance = createRetryAllowance(3);
    const send = vi.fn(async () => response(503));
    await sendWithRetry(send, options({ allowance }));
    await sendWithRetry(send, options({ allowance }));
    // Two retries on the first call, one on the second, then none are left.
    expect(send).toHaveBeenCalledTimes(3 + 2);
    expect(allowance.used()).toBe(3);
    await sendWithRetry(send, options({ allowance }));
    expect(send).toHaveBeenCalledTimes(3 + 2 + 1);
  });

  it("says it is retrying before it waits, so the idle timer hears it", async () => {
    const onRetry = vi.fn();
    const send = vi
      .fn()
      .mockResolvedValueOnce(response(429, { "retry-after": "1" }))
      .mockResolvedValueOnce(response(200));
    await sendWithRetry(send, options({ onRetry }));
    expect(onRetry).toHaveBeenCalledWith(1, 429, 1000);
  });

  it("abandons the wait when the run is cancelled", async () => {
    const controller = new AbortController();
    const waiting = sleepUnlessAborted(60_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses to start a wait on a run already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleepUnlessAborted(10, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("does not send again once the wait was cancelled", async () => {
    const controller = new AbortController();
    const send = vi.fn(async () => response(503));
    const sleep = vi.fn(async () => {
      controller.abort();
      throw new DOMException("Tabario AI run cancelled.", "AbortError");
    });
    await expect(
      sendWithRetry(send, options({ signal: controller.signal, sleep })),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
