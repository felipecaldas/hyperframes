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
  it("passes generated context and user additions through unchanged", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAgentRequests(listener);
    const prompt = "generated context\n\nUser request: keep this exact → text";
    openAgentBridge({ kind: "selection", prompt, title: "Hero", registryItem: "neon" });
    expect(listener).toHaveBeenCalledWith({
      kind: "selection",
      prompt,
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
