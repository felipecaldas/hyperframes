import { useCallback, useRef, useState } from "react";
import { saveProjectFilesWithHistory } from "../utils/studioFileHistory";
import type { EditHistoryKind } from "../utils/editHistory";
import { trackStudioEvent } from "../utils/studioTelemetry";

interface RecordEditInput {
  label: string;
  kind: EditHistoryKind;
  coalesceKey?: string;
  files: Record<string, { before: string; after: string }>;
}

interface UseEditorSaveOptions {
  editingPathRef: React.RefObject<string | undefined>;
  projectIdRef: React.RefObject<string | null>;
  readProjectFile: (path: string) => Promise<string>;
  writeProjectFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  recordEdit: (input: RecordEditInput) => Promise<void>;
  domEditSaveTimestampRef: React.MutableRefObject<number>;
  setRefreshKey: React.Dispatch<React.SetStateAction<number>>;
  showToast: (message: string, tone?: "error" | "info") => void;
}

export function useEditorSave({
  editingPathRef,
  projectIdRef,
  readProjectFile,
  writeProjectFile,
  recordEdit,
  domEditSaveTimestampRef,
  setRefreshKey,
  showToast,
}: UseEditorSaveOptions) {
  const saveRafRef = useRef<number | null>(null);
  const pendingSaveRef = useRef<Promise<void> | null>(null);
  const editGenerationRef = useRef(0);
  const editorDirtyRef = useRef(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const refreshRafRef = useRef<number | null>(null);
  // One error toast per burst of failures — every keystroke retries the save,
  // and error toasts persist until dismissed, so don't stack duplicates.
  const lastFailureToastAtRef = useRef(0);

  const handleContentChange = useCallback(
    (content: string) => {
      const pid = projectIdRef.current;
      if (!pid) return;
      const path = editingPathRef.current;
      if (!path) return;
      const generation = ++editGenerationRef.current;
      editorDirtyRef.current = true;
      setEditorDirty(true);

      if (saveRafRef.current != null) cancelAnimationFrame(saveRafRef.current);
      saveRafRef.current = requestAnimationFrame(() => {
        saveRafRef.current = null;
        domEditSaveTimestampRef.current = Date.now();
        const save = saveProjectFilesWithHistory({
          projectId: pid,
          label: "Edit source",
          kind: "source",
          coalesceKey: `source:${path}`,
          files: { [path]: content },
          readFile: readProjectFile,
          writeFile: writeProjectFile,
          recordEdit,
        })
          .then(() => {
            if (editGenerationRef.current === generation) {
              editorDirtyRef.current = false;
              setEditorDirty(false);
            }
            if (refreshRafRef.current != null) cancelAnimationFrame(refreshRafRef.current);
            refreshRafRef.current = requestAnimationFrame(() => setRefreshKey((k) => k + 1));
          })
          .catch((error) => {
            trackStudioEvent("save_failure", {
              source: "code_editor",
              error_message: error instanceof Error ? error.message : "unknown",
            });
            const now = Date.now();
            if (now - lastFailureToastAtRef.current > 5000) {
              lastFailureToastAtRef.current = now;
              showToast(
                `Couldn't save ${path} — your latest edits are NOT persisted. Check the preview server; editing again retries the save.`,
                "error",
              );
            }
          });
        pendingSaveRef.current = save.then(() => undefined);
      });
    },
    [
      domEditSaveTimestampRef,
      editingPathRef,
      projectIdRef,
      readProjectFile,
      recordEdit,
      setRefreshKey,
      showToast,
      writeProjectFile,
    ],
  );

  const flushPendingSourceSave = useCallback(async (): Promise<boolean> => {
    if (saveRafRef.current !== null) {
      await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
    }
    await pendingSaveRef.current;
    return !editorDirtyRef.current;
  }, []);

  return {
    saveRafRef,
    handleContentChange,
    editorDirty,
    flushPendingSourceSave,
  };
}
