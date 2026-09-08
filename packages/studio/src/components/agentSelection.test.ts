import { describe, expect, it } from "vitest";
import { selectedElementForAgent } from "./agentSelection";
import type { TimelineElement } from "../player/store/timelineElement";

const caption: TimelineElement = {
  id: "caption-0",
  domId: "caption-0",
  label: "Caption 0",
  tag: "div",
  start: 0,
  duration: 3.2,
  track: 2,
};

const scene: TimelineElement = {
  id: "clip-7",
  tag: "video",
  start: 4,
  duration: 2,
  track: 0,
  sourceFile: "compositions/intro.html",
};

describe("selectedElementForAgent (TAB-1063)", () => {
  it("sends the selected element by its file id and its timeline name", () => {
    expect(selectedElementForAgent([caption, scene], "caption-0")).toEqual({
      id: "caption-0",
      label: "Caption 0",
      start: 0,
      duration: 3.2,
    });
  });

  it("falls back to the timeline id and names the owning file when known", () => {
    expect(selectedElementForAgent([caption, scene], "clip-7")).toEqual({
      id: "clip-7",
      label: "clip-7",
      start: 4,
      duration: 2,
      sourceFile: "compositions/intro.html",
    });
  });

  it("sends nothing when nothing is selected or the selection is stale", () => {
    expect(selectedElementForAgent([caption], null)).toBeNull();
    expect(selectedElementForAgent([caption], "gone")).toBeNull();
  });
});
