// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  finishAgentRun,
  hasAgentEditorDirty,
  openAgentBridge,
  setAgentEditorDirty,
  setAgentRunActive,
  shouldSuppressAgentRefresh,
  subscribeAgentRefresh,
  subscribeAgentRequests,
} from "./agentBridge";

afterEach(() => {
  setAgentRunActive(false);
  setAgentEditorDirty(false);
  vi.restoreAllMocks();
});

describe("Studio Agent Bridge event state", () => {
  // Amended by TAB-1221: the two used to travel as one string, and now travel
  // apart. What this pins is unchanged, that the bridge rewrites neither.
  it("passes the user's words and what was gathered through unchanged, and apart", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAgentRequests(listener);
    const prompt = "keep this exact → text";
    const material = "generated context\n\nText: keep this exact too";
    openAgentBridge({ kind: "selection", prompt, material, title: "Hero", registryItem: "neon" });
    expect(listener).toHaveBeenCalledWith({
      kind: "selection",
      prompt,
      material,
      title: "Hero",
      registryItem: "neon",
    });
    unsubscribe();
  });

  it("suppresses intermediate reloads and emits one completion refresh", () => {
    const refresh = vi.fn();
    const unsubscribe = subscribeAgentRefresh(refresh);
    setAgentRunActive(true);
    expect(shouldSuppressAgentRefresh()).toBe(true);
    finishAgentRun();
    expect(refresh).toHaveBeenCalledOnce();
    expect(shouldSuppressAgentRefresh()).toBe(true);
    unsubscribe();
  });

  it("shares dirty Storyboard editor state with the run gate", () => {
    expect(hasAgentEditorDirty()).toBe(false);
    setAgentEditorDirty(true);
    expect(hasAgentEditorDirty()).toBe(true);
  });
});
