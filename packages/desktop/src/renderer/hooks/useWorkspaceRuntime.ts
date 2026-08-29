import { useCallback, useRef } from "react";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import type { CanvasRuntimeResetAccepted } from "@planweave-ai/collaboration-protocol/canvas/runtime-control";
import type {
  PlanWeaveCollaborationApi,
  RemoteCollaborationCanvasBindingInput
} from "../../shared/collaboration";
import type {
  CanvasRuntimeAvailability,
  CanvasRuntimeAvailabilityV2
} from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import type { CanvasLocator } from "../../shared/canvasLocator";
import { collaborationBridge } from "../bridge";
import type { ProjectWorkspaceShellInput } from "../projectWorkspaceShell";
import { useWorkspaceRuntimeAvailability } from "./useWorkspaceRuntimeAvailability";
import type { WorkspaceRuntimeAvailabilityBridge } from "./useWorkspaceRuntimeAvailability";
import {
  presentWorkspaceRuntimeResetError,
  workspaceRuntimeResetError
} from "../collaboration/runtimeResetPresentation";
import { collaborationRuntimeResetAllowed } from "../collaboration/runtimeAvailabilityView";

export type WorkspaceRuntimeBridge = WorkspaceRuntimeAvailabilityBridge &
  Pick<PlanWeaveCollaborationApi, "resetWorkspaceCanvasRuntime">;

function runtimeAvailabilityAfterAcceptedControl(
  current: CanvasRuntimeAvailabilityV2,
  outcome: CanvasRuntimeResetAccepted
): CanvasRuntimeAvailability {
  return {
    ...current,
    state: {
      kind: "initialized",
      runtimeRevision: outcome.runtimeRevision,
      status: outcome.status
    },
    execution:
      current.execution.kind === "available"
        ? {
            ...current.execution,
            sourceRevision: outcome.sourceRevision,
            graphFingerprint: outcome.graphFingerprint,
            status: outcome.status
          }
        : current.execution,
    authority: {
      ...current.authority,
      sourceRevision: outcome.sourceRevision,
      graphFingerprint: outcome.graphFingerprint
    }
  };
}

export function useWorkspaceRuntime(input: {
  activeProfileId: string | null;
  activeProjectId: string | null;
  graph: DesktopGraphViewModel | null;
  sessionConnected: boolean | null;
  binding: RemoteCollaborationCanvasBindingInput | null;
  initialRuntimeAvailability: CanvasRuntimeAvailability | null;
  locator: CanvasLocator | null;
  setError: ProjectWorkspaceShellInput["setError"];
  setSuccessMessage: ProjectWorkspaceShellInput["setSuccessMessage"];
  t: ProjectWorkspaceShellInput["t"];
  api?: WorkspaceRuntimeBridge | null;
}) {
  const api = input.api === undefined ? collaborationBridge : input.api;
  const activeScopeKey =
    input.locator?.kind === "workspace"
      ? `${input.locator.connectionProfileId}\u0000${input.locator.workspaceId}\u0000${input.locator.projectId}\u0000${input.locator.canvasId}`
      : null;
  const workspaceRuntimeAuthorityKey = activeScopeKey
    ? `${activeScopeKey}\u0000${input.graph?.packageFingerprint ?? "no-graph"}`
    : null;
  const activeScopeKeyRef = useRef(activeScopeKey);
  activeScopeKeyRef.current = activeScopeKey;
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
    initialRuntimeAvailability: input.initialRuntimeAvailability,
    api
  });
  const resetWorkspaceRuntime = useCallback(async () => {
    const currentRuntime = runtime.authoritativeRuntime;
    const authority =
      currentRuntime?.schemaVersion === "canvas-runtime-view/v2"
        ? currentRuntime.authority
        : undefined;
    if (
      input.locator?.kind !== "workspace" ||
      !input.binding ||
      !currentRuntime ||
      currentRuntime.schemaVersion !== "canvas-runtime-view/v2" ||
      !authority ||
      !collaborationRuntimeResetAllowed(runtime.availability)
    ) {
      throw workspaceRuntimeResetError(input.t, "unavailable");
    }
    if (!api) throw new Error(input.t("bridgeUnavailable"));
    const previousRuntimeRevision =
      currentRuntime.state.kind === "initialized" ? currentRuntime.state.runtimeRevision : 0;
    const scopeKey = `${input.locator.connectionProfileId}\u0000${input.locator.workspaceId}\u0000${input.locator.projectId}\u0000${input.locator.canvasId}`;
    const request =
      pendingResetOperation.current?.scopeKey === scopeKey
        ? pendingResetOperation.current.request
        : {
            operationId: crypto.randomUUID(),
            expectedSourceRevision: authority.sourceRevision,
            expectedGraphFingerprint: authority.graphFingerprint,
            reason: "Desktop workspace runtime reset requested."
          };
    pendingResetOperation.current = { scopeKey, request };
    let outcome: Awaited<ReturnType<typeof api.resetWorkspaceCanvasRuntime>>;
    try {
      outcome = await api.resetWorkspaceCanvasRuntime({
        locator: input.locator,
        ...request
      });
    } catch (caught) {
      throw presentWorkspaceRuntimeResetError(input.t, caught);
    }
    if (outcome.type === "canvas.runtime.reset.rejected") {
      if (
        outcome.code !== "reconcile_required" &&
        pendingResetOperation.current?.scopeKey === scopeKey &&
        pendingResetOperation.current.request.operationId === request.operationId
      ) {
        pendingResetOperation.current = null;
      }
      throw workspaceRuntimeResetError(input.t, outcome.code);
    }
    if (outcome.runtimeRevision <= previousRuntimeRevision) {
      throw workspaceRuntimeResetError(input.t, "projection_postcondition_failed");
    }
    if (
      pendingResetOperation.current?.scopeKey === scopeKey &&
      pendingResetOperation.current.request.operationId === request.operationId
    ) {
      pendingResetOperation.current = null;
    }
    if (activeScopeKeyRef.current !== scopeKey) return;
    runtime.applyAcceptedRuntimeProjection(
      runtimeAvailabilityAfterAcceptedControl(currentRuntime, outcome)
    );
    input.setSuccessMessage(input.t("resetRuntimeStateSuccess"));
  }, [
    api,
    input.binding,
    input.locator,
    input.setSuccessMessage,
    input.t,
    runtime.applyAcceptedRuntimeProjection,
    runtime.authoritativeRuntime,
    runtime.availability
  ]);

  return {
    ...runtime,
    workspaceRuntimeAuthorityKey,
    resetWorkspaceRuntime:
      input.locator?.kind === "workspace" &&
      runtime.authoritativeRuntime?.schemaVersion === "canvas-runtime-view/v2"
        ? resetWorkspaceRuntime
        : undefined
  };
}
