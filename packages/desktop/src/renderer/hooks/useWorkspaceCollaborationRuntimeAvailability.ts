import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import { useCollaborationRuntimeAvailability } from "./useCollaborationRuntimeAvailability";
import type { SharedCanvasAuthorityMode } from "./useSharedCanvasCommands";
import type { CollaborationCanvasBindingInput } from "../../shared/collaboration";

export function useWorkspaceCollaborationRuntimeAvailability(input: {
  activeProfileId: string | null;
  activeProjectId: string | null;
  graph: DesktopGraphViewModel | null;
  sessionConnected: boolean;
  sharedAuthorityMode: SharedCanvasAuthorityMode;
  binding: CollaborationCanvasBindingInput | null;
  refreshRevision?: number;
}) {
  const collaborationAuthorityApplies = input.binding?.kind === "remote";
  return useCollaborationRuntimeAvailability({
    enabled: Boolean(input.binding) && collaborationAuthorityApplies,
    sessionConnected: input.sessionConnected,
    profileId: input.activeProfileId,
    activeProjectId: input.activeProjectId,
    binding: input.binding,
    graph: input.graph,
    refreshRevision: input.refreshRevision
  });
}
