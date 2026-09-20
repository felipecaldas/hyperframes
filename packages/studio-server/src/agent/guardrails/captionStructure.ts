/**
 * TAB-1202. Refuse a line break written into a caption as `<br>`.
 *
 * The fix for TAB-1202 is in the timeline lint: a caption row break — the
 * compositor's `class="hf-caption-break"` or the inline
 * `style="flex-basis:100%;height:0"` the system prompt tells the agent to write
 * — is no longer counted as nested structure, so the prompt's wrap recipe can
 * finally be applied. This gate covers the one wrong turn that opening that
 * route leaves available.
 *
 * `<br>` is the dangerous element, and it is dangerous precisely because nothing
 * refuses it:
 *
 * | written into a caption        | timeline lint | at runtime                  |
 * |-------------------------------|---------------|-----------------------------|
 * | `div` with `flex-basis:100%`  | allowed now   | ends the flex line — works  |
 * | nested `div`, anything else   | error         | refused, visibly            |
 * | **`<br>` / `<wbr>`**          | **allowed**   | **nothing** — parent is flex |
 *
 * A caption is `display: flex`, so a `<br>` between two word spans is an inert
 * flex item. The lint passes it, the apply gate applies it, the run reports
 * success and the caption is unchanged. That is the TAB-1201 shape — a turn
 * claiming an edit the user cannot see — arriving through a door the TAB-1201
 * fix does not cover, because there the run was refused and here nothing is.
 * A silent no-op is worse than a refusal, so this is the refusal.
 *
 * Thrown from `edit_file` / `write_file`, so `executeToolCalls` hands it back as
 * a tool result and the model can correct itself **within the same run** — the
 * difference between this and the apply gate, which can only refuse after the
 * model has stopped talking and the budget is spent.
 *
 * Introduced-only, like every gate here: a caption that already contains a `<br>`
 * keeps it, and editing that caption's words stays possible. Refusing on the
 * result rather than on the change is the bug that once made Tabario AI unable to
 * apply anything to a project that had scenes.
 */

const CAPTION_CLASS = "hf-captions";

/** Written into a caption to end a line, and doing nothing there. */
const INERT_BREAK_TAGS = new Set(["br", "wbr"]);

/** Tags that never open a scope, so they must not move the depth counter. */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)\b([^>]*)>/g;

function classOf(attrs: string): string {
  const match = /\bclass\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
  return (match?.[2] ?? match?.[3] ?? match?.[4] ?? "").trim();
}

const hasCaptionClass = (attrs: string) => classOf(attrs).split(/\s+/).includes(CAPTION_CLASS);

/**
 * Where the scan is: how deep, and whether a caption encloses it.
 *
 * `captionDepth` is the depth the caption element itself opened at, so the
 * caption's scope ends when the depth comes back down to it — a word span's
 * `</span>` must not close it.
 */
interface Scan {
  depth: number;
  captionDepth: number | null;
}

function enterTag(scan: Scan, tag: string, attrs: string): void {
  if (VOID_TAGS.has(tag) || /\/\s*$/.test(attrs)) return;
  if (scan.captionDepth === null && hasCaptionClass(attrs)) scan.captionDepth = scan.depth;
  scan.depth += 1;
}

function leaveTag(scan: Scan): void {
  scan.depth = Math.max(0, scan.depth - 1);
  if (scan.captionDepth !== null && scan.depth <= scan.captionDepth) scan.captionDepth = null;
}

/**
 * How many inert break tags sit anywhere inside a caption container.
 *
 * A depth counter rather than a parser: this runs in the synchronous write path
 * and the question is narrow — is this tag inside an element carrying
 * `hf-captions`. Nesting below the caption still counts, since a `<br>` wrapped
 * in an `<em>` is just as inert.
 */
export function captionBreakTagCount(html: string): number {
  const scan: Scan = { depth: 0, captionDepth: null };
  let count = 0;

  TAG_RE.lastIndex = 0;
  for (let match = TAG_RE.exec(html); match !== null; match = TAG_RE.exec(html)) {
    const [, closing, rawTag = "", attrs = ""] = match;
    if (closing) {
      leaveTag(scan);
      continue;
    }

    const tag = rawTag.toLowerCase();
    if (scan.captionDepth !== null && INERT_BREAK_TAGS.has(tag)) count += 1;
    enterTag(scan, tag, attrs);
  }

  return count;
}

/**
 * The text the model receives as a tool result. It has to say the edit was
 * refused, say why the element it chose cannot work, and hand back the form that
 * does — otherwise the next round is spent guessing.
 */
const REFUSAL = [
  "Refused: a <br> inside a caption does nothing.",
  "",
  "A caption is a flex container, so a <br> between word spans is an inert flex",
  "item. The timeline lint allows it, which means this edit would have applied",
  "cleanly and changed nothing the user can see.",
  "",
  'To end a caption line, write `<div style="flex-basis:100%;height:0"></div>`',
  "between the words where the line should end, and add `flex-wrap: wrap` to that",
  "caption element's inline style. Both parts are needed, and the break must be",
  "styled inline rather than by class, because a project compiled for a single",
  "line carries no rule for a break class.",
].join("\n");

/**
 * Throw if this edit introduces a `<br>` or `<wbr>` into a caption.
 *
 * Called from `edit_file` and `write_file` beside `assertNoNewDuplicateHfIds`,
 * which it mirrors deliberately: both take the before and after text and refuse
 * only what this edit added.
 */
export function assertNoCaptionStructureEdit(
  before: string,
  after: string,
  relative: string,
): void {
  if (!relative.toLowerCase().endsWith(".html")) return;
  if (captionBreakTagCount(after) <= captionBreakTagCount(before)) return;
  throw new Error(REFUSAL);
}
