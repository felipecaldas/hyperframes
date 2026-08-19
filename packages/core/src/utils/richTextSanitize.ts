/**
 * What inline formatting a composition file is allowed to receive.
 *
 * Editing text in the Studio preview can style a run of characters, which means
 * markup now travels from a contenteditable element into a file on disk. This
 * module is the only thing deciding what may make that trip. The server write
 * boundary applies it unconditionally before returning composition bytes.
 *
 * One module rather than two implementations. Two would drift, and the drift
 * would be a security bug rather than an inconsistency.
 *
 * It works on an element's subtree in place. Untrusted markup must be parsed in
 * an inert document before this function receives it.
 */

/** Tags an inline text edit may contain. Everything else is not text styling. */
const FORMATTING_TAGS = new Set(["SPAN", "B", "STRONG", "I", "EM", "U", "BR"]);

/**
 * Style properties a formatting tag may carry.
 *
 * This was paint-only, on the reasoning that a property which moves or resizes
 * text would let an edit inside one element change the composition's layout,
 * and layout is the design panel's job. The reasoning was wrong about who was
 * being restricted: the design panel writes exactly these typography
 * properties onto exactly these spans, as its text layers. Sanitizing them
 * away did not stop text from changing layout, it deleted the layout the user
 * had already set — colouring one word silently dropped a sibling layer's font
 * size. The line that matters is the one below, values that reach outside the
 * stylesheet, not which of its own properties the editor is allowed to keep.
 */
const FORMATTING_STYLE_PROPS = new Set([
  "color",
  "background-color",
  "font-weight",
  "font-style",
  "text-decoration-line",
  "font-family",
  "font-size",
  "letter-spacing",
  "line-height",
  // Paints the glyph fill and inherits, so an ancestor that sets it wins over
  // any `color` below. The editor mirrors a run's colour into it when that is
  // happening, and stripping it here would put the colour back to invisible.
  "-webkit-text-fill-color",
]);

// Keep this list limited to properties whose grammar cannot fetch a resource.
// Adding a URL-consuming property also requires decoding CSS escapes before
// UNSAFE_VALUE can be a sufficient guard.

/**
 * Attributes a formatting tag may carry: any `data-*` with a bare-token value.
 *
 * This was only the identity pair a text layer is tracked by
 * (`data-hf-text-key`/`data-hf-id`), on the reasoning that nothing else on a
 * span was formatting. But compilers author data on spans too — a caption
 * word carries its highlight timings as `data-w-start`/`data-w-end` — and
 * stripping those on a structural text edit silently killed the behaviour
 * they drive. Data attributes are inert to the browser, so with their values
 * held to a bare token the risk was never the name. Event handlers, ids that
 * shadow a composition's own, and anything URL-shaped are still not
 * formatting and still dropped.
 */
const DATA_ATTR_NAME = /^data-[a-z0-9-]+$/;

/**
 * What an allowed attribute's value may look like: a bare token, nothing else.
 * `:` is deliberate because text keys use selector-like tokens such as
 * `child:1`; `.` because compiler-authored numbers look like `3.000`. No
 * allowed attribute is interpreted as a URL.
 */
const SAFE_ATTR_VALUE = /^[A-Za-z0-9_.:-]+$/;

/**
 * What a class may keep: its valid tokens. A span's classes are how a
 * stylesheet recognises it (`hf-caption-word`), so a structural edit that
 * drops them un-styles words the user never touched. Filtered token by token
 * rather than kept-or-dropped whole: one hostile token should cost itself,
 * not the styling next to it.
 */
const SAFE_CLASS_TOKEN = /^[A-Za-z0-9_-]+$/;

/**
 * Tags dropped whole rather than unwrapped.
 *
 * Everything else is unwrapped, so an unexpected tag costs the user its
 * formatting and not their words. These are the ones whose contents are not
 * words: unwrapping a script would turn its source into visible text.
 */
const OPAQUE_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
  "NOSCRIPT",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "SVG",
  "MATH",
]);

/** Anything that reaches out of the stylesheet, in a property that should not. */
const UNSAFE_VALUE = /url\(|expression\(|javascript:|vbscript:|@import|<\//i;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

type SanitizerFrame =
  | { phase: "visit"; node: Node }
  | { phase: "sanitize"; element: Element; tag: string };

export function isRichTextFormattingTag(tagName: string): boolean {
  return FORMATTING_TAGS.has(tagName.toUpperCase());
}

/** Whether an attribute survives the rich-text persistence boundary. */
export function isRichTextFormattingAttribute(name: string, value: string): boolean {
  return DATA_ATTR_NAME.test(name.toLowerCase()) && SAFE_ATTR_VALUE.test(value);
}

export interface RichTextSanitizeOptions {
  /**
   * The `data-hf-id` values the composition file held before this edit.
   *
   * An element carrying one of them may keep its `id`: that identity was
   * already in the file, so the id rides on it rather than on anything the
   * payload minted for itself. Without this set — the default — every id is
   * stripped, which is the strictly safer behaviour this module always had.
   */
  knownHfIds?: ReadonlySet<string>;
}

/** Whether a declaration survives the rich-text persistence boundary. */
export function isRichTextFormattingStyle(property: string, value: string): boolean {
  return (
    FORMATTING_STYLE_PROPS.has(property.toLowerCase()) &&
    value.length > 0 &&
    !UNSAFE_VALUE.test(value)
  );
}

function isElementNode(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE;
}

/**
 * Strip everything but allowed formatting from an element's contents, in place.
 *
 * The element itself is never touched, only what is inside it. Callers own the
 * element, and it is the composition's, not the editor's, to rewrite.
 *
 * When the children came from untrusted markup, callers must parse that markup
 * into an inert document (for example linkedom or a detached DOMParser document)
 * first. Never assign untrusted HTML to a live DOM element and then call this
 * function: active content can run before sanitization begins.
 */
export function sanitizeRichTextChildren(
  parent: Element,
  options: RichTextSanitizeOptions = {},
): void {
  const pending: SanitizerFrame[] = Array.from(
    parent.childNodes,
    (node): SanitizerFrame => ({ phase: "visit", node }),
  ).reverse();

  // Post-order without recursion: adversarially deep pasted markup must not
  // exhaust either the server or browser call stack.
  for (let frame = pending.pop(); frame; frame = pending.pop()) {
    if (frame.phase === "sanitize") {
      if (!FORMATTING_TAGS.has(frame.tag)) unwrap(frame.element);
      else stripAttributes(frame.element, options);
      continue;
    }

    const child = frame.node;
    if (child.nodeType === TEXT_NODE) continue;

    if (!isElementNode(child)) {
      // Comments and processing instructions are neither words nor formatting.
      child.parentNode?.removeChild(child);
      continue;
    }

    const element = child;
    const tag = element.tagName.toUpperCase();

    if (OPAQUE_TAGS.has(tag)) {
      element.parentNode?.removeChild(element);
      continue;
    }

    pending.push({ phase: "sanitize", element, tag });
    for (const descendant of Array.from(element.childNodes).reverse()) {
      pending.push({ phase: "visit", node: descendant });
    }
  }
}

/** Replace an element with its own children, keeping their order and place. */
function unwrap(element: Element): void {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
}

/**
 * Whether this element's `id` survives. Only when the element also carries a
 * `data-hf-id` the file already knew: pasted markup can claim any id it
 * likes, but it cannot have been in the file before the edit.
 */
function mayKeepId(element: Element, id: string, options: RichTextSanitizeOptions): boolean {
  if (!SAFE_ATTR_VALUE.test(id)) return false;
  const hfId = element.getAttribute("data-hf-id");
  if (!hfId) return false;
  return options.knownHfIds?.has(hfId) === true;
}

/** The valid tokens of a class value, which are all of it that may survive. */
function filterClassTokens(value: string): string {
  return value
    .split(/\s+/)
    .filter((token) => SAFE_CLASS_TOKEN.test(token))
    .join(" ");
}

/** Put back what a filter kept of a value, or nothing when it kept nothing. */
function setFilteredAttribute(
  element: Element,
  name: string,
  value: string | null,
  filter: (value: string) => string,
): void {
  if (value === null) return;
  const safe = filter(value);
  if (safe) element.setAttribute(name, safe);
  else element.removeAttribute(name);
}

/** Keep a kept tag's filtered style, classes, data, and proven identity, no more. */
function stripAttributes(element: Element, options: RichTextSanitizeOptions): void {
  const style = element.getAttribute("style");
  const classValue = element.getAttribute("class");
  for (const name of Array.from(element.getAttributeNames())) {
    const value = element.getAttribute(name) ?? "";
    if (isRichTextFormattingAttribute(name, value)) continue;
    if (name.toLowerCase() === "id" && mayKeepId(element, value, options)) continue;
    element.removeAttribute(name);
  }
  setFilteredAttribute(element, "class", classValue, filterClassTokens);
  setFilteredAttribute(element, "style", style, filterStyle);
}

/** Keep only the allowlisted declarations, and only if their values are inert. */
function filterStyle(style: string): string {
  return splitDeclarations(style)
    .map((declaration) => {
      const colon = declaration.indexOf(":");
      if (colon === -1) return null;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();
      if (!isRichTextFormattingStyle(property, value)) return null;
      return `${property}: ${value}`;
    })
    .filter((declaration): declaration is string => declaration !== null)
    .join("; ");
}

function isQuoteDelimiter(char: string): char is "'" | '"' {
  return char === "'" || char === '"';
}

function nextParenthesisDepth(depth: number, char: string): number {
  if (char === "(") return depth + 1;
  if (char === ")") return Math.max(0, depth - 1);
  return depth;
}

function isDeclarationSeparator(char: string, depth: number, quote: "'" | '"' | null): boolean {
  return char === ";" && depth === 0 && quote === null;
}

/**
 * Split on the semicolons that separate declarations, not the ones inside a
 * value. `color: rgb(1, 2, 3)` is one declaration however many separators its
 * value contains.
 */
function splitDeclarations(style: string): string[] {
  const declarations: string[] = [];
  let current = "";
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (const char of style) {
    if (char === quote) quote = null;
    else if (quote === null && isQuoteDelimiter(char)) quote = char;
    else if (isDeclarationSeparator(char, depth, quote)) {
      declarations.push(current);
      current = "";
      continue;
    } else if (quote === null) {
      depth = nextParenthesisDepth(depth, char);
    }
    current += char;
  }
  if (current.trim()) declarations.push(current);
  return declarations;
}
