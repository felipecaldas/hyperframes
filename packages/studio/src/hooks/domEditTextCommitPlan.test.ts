// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildCaptionWordSpans } from "./domEditTextCommitPlan";

/**
 * TAB-819: the caption a commit reads lives in the preview iframe.
 *
 * Every fixture in `domEditingCaptionText.test.ts` builds its caption with the
 * top-level `document`, which is the one realm the production code never sees.
 * Studio's preview is an iframe, so a caption's spans are constructed by that
 * frame's `HTMLElement`, and `instanceof HTMLElement` measured against this
 * frame's constructor returns false for every one of them.
 *
 * That is not theoretical. It shipped, and a live Studio session was the only
 * thing that caught it: the commit still wrote four spans, so the caption still
 * animated and nothing looked wrong, but every span came out bare. The words
 * lost their ASR timings, their emphasis class and their pop cap, and the group
 * fell back to an even split on every single edit.
 *
 * So these tests build the caption in a real second realm.
 */
function captionInOwnRealm(words: string[]): HTMLElement {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) throw new Error("iframe has no document");

  const caption = doc.createElement("div");
  caption.setAttribute("data-hf-atomic", "");
  caption.className = "clip hf-captions";
  words.forEach((text, index) => {
    const word = doc.createElement("span");
    word.className = "hf-caption-word";
    word.setAttribute("data-w-start", (index * 0.25).toFixed(3));
    word.setAttribute("data-w-end", (index * 0.25 + 0.2).toFixed(3));
    word.setAttribute("data-pop-scale", (1 + 0.8 / text.length).toFixed(4));
    word.textContent = text;
    caption.appendChild(word);
    if (index < words.length - 1) caption.appendChild(doc.createTextNode(" "));
  });
  doc.body.appendChild(caption);
  return caption;
}

const CAPTION = ["solving", "her", "production", "bottleneck."];

describe("buildCaptionWordSpans reads a caption in another realm", () => {
  it("is the realm the bug needs — these spans fail `instanceof HTMLElement`", () => {
    // The positive control. Without this the two tests below would pass against
    // the broken code as happily as against the fixed code.
    const caption = captionInOwnRealm(CAPTION);

    expect(Array.from(caption.children).every((child) => child instanceof HTMLElement)).toBe(false);
    expect(caption.children).toHaveLength(4);
  });

  it("carries the timings off spans this frame did not construct", () => {
    const markup = buildCaptionWordSpans(
      captionInOwnRealm(CAPTION),
      "solving her production bottlenecks.",
    );

    const host = document.createElement("div");
    host.innerHTML = markup ?? "";
    const spans = Array.from(host.querySelectorAll<HTMLElement>(":scope > span"));
    expect(spans).toHaveLength(4);
    // Every span timed is what keeps the runtime in precise mode.
    expect(spans.every((span) => span.hasAttribute("data-w-start"))).toBe(true);
    expect(spans[2].getAttribute("data-pop-scale")).toBe("1.0800");
    expect(spans[2].className).toBe("hf-caption-word");
    // The rewritten word keeps the slot's timing and neither of the word's own.
    expect(spans[3].getAttribute("data-w-start")).toBe("0.750");
    expect(spans[3].hasAttribute("data-pop-scale")).toBe(false);
  });

  it("still returns null for a container that is not atomic", () => {
    const plain = captionInOwnRealm(CAPTION);
    plain.removeAttribute("data-hf-atomic");
    plain.className = "";

    expect(buildCaptionWordSpans(plain, "anything at all")).toBeNull();
  });
});
