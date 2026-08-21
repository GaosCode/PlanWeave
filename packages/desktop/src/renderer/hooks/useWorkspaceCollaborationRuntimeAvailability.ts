import { useMemo } from "react";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import {
  failClosedCollaborationRuntimeDispatchability,
  useCollaborationRuntimeAvailability
} from "./useCollaborationRuntimeAvailability";
import type { SharedCanvasAuthorityMode } from "./useSharedCanvasCommands";
import type { CollaborationCanvasBindingInput } from "../../shared/collaboration";

const CHECKING_RUNTIME_AVAILABILITY = { kind: "checking" } as const;

export function useWorkspaceCollaborationRuntimeAvailability(input: {
  activeProfileId: string | null;
  activeProjectId: string | null;
  graph: DesktopGraphViewModel | null;
  sessionConnected: boolean;
  sharedAuthorityMode: SharedCanvasAuthorityMode;
  binding: CollaborationCanvasBindingInput | null;
  refreshRevision?: number;
}) {
  const collaborationAuthorityApplies =
    input.binding?.kind === "remote" || input.sharedAuthorityMode === "shared";
  const runtime = useCollaborationRuntimeAvailability({
    enabled: Boolean(input.binding) && collaborationAuthorityApplies,
    sessionConnected: input.sessionConnected,
    profileId: input.activeProfileId,
    activeProjectId: input.activeProjectId,
    binding: input.binding,
    graph: input.graph,
    refreshRevision: input.refreshRevision
  });
  const resolvingRuntime = useMemo(
    () => ({
      availability: CHECKING_RUNTIME_AVAILABILITY,
      graph: input.graph ? failClosedCollaborationRuntimeDispatchability(input.graph) : null
    }),
    [input.graph]
  );
  if (input.binding?.kind !== "local" || input.sharedAuthorityMode !== "resolving") {
    return runtime;
  }
  return resolvingRuntime;
}
