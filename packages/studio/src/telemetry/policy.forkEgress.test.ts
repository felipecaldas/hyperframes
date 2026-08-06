// ---------------------------------------------------------------------------
// Tabario fork (TAB-697) — regression guard for the telemetry kill switch.
//
// Fork-owned file: it does not exist upstream, so it never conflicts on a
// rebase. Its whole job is to fail loudly if the hard-OFF short-circuit in
// `browserTelemetryAllowed()` is dropped while resolving one — which would
// silently resume sending Tabario customers' usage to HeyGen's PostHog.
//
// `policy.test.ts` (upstream) covers the control matrix itself; this asserts
// the fork's override sits ABOVE that matrix and cannot be re-enabled by any
// combination of runtime state.
// ---------------------------------------------------------------------------
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserTelemetryAllowed, browserTelemetryAllowedUpstream } from "./policy";

const OPT_OUT_KEY = "hyperframes-studio:telemetryDisabled";
const LEGACY_OPT_OUT_KEY = "hf-studio-telemetry-opt-out";

describe("Tabario fork: browser telemetry is unconditionally off", () => {
  beforeEach(() => {
    localStorage.removeItem(OPT_OUT_KEY);
    localStorage.removeItem(LEGACY_OPT_OUT_KEY);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is false with no opt-out set and Do Not Track off — the case that would otherwise send", () => {
    vi.stubGlobal("navigator", { ...navigator, doNotTrack: "0" });
    expect(browserTelemetryAllowed()).toBe(false);
  });

  it("is false even when every user-facing opt-out is explicitly cleared", () => {
    vi.stubGlobal("navigator", { ...navigator, doNotTrack: null });
    localStorage.setItem(OPT_OUT_KEY, "0");
    localStorage.setItem(LEGACY_OPT_OUT_KEY, "0");
    expect(browserTelemetryAllowed()).toBe(false);
  });

  it("stays false when the opt-out keys are set (no double-negative re-enables it)", () => {
    localStorage.setItem(OPT_OUT_KEY, "1");
    expect(browserTelemetryAllowed()).toBe(false);
    localStorage.removeItem(OPT_OUT_KEY);
    localStorage.setItem(LEGACY_OPT_OUT_KEY, "1");
    expect(browserTelemetryAllowed()).toBe(false);
  });

  it("does not depend on localStorage being reachable at all", () => {
    // A partitioned/sandboxed context where getItem throws. Upstream fails
    // closed here; the fork must not even reach that path.
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    vi.stubGlobal("localStorage", throwing);
    expect(browserTelemetryAllowed()).toBe(false);
  });

  it("keeps upstream's control matrix intact and separately reachable", () => {
    // Guards against "resolving" a future conflict by deleting upstream's
    // logic instead of keeping the fork override layered on top of it. If the
    // upstream evaluator disappears, this file stops compiling.
    expect(typeof browserTelemetryAllowedUpstream).toBe("function");
    localStorage.setItem(OPT_OUT_KEY, "1");
    expect(browserTelemetryAllowedUpstream()).toBe(false);
  });
});
