import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import { useCollaborationRuntimeAvailability } from "./useCollaborationRuntimeAvailability";

export function useWorkspaceCollaborationRuntimeAvailability(input: {
  activeProfileId: string | null;
  activeProjectId: string | null;
  graph: DesktopGraphViewModel | null;
  localOwnerDirectWriteAvailable: boolean;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  sessionConnected: boolean;
}) {
  return useCollaborationRuntimeAvailability({
    enabled: Boolean(input.selectedProject) && !input.localOwnerDirectWriteAvailable,
    sessionConnected: input.sessionConnected,
    profileId: input.activeProfileId,
    activeProjectId: input.activeProjectId,
    localProjectId: input.selectedProject?.projectId ?? null,
    localCanvasId: input.selectedCanvasId,
    graph: input.graph
  });
}
