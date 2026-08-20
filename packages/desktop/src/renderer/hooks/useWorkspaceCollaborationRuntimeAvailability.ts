import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import { useCollaborationRuntimeAvailability } from "./useCollaborationRuntimeAvailability";
import type { CollaborationCanvasBindingInput } from "../../shared/collaboration";

export function useWorkspaceCollaborationRuntimeAvailability(input: {
  activeProfileId: string | null;
  activeProjectId: string | null;
  graph: DesktopGraphViewModel | null;
  localOwnerDirectWriteAvailable: boolean;
  sessionConnected: boolean;
  binding: CollaborationCanvasBindingInput | null;
}) {
  return useCollaborationRuntimeAvailability({
    enabled: Boolean(input.binding) && !input.localOwnerDirectWriteAvailable,
    sessionConnected: input.sessionConnected,
    profileId: input.activeProfileId,
    activeProjectId: input.activeProjectId,
    binding: input.binding,
    graph: input.graph
  });
}
