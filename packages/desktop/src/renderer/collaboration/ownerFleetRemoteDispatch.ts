import type { RemoteOperationObservation } from "@planweave-ai/collaboration-protocol/remote-run";
import type { RemoteDispatchIntentV3 } from "@planweave-ai/collaboration-protocol/remote-run";
import type { RemoteHumanExecutionActionCommand } from "@planweave-ai/collaboration-protocol/remote-run";
import type { PlanWeaveOperatorControlApi } from "../../shared/operatorControl";

export type OwnerFleetRemoteOperationsApi = Pick<
  PlanWeaveOperatorControlApi,
  | "dispatchOwnerFleetRemoteOperation"
  | "observeOwnerFleetRemoteOperation"
  | "executeOwnerFleetRemoteOperationAction"
>;

export type OwnerFleetRemoteDispatchApi = {
  dispatchOwnerFleetRemoteOperation(input: {
    command: RemoteDispatchIntentV3;
  }): Promise<RemoteOperationObservation>;
  observeOwnerFleetRemoteOperation(input: {
    operationId: string;
  }): Promise<RemoteOperationObservation>;
  executeOwnerFleetRemoteOperationAction(input: {
    operationId: string;
    action: RemoteHumanExecutionActionCommand;
  }): Promise<unknown>;
};

export function createOwnerFleetRemoteDispatchApi(input: {
  operatorProfileId: string;
  humanPrincipalId: string;
  workspaceId?: string;
  fleetApi: OwnerFleetRemoteOperationsApi;
}): OwnerFleetRemoteDispatchApi {
  const profileId = input.operatorProfileId;
  const humanPrincipalId = input.humanPrincipalId;
  const workspaceId = input.workspaceId;
  return {
    dispatchOwnerFleetRemoteOperation: (dispatchInput) =>
      input.fleetApi.dispatchOwnerFleetRemoteOperation({
        profileId,
        humanPrincipalId,
        command: dispatchInput.command,
        ...(workspaceId === undefined ? {} : { workspaceId })
      }),
    observeOwnerFleetRemoteOperation: (observeInput) =>
      input.fleetApi.observeOwnerFleetRemoteOperation({
        profileId,
        operationId: observeInput.operationId
      }),
    executeOwnerFleetRemoteOperationAction: (actionInput) =>
      input.fleetApi.executeOwnerFleetRemoteOperationAction({
        profileId,
        operationId: actionInput.operationId,
        action: actionInput.action
      })
  };
}
