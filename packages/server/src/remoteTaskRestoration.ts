import type { RemoteBlockDispatchCandidate } from "@planweave-ai/runtime";
import type { RemoteOperation } from "./remoteOperations.js";
import type { RemoteDispatchCandidateReaderPort } from "./remoteBlockCoordinatorPorts.js";
import type { RemoteEndpointDispatchRequest } from "./remoteBlockDispatchAcceptance.js";

export function taskRestorationIdempotencyKey(operationId: string): string {
  return `restore-${operationId}`;
}

export async function restoredTaskDispatchRequest(
  reader: RemoteDispatchCandidateReaderPort,
  operation: RemoteOperation,
  actorId: string,
  restoration: NonNullable<RemoteBlockDispatchCandidate["restoration"]>
): Promise<RemoteEndpointDispatchRequest> {
  if (
    operation.state !== "cancelled" ||
    restoration.operationId !== operation.id ||
    restoration.executionAttemptId !== operation.executionAttemptId ||
    restoration.hostId !== operation.attempt.hostId
  )
    throw new Error("acp_restore_task_not_stopped");
  const selection = operation.endpointSelection;
  if (!selection || selection.authority.executionTargetRevision === undefined)
    throw new Error("acp_restore_endpoint_unavailable");
  const candidate = await reader.read(operation);
  return {
    workspaceId: operation.workspaceId,
    projectId: operation.projectId,
    canvasId: operation.canvasId,
    blockRef: operation.blockRef,
    idempotencyKey: taskRestorationIdempotencyKey(operation.id),
    agentEndpointId: selection.endpointId,
    expectedResponsibilityRevision: selection.authority.responsibilityRevision,
    expectedReviewerRevision: selection.authority.reviewerRevision,
    executionTargetRevision: selection.authority.executionTargetRevision,
    contentRevision: candidate.sourceRevision,
    graphFingerprint: candidate.graphFingerprint,
    targetKind: selection.authority.kind,
    callerHumanPrincipalId: actorId,
    restoration
  };
}
