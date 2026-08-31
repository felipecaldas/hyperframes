/**
 * What a text commit becomes: the operations that go to the file, and the markup
 * the preview is set to.
 *
 * Split out of `useDomEditTextCommits` when the caption re-split pushed that
 * file past the size cap (TAB-819). The hook is about running a commit and
 * recovering when one fails; this is the decision it runs.
 */
import type { PatchOperation } from "../utils/sourcePatcher";
import {
  buildDomEditRichTextPatchOperation,
  buildDomEditTextPatchOperation,
  serializeCaptionWordSpans,
  serializeDomEditTextFields,
  type DomEditTextField,
} from "../components/editor/domEditing";
import { isAtomicContainer } from "../components/editor/domEditingGroups";
import { isHtmlElement } from "../components/editor/domEditingDom";
import { buildTextFieldChildOperations } from "./domEditTextFieldCommitOps";

export interface DomTextCommitPlan {
  usesSerializedTextFields: boolean;
  nextContent: string;
  childOperations: PatchOperation[] | null;
  operations: PatchOperation[];
}

/**
 * The word-span markup for an edited caption, or null for anything else.
 *
 * Kept out of `planDomTextCommit` so that function stays about the text-field
 * model: this is the one question the model cannot answer, because an atomic
 * caption reports a single field and its word spans live only in the DOM.
 */
export function buildCaptionWordSpans(element: HTMLElement, value: string): string | null {
  if (!isAtomicContainer(element)) return null;
  // `isHtmlElement`, never `instanceof HTMLElement`. The caption lives in the
  // preview iframe, so its spans are built by that frame's constructor and are
  // not instances of this one. `instanceof` dropped every child here, silently:
  // the words still came back as spans, so the caption still animated, but with
  // no timings, no class and no pop cap on any of them. Every edit quietly
  // demoted its caption to an even split. `isHtmlElement` tests `nodeType`, so
  // it holds across realms.
  const previousWords = Array.from(element.children).filter(isHtmlElement);
  return serializeCaptionWordSpans(value, previousWords) || null;
}

export function buildNextDomTextFields(
  textFields: DomEditTextField[],
  value: string,
  fieldKey?: string,
): DomEditTextField[] {
  if (textFields.length === 0) return [];
  return textFields.map((field) => (field.key === fieldKey ? { ...field, value } : field));
}

export function planDomTextCommit(
  originalTextFields: DomEditTextField[],
  nextTextFields: DomEditTextField[],
  plainTextContent: string,
  // An atomic caption is one field but must not be written as one string — see
  // serializeCaptionWordSpans for why plain text silently kills the karaoke.
  captionWordSpans?: string | null,
): DomTextCommitPlan {
  if (captionWordSpans) {
    return {
      usesSerializedTextFields: true,
      nextContent: captionWordSpans,
      childOperations: null,
      operations: [buildDomEditRichTextPatchOperation(captionWordSpans)],
    };
  }
  const usesSerializedTextFields =
    nextTextFields.length > 1 || nextTextFields.some((field) => field.source === "child");
  const nextContent = usesSerializedTextFields
    ? serializeDomEditTextFields(nextTextFields)
    : plainTextContent;
  const childOperations = usesSerializedTextFields
    ? buildTextFieldChildOperations(originalTextFields, nextTextFields)
    : null;
  // Per-child operations when the layers still line up one-for-one, and the
  // element's whole markup when they do not.
  //
  // `buildTextFieldChildOperations` can only address children that already
  // exist, so it returns null for any change in how many there are — which is
  // every delete and every add. That used to end here with "Couldn't save this
  // text structure change": the panel offered a remove button and an Add text
  // field row, and neither could ever save. A structure change has one honest
  // operation, which is to write the structure.
  const operations =
    childOperations ??
    (usesSerializedTextFields
      ? [buildDomEditRichTextPatchOperation(nextContent)]
      : [buildDomEditTextPatchOperation(nextContent)]);

  return {
    usesSerializedTextFields,
    nextContent,
    childOperations,
    operations,
  };
}
