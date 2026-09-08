import type { AgentSelectedElement } from "./types.js";

const MAX_FIELD_CHARS = 200;

function isShortString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_CHARS;
}

function isSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Whether a request body's `selection` is one Studio could have sent.
 *
 * Bounded on purpose: one element, short strings, non-negative seconds. The
 * request is written by the browser, so this is the only place the shape is
 * checked before it reaches the prompt.
 */
export function isAgentSelectedElement(value: unknown): value is AgentSelectedElement {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    isShortString(item.id) &&
    isShortString(item.label) &&
    isSeconds(item.start) &&
    isSeconds(item.duration) &&
    (item.sourceFile === undefined || isShortString(item.sourceFile))
  );
}

/**
 * The selection as one sentence the model reads before the user's words.
 *
 * Names the element the way the user does and the way the file does, because
 * the two differ: the timeline says "Caption 0", the file says `id="caption-0"`.
 * The model still has to read the element to know what it says.
 */
export function describeSelectedElement(selection: AgentSelectedElement): string {
  const file = selection.sourceFile ?? "index.html";
  const end = selection.start + selection.duration;
  return (
    `Selected on the timeline: "${selection.label}", the element with id "${selection.id}" in ` +
    `${file}, on screen from ${selection.start.toFixed(1)}s to ${end.toFixed(1)}s. ` +
    'When the request says "this" or names that element, it means this one. Read it before answering.'
  );
}
