// @vitest-environment node

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assertNoCaptionStructureEdit, captionBreakTagCount } from "./captionStructure.js";

const providers = readFileSync(new URL("../providers.ts", import.meta.url).pathname, "utf8");

const caption = (inner: string) =>
  `<div id="caption-0" class="clip hf-captions" data-hf-atomic>${inner}</div>`;
const word = (i: number, text: string) => `<span id="caption-0-w${i}">${text}</span>`;
const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

const WORDS = word(0, "what") + word(1, "if");

/**
 * TAB-1202. The lint fix opens the break-div route; this closes the one wrong
 * turn that leaves available. `<br>` is the only element that would both pass
 * the timeline lint and do nothing, so it is the only one that could be applied
 * as a success while changing nothing the user can see.
 */
describe("a <br> written into a caption is refused rather than silently applied", () => {
  it("refuses a break the edit introduced", () => {
    expect(() =>
      assertNoCaptionStructureEdit(
        page(caption(WORDS)),
        page(caption(word(0, "what") + "<br>" + word(1, "if"))),
        "index.html",
      ),
    ).toThrow(/does nothing/);
  });

  it("hands back the form that works, so the next round is not a guess", () => {
    let message = "";
    try {
      assertNoCaptionStructureEdit(
        page(caption(WORDS)),
        page(caption(word(0, "what") + "<wbr>" + word(1, "if"))),
        "index.html",
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("flex-basis:100%;height:0");
    expect(message).toContain("flex-wrap: wrap");
  });

  it("allows the break element the prompt actually prescribes", () => {
    // The whole point of TAB-1202 is that this edit must land. A gate that
    // refused it would re-break the thing the lint fix just unblocked.
    expect(() =>
      assertNoCaptionStructureEdit(
        page(caption(WORDS)),
        page(
          caption(word(0, "what") + '<div style="flex-basis:100%;height:0"></div>' + word(1, "if")),
        ),
        "index.html",
      ),
    ).not.toThrow();
  });

  it("leaves a caption that already had a <br> editable", () => {
    // Introduced-only. Refusing on the result rather than on the change is what
    // once made the agent unable to apply anything to a project with scenes.
    const before = page(caption(word(0, "what") + "<br>" + word(1, "if")));
    const after = page(caption(word(0, "WHAT") + "<br>" + word(1, "if")));
    expect(() => assertNoCaptionStructureEdit(before, after, "index.html")).not.toThrow();
  });

  it("does not care about a <br> outside a caption", () => {
    const before = page('<div id="body">a</div>');
    const after = page('<div id="body">a<br>b</div>');
    expect(() => assertNoCaptionStructureEdit(before, after, "index.html")).not.toThrow();
  });

  it("counts a break nested below the caption, which is just as inert", () => {
    expect(captionBreakTagCount(page(caption(`<em>${word(0, "x")}<br></em>`)))).toBe(1);
    expect(captionBreakTagCount(page(caption(WORDS)))).toBe(0);
  });

  it("closes the caption scope at its own end, not at the first close tag", () => {
    // The depth counter is the whole correctness argument for not using a
    // parser here: a word span's `</span>` must not end the caption.
    const html = page(caption(WORDS) + '<div id="after">x<br></div>');
    expect(captionBreakTagCount(html)).toBe(0);
  });

  it("ignores a file that is not HTML", () => {
    expect(() =>
      assertNoCaptionStructureEdit("", caption("<br>"), "compositions/notes.md"),
    ).not.toThrow();
  });

  it("is wired into both write paths, not merely exported", () => {
    // Exported and unwired, every assertion above is green against nothing.
    expect(providers).toContain("assertNoCaptionStructureEdit(before, after, file.relative)");
    expect(providers).toContain('assertNoCaptionStructureEdit("", args.content, file.relative)');
  });
});
