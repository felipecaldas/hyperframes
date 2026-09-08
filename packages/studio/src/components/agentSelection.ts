import type { AgentSelectedElement } from "@hyperframes/studio-server";
import type { TimelineElement } from "../player/store/timelineElement";

/**
 * The element selected on the timeline, as a chat request carries it
 * (TAB-1063).
 *
 * A typed message used to travel alone, so "make this caption two lines" left
 * the model to guess which one, and one live run guessed by asking the user
 * for the caption's text. Only the anchor of a multi-selection is sent: one
 * element keeps the prompt the same size whatever the project holds. The id is
 * the element's `id` in the file when it has one, so the model can go straight
 * to it; the label is what the user sees on the timeline.
 */
export function selectedElementForAgent(
  elements: readonly TimelineElement[],
  selectedElementId: string | null,
): AgentSelectedElement | null {
  if (!selectedElementId) return null;
  const element = elements.find((candidate) => candidate.id === selectedElementId);
  if (!element) return null;
  const id = element.domId ?? element.id;
  return {
    id,
    label: element.label ?? id,
    start: element.start,
    duration: element.duration,
    ...(element.sourceFile ? { sourceFile: element.sourceFile } : {}),
  };
}
