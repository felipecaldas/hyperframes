/**
 * Measure what a composition actually looks like, so the agent can check a
 * visual claim instead of asserting one (TAB-805).
 *
 * Tabario AI's only verification tool was `validate_project`, an HTML lint.
 * Asked four times to put a caption on one line, it rewrote the caption's span
 * structure twice — once merging four word spans into one, once splitting them
 * back — and reported success every time. Both shapes are valid HTML, so lint
 * passed; the caption stayed on three lines because a persisted Studio resize
 * pinned its box to 405px, which no lint can see.
 *
 * "Three lines" only exists after a browser lays the text out. This module is
 * the measuring half of that: `measureInPage` runs inside the page and reports
 * raw geometry, `classifyLayoutProbe` decides what that geometry means. They
 * are split so the decision — in particular *when a measurement is not a
 * measurement* — is testable without a browser.
 */

/** Raw numbers straight from the page. No judgement applied yet. */
export interface RawLayoutElement {
  selector: string;
  found: boolean;
  box?: { x: number; y: number; width: number; height: number };
  /** Distinct rendered line-box tops of the element's content. */
  lines?: number;
  scroll?: { width: number; height: number; clientWidth: number; clientHeight: number };
  display?: string;
  visibility?: string;
  /** Inline width/height — what a persisted Studio resize writes. */
  inline?: { width: string; height: string };
  /** Trimmed, truncated text so the caller can confirm it measured the right thing. */
  text?: string;
}

export interface RawLayoutProbe {
  frame: { width: number; height: number };
  elements: RawLayoutElement[];
}

export interface LayoutElementMeasurement {
  selector: string;
  /** Present only when the element was genuinely measured. */
  box?: { x: number; y: number; width: number; height: number };
  lines?: number;
  overflows?: boolean;
  visibility?: string;
  /** The inline box pin a manual Studio resize leaves behind, when there is one. */
  pinnedByManualEdit?: { width?: string; height?: string };
  text?: string;
  /**
   * Why this element yielded no measurement. Set means: nothing was measured —
   * never read the other fields as a finding.
   */
  unmeasurable?: string;
}

export interface LayoutMeasurement {
  /** True only if at least one requested element was genuinely measured. */
  measured: boolean;
  seekTime: number;
  frame?: { width: number; height: number };
  elements: LayoutElementMeasurement[];
  /** Set when the probe never got as far as measuring anything at all. */
  unavailable?: string;
}

/**
 * Runs **inside the page**. Must stay self-contained — it is serialized to the
 * browser, so it may not close over anything in this module.
 *
 * Line counting reads distinct rendered line-box tops rather than dividing
 * height by line-height, because a caption is a flex row of inline-block words
 * and the wrap happens *between* them. Children's client rects are used when
 * the element has element children (the caption case) and a Range over its
 * contents otherwise (a plain text node).
 */
export function measureInPage(selectors: string[]): RawLayoutProbe {
  const round = (n: number) => Math.round(n * 10) / 10;

  /** Distinct rendered line-box tops — the wrap count, however it is composed. */
  function countLines(el: Element): number {
    const tops = new Set<number>();
    const collect = (rects: DOMRectList) => {
      for (const r of Array.from(rects)) tops.add(Math.round(r.top));
    };
    if (el.children.length > 0) {
      for (const child of Array.from(el.children)) collect(child.getClientRects());
      return tops.size;
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    collect(range.getClientRects());
    return tops.size;
  }

  function find(selector: string): Element | null {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  function read(selector: string): RawLayoutElement {
    const el = find(selector);
    if (!el) return { selector, found: false };
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const html = el as HTMLElement;
    return {
      selector,
      found: true,
      box: {
        x: round(rect.x),
        y: round(rect.y),
        width: round(rect.width),
        height: round(rect.height),
      },
      lines: countLines(el),
      scroll: {
        width: html.scrollWidth,
        height: html.scrollHeight,
        clientWidth: html.clientWidth,
        clientHeight: html.clientHeight,
      },
      display: style.display,
      visibility: style.visibility,
      inline: { width: html.style.width, height: html.style.height },
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
    };
  }

  const root = document.querySelector("[data-composition-id]");
  const frameRect = root ? root.getBoundingClientRect() : null;
  return {
    frame: {
      width: round(frameRect ? frameRect.width : document.documentElement.clientWidth),
      height: round(frameRect ? frameRect.height : document.documentElement.clientHeight),
    },
    elements: selectors.map(read),
  };
}

/**
 * Why a reading is not a measurement, or null when it is one.
 *
 * This is the part TAB-700 is about: `.clip { visibility: hidden }` is the
 * runtime's resting state, and a probe that treats a hidden element as "nothing
 * wrong" reports clean without having measured anything. `visibility: hidden`
 * is fine — it preserves layout, so the box and the line count are true — but
 * `display: none` and a zero-size box are not, and those must come back as
 * unmeasurable rather than as a zero.
 */
function unmeasurableReason(el: RawLayoutElement): string | null {
  if (!el.found)
    return "nothing matches this selector. Check the selector against the source, and note that an element belonging to a scene is only in the page while that scene is mounted — seek to a time when it is on screen.";
  if (el.display === "none")
    return "the element is display:none at this time, so it has no layout to measure. Seek to a time when it is on screen.";
  if (!el.box || (el.box.width === 0 && el.box.height === 0))
    return "the element has a zero-size box, so there is nothing to measure. This is not the same as it being laid out correctly.";
  return null;
}

/** The inline box a manual Studio resize leaves behind, when there is one. */
function pinnedSize(el: RawLayoutElement): { width?: string; height?: string } | undefined {
  const width = el.inline?.width;
  const height = el.inline?.height;
  if (!width && !height) return undefined;
  return { ...(width ? { width } : {}), ...(height ? { height } : {}) };
}

function overflowsBox(el: RawLayoutElement): boolean | undefined {
  const scroll = el.scroll;
  if (!scroll) return undefined;
  return scroll.width > scroll.clientWidth + 1 || scroll.height > scroll.clientHeight + 1;
}

/** Turn raw readings into measurements, keeping the two kinds apart. */
export function classifyLayoutProbe(raw: RawLayoutProbe, seekTime: number): LayoutMeasurement {
  const elements: LayoutElementMeasurement[] = raw.elements.map((el) => {
    const unmeasurable = unmeasurableReason(el);
    if (unmeasurable) return { selector: el.selector, unmeasurable };
    const pinned = pinnedSize(el);
    return {
      selector: el.selector,
      box: el.box,
      lines: el.lines,
      overflows: overflowsBox(el),
      visibility: el.visibility,
      ...(pinned ? { pinnedByManualEdit: pinned } : {}),
      text: el.text,
    };
  });

  return {
    measured: elements.some((el) => !el.unmeasurable),
    seekTime,
    frame: raw.frame,
    elements,
  };
}

/** A probe that never ran. Kept here so every caller words it the same way. */
export function unavailableMeasurement(reason: string, seekTime: number): LayoutMeasurement {
  return { measured: false, seekTime, elements: [], unavailable: reason };
}
