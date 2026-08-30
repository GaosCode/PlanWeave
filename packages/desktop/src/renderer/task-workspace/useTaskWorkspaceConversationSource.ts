import type { RemoteBlockExecutionReadModel } from "@planweave-ai/runtime";
import type { RemoteOperationState } from "@planweave-ai/collaboration-protocol/remote-run";
import { useMemo } from "react";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import type { PlanWeaveOperatorControlApi } from "../../shared/operatorControl";
import type { PlanWeaveWorkspaceExecutionApi } from "../../shared/workspaceExecution";
import type { WorkspaceTaskWorkspaceNavigationIdentity } from "../taskWorkspaceNavigation";
import { remoteTaskWorkspaceConversationSource } from "./remoteTaskWorkspaceConversationSource";
import { useRemoteTaskWorkspaceConversation } from "./useRemoteTaskWorkspaceConversation";
import { useWorkspaceExecutionTaskWorkspaceConversation } from "./useWorkspaceExecutionTaskWorkspaceConversation";

function projectedRemoteConversationState(
  execution: RemoteBlockExecutionReadModel | null | undefined
): RemoteOperationState | undefined {
  if (!execution) return undefined;
  if (execution.phase === "terminal") {
    return execution.status === "completed" ? "completed" : "failed";
  }
  if (execution.status === "interrupted") return "interrupted";
  if (execution.status === "source_drift") return "action_required";
  return execution.phase === "active" ? "running" : "preparing";
}

export function useTaskWorkspaceConversationSource(input: {
  collaborationApi: Pick<
    PlanWeaveCollaborationApi,
    | "observeCollaborationRemoteOperation"
    | "onCollaborationObserverSignal"
    | "replayCollaborationRemoteOperationEvents"
  > | null;
  execution: RemoteBlockExecutionReadModel | null | undefined;
  onTerminal(): void;
  operatorApi: Pick<
    PlanWeaveOperatorControlApi,
    "observeOwnerFleetRemoteOperation" | "replayOwnerFleetRemoteOperationEvents"
  > | null;
  operatorProfileId: string | null;
  scopeKey: string;
  selectedBlockRef: string;
  workspaceExecutionApi: PlanWeaveWorkspaceExecutionApi | null;
  workspaceNavigation: WorkspaceTaskWorkspaceNavigationIdentity | null;
}) {
  const workspaceScope = useMemo(() => {
    if (!input.workspaceNavigation || !input.selectedBlockRef) return null;
    return {
      locator: {
        kind: "workspace" as const,
        connectionProfileId: input.workspaceNavigation.connectionProfileId,
        workspaceId: input.workspaceNavigation.workspaceId,
        projectId: input.workspaceNavigation.projectId,
        canvasId: input.workspaceNavigation.canvasId
      },
      blockRef: input.selectedBlockRef
    };
  }, [input.selectedBlockRef, input.workspaceNavigation]);
  const legacyApi = useMemo(
    () =>
      input.execution?.controlPlane && !workspaceScope
        ? remoteTaskWorkspaceConversationSource({
            controlPlane: input.execution.controlPlane,
            collaborationApi: input.collaborationApi,
            operatorApi: input.operatorApi,
            operatorProfileId: input.operatorProfileId
          })
        : null,
    [
      input.collaborationApi,
      input.execution?.controlPlane,
      input.operatorApi,
      input.operatorProfileId,
      workspaceScope
    ]
  );
  const operationId = input.execution?.identity.operationId ?? null;
  const legacyConversation = useRemoteTaskWorkspaceConversation({
    api: workspaceScope ? null : legacyApi,
    blockRef: input.selectedBlockRef || null,
    cacheScopeKey: input.scopeKey,
    initialState: projectedRemoteConversationState(input.execution),
    operationId,
    onTerminal: input.onTerminal
  });
  const workspaceConversation = useWorkspaceExecutionTaskWorkspaceConversation({
    api: input.workspaceExecutionApi,
    locator: workspaceScope?.locator ?? null,
    blockRef: input.selectedBlockRef || null,
    operationId,
    scopeKey: input.scopeKey,
    onTerminal: input.onTerminal
  });
  return workspaceScope ? workspaceConversation : legacyConversation;
}
