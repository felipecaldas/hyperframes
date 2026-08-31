// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { collectDomEditTextFields, serializeCaptionWordSpans } from "./domEditingLayers";

/**
 * TAB-818 / TAB-819: a caption is one piece of copy in the design panel, and
 * survives being edited as one.
 *
 * The atomic contract already made a caption one row in the Layers tree and one
 * click target on canvas, but the design panel went on enumerating the word
 * spans underneath it — a four-word caption offered four TEXT LAYERS and no way
 * to edit the sentence. Collapsing it to one field is only half the fix: the
 * ordinary single-field commit writes `textContent`, which deletes the spans the
 * compiler's karaoke loop walks, so the caption would keep its words and quietly
 * lose its highlight. These cover both halves.
 */

/** The shape a compiler emits: an atomic container, one timed span per word. */
function buildCaption(words: string[]): HTMLElement {
  const caption = document.createElement("div");
  caption.id = "caption-2";
  caption.className = "clip hf-captions";
  caption.setAttribute("data-hf-atomic", "");
  caption.setAttribute("data-hf-label", "Caption 2");
  words.forEach((text, index) => {
    const word = document.createElement("span");
    word.id = `caption-2-w${index}`;
    word.className = "hf-caption-word";
    word.setAttribute("data-w-start", (index * 0.25).toFixed(3));
    word.setAttribute("data-w-end", (index * 0.25 + 0.2).toFixed(3));
    // The compiler's pixel cap on the pop, solved per word from its character
    // count. Every attribute here is one the compiler really writes: a fixture
    // that emitted only timings would have passed while the cap was being
    // dropped on every edit.
    word.setAttribute("data-pop-scale", (1 + 0.8 / text.length).toFixed(4));
    word.textContent = text;
    caption.appendChild(word);
    if (index < words.length - 1) caption.appendChild(document.createTextNode(" "));
  });
  return caption;
}

const CAPTION = ["solving", "her", "production", "bottleneck."];

describe("atomic caption reports one text field (TAB-818)", () => {
  it("collapses the word spans into a single Content field", () => {
    const fields = collectDomEditTextFields(buildCaption(CAPTION));

    expect(fields).toHaveLength(1);
    expect(fields[0].source).toBe("self");
    expect(fields[0].label).toBe("Content");
    expect(fields[0].value).toBe("solving her production bottleneck.");
  });

  it("still reports one field per child for a non-atomic element", () => {
    const plain = document.createElement("div");
    ["one", "two", "three"].forEach((text) => {
      const span = document.createElement("span");
      span.textContent = text;
      plain.appendChild(span);
    });

    const fields = collectDomEditTextFields(plain);

    expect(fields).toHaveLength(3);
    expect(fields.every((field) => field.source === "child")).toBe(true);
  });

  it("reports a drilled-into word span as itself", () => {
    const caption = buildCaption(CAPTION);
    const word = caption.querySelector<HTMLElement>("#caption-2-w2")!;

    const fields = collectDomEditTextFields(word);

    expect(fields).toHaveLength(1);
    expect(fields[0].value).toBe("production");
  });

  it("still offers one empty field for an emptied caption", () => {
    // Not a curiosity: the atomic branch is skipped for an empty container so
    // this falls through to the ordinary leaf path, and it has to. A caption
    // the user cleared must keep a field to type back into, or clearing it
    // would be the one edit that could never be undone from the panel.
    const empty = document.createElement("div");
    empty.setAttribute("data-hf-atomic", "");

    const fields = collectDomEditTextFields(empty);

    expect(fields).toHaveLength(1);
    expect(fields[0].source).toBe("self");
    expect(fields[0].value).toBe("");
  });
});

describe("editing a caption re-splits it into word spans (TAB-819)", () => {
  const previous = () =>
    Array.from(buildCaption(CAPTION).children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );

  it("writes one span per word rather than a bare string", () => {
    const markup = serializeCaptionWordSpans("solving her production bottleneck.", previous());

    // The karaoke loop walks `:scope > span` and gives up when it finds none.
    const host = document.createElement("div");
    host.innerHTML = markup;
    expect(host.querySelectorAll(":scope > span")).toHaveLength(4);
    expect(host.textContent).toBe("solving her production bottleneck.");
  });

  it("keeps per-word timings when a typo fix leaves the word count alone", () => {
    const markup = serializeCaptionWordSpans("solving her production bottlenecks.", previous());

    const host = document.createElement("div");
    host.innerHTML = markup;
    const spans = Array.from(host.querySelectorAll<HTMLElement>(":scope > span"));
    // Every span timed is what keeps the runtime in precise mode; one bare span
    // drops the whole group to an even split.
    expect(spans.every((span) => span.hasAttribute("data-w-start"))).toBe(true);
    expect(spans[3].getAttribute("data-w-start")).toBe("0.750");
    expect(spans[3].textContent).toBe("bottlenecks.");
  });

  it("carries a surviving word's class and pop cap, and gives the rewritten one neither", () => {
    const markup = serializeCaptionWordSpans("solving her production bottlenecks.", previous());

    const host = document.createElement("div");
    host.innerHTML = markup;
    const spans = Array.from(host.querySelectorAll<HTMLElement>(":scope > span"));
    // "production" came through untouched, so it pops exactly as far as it did
    // before the edit. Without its own cap the highlight loop reads the group's
    // uncapped active scale and a long word grows into its neighbour.
    expect(spans[2].getAttribute("data-pop-scale")).toBe("1.0800");
    expect(spans[2].className).toBe("hf-caption-word");
    // "bottlenecks." is a different word: the cap was solved for the old one's
    // character count, and emphasis was set on the old one.
    expect(spans[3].hasAttribute("data-pop-scale")).toBe(false);
    expect(spans[3].hasAttribute("class")).toBe(false);
  });

  it("drops to the even-split fallback when the word count changed", () => {
    const markup = serializeCaptionWordSpans("solving her bottleneck.", previous());

    const host = document.createElement("div");
    host.innerHTML = markup;
    const spans = Array.from(host.querySelectorAll<HTMLElement>(":scope > span"));
    expect(spans).toHaveLength(3);
    expect(spans.some((span) => span.hasAttribute("data-w-start"))).toBe(false);
  });

  it("never re-emits an id or a data-hf-id", () => {
    const words = previous();
    words[0].setAttribute("data-hf-id", "abc123");

    const markup = serializeCaptionWordSpans("solving her production bottleneck.", words);

    expect(markup).not.toContain("data-hf-id");
    expect(markup).not.toContain("id=");
  });

  it("escapes markup a user typed into the caption", () => {
    const markup = serializeCaptionWordSpans("<script>alert(1)</script> her", previous());

    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
  });

  it("has nothing to write for an emptied caption", () => {
    expect(serializeCaptionWordSpans("   ", previous())).toBe("");
  });

  // The counterpart of this assertion lives in the compositor, whose caption
  // runtime is what has to read these spans back:
  // video-compositor/tests/unit/hyperframesCaptionHighlight.test.ts, test
  // "keeps a caption animating after Studio re-splits it". It runs the emitted
  // highlight script over exactly this markup. Neither repo can import the
  // other, so the two pin the same bytes from opposite sides — change this
  // string and that test is the one that tells you what it cost.
  it("emits the markup the compositor's highlight runtime is tested against", () => {
    expect(serializeCaptionWordSpans("solving her production bottleneck.", previous())).toBe(
      '<span class="hf-caption-word" data-w-start="0.000" data-w-end="0.200" data-pop-scale="1.1143">solving</span> ' +
        '<span class="hf-caption-word" data-w-start="0.250" data-w-end="0.450" data-pop-scale="1.2667">her</span> ' +
        '<span class="hf-caption-word" data-w-start="0.500" data-w-end="0.700" data-pop-scale="1.0800">production</span> ' +
        '<span class="hf-caption-word" data-w-start="0.750" data-w-end="0.950" data-pop-scale="1.0727">bottleneck.</span>',
    );
  });
});
