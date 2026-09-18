// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  classifyLayoutProbe,
  unavailableMeasurement,
  type RawLayoutElement,
  type RawLayoutProbe,
} from "./layoutProbe.js";

function probe(...elements: RawLayoutElement[]): RawLayoutProbe {
  return { frame: { width: 720, height: 720 }, elements };
}

/** The caption as it actually measured in the repro project. */
const PINNED_CAPTION: RawLayoutElement = {
  selector: "#caption-2",
  found: true,
  box: { x: 157, y: 524, width: 405, height: 149 },
  lines: 3,
  scroll: { width: 405, height: 149, clientWidth: 405, clientHeight: 149 },
  display: "flex",
  visibility: "hidden",
  inline: { width: "405px", height: "149px" },
  text: "solving her production bottleneck.",
};

describe("classifyLayoutProbe", () => {
  it("reports the line count and the pinned box that caused it", () => {
    const result = classifyLayoutProbe(probe(PINNED_CAPTION), 5.5);
    expect(result.measured).toBe(true);
    expect(result.seekTime).toBe(5.5);
    expect(result.elements[0]).toMatchObject({
      lines: 3,
      box: { width: 405, height: 149 },
      pinnedByManualEdit: { width: "405px", height: "149px" },
      overflows: false,
    });
    expect(result.elements[0].unmeasurable).toBeUndefined();
  });

  /**
   * TAB-700's trap, and the reason this distinction is a separate function.
   * `.clip { visibility: hidden }` is the runtime's resting state — it hides the
   * element but *preserves its layout*, so the box and the line count are true.
   * Treating it as unmeasurable would make every clip unmeasurable; treating
   * `display: none` as measurable would report a zero as a finding.
   */
  it("measures a visibility:hidden clip, because hiding it keeps its layout", () => {
    const result = classifyLayoutProbe(probe(PINNED_CAPTION), 0);
    expect(result.elements[0].visibility).toBe("hidden");
    expect(result.elements[0].lines).toBe(3);
  });

  it("refuses to call a display:none element measured", () => {
    const result = classifyLayoutProbe(
      probe({ ...PINNED_CAPTION, display: "none", box: { x: 0, y: 0, width: 0, height: 0 } }),
      0,
    );
    expect(result.measured).toBe(false);
    expect(result.elements[0].unmeasurable).toContain("display:none");
    expect(result.elements[0].lines).toBeUndefined();
  });

  it("refuses to call a zero-size box measured", () => {
    const result = classifyLayoutProbe(
      probe({
        ...PINNED_CAPTION,
        display: "flex",
        lines: 0,
        box: { x: 0, y: 0, width: 0, height: 0 },
      }),
      0,
    );
    expect(result.measured).toBe(false);
    expect(result.elements[0].unmeasurable).toContain("zero-size");
    // Said outright, because a zero read as "fine" is how TAB-700 happened.
    expect(result.elements[0].unmeasurable).toContain(
      "not the same as it being laid out correctly",
    );
  });

  it("says a missing element is missing, and says it may just be off screen", () => {
    const result = classifyLayoutProbe(probe({ selector: "#nope", found: false }), 0);
    expect(result.measured).toBe(false);
    expect(result.elements[0].unmeasurable).toContain("nothing matches this selector");
    expect(result.elements[0].unmeasurable).toContain("seek to a time when it is on screen");
  });

  it("flags content wider than its own box", () => {
    const result = classifyLayoutProbe(
      probe({
        ...PINNED_CAPTION,
        lines: 1,
        scroll: { width: 587, height: 67, clientWidth: 405, clientHeight: 67 },
      }),
      0,
    );
    expect(result.elements[0].overflows).toBe(true);
  });

  it("stays measured when one of several elements could not be read", () => {
    const result = classifyLayoutProbe(
      probe(PINNED_CAPTION, { selector: "#gone", found: false }),
      0,
    );
    expect(result.measured).toBe(true);
    expect(result.elements[1].unmeasurable).toBeTruthy();
  });

  it("omits the pin when there is no inline size", () => {
    const result = classifyLayoutProbe(
      probe({ ...PINNED_CAPTION, inline: { width: "", height: "" } }),
      0,
    );
    expect(result.elements[0].pinnedByManualEdit).toBeUndefined();
  });

  /**
   * TAB-1177. The size the reply talks in. A live run answered "It is now
   * displaying at 32px" over a project whose every caption read 48px, and the
   * measurement it was told to trust had no size to contradict it with.
   */
  it("reports the rendered font size beside the lines it was rendered in", () => {
    const result = classifyLayoutProbe(probe({ ...PINNED_CAPTION, fontPx: 46.8 }), 0);
    expect(result.elements[0].fontPx).toBe(46.8);
    expect(result.elements[0].lines).toBe(3);
  });

  /**
   * The same rule the width follows, for the same reason: an element that paints
   * nothing has no line, so a size reported against it is a reading about text
   * that is not there. A sweep asking "is every caption 32px" would count such an
   * element as one that matched.
   */
  it("drops the font size when no line was painted", () => {
    const result = classifyLayoutProbe(
      probe({ ...PINNED_CAPTION, lines: 0, widestLinePx: 0, fontPx: 46.8 }),
      0,
    );
    expect(result.elements[0].fontPx).toBeUndefined();
    expect(result.elements[0].widestLinePx).toBeUndefined();
  });
});

describe("unavailableMeasurement", () => {
  it("carries no elements at all, so it cannot read as a clean result", () => {
    const result = unavailableMeasurement("no browser is available", 2);
    expect(result).toEqual({
      measured: false,
      seekTime: 2,
      elements: [],
      unavailable: "no browser is available",
    });
  });
});
