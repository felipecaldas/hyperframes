import type { EditorSaveDrainResult } from "../hooks/useEditorSave";

export interface AgentPreflightResult {
  ok: boolean;
  message?: string;
}

/**
 * Why each drain status blocks an agent run. Upstream's flush reports WHY the
 * drain failed rather than a bare boolean, so a conflict and a write failure no
 * longer read as the same "unsaved changes" — starting a run on top of either
 * would let the agent overwrite the user's work with stale content.
 *
 * `clean` still has a message because a clean drain can coincide with a dirty
 * editor buffer (see `hasAgentEditorDirty`) — nothing failed to save, there is
 * simply more the user hasn't committed to disk yet.
 */
const BLOCK_MESSAGES: Record<EditorSaveDrainResult["status"], string> = {
  clean:
    "The source editor still has unsaved changes. Save or resolve them before starting an agent.",
  conflict:
    "This file changed on disk while you were editing it. Resolve the conflict before starting an agent.",
  failed:
    "The source editor's latest changes could not be saved. Fix the save error before starting an agent.",
};

/**
 * Decide whether an agent run may start, given the outcome of flushing the
 * source editor's pending save and whether the editor buffer is still dirty.
 *
 * Pure and separate from the component so the gate is unit-testable and the
 * host stays a thin wiring layer.
 */
export function resolveAgentPreflight(
  drain: EditorSaveDrainResult,
  editorDirty: boolean,
): AgentPreflightResult {
  if (drain.status === "clean" && !editorDirty) return { ok: true };
  return { ok: false, message: BLOCK_MESSAGES[drain.status] };
}
