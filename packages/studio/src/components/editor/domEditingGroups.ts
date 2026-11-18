import { isHtmlElement } from "./domEditingDom";

// `data-hf-atomic` marks a container that behaves like a group for selection
// and drill-in, but is not a user-made group: it cannot be ungrouped, and the
// Layers panel shows it as one row. Compilers use it for units like captions.
//
// Tabario projects compiled before that contract already used `.hf-captions`
// for the same container shape. Treat that one established legacy marker as
// atomic too so opening an existing project does not expose every word as an
// independent layer. New generic compilers should keep emitting the attribute.
// Selection reads the same rule through `isGroupUnit` in domEditSelectionRules.
export function isAtomicContainer(el: HTMLElement): boolean {
  return el.hasAttribute("data-hf-atomic") || el.classList.contains("hf-captions");
}

export function isAtomicCapture(el: HTMLElement): boolean {
  return el.hasAttribute("data-hf-group") || isAtomicContainer(el);
}
// Layer-tree roots: the drilled-into group's element children, else the doc root.
export function groupScopedLayerRoots(
  root: HTMLElement,
  activeGroupElement: HTMLElement | null,
): HTMLElement[] {
  const els = activeGroupElement?.isConnected ? Array.from(activeGroupElement.children) : [root];
  return els.filter(isHtmlElement);
}
