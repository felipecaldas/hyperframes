import { AgentDrawer } from "./AgentDrawer";
import { useFileManagerContext } from "../contexts/FileManagerContext";
import { useStudioPlaybackContext, useStudioShellContext } from "../contexts/StudioContext";
import { hasAgentEditorDirty } from "../utils/agentBridge";

/**
 * Wires the Agent drawer to Studio's shell, playback and file-manager contexts.
 *
 * Deliberately not inlined in App.tsx: that file sits against the 600-line
 * decomposition cap, and none of this wiring needs to live there. Must be
 * rendered inside StudioShellProvider, StudioPlaybackProvider and
 * FileManagerProvider.
 */
export function AgentDrawerHost() {
  const { projectId, waitForPendingDomEditSaves } = useStudioShellContext();
  const { setRefreshKey } = useStudioPlaybackContext();
  const { flushPendingSourceSave, refreshFileTree } = useFileManagerContext();

  return (
    <AgentDrawer
      projectId={projectId}
      beforeRun={async () => {
        await waitForPendingDomEditSaves();
        const saved = await flushPendingSourceSave();
        return saved && !hasAgentEditorDirty()
          ? { ok: true }
          : {
              ok: false,
              message:
                "The source editor still has unsaved changes. Save or resolve them before starting an agent.",
            };
      }}
      onRefresh={async () => {
        await refreshFileTree();
        setRefreshKey((key) => key + 1);
      }}
    />
  );
}
