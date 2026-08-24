import type { RemoteBlockExecutionReadModel } from "@planweave-ai/runtime";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import type { PlanWeaveOperatorControlApi } from "../../shared/operatorControl";
import type { RemoteTaskWorkspaceConversationApi } from "./useRemoteTaskWorkspaceConversation";
import type { WorkspaceCanvasLocator } from "../../shared/canvasLocator";

type CollaborationRemoteOperationApi = Pick<
  PlanWeaveCollaborationApi,
  | "observeCollaborationRemoteOperation"
  | "observeWorkspaceRemoteOperation"
  | "onCollaborationObserverSignal"
  | "replayCollaborationRemoteOperationEvents"
  | "replayWorkspaceRemoteOperationEvents"
>;

type OwnerRemoteOperationApi = Pick<
  PlanWeaveOperatorControlApi,
  "observeOwnerFleetRemoteOperation" | "replayOwnerFleetRemoteOperationEvents"
>;

function unavailableRemoteOperationSource(code: string): RemoteTaskWorkspaceConversationApi {
  const unavailable = async () => {
    throw new Error(code);
  };
  return {
    observe: unavailable,
    replay: unavailable
  };
}

/** Resolve auth/transport below the transport-neutral Task Workspace conversation model. */
export function remoteTaskWorkspaceConversationSource(input: {
  controlPlane: RemoteBlockExecutionReadModel["controlPlane"];
  collaborationApi: CollaborationRemoteOperationApi | null;
  operatorApi: OwnerRemoteOperationApi | null;
  operatorProfileId: string | null;
  workspaceScope?: { locator: WorkspaceCanvasLocator; blockRef: string };
}): RemoteTaskWorkspaceConversationApi {
  if (input.controlPlane === "owner") {
    if (!input.operatorApi || !input.operatorProfileId) {
      return unavailableRemoteOperationSource("owner_remote_operation_control_unavailable");
    }
    const api = input.operatorApi;
    const profileId = input.operatorProfileId;
    return {
      observe: (operationId) => api.observeOwnerFleetRemoteOperation({ profileId, operationId }),
      replay: (operationId, afterCursor) =>
        api.replayOwnerFleetRemoteOperationEvents({
          profileId,
          operationId,
          query: { afterCursor }
        }),
      replayTerminal: false
    };
  }

  if (!input.collaborationApi) {
    return unavailableRemoteOperationSource("collaboration_remote_operation_control_unavailable");
  }
  const api = input.collaborationApi;
  const workspaceScope = input.workspaceScope;
  return {
    observe: (operationId) =>
      workspaceScope
        ? api.observeWorkspaceRemoteOperation({ ...workspaceScope, operationId })
        : api.observeCollaborationRemoteOperation({ operationId }),
    replay: (operationId, afterCursor) =>
      workspaceScope
        ? api.replayWorkspaceRemoteOperationEvents({
            ...workspaceScope,
            operationId,
            query: { afterCursor }
          })
        : api.replayCollaborationRemoteOperationEvents({
            operationId,
            query: { afterCursor }
          }),
    replayTerminal: true,
    subscribe: (refresh) =>
      api.onCollaborationObserverSignal((signal) => {
        if (signal.type === "human.observer.event" && signal.event.kind === "remote_run") {
          refresh();
        }
      })
  };
}
