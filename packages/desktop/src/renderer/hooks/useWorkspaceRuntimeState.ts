import { useCallback, useState } from "react";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import type { CollaborationCanvasBindingInput } from "../../shared/collaboration";
import { collaborationBridge } from "../bridge";
import type { ProjectWorkspaceShellInput } from "../projectWorkspaceShell";
import type { SharedCanvasAuthorityMode } from "./useSharedCanvasCommands";
import { useWorkspaceCollaborationRuntimeAvailability } from "./useWorkspaceCollaborationRuntimeAvailability";

export function useWorkspaceRuntimeState(input: {
  activeProfileId: string | null;
  activeProjectId: string | null;
  graph: DesktopGraphViewModel | null;
  sessionConnected: boolean;
  binding: CollaborationCanvasBindingInput | null;
  sharedAuthorityMode: SharedCanvasAuthorityMode;
  setError: ProjectWorkspaceShellInput["setError"];
  setSuccessMessage: ProjectWorkspaceShellInput["setSuccessMessage"];
  t: ProjectWorkspaceShellInput["t"];
}) {
  const [refreshRevision, setRefreshRevision] = useState(0);
  const runtime = useWorkspaceCollaborationRuntimeAvailability({
    activeProfileId: input.activeProfileId,
    activeProjectId: input.activeProjectId,
    graph: input.graph,
    sessionConnected: input.sessionConnected,
    binding: input.binding,
    sharedAuthorityMode: input.sharedAuthorityMode,
    refreshRevision
  });
  const importLocalRuntimeState = useCallback(async () => {
    if (!input.binding || input.binding.kind !== "local") {
      input.setError(input.t("collaborationRuntimeStateWorkingCopyRequired"));
      return;
    }
    try {
      if (!collaborationBridge) throw new Error(input.t("bridgeUnavailable"));
      const imported = await collaborationBridge.importCollaborationLocalRuntimeStatus(
        input.binding
      );
      if (!imported || imported.kind !== "initialized") {
        throw new Error("collaboration_runtime_state_import_failed");
      }
      setRefreshRevision((revision) => revision + 1);
      input.setSuccessMessage(input.t("collaborationRuntimeStateImported"));
    } catch (caught) {
      input.setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [input.binding, input.setError, input.setSuccessMessage, input.t]);

  return {
    ...runtime,
    onImportRuntimeState:
      input.binding?.kind === "local" && runtime.availability.kind === "state_uninitialized"
        ? importLocalRuntimeState
        : undefined
  };
}
