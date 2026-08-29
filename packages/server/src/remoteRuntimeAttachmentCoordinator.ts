import type { RemoteBlockDispatchCandidate } from "@planweave-ai/runtime";
import type { CanvasExecutionRuntimeLease } from "./canvas/executionRuntimePort.js";
import type { RuntimeAttachmentRequest } from "./canvas/runtimeAttachment.js";
import type { HostCapacityReservation } from "./hostReservations.js";
import type { RemoteOperation } from "./remoteOperations.js";
import type { RemoteRuntimeContentTargetPort } from "./remoteBlockCoordinatorPorts.js";

export type RemoteRuntimeAttachmentPorts = {
  contentTargets: RemoteRuntimeContentTargetPort;
  record(input: RuntimeAttachmentRequest): void;
  project?(
    input: RuntimeAttachmentRequest & { lease: CanvasExecutionRuntimeLease }
  ): void | Promise<void>;
  confirmMaterializedRoute?(input: {
    workspaceId: string;
    projectId: string;
    hostId: string;
  }): void;
};

export async function attachWorkspaceRuntimeForAcceptedOperation(input: {
  operation: RemoteOperation;
  candidate: RemoteBlockDispatchCandidate;
  reservation: HostCapacityReservation;
  lease: CanvasExecutionRuntimeLease;
  ports: RemoteRuntimeAttachmentPorts;
}): Promise<void> {
  const scope = {
    workspaceId: input.operation.workspaceId,
    projectId: input.operation.projectId,
    canvasId: input.operation.canvasId
  };
  const contentTarget = input.ports.contentTargets.read(scope);
  if (
    contentTarget.graphFingerprint !== input.operation.sourceFingerprint ||
    contentTarget.graphFingerprint !== input.candidate.graphFingerprint
  ) {
    throw new Error("runtime_attachment_content_target_conflict");
  }
  const attachment = {
    ...scope,
    hostId: input.reservation.hostId,
    operationId: input.operation.id,
    executionAttemptId: input.operation.executionAttemptId,
    reservationLeaseId: input.reservation.leaseId,
    contentRevision: contentTarget.revision,
    graphFingerprint: contentTarget.graphFingerprint
  };
  input.ports.record(attachment);
  await input.ports.project?.({ ...attachment, lease: input.lease });
  if (input.ports.project) {
    input.ports.confirmMaterializedRoute?.({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      hostId: input.reservation.hostId
    });
  }
}
