/**
 * The stateless decisions `useDomEditTextCommits` makes: whether a commit may
 * proceed, what a style commit writes, and how a selection is picked up again
 * after the preview replaced it.
 *
 * Split out of `useDomEditTextCommits` for the same reason `domEditTextCommitPlan`
 * was (TAB-819): merging upstream v0.8.31 put that hook back over the 600-line
 * cap, because #3581 split each commit into a `...ForSelection` form plus a
 * wrapper. Nothing here touches hook state, so it reads better outside the hook
 * than inside it.
 */
import type { PatchOperation } from "../utils/sourcePatcher";
import {
  buildDomEditStylePatchOperation,
  findElementForSelection,
  type DomEditSelection,
} from "../components/editor/domEditing";
import { canEditElementTextInline } from "../components/editor/domEditInlineText";
import { normalizeDomEditStyleValue } from "../utils/studioHelpers";

export type ApplyDomSelection = (
  selection: DomEditSelection | null,
  options?: { revealPanel?: boolean; additive?: boolean; preserveGroup?: boolean },
) => void;

export type BuildDomSelectionFromTarget = (
  target: HTMLElement,
  options?: { preferClipAncestor?: boolean },
) => Promise<DomEditSelection | null>;

export function canCommitInlineTextSelection(
  selection: DomEditSelection,
  element: HTMLElement,
): boolean {
  if (selection.isCompositionHost || selection.isInsideLockedComposition) return false;
  return canEditElementTextInline(element);
}

export function ownsCurrentPreviewElement(
  selection: DomEditSelection,
  element: HTMLElement,
  document: Document | null | undefined,
): document is Document {
  if (!document || !element.isConnected) return false;
  return element === selection.element && element.ownerDocument === document;
}

export function buildDomStyleCommitOperations(
  property: string,
  value: string,
  isImageBackgroundCommit: boolean,
): PatchOperation[] {
  const operations: PatchOperation[] = [
    buildDomEditStylePatchOperation(property, normalizeDomEditStyleValue(property, value)),
  ];
  if (isImageBackgroundCommit) {
    operations.push(
      buildDomEditStylePatchOperation("background-position", "center"),
      buildDomEditStylePatchOperation("background-repeat", "no-repeat"),
      buildDomEditStylePatchOperation("background-size", "contain"),
    );
  }
  return operations;
}

export async function resyncDomTextSelectionFromPreview(
  doc: Document | null | undefined,
  selection: DomEditSelection,
  activeCompPath: string | null,
  buildDomSelectionFromTarget: BuildDomSelectionFromTarget,
  applyDomSelection: ApplyDomSelection,
): Promise<void> {
  if (!doc) return;
  const refreshed = findElementForSelection(doc, selection, activeCompPath);
  if (!refreshed) return;
  const nextSelection = await buildDomSelectionFromTarget(refreshed);
  if (!nextSelection) return;
  applyDomSelection(nextSelection, { revealPanel: false, preserveGroup: true });
}
