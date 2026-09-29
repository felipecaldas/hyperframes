// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { LayoutMeasurement } from "../../helpers/layoutProbe.js";
import { decideVerdict, type VerdictFacts } from "./verdict.js";

const READING: LayoutMeasurement = {
  measured: true,
  seekTime: 1,
  elements: [{ selector: "#caption-0", lines: 2 }],
};

function facts(overrides: Partial<VerdictFacts> = {}): VerdictFacts {
  return {
    cancelled: false,
    timeout: null,
    failure: null,
    refusals: [],
    changedFiles: 0,
    verification: null,
    stopReason: "complete",
    ...overrides,
  };
}

describe("decideVerdict (TAB-1196)", () => {
  it("calls a run that answered and changed nothing dispatched", () => {
    expect(decideVerdict(facts()).verdict).toBe("dispatched");
  });

  it("calls a run that wrote a renderable file and never measured saved, not verified", () => {
    const receipt = decideVerdict(facts({ changedFiles: 1, verification: { measurement: null } }));
    expect(receipt.verdict).toBe("saved");
    expect(receipt.reason).toContain("nothing measured them afterwards");
  });

  it("calls a run whose measurement could not be taken saved, not verified", () => {
    const unavailable: LayoutMeasurement = {
      measured: false,
      seekTime: 0,
      elements: [],
      unavailable: "no browser",
    };
    const receipt = decideVerdict(
      facts({ changedFiles: 1, verification: { measurement: unavailable } }),
    );
    expect(receipt.verdict).toBe("saved");
    expect(receipt.reason).toContain("returned no reading");
  });

  it("calls a run whose every element was unmeasurable saved, not verified", () => {
    const nothingRead: LayoutMeasurement = {
      measured: false,
      seekTime: 1,
      elements: [{ selector: "#gone", unmeasurable: "not in the document" }],
    };
    expect(
      decideVerdict(facts({ changedFiles: 1, verification: { measurement: nothingRead } })).verdict,
    ).toBe("saved");
  });

  it("calls a run that changed only files no measurement can read saved", () => {
    const receipt = decideVerdict(facts({ changedFiles: 1, verification: null }));
    expect(receipt.verdict).toBe("saved");
    expect(receipt.reason).toContain("none was taken");
  });

  it("calls a run measured after its last change verified", () => {
    expect(
      decideVerdict(facts({ changedFiles: 1, verification: { measurement: READING } })).verdict,
    ).toBe("verified");
  });

  it("calls a run a gate declined refused, and says which gate in plain words", () => {
    const receipt = decideVerdict(
      facts({
        failure: "Staged changes introduced lint errors and were not applied",
        refusals: [{ gate: "lint", stage: "apply", message: "index.html: fixture lint error" }],
      }),
    );
    expect(receipt.verdict).toBe("refused");
    expect(receipt.reason).toContain("introduced errors the project did not have");
  });

  it("does not let a refusal the model repaired mid-run decide the verdict", () => {
    const receipt = decideVerdict(
      facts({
        changedFiles: 1,
        verification: { measurement: READING },
        refusals: [{ gate: "lint", stage: "tool", message: "refused once, then repaired" }],
      }),
    );
    expect(receipt.verdict).toBe("verified");
  });

  it("calls a run that fell over failed rather than refused", () => {
    expect(decideVerdict(facts({ failure: "Tabario AI request failed (503)" })).verdict).toBe(
      "failed",
    );
  });

  it("calls a cancelled run failed even when a failure text is also present", () => {
    const receipt = decideVerdict(facts({ cancelled: true, failure: "aborted" }));
    expect(receipt).toEqual({
      verdict: "failed",
      reason: "The run was cancelled. Nothing was applied.",
    });
  });

  it("calls a timed-out run failed and puts the timeout ahead of a refusal", () => {
    const receipt = decideVerdict(
      facts({
        timeout: "Tabario AI timed out after 3 minutes without activity.",
        refusals: [{ gate: "lint", stage: "apply", message: "late" }],
      }),
    );
    expect(receipt.verdict).toBe("failed");
    expect(receipt.reason).toContain("ran out of time");
  });

  it.each([
    ["tokens", "its token budget"],
    ["cost", "its cost budget"],
    ["rounds", "its limit of tool rounds"],
  ] as const)("names the %s ceiling beside the verdict it did not change", (stopReason, words) => {
    const receipt = decideVerdict(
      facts({ changedFiles: 1, verification: { measurement: null }, stopReason }),
    );
    expect(receipt.verdict).toBe("saved");
    expect(receipt.reason).toContain(`stopped early because it reached ${words}`);
  });

  it("never carries the failure text or the refusal message into the reason", () => {
    const receipt = decideVerdict(
      facts({
        failure: "SECRET-FAILURE-TEXT",
        refusals: [{ gate: "conflict", stage: "apply", message: "SECRET-FILE-CONTENT" }],
      }),
    );
    expect(receipt.reason).not.toContain("SECRET");
  });
});
