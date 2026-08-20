/**
 * Whether a keystroke is going somewhere the user is typing.
 *
 * Every keyboard shortcut in Studio has to ask this before claiming a key, and
 * they were each asking it slightly differently. The version that matched
 * `[contenteditable='true']` missed `contenteditable="plaintext-only"`, which
 * is what inline text editing uses, so the playback shortcuts kept claiming
 * letters out of it: `a` seeked to the in-point and `e` to the out-point,
 * `preventDefault` and all, and the character never reached the text.
 *
 * `isContentEditable` is the property to ask, not the attribute to match: it is
 * true for every editable value and for an element made editable by an
 * ancestor, which an attribute selector on the target alone cannot see.
 * The wider input gate is deliberate too: checkboxes and readonly fields own
 * Space and arrow keys even when they do not accept text.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = asElement(target);
  if (!element) return false;
  if (element.isContentEditable) return true;
  return element.closest(TYPING_SELECTOR) !== null;
}

/**
 * Whether a keyboard event still belongs to an editor even when its reported
 * target was retargeted to a window/body boundary.
 *
 * Studio listens on `window` in capture mode and forwards the same handler into
 * the preview iframe. Most native key events report the focused field as their
 * target, but composed/shadow events and forwarded test/host events can report
 * a higher boundary instead. Looking only at `event.target` turns Backspace or
 * Delete into a layer-delete shortcut while the textarea still owns focus.
 */
export function isTypingKeyEvent(event: KeyboardEvent): boolean {
  if (isTypingTarget(event.target)) return true;

  if (typeof event.composedPath === "function") {
    for (const target of event.composedPath()) {
      if (isTypingTarget(target)) return true;
    }
  }

  const documents = new Set<Document>();
  if (typeof document !== "undefined") documents.add(document);
  try {
    if (event.view?.document) documents.add(event.view.document);
  } catch {
    // Cross-origin event views cannot expose their document. The target/path
    // checks above remain the safe boundary in that case.
  }
  for (const eventDocument of documents) {
    if (isTypingTarget(eventDocument.activeElement)) return true;
  }
  return false;
}

/**
 * Things a keystroke belongs to rather than to a shortcut. `contenteditable` is
 * matched by value as well, for a host whose own property is not yet true.
 */
const TYPING_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='textbox']",
  "[role='searchbox']",
  "[role='combobox']",
  ".cm-editor",
].join(",");

function asElement(target: EventTarget | null): HTMLElement | null {
  if (!target || typeof target !== "object") return null;
  const candidate = target as { closest?: unknown; isContentEditable?: unknown };
  return typeof candidate.closest === "function" ? (target as HTMLElement) : null;
}
