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
  /**
   * The widest rendered line, in px (TAB-1173).
   *
   * The count says a caption is on three lines; this says how much room those
   * lines had. Without it "does the text fit its box" is unanswerable — the
   * measurement returned a count and no width, so an instruction to fit the text
   * by measuring it named a number the instrument never took.
   */
  widestLinePx?: number;
  /**
   * The element's content box width — what text may occupy, which is not the
   * border box once padding is on it (TAB-1173). A caption carries horizontal
   * padding, so comparing a line against `box.width` overstates the room.
   */
  contentBoxPx?: number;
  /**
   * The element's rendered font size, in px (TAB-1177).
   *
   * The size was the one number the probe never took, and it is the number a
   * user changing captions talks in. A live run asked twice for 32px captions
   * replied "It is now displaying at 32px" against a project where every
   * caption read 48px, and nothing in this module could have contradicted it.
   * Read from the computed style, so a size set by a shared rule and a size set
   * by an inline `font-size` report the same way — which is what makes "is every
   * caption the size it was asked to be" a question a sweep can ask of each one.
   */
  fontPx?: number;
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
  /** The widest rendered line in px, and the content width it had to fit (TAB-1173). */
  widestLinePx?: number;
  contentBoxPx?: number;
  /** The rendered font size in px (TAB-1177). See `RawLayoutElement.fontPx`. */
  fontPx?: number;
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

  /**
   * Distinct rendered line-box tops — the wrap count, however it is composed.
   *
   * Rects that paint nothing are skipped. The caption emitter breaks a line with
   * `<div class="hf-caption-break">` at `flex-basis: 100%; height: 0` (see
   * `video-compositor`'s `captions.ts`): the flex basis gives it a line of its own, so
   * it reports a client rect with its own `top`, but nothing is drawn in that line.
   * Counting it made every correctly wrapped caption measure one line too many
   * (TAB-1169) — and the agent, told to trust this number, chased a criterion the
   * instrument could not return, once by deleting a word from the caption.
   *
   * Height is the test rather than the class name on purpose: the probe is generic and
   * must not learn one emitter's markup. A line box is a line only if something is
   * painted in it.
   */
  function readLines(el: Element): { lines: number; widestLinePx: number } {
    const rows = new Map<number, { left: number; right: number }>();
    const collect = (rects: DOMRectList) => {
      for (const r of Array.from(rects)) {
        if (Math.round(r.height) === 0) continue;
        const top = Math.round(r.top);
        const row = rows.get(top);
        if (!row) rows.set(top, { left: r.left, right: r.right });
        else {
          row.left = Math.min(row.left, r.left);
          row.right = Math.max(row.right, r.right);
        }
      }
    };
    if (el.children.length > 0) {
      for (const child of Array.from(el.children)) collect(child.getClientRects());
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      collect(range.getClientRects());
    }
    // Width comes off the same rects the count does — one pass, and the two can
    // never disagree about what a line is (TAB-1173). Each row keeps the span
    // from its leftmost paint to its rightmost, so a flex row of word spans
    // reports the line a reader sees rather than one word's box.
    let widestLinePx = 0;
    for (const row of rows.values()) widestLinePx = Math.max(widestLinePx, row.right - row.left);
    return { lines: rows.size, widestLinePx };
  }

  /**
   * The width text may occupy — the content box, not the border box.
   *
   * A caption carries horizontal padding (video-compositor's emitter sets
   * `padding: 0 <safe zone>`), so a line compared against `box.width` is judged
   * against room it never had, and the overflow this probe exists to catch reads
   * as fitting (TAB-1173).
   *
   * Padding only, and the borders are deliberately **not** subtracted:
   * `clientWidth` is already the inner width, which includes padding and
   * excludes borders and scrollbars. Taking the border off a second time
   * under-reports the content box by its total border width, so a bordered
   * element would be told less room than it has — the opposite error to the one
   * this function exists to fix, and just as wrong.
   */
  function contentBoxWidth(html: HTMLElement, style: CSSStyleDeclaration): number {
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    return Math.max(0, html.clientWidth - (Number.isFinite(padding) ? padding : 0));
  }

  /**
   * The rendered font size, or 0 when the page gave none.
   *
   * A computed `font-size` is always an absolute length in px, so there is no
   * unit to interpret — but `parseFloat("")` is NaN, and a NaN reaching the
   * caller would compare false against every size the model was told to expect.
   * 0 is the "no reading" value, and the caller drops the field on it.
   */
  function fontSizePx(style: CSSStyleDeclaration): number {
    const size = parseFloat(style.fontSize);
    return Number.isFinite(size) ? size : 0;
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
    const { lines, widestLinePx } = readLines(el);
    return {
      selector,
      found: true,
      box: {
        x: round(rect.x),
        y: round(rect.y),
        width: round(rect.width),
        height: round(rect.height),
      },
      lines,
      widestLinePx: round(widestLinePx),
      contentBoxPx: round(contentBoxWidth(html, style)),
      fontPx: round(fontSizePx(style)),
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
      // Only when a line was actually painted. On an element with no text the
      // count is 0 and the width is 0, and reporting "widest line 0px" reads as
      // a finding about a line that does not exist (TAB-1173). The font size
      // goes with them and for the same reason (TAB-1177): a size on an element
      // that paints nothing is a reading about text that is not there, and a
      // model asked to check a caption's size would count it as one that matched.
      ...(el.lines
        ? { widestLinePx: el.widestLinePx, contentBoxPx: el.contentBoxPx, fontPx: el.fontPx }
        : {}),
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
