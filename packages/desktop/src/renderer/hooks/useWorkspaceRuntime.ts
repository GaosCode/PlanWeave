import { useCallback, useRef, useState } from "react";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import type { RemoteCollaborationCanvasBindingInput } from "../../shared/collaboration";
import type { CanvasLocator } from "../../shared/canvasLocator";
import { collaborationBridge } from "../bridge";
import type { ProjectWorkspaceShellInput } from "../projectWorkspaceShell";
import { useWorkspaceRuntimeAvailability } from "./useWorkspaceRuntimeAvailability";
import {
  presentWorkspaceRuntimeResetError,
  workspaceRuntimeResetError
} from "../collaboration/runtimeResetPresentation";

export function useWorkspaceRuntime(input: {
  activeProfileId: string | null;
  activeProjectId: string | null;
  graph: DesktopGraphViewModel | null;
  sessionConnected: boolean;
  binding: RemoteCollaborationCanvasBindingInput | null;
  locator: CanvasLocator | null;
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
  const runtime = useWorkspaceRuntimeAvailability({
    enabled: input.locator?.kind === "workspace",
    profileId:
      input.locator?.kind === "workspace" &&
      input.locator.connectionProfileId === input.activeProfileId
        ? input.activeProfileId
        : null,
    activeProjectId: input.activeProjectId,
    graph: input.graph,
    sessionConnected: input.sessionConnected,
    binding: input.binding,
    refreshRevision
  });
  const resetWorkspaceRuntime = useCallback(async () => {
    if (
      input.locator?.kind !== "workspace" ||
      !input.binding ||
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
    resetWorkspaceRuntime: input.locator?.kind === "workspace" ? resetWorkspaceRuntime : undefined
  };
}
