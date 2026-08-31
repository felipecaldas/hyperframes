/**
 * The text-field model: what a selected element offers the Design tab to edit,
 * and how an edit goes back into the file as markup.
 *
 * Split out of `domEditingLayers` when the caption work pushed that module past
 * the size cap (TAB-819). The seam is real rather than convenient: everything
 * here is about the *text* inside one element, while what is left in
 * `domEditingLayers` is about which element is selected, what the layer tree
 * shows, and which patch a change becomes. `domEditingLayers` re-exports all of
 * it, so no call site had to move.
 */
import { isAtomicContainer } from "./domEditingGroups";
import {
  getCuratedComputedStyles,
  getInlineStyles,
  isHtmlElement,
  isTextBearingTag,
} from "./domEditingDom";
import type { DomEditTextField } from "./domEditingTypes";

/** A leaf that holds text and nothing else. Module-private: the only caller is
 * `collectDomEditTextFields`, and an export with no consumer is a finding. */
function isEditableTextLeaf(el: HTMLElement): boolean {
  return isTextBearingTag(el.tagName.toLowerCase()) && el.children.length === 0;
}

function sameTagChildIndex(el: HTMLElement): number {
  let index = 0;
  let sibling = el.previousElementSibling;
  while (sibling) {
    if (sibling.tagName === el.tagName) index += 1;
    sibling = sibling.previousElementSibling;
  }
  return index;
}

function getTextFieldLabel(
  _tagName: string,
  index: number,
  total: number,
  source: "self" | "child",
): string {
  if (source === "self" || total === 1) return "Content";
  return `Text ${index + 1}`;
}

function buildTextField(
  el: HTMLElement,
  index: number,
  total: number,
  source: "self" | "child",
  sourceChildIndex?: number,
): DomEditTextField {
  const tagName = el.tagName.toLowerCase();
  const key = el.getAttribute("data-hf-text-key") ?? `${source}:${index}:${tagName}`;
  return {
    key,
    label: getTextFieldLabel(tagName, index, total, source),
    value: el.textContent ?? "",
    tagName,
    attributes: Array.from(el.attributes)
      .filter((attribute) => attribute.name !== "style")
      .map((attribute) => ({
        name: attribute.name,
        value: attribute.value,
      })),
    inlineStyles: getInlineStyles(el),
    computedStyles: getCuratedComputedStyles(el),
    source,
    ...(sourceChildIndex == null ? {} : { sourceChildIndex }),
  };
}

// fallow-ignore-next-line complexity
export function collectDomEditTextFields(el: HTMLElement): DomEditTextField[] {
  // An atomic container is one piece of copy, so it reports one field (TAB-818).
  //
  // The atomic contract already stopped the Layers tree and canvas click-through
  // at a caption, but this function was never told, so the design panel went on
  // enumerating the word spans underneath it: a four-word caption offered four
  // TEXT LAYERS and no way to edit the sentence. Reporting a single field is
  // also what puts the caret through the whole caption, because the in-place
  // editing gate opens on an element with one field or fewer.
  //
  // Only when the container itself is the selection. Drilling in selects a word
  // span, which is not atomic and still reports itself normally.
  if (isAtomicContainer(el) && (el.textContent ?? "").length > 0) {
    return [buildTextField(el, 0, 1, "self")];
  }

  const childElements = Array.from(el.children).filter(isHtmlElement).filter(isEditableTextLeaf);

  if (childElements.length > 0) {
    const hasMixedContent = Array.from(el.childNodes).some(
      (node) => node.nodeType === 3 && node.textContent?.trim(),
    );

    if (hasMixedContent) {
      const fields: DomEditTextField[] = [];
      let childIdx = 0;
      for (const node of el.childNodes) {
        if (node.nodeType === 3) {
          const text = node.textContent ?? "";
          if (!text.trim()) continue;
          fields.push({
            key: `text-node:${childIdx}`,
            label: `Text ${childIdx + 1}`,
            value: text,
            tagName: "#text",
            attributes: [],
            inlineStyles: {},
            computedStyles: {},
            source: "text-node",
          });
          childIdx++;
        } else if (isHtmlElement(node) && isEditableTextLeaf(node)) {
          fields.push(
            buildTextField(node, childIdx, childElements.length, "child", sameTagChildIndex(node)),
          );
          childIdx++;
        }
      }
      return fields;
    }

    return childElements.map((child, index) =>
      buildTextField(child, index, childElements.length, "child", sameTagChildIndex(child)),
    );
  }

  if (isEditableTextLeaf(el)) {
    return [buildTextField(el, 0, 1, "self")];
  }

  return [];
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serializeTextFieldStyle(field: DomEditTextField): string {
  const entries = Object.entries(field.inlineStyles).filter(([, value]) => Boolean(value));
  if (entries.length === 0) return "";
  return entries.map(([key, value]) => `${key}: ${value}`).join("; ");
}

export function serializeDomEditTextFields(fields: DomEditTextField[]): string {
  return fields
    .filter((field) => field.source === "child" || field.source === "text-node")
    .map((field) => {
      if (field.source === "text-node") {
        return escapeHtmlText(field.value);
      }
      const attrs = [
        ...field.attributes.filter((attribute) => attribute.name !== "data-hf-text-key"),
        { name: "data-hf-text-key", value: field.key },
      ]
        .map((attribute) => ` ${attribute.name}="${attribute.value.replace(/"/g, "&quot;")}"`)
        .join("");
      const style = serializeTextFieldStyle(field);
      const styleAttr = style ? ` style="${style.replace(/"/g, "&quot;")}"` : "";
      return `<${field.tagName}${attrs}${styleAttr}>${escapeHtmlText(field.value)}</${field.tagName}>`;
    })
    .join("");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/g, "&quot;");
}

/** One attribute copied off the span being replaced, or nothing when it has none. */
function carriedAttribute(previous: HTMLElement, name: string): string {
  const value = previous.getAttribute(name);
  return value ? ` ${name}="${escapeHtmlAttribute(value)}"` : "";
}

/**
 * What a re-emitted word keeps from the span it replaces.
 *
 * Two rules, because two kinds of attribute belong to two different things.
 * `data-w-start` / `data-w-end` belong to the **slot**: the audio did not
 * change, so word N is still spoken when word N was, and a typo fix keeps
 * frame-accurate karaoke rather than dropping the group to an even split.
 * `class` and `data-pop-scale` belong to the **word**: emphasis was set on that
 * word, and the pop cap is solved from that word's own character count, so a
 * word the edit rewrote must inherit neither.
 *
 * Both timings or neither. One span the runtime cannot read already drops its
 * whole group to the even split, so half a timing buys nothing.
 *
 * Losing `data-pop-scale` is not cosmetic. The highlight loop falls back to the
 * group's raw `data-active-scale`, which is the uncapped figure that pushed
 * words into each other before the compiler started capping the pop in pixels.
 * Carrying it means an untouched word in an edited caption pops exactly as far
 * as it did before the edit.
 */
function carriedWordAttributes(previous: HTMLElement | undefined, word: string): string {
  if (!previous) return "";
  const start = previous.getAttribute("data-w-start");
  const end = previous.getAttribute("data-w-end");
  const timing =
    start && end
      ? ` data-w-start="${escapeHtmlAttribute(start)}" data-w-end="${escapeHtmlAttribute(end)}"`
      : "";
  if (previous.textContent !== word) return timing;
  return `${carriedAttribute(previous, "class")}${timing}${carriedAttribute(previous, "data-pop-scale")}`;
}

/**
 * Re-split an edited caption into one `<span>` per word (TAB-819).
 *
 * An atomic caption reports a single text field, and the ordinary commit path
 * for a single field writes `textContent`. On a caption that is destructive in
 * a way nothing announces: the compiler's karaoke loop walks `:scope > span`
 * and returns when it finds none, so the caption keeps its words and silently
 * loses its highlight, its active and rest colours and its pop. The even-split
 * fallback does not save it either — that needs spans to exist. So the words
 * have to go back in as spans.
 *
 * Literal tags, because Studio can only patch elements that exist as tags in
 * the saved file. No `id` and no `data-hf-id`: duplicating an id breaks patch
 * targeting, and a re-typed word is not the word that carried it. A word that
 * survived the edit keeps its own attributes; see `carriedWordAttributes`. A
 * new word gets none, and the stylesheet is built for that — the compiler keys
 * the word rest state on `.hf-captions > span` rather than on its own class,
 * precisely so a span Studio wrote sits in the same rest state as its
 * neighbours.
 *
 * Adding or removing a word changes the word count, and that group even-splits
 * its own window instead. That is the documented intent: degraded-but-live
 * beats frozen, and per-word timings from the ASR cannot survive an edit that
 * changed which words exist.
 */
export function serializeCaptionWordSpans(value: string, previousWords: HTMLElement[]): string {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const carrySlots = previousWords.length === words.length;
  return words
    .map((word, index) => {
      const previous = carrySlots ? previousWords[index] : undefined;
      return `<span${carriedWordAttributes(previous, word)}>${escapeHtmlText(word)}</span>`;
    })
    .join(" ");
}

export function buildDefaultDomEditTextField(base?: Partial<DomEditTextField>): DomEditTextField {
  return {
    key: `child:new:${Date.now()}`,
    label: "Text",
    value: "New text",
    tagName: "span",
    attributes: [],
    inlineStyles: {
      "font-family": base?.computedStyles?.["font-family"] ?? "inherit",
      "font-size": base?.computedStyles?.["font-size"] ?? "16px",
      "font-weight": base?.computedStyles?.["font-weight"] ?? "400",
      color: base?.computedStyles?.color ?? "inherit",
    },
    computedStyles: {},
    source: "child",
  };
}
