import { describe, expect, it } from "vitest";
import { StudioFileConflictError } from "../utils/studioSaveDiagnostics";
import { resolveAgentPreflight } from "./agentPreflight";

describe("resolveAgentPreflight", () => {
  it("allows the run only when the drain is clean AND the editor buffer is not dirty", () => {
    expect(resolveAgentPreflight({ status: "clean" }, false)).toEqual({ ok: true });
  });

  it("blocks a clean drain that still has a dirty editor buffer", () => {
    // Nothing failed to save — there is simply more the user hasn't committed
    // to disk yet, and an agent run would write over it.
    const result = resolveAgentPreflight({ status: "clean" }, true);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/unsaved changes/i);
  });

  it("distinguishes a conflict from a failed write", () => {
    const conflict = resolveAgentPreflight(
      {
        status: "conflict",
        error: new StudioFileConflictError({
          filePath: "index.html",
          currentVersion: null,
          currentContent: null,
          attemptedContent: "",
        }),
      },
      false,
    );
    const failed = resolveAgentPreflight(
      { status: "failed", error: new Error("disk full") },
      false,
    );

    expect(conflict.ok).toBe(false);
    expect(failed.ok).toBe(false);
    // The whole point of reading upstream's drain result instead of a boolean:
    // these two block for different reasons and must not read identically.
    expect(conflict.message).not.toBe(failed.message);
    expect(conflict.message).toMatch(/changed on disk/i);
    expect(failed.message).toMatch(/could not be saved/i);
  });

  it("still blocks a conflict or failure even when the editor buffer is clean", () => {
    expect(
      resolveAgentPreflight(
        {
          status: "conflict",
          error: new StudioFileConflictError({
            filePath: "index.html",
            currentVersion: null,
            currentContent: null,
            attemptedContent: "",
          }),
        },
        false,
      ).ok,
    ).toBe(false);
    expect(resolveAgentPreflight({ status: "failed", error: new Error("nope") }, false).ok).toBe(
      false,
    );
  });
});
