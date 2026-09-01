import type {
  ExecutionEnvelope,
  InterruptionReason,
  MailboxCommand,
  NormalizedFailure
} from "@planweave-ai/agent-host-protocol";
import type {
  RemoteBlockArtifactSource,
  RemoteBlockDispatchCandidate
} from "@planweave-ai/runtime";
import type { HostCapacityReservation } from "./hostReservations.js";
import type { MailboxMessage } from "./mailbox.js";
import type { RemoteOperation } from "./remoteOperations.js";
import type {
  CanvasExecutionRuntimeLease,
  CanvasExecutionRuntimeLeasePort,
  CanvasExecutionRuntimeRoutePort
} from "./canvas/executionRuntimePort.js";
import type {
  RemoteExecutionActionRequest,
  RemoteExecutionLifecycleSnapshot
} from "./remoteExecutionLifecycle.js";
import type { RuntimeContentTargetAuthorityPort } from "./canvas/runtimeContentTargetPort.js";

export type RemoteCoordinatorCheckpoint =
  | "before_operation_commit"
  | "after_operation_commit"
  | "after_runtime_claim"
  | "after_candidate_persistence"
  | "after_envelope_persistence"
  | "after_input_materialization"
  | "after_host_reservation"
  | "after_runtime_attachment"
  | "after_dispatch_persistence"
  | "after_runtime_binding"
  | "after_mailbox_enqueue"
  | "after_mailbox_publish"
  | "after_action_side_effect"
  | "after_host_acceptance_observed"
  | "after_terminal_event_persistence"
  | "before_runtime_writeback"
  | "after_runtime_writeback"
  | "after_dispatch_terminal_persistence"
  | "after_terminal_persistence";

export class RemoteCoordinatorCheckpointCrash extends Error {
  constructor(readonly checkpoint: RemoteCoordinatorCheckpoint) {
    super(`injected_crash:${checkpoint}`);
    this.name = "RemoteCoordinatorCheckpointCrash";
  }
}

export interface RemoteCoordinatorCheckpointPort {
  reached(checkpoint: RemoteCoordinatorCheckpoint): void | Promise<void>;
}

export type RemoteRuntimeLocator = {
  workspaceId: string;
  projectId: string;
  canvasId: string;
};

export type RemoteRuntimeContentTargetPort = RuntimeContentTargetAuthorityPort;

/** Atomically fences an Operation create against the persisted Canvas content authority. */
export type RemoteContentAuthorizePort = (input: {
  workspaceId: string;
  projectId: string;
  canvasId: string;
  contentRevision: string;
  graphFingerprint: string;
}) => void;

/** Reads an immutable dispatch candidate from Server-owned Canvas content authority. */
export interface RemoteDispatchCandidateReaderPort {
  read(
    input: RemoteRuntimeLocator & { blockRef: string }
  ): RemoteBlockDispatchCandidate | Promise<RemoteBlockDispatchCandidate>;
}

/** Project a domain record onto the exact Runtime lease scope contract. */
export function remoteRuntimeLocator(locator: RemoteRuntimeLocator): RemoteRuntimeLocator {
  return {
    workspaceId: locator.workspaceId,
    projectId: locator.projectId,
    canvasId: locator.canvasId
  };
}

export function acquireRemoteRuntimeLease(
  runtimeLeases: CanvasExecutionRuntimeLeasePort | CanvasExecutionRuntimeRoutePort,
  locator: RemoteRuntimeLocator,
  hostId: string | undefined
): CanvasExecutionRuntimeLease | Promise<CanvasExecutionRuntimeLease> {
  const scope = remoteRuntimeLocator(locator);
  if (hostId && "acquireForHost" in runtimeLeases) {
    return runtimeLeases.acquireForHost(scope, hostId);
  }
  return runtimeLeases.acquire(scope);
}

export function authorizedOperationHostId(operation: {
  endpointSelection?: { hostId: string };
  agentAccess?: { authorized: { remoteAgent: { hostId: string } } };
}): string | undefined {
  return (
    operation.endpointSelection?.hostId ?? operation.agentAccess?.authorized.remoteAgent.hostId
  );
}

export interface RemoteOperationCandidatePort {
  get(operationId: string): RemoteBlockDispatchCandidate | undefined;
  record(operationId: string, candidate: RemoteBlockDispatchCandidate): void;
  createWithCandidate(
    createOperation: () => RemoteOperation,
    candidate: RemoteBlockDispatchCandidate
  ): RemoteOperation;
}

export type ActivatedMailboxDelivery = {
  operation: RemoteOperation;
  message: MailboxMessage;
};

export type RemoteDispatchReconciliationState = {
  dispatch?: {
    status:
      | "leased"
      | "running"
      | "interrupted"
      | "cancelling"
      | "awaiting_writeback"
      | "completed"
      | "failed"
      | "cancelled";
    interruption?: {
      reason: InterruptionReason;
      resumable: boolean;
    };
    envelopeDigest?: string;
    inputGrantCount: number;
    terminalAction?:
      | { kind: "complete"; reportArtifactRef: string }
      | { kind: "fail"; failure: NormalizedFailure };
  };
  mailbox?: {
    messageId: string;
    publishedAt?: string;
  };
};

export interface RemoteDispatchPersistencePort {
  inspect(operation: RemoteOperation): RemoteDispatchReconciliationState;
  readEnvelope(operation: RemoteOperation): ExecutionEnvelope;
  prepare(input: {
    operation: RemoteOperation;
    reservation: HostCapacityReservation;
    envelope: ExecutionEnvelope;
    envelopeDigest: string;
    validateBeforeCommit?: () => void;
  }): void;
  activate(input: {
    operation: RemoteOperation;
    reservation: HostCapacityReservation;
    command: MailboxCommand;
  }): ActivatedMailboxDelivery;
  actionSnapshot(operation: RemoteOperation): RemoteExecutionLifecycleSnapshot;
  enqueueCancel(input: {
    operation: RemoteOperation;
    action: Extract<RemoteExecutionActionRequest, { kind: "cancel" }>;
  }): MailboxMessage;
  enqueueResume(input: {
    operation: RemoteOperation;
    action: Extract<RemoteExecutionActionRequest, { kind: "resume_same_session" }>;
  }): MailboxMessage;
  markActionRequired(operation: RemoteOperation): void;
  prepareManualFailure(input: { operation: RemoteOperation; failure: NormalizedFailure }): void;
  markMailboxPublished(messageId: string): void;
  cancelInterruptedAfterRuntimeReset(operation: RemoteOperation): void;
  finishTerminal(input: {
    operation: RemoteOperation;
    status: "completed" | "failed" | "cancelled";
  }): void;
}

export interface RemoteMailboxPublisherPort {
  publish(message: MailboxMessage): void;
}

export interface RemoteArtifactContentPort {
  readReport(artifactRef: string): Promise<Uint8Array>;
  readReportMediaType?(artifactRef: string): Promise<string>;
}

export interface RemoteInputArtifactPort {
  materialize(
    candidate: RemoteBlockDispatchCandidate,
    source: RemoteBlockArtifactSource
  ): Promise<void>;
}
