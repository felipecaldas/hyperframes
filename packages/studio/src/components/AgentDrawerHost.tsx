import { AgentDrawer } from "./AgentDrawer";
import { useFileManagerContext } from "../contexts/FileManagerContext";
import { useStudioPlaybackContext, useStudioShellContext } from "../contexts/StudioContext";
import { hasAgentEditorDirty } from "../utils/agentBridge";
import { resolveAgentPreflight } from "./agentPreflight";

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
        return resolveAgentPreflight(await flushPendingSourceSave(), hasAgentEditorDirty());
      }}
      onRefresh={async () => {
        await refreshFileTree();
        setRefreshKey((key) => key + 1);
      }}
    />
  );
}
