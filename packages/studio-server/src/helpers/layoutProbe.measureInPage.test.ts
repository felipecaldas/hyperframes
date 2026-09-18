// @vitest-environment node

/**
 * TAB-1169 — the in-page half of the probe, exercised for the first time.
 *
 * `layoutProbe.test.ts` covers `classifyLayoutProbe`, the pure decision half. It cannot
 * reach `measureInPage`, which is where the defect lived: `countLines` added a line top
 * for **every child**, so the caption emitter's break element —
 * `<div class="hf-caption-break">` at `flex-basis: 100%; height: 0`, which takes a flex
 * line of its own while painting nothing — was counted as a line of text. Every
 * correctly wrapped caption therefore measured one line too many, and the agent, told to
 * trust `measure_layout`, chased a `lines: 2` the instrument could only answer with `3`.
 *
 * ## Why this evaluates the function's source instead of calling it
 *
 * `studioServer.ts` runs it as `page.evaluate(measureInPage, selectors)`, so **Puppeteer
 * serializes the function's own source into the page**. Stringifying it here and
 * evaluating it against a declared DOM means the code under test is the code the Studio
 * actually runs — including the self-containment constraint, which a plain import would
 * quietly let us break. A helper this function closed over would work in this test and
 * fail in the browser; here it fails in both.
 *
 * ## What this does and does not establish
 *
 * The inputs are **explicit rects**, so this asserts the counting rule given geometry:
 * which rects constitute a line. It does not establish that a real browser gives a
 * zero-height flex child its own rect — that is a layout fact, it was measured directly
 * on the Tier-1 Studio (same words, `box.height` 50px both times: no break → `lines: 2`,
 * with break → `lines: 3`), and it is recorded in TAB-1168's story. This test guards the
 * rule against being reverted; the browser fact is what the rule is for.
 */

import { describe, expect, it } from "vitest";
import { measureInPage, type RawLayoutProbe } from "./layoutProbe.js";

/** A client rect as the page reports it. Only `top` and `height` reach the line count. */
function rect(top: number, height: number): DOMRect {
  return {
    top,
    height,
    bottom: top + height,
    width: 100,
    x: 0,
    y: top,
    left: 0,
    right: 100,
    toJSON: () => ({}),
  } as DOMRect;
}

/** A word span: one rect, painted, on the line at `top`. */
const word = (top: number) => rect(top, 40);

/**
 * The emitter's break element: `flex-basis: 100%` puts it on a flex line of its own, and
 * `height: 0` means nothing is painted there. It still reports a rect, whose `top` is
 * distinct from both word lines — that extra top **is** the phantom third line.
 */
const breakEl = (top: number) => rect(top, 0);

/**
 * The three tops a real browser reports for a two-line caption: line 1's words at 0, the
 * break's own line at 20, line 2's words at 40. Three distinct tops, two lines of text —
 * which is how `lines: 3` came back for a caption with two.
 *
 * These numbers state the *shape* of the fact rather than quote a pixel measurement. What
 * was measured on the Tier-1 Studio is that the reading goes from 2 to 3 when the break is
 * present (TAB-1168). The `20` matters: a fixture that put the break's top level with
 * line 2 would add no distinct top, and would then pass with or without the fix — which
 * is exactly how the first version of this file managed to assert nothing.
 */
const LINE_1_TOP = 0;
const BREAK_TOP = 20;
const LINE_2_TOP = 40;

/** An element whose children report the given rects. */
function caption(childRects: DOMRect[][], rangeRects: DOMRect[] = []): Element {
  const children = childRects.map((rects) => ({
    getClientRects: () => rects as unknown as DOMRectList,
  }));
  return {
    children,
    getClientRects: () => childRects.flat() as unknown as DOMRectList,
    getBoundingClientRect: () => rect(0, 100),
    scrollWidth: 100,
    scrollHeight: 100,
    clientWidth: 100,
    clientHeight: 100,
    style: { width: "", height: "" },
    textContent: "what if AI could do",
    __rangeRects: rangeRects,
  } as unknown as Element;
}

/**
 * Run the real `measureInPage` against a stub page, exactly as Puppeteer would: the
 * function's source is evaluated with only `document` and `getComputedStyle` in scope.
 */
function measure(target: Element): RawLayoutProbe {
  const documentStub = {
    querySelector: (selector: string) => (selector === "#caption-0" ? target : null),
    createRange: () => ({
      selectNodeContents: () => {},
      getClientRects: () =>
        ((target as unknown as { __rangeRects: DOMRect[] }).__rangeRects ??
          []) as unknown as DOMRectList,
    }),
    documentElement: { clientWidth: 720, clientHeight: 720 },
  };
  const getComputedStyleStub = () => ({ display: "flex", visibility: "visible" });

  const run = new Function(
    "document",
    "getComputedStyle",
    "selectors",
    `return (${measureInPage.toString()})(selectors);`,
  );
  return run(documentStub, getComputedStyleStub, ["#caption-0"]) as RawLayoutProbe;
}

const linesOf = (target: Element): number | undefined => measure(target).elements[0]?.lines;

describe("measureInPage line counting", () => {
  /**
   * The exact shape the compiler emits for a two-line caption: two words, the break
   * element, two more words. `flex-basis: 100%` forces the break onto its own flex line,
   * so a real browser reports three distinct tops — which is why the old count said 3.
   */
  it("does not count the break element as a line (TAB-1169)", () => {
    const wrapped = caption([
      [word(LINE_1_TOP)],
      [word(LINE_1_TOP)],
      [breakEl(BREAK_TOP)],
      [word(LINE_2_TOP)],
      [word(LINE_2_TOP)],
    ]);
    expect(linesOf(wrapped)).toBe(2);
  });

  /** The control: the same words with no break element must read the same. */
  it("reads the same two lines whether or not the break element is present", () => {
    const withBreak = caption([
      [word(LINE_1_TOP)],
      [word(LINE_1_TOP)],
      [breakEl(BREAK_TOP)],
      [word(LINE_2_TOP)],
      [word(LINE_2_TOP)],
    ]);
    const withoutBreak = caption([
      [word(LINE_1_TOP)],
      [word(LINE_1_TOP)],
      [word(LINE_2_TOP)],
      [word(LINE_2_TOP)],
    ]);
    expect(linesOf(withoutBreak)).toBe(2);
    expect(linesOf(withBreak)).toBe(linesOf(withoutBreak));
  });

  /**
   * The guard against over-correcting. A genuine three-line caption must still say three;
   * a fix that flattened real wraps would trade one silent wrong answer for another.
   */
  it("still counts three real lines as three", () => {
    const threeLine = caption([[word(0)], [word(40)], [word(80)]]);
    expect(linesOf(threeLine)).toBe(3);
  });

  /** A two-line caption whose break sits between them, with real lines either side. */
  it("counts the painted lines around a break, not the break", () => {
    const twoLine = caption([
      [word(LINE_1_TOP)],
      [word(LINE_1_TOP)],
      [breakEl(BREAK_TOP)],
      [word(LINE_2_TOP)],
    ]);
    expect(linesOf(twoLine)).toBe(2);
  });

  /**
   * The other branch: an element with no element children is measured through a Range
   * over its contents. Unchanged by this fix, and asserted so that it stays that way.
   */
  it("measures a text-only element from its Range rects", () => {
    const plain = caption([], [rect(0, 40), rect(40, 40)]);
    expect(linesOf(plain)).toBe(2);
  });
});
