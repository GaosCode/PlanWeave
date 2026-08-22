import { useCallback, useRef, useState } from "react";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import type { CollaborationCanvasBindingInput } from "../../shared/collaboration";
import type { CanvasLocator } from "../../shared/canvasLocator";
import { collaborationBridge } from "../bridge";
import type { ProjectWorkspaceShellInput } from "../projectWorkspaceShell";
import type { SharedCanvasAuthorityMode } from "./useSharedCanvasCommands";
import { useWorkspaceCollaborationRuntimeAvailability } from "./useWorkspaceCollaborationRuntimeAvailability";
import {
  presentWorkspaceRuntimeResetError,
  workspaceRuntimeResetError
} from "../collaboration/runtimeResetPresentation";

export function useWorkspaceRuntimeState(input: {
  activeProfileId: string | null;
  activeProjectId: string | null;
  graph: DesktopGraphViewModel | null;
  sessionConnected: boolean;
  binding: CollaborationCanvasBindingInput | null;
  locator: CanvasLocator | null;
  sharedAuthorityMode: SharedCanvasAuthorityMode;
  setError: ProjectWorkspaceShellInput["setError"];
  setSuccessMessage: ProjectWorkspaceShellInput["setSuccessMessage"];
  t: ProjectWorkspaceShellInput["t"];
}) {
  const [refreshRevision, setRefreshRevision] = useState(0);
  const pendingResetOperation = useRef<{
    scopeKey: string;
    request: {
      operationId: string;
      expectedSourceRevision: string;
      expectedGraphFingerprint: string;
      reason: string;
    };
  } | null>(null);
  const runtime = useWorkspaceCollaborationRuntimeAvailability({
    activeProfileId:
      input.locator?.kind === "workspace" &&
      input.locator.connectionProfileId === input.activeProfileId
        ? input.activeProfileId
        : null,
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

  const resetWorkspaceRuntime = useCallback(async () => {
    if (
      input.locator?.kind !== "workspace" ||
      input.binding?.kind !== "remote" ||
      runtime.authoritativeRuntime?.execution.kind !== "available"
    ) {
      throw workspaceRuntimeResetError(input.t, "unavailable");
    }
    if (!collaborationBridge) throw new Error(input.t("bridgeUnavailable"));
    const previousRuntimeRevision =
      runtime.authoritativeRuntime.state.kind === "initialized"
        ? runtime.authoritativeRuntime.state.runtimeRevision
        : 0;
    const scopeKey = `${input.locator.connectionProfileId}\u0000${input.locator.workspaceId}\u0000${input.locator.projectId}\u0000${input.locator.canvasId}`;
    const request =
      pendingResetOperation.current?.scopeKey === scopeKey
        ? pendingResetOperation.current.request
        : {
            operationId: crypto.randomUUID(),
            expectedSourceRevision: runtime.authoritativeRuntime.execution.sourceRevision,
            expectedGraphFingerprint:
              runtime.authoritativeRuntime.execution.status.packageFingerprint,
            reason: "Desktop workspace runtime reset requested."
          };
    pendingResetOperation.current = { scopeKey, request };
    let outcome: Awaited<ReturnType<typeof collaborationBridge.resetWorkspaceCanvasRuntime>>;
    try {
      outcome = await collaborationBridge.resetWorkspaceCanvasRuntime({
        locator: input.locator,
        ...request
      });
    } catch (caught) {
      throw presentWorkspaceRuntimeResetError(input.t, caught);
    }
    if (outcome.type === "canvas.runtime.reset.rejected") {
      if (outcome.code !== "reconcile_required") pendingResetOperation.current = null;
      throw workspaceRuntimeResetError(input.t, outcome.code);
    }
    let authoritative: Awaited<
      ReturnType<typeof collaborationBridge.readCollaborationCanvasBindingRuntimeAvailability>
    >;
    try {
      authoritative = await collaborationBridge.readCollaborationCanvasBindingRuntimeAvailability(
        input.binding
      );
    } catch (caught) {
      throw presentWorkspaceRuntimeResetError(input.t, caught);
    }
    if (
      !authoritative ||
      authoritative.state.kind !== "initialized" ||
      authoritative.state.runtimeRevision <= previousRuntimeRevision ||
      authoritative.state.runtimeRevision < outcome.runtimeRevision ||
      JSON.stringify(authoritative.state.status) !== JSON.stringify(outcome.status)
    ) {
      throw workspaceRuntimeResetError(input.t, "projection_postcondition_failed");
    }
    pendingResetOperation.current = null;
    setRefreshRevision((revision) => revision + 1);
    input.setSuccessMessage(input.t("resetRuntimeStateSuccess"));
  }, [
    input.binding,
    input.locator,
    input.setSuccessMessage,
    input.t,
    runtime.authoritativeRuntime
  ]);

  return {
    ...runtime,
    resetWorkspaceRuntime: input.locator?.kind === "workspace" ? resetWorkspaceRuntime : undefined,
    onImportRuntimeState:
      input.binding?.kind === "local" && runtime.availability.kind === "state_uninitialized"
        ? importLocalRuntimeState
        : undefined
  };
}
