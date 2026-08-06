// @vitest-environment happy-dom

import { describe, expect, it, vi, beforeEach } from "vitest";

// `shouldTrack()` reads module-level constants evaluated at module load time,
// so changing env after import has no effect. Each test resets module cache.

const OPT_OUT_KEY = "hyperframes-studio:telemetryDisabled";

function setNoTelemetry(value: string | undefined): void {
  if (value === undefined) {
    delete (import.meta.env as Record<string, unknown>).VITE_HYPERFRAMES_NO_TELEMETRY;
  } else {
    (import.meta.env as Record<string, unknown>).VITE_HYPERFRAMES_NO_TELEMETRY = value;
  }
}

function setDev(value: boolean): void {
  (import.meta.env as { DEV: boolean }).DEV = value;
}

async function loadShouldTrack(): Promise<() => boolean> {
  vi.resetModules();
  const mod = await import("./client");
  return mod.shouldTrack;
}

describe("studio client shouldTrack", () => {
  beforeEach(() => {
    setDev(false);
    setNoTelemetry(undefined);
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  // Tabario fork (TAB-697): was `toBe(true)`. This transport delegates to
  // `browserTelemetryAllowed()`, which the fork holds hard OFF because Studio
  // ships to Tabario's customers. Upstream's control matrix is still covered
  // in full by policy.test.ts against `browserTelemetryAllowedUpstream()`.
  it("returns false with no opt-outs and no dev mode — the case that would otherwise send", async () => {
    const shouldTrack = await loadShouldTrack();
    expect(shouldTrack()).toBe(false);
  });

  it("returns false when user has opted out via localStorage", async () => {
    localStorage.setItem(OPT_OUT_KEY, "1");
    const shouldTrack = await loadShouldTrack();
    expect(shouldTrack()).toBe(false);
  });

  it("returns false when navigator.doNotTrack is '1'", async () => {
    vi.stubGlobal("navigator", { ...navigator, doNotTrack: "1" });
    const shouldTrack = await loadShouldTrack();
    expect(shouldTrack()).toBe(false);
  });

  it("returns false when VITE_HYPERFRAMES_NO_TELEMETRY=1 at build time", async () => {
    setNoTelemetry("1");
    const shouldTrack = await loadShouldTrack();
    expect(shouldTrack()).toBe(false);
  });

  it.each(["true", "TRUE", " yes ", "on"])(
    "returns false when VITE_HYPERFRAMES_NO_TELEMETRY=%j",
    async (value) => {
      setNoTelemetry(value);
      const shouldTrack = await loadShouldTrack();
      expect(shouldTrack()).toBe(false);
    },
  );

  // Tabario fork (TAB-697): was `toBe(true)`. VITE_HYPERFRAMES_NO_TELEMETRY=false
  // is upstream's "measure me" spelling; under the fork it must NOT re-enable
  // sending — that env var is exactly the misconfiguration the hard-off
  // constant exists to survive.
  it("stays off even for an explicit VITE_HYPERFRAMES_NO_TELEMETRY=false", async () => {
    setNoTelemetry("false");
    const shouldTrack = await loadShouldTrack();
    expect(shouldTrack()).toBe(false);
  });

  it("returns false in vite dev mode", async () => {
    setDev(true);
    const shouldTrack = await loadShouldTrack();
    expect(shouldTrack()).toBe(false);
  });

  // Previously asserted the opposite. That memoization WAS the bug: policy.ts
  // is explicit that transports re-ask, and policy.test.ts asserts a
  // mid-session opt-out takes effect at once — but this transport cached on
  // first call, so a user who opted out in DevTools after one event kept
  // sending `studio_*` and render events while `studio:*` correctly stopped.
  // Tabario fork (TAB-697): the first assertion was `toBe(true)`. The property
  // under test is that the transport re-asks the policy per call rather than
  // memoizing the first answer — preserved here so a future rebase that
  // reintroduces caching is still caught, even though both reads are now off.
  it("re-reads the policy on every call rather than memoizing the first answer", async () => {
    const shouldTrack = await loadShouldTrack();
    expect(shouldTrack()).toBe(false);
    localStorage.setItem(OPT_OUT_KEY, "1");
    expect(shouldTrack()).toBe(false);
  });
});
