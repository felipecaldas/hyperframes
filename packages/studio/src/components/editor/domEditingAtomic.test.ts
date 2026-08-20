// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isAtomicCapture, isAtomicContainer, resolveGroupCapture } from "./domEditingGroups";
import { collectDomEditLayerItems } from "./domEditingLayers";
import { buildElementLabel } from "./domEditingDom";
import { parseCaptionComposition } from "../../captions/parser";

const opts = { activeCompositionPath: "index.html", isMasterView: true, skipSourceProbe: true };

// The shape a compiler emits for a unit that must edit as one thing: an
// identified container marked atomic, holding one identified span per word.
function buildCaption(
  words = 6,
  options: { atomicAttribute?: boolean } = {},
): { root: HTMLElement; caption: HTMLElement } {
  const root = document.createElement("div");
  const caption = document.createElement("div");
  caption.id = "caption-4";
  caption.className = "clip hf-captions";
  if (options.atomicAttribute !== false) caption.setAttribute("data-hf-atomic", "");
  caption.setAttribute("data-hf-label", "Caption 4");
  for (let i = 0; i < words; i += 1) {
    const word = document.createElement("span");
    word.id = `caption-4-w${i}`;
    word.className = "hf-caption-word";
    word.textContent = `word${i}`;
    caption.appendChild(word);
  }
  root.appendChild(caption);
  document.body.appendChild(root);
  return { root, caption };
}

describe("atomic container predicates", () => {
  it("data-hf-atomic is atomic but data-hf-group alone is not a container", () => {
    const atomic = document.createElement("div");
    atomic.setAttribute("data-hf-atomic", "");
    const group = document.createElement("div");
    group.setAttribute("data-hf-group", "Group 1");

    expect(isAtomicContainer(atomic)).toBe(true);
    expect(isAtomicContainer(group)).toBe(false);
    expect(isAtomicCapture(atomic)).toBe(true);
    expect(isAtomicCapture(group)).toBe(true);
    expect(isAtomicCapture(document.createElement("div"))).toBe(false);
  });

  it("keeps pre-contract hf-captions projects atomic", () => {
    const { root, caption } = buildCaption(4, { atomicAttribute: false });

    expect(isAtomicContainer(caption)).toBe(true);
    expect(isAtomicCapture(caption)).toBe(true);
    expect(collectDomEditLayerItems(root, opts)).toHaveLength(1);

    document.body.removeChild(root);
  });
});

describe("resolveGroupCapture with data-hf-atomic", () => {
  it("captures the atomic container as one unit when a word is clicked", () => {
    const { root, caption } = buildCaption();
    const word = caption.children[2] as HTMLElement;

    const capture = resolveGroupCapture(word, null);
    document.body.removeChild(root);

    expect(capture).toEqual({ kind: "unit", element: caption });
  });

  it("resolves the word normally once drilled into the container", () => {
    const { root, caption } = buildCaption();
    const word = caption.children[2] as HTMLElement;

    const capture = resolveGroupCapture(word, caption);
    document.body.removeChild(root);

    expect(capture).toEqual({ kind: "child" });
  });
});

describe("collectDomEditLayerItems with data-hf-atomic", () => {
  it("shows the container as one row whose childCount is the word count", () => {
    const { root, caption } = buildCaption(6);

    const items = collectDomEditLayerItems(root, opts);
    document.body.removeChild(root);

    expect(items).toHaveLength(1);
    expect(items[0].element).toBe(caption);
    expect(items[0].childCount).toBe(6);
  });

  it("no longer spends the layer budget on words (100 words, one item)", () => {
    const { root } = buildCaption(100);

    const items = collectDomEditLayerItems(root, opts);
    document.body.removeChild(root);

    expect(items).toHaveLength(1);
  });

  it("enumerates the words once drilled into the container", () => {
    const { root, caption } = buildCaption(6);

    const items = collectDomEditLayerItems(root, { ...opts, activeGroupElement: caption });
    document.body.removeChild(root);

    expect(items.map((i) => i.id)).toEqual([
      "caption-4-w0",
      "caption-4-w1",
      "caption-4-w2",
      "caption-4-w3",
      "caption-4-w4",
      "caption-4-w5",
    ]);
  });
});

describe("buildElementLabel with data-hf-label", () => {
  it("prefers data-hf-label over the element id", () => {
    const { root, caption } = buildCaption();
    const label = buildElementLabel(caption);
    document.body.removeChild(root);

    expect(label).toBe("Caption 4");
  });

  it("prefers data-hf-label over data-hf-group", () => {
    const el = document.createElement("div");
    el.setAttribute("data-hf-label", "Caption 4");
    el.setAttribute("data-hf-group", "Group 1");
    expect(buildElementLabel(el)).toBe("Caption 4");
  });

  it("still labels by data-hf-group when no data-hf-label is present", () => {
    const el = document.createElement("div");
    el.setAttribute("data-hf-group", "Group 1");
    expect(buildElementLabel(el)).toBe("Group 1");
  });
});

describe("caption designer regression", () => {
  it("hf-captions markup does not parse as a caption composition", () => {
    const { root } = buildCaption();
    const source = root.innerHTML;

    const model = parseCaptionComposition(document, window, source, 1080, 1920, 10);
    document.body.removeChild(root);

    expect(model).toBeNull();
  });
});
