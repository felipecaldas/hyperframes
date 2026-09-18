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
 * A rect with a horizontal extent, for TAB-1173.
 *
 * `rect()` pins `left: 0, right: 100`, which is all a line *count* needs and is
 * exactly useless for a width — every line would measure 100 and the assertion
 * could not tell a wide line from a narrow one, which is the failure mode this
 * file's own history warns about.
 */
function span(top: number, left: number, right: number, height = 40): DOMRect {
  return {
    top,
    height,
    bottom: top + height,
    width: right - left,
    x: left,
    y: top,
    left,
    right,
    toJSON: () => ({}),
  } as DOMRect;
}

/** A break element with a horizontal extent: paints nothing, so it measures nothing. */
const wideBreak = (top: number) => span(top, 0, 500, 0);

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
function measure(target: Element, style: Record<string, string> = {}): RawLayoutProbe {
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
  const getComputedStyleStub = () => ({ display: "flex", visibility: "visible", ...style });

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

/**
 * TAB-1173 — the probe now returns how wide the widest line is, and how much room
 * it had.
 *
 * Why this exists: the agent was told to fit a caption by "measuring the longest
 * line and setting the size so it fits", and the instrument it was told to use
 * could not return a width. `measure_layout` reported the line *count* — the
 * rects' `top` values — and threw the `left`/`right` of those same rects away one
 * line after reading them. An instruction naming a number the tool never produces
 * is not an instruction, and the run that motivated this ticket is what that looks
 * like: the model could see it had three lines and could not see how far past the
 * box the third one reached, so it guessed a font size.
 *
 * These assert the rule — a line's width is its leftmost paint to its rightmost,
 * compared against the content box — rather than the caption emitter's markup, so
 * they hold for any element measured through this probe.
 */
describe("measureInPage line widths (TAB-1173)", () => {
  const widthOf = (target: Element, style?: Record<string, string>) =>
    measure(target, style).elements[0]?.widestLinePx;
  const contentOf = (target: Element, style?: Record<string, string>) =>
    measure(target, style).elements[0]?.contentBoxPx;

  it("reports the widest line, not the first one", () => {
    // The whole point: line 2 is the one that does not fit, and a probe that
    // reported the first line's width would call this caption laid out fine.
    const ragged = caption([[span(0, 0, 80)], [span(40, 0, 140)]]);
    expect(widthOf(ragged)).toBe(140);
  });

  it("measures a line from its leftmost to its rightmost paint", () => {
    // Two word spans on one line: neither is the line, and reporting either one
    // would understate the row by the other's width plus the gap between them.
    const oneLine = caption([[span(0, 0, 60), span(0, 70, 120)]]);
    expect(widthOf(oneLine)).toBe(120);
  });

  it("compares a line against the content box, not the border box", () => {
    // A caption carries horizontal padding, so the room text has is narrower than
    // the element. Comparing against the border box is how a line that overflows
    // reads as fitting.
    const padded = caption([[span(0, 0, 90)]]);
    expect(contentOf(padded, { paddingLeft: "8px", paddingRight: "8px" })).toBe(84);
  });

  it("does not also subtract the border, which clientWidth already excludes", () => {
    // The first cut of this subtracted `borderLeftWidth` + `borderRightWidth` on
    // top of the padding, which double-counts: `clientWidth` is the inner width,
    // so it already excludes borders. A bordered element was told it had 20px
    // less room than it does. No caption has a border, so the caption case could
    // not have caught it — which is the reason the assertion is here rather than
    // in a caption fixture.
    const bordered = caption([[span(0, 0, 90)]]);
    expect(contentOf(bordered, { borderLeftWidth: "10px", borderRightWidth: "10px" })).toBe(100);
  });

  it("treats an unset padding as zero rather than as NaN", () => {
    // `getComputedStyle` in a real page always answers, but the stub here and any
    // future caller may not — and `parseFloat(undefined)` would make the content
    // box NaN, which compares false against everything and would silently report
    // no overflow forever.
    const bare = caption([[span(0, 0, 90)]]);
    expect(contentOf(bare)).toBe(100);
  });

  it("does not let the break element widen a line", () => {
    // Same rule the count follows, for the same reason: `flex-basis: 100%` gives
    // the break a flex line of its own, and at `height: 0` nothing is painted in
    // it. A break that reached 500px would otherwise report as the widest line in
    // a caption whose real lines are 80px, and the number the agent is told to
    // trust would be about an element that draws nothing.
    const wrapped = caption([[span(0, 0, 80)], [wideBreak(20)], [span(40, 0, 60)]]);
    expect(widthOf(wrapped)).toBe(80);
  });

  it("reports no width for an element with no painted line", () => {
    // 0 would read as "a line of zero width", which is a different claim from
    // "there is no line here". The caller drops the fields rather than reporting
    // them, and this pins the raw value that decision is made on.
    const empty = caption([[]]);
    expect(linesOf(empty)).toBe(0);
    expect(widthOf(empty)).toBe(0);
  });
});
