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
import type { RemoteBlockCompletionInput } from "@planweave-ai/runtime";
import type { HostCapacityReservation } from "./hostReservations.js";
import type { MailboxMessage } from "./mailbox.js";
import type { RemoteOperation } from "./remoteOperations.js";
import type {
  RemoteExecutionActionRequest,
  RemoteExecutionLifecycleSnapshot
} from "./remoteExecutionLifecycle.js";

export type RemoteCoordinatorCheckpoint =
  | "before_operation_commit"
  | "after_operation_commit"
  | "after_runtime_claim"
  | "after_candidate_persistence"
  | "after_envelope_persistence"
  | "after_input_materialization"
  | "after_host_reservation"
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

export interface RemoteCoordinatorCheckpointPort {
  reached(checkpoint: RemoteCoordinatorCheckpoint): void | Promise<void>;
}

export type RemoteRuntimeLocator = {
  workspaceId: string;
  projectId: string;
  canvasId: string;
};

export interface RemoteOperationCandidatePort {
  get(operationId: string): RemoteBlockDispatchCandidate | undefined;
  record(operationId: string, candidate: RemoteBlockDispatchCandidate): void;
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
  prepare(input: {
    operation: RemoteOperation;
    reservation: HostCapacityReservation;
    envelope: ExecutionEnvelope;
    envelopeDigest: string;
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
}

export interface RemoteAcpTranscriptPort {
  readCompletionTranscript(
    executionAttemptId: string
  ): Pick<NonNullable<RemoteBlockCompletionInput["transcript"]>, "sessionId" | "events"> | null;
}

export interface RemoteInputArtifactPort {
  materialize(
    candidate: RemoteBlockDispatchCandidate,
    source: RemoteBlockArtifactSource
  ): Promise<void>;
}
