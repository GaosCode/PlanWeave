import type { RemoteBlockDispatchCandidate } from "@planweave-ai/runtime";
import type { CanvasExecutionRuntimeLease } from "./canvas/executionRuntimePort.js";
import type { RuntimeAttachmentRequest } from "./canvas/runtimeAttachment.js";
import type { HostCapacityReservation } from "./hostReservations.js";
import type { RemoteOperation } from "./remoteOperations.js";
import type { RemoteRuntimeContentTargetPort } from "./remoteBlockCoordinatorPorts.js";

export class RuntimeAttachmentContentTargetError extends Error {
  constructor(
    readonly code:
      | "runtime_attachment_content_target_conflict"
      | "runtime_attachment_content_target_changed"
  ) {
    super(code);
    this.name = "RuntimeAttachmentContentTargetError";
  }
}

export type RemoteRuntimeAttachmentRecordPorts = {
  contentTargets: RemoteRuntimeContentTargetPort;
  record(input: RuntimeAttachmentRequest): void;
};

export type RemoteRuntimeMaterializationPorts = {
  contentTargets: RemoteRuntimeContentTargetPort;
  project?(
    input: RuntimeAttachmentRequest & { lease: CanvasExecutionRuntimeLease }
  ): void | Promise<void>;
};

export async function attachWorkspaceRuntimeForAcceptedOperation(input: {
  operation: RemoteOperation;
  candidate: RemoteBlockDispatchCandidate;
  reservation: HostCapacityReservation;
  ports: RemoteRuntimeAttachmentRecordPorts;
}): Promise<RuntimeAttachmentRequest> {
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
    throw new RuntimeAttachmentContentTargetError("runtime_attachment_content_target_conflict");
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
  return attachment;
}

export function assertRuntimeAttachmentContentTarget(input: {
  attachment: RuntimeAttachmentRequest;
  candidate: RemoteBlockDispatchCandidate;
  contentTargets: RemoteRuntimeContentTargetPort;
}): void {
  const current = input.contentTargets.read({
    workspaceId: input.attachment.workspaceId,
    projectId: input.attachment.projectId,
    canvasId: input.attachment.canvasId
  });
  if (
    current.revision !== input.attachment.contentRevision ||
    current.graphFingerprint !== input.attachment.graphFingerprint ||
    current.graphFingerprint !== input.candidate.graphFingerprint
  ) {
    throw new RuntimeAttachmentContentTargetError("runtime_attachment_content_target_changed");
  }
}

export async function materializeAttachedWorkspaceRuntime(input: {
  attachment: RuntimeAttachmentRequest;
  candidate: RemoteBlockDispatchCandidate;
  lease: CanvasExecutionRuntimeLease;
  ports: RemoteRuntimeMaterializationPorts;
}): Promise<void> {
  assertRuntimeAttachmentContentTarget({
    attachment: input.attachment,
    candidate: input.candidate,
    contentTargets: input.ports.contentTargets
  });
  await input.ports.project?.({ ...input.attachment, lease: input.lease });
}
