import { createHash } from "node:crypto";
import {
  acpRecoveryIdentitySchema,
  agentHostProtocolVersion,
  capabilitiesSchema,
  dispatchResultSchema,
  interruptionReasonSchema,
  mailboxCommandSchema,
  normalizedFailureSchema,
  type ExecutionEnvelope
} from "@planweave-ai/agent-host-protocol";
import { remoteBlockDispatchCandidateSchema } from "@planweave-ai/runtime";
import { z } from "zod";
import { ArtifactAuthorizationRepository } from "./artifactAuthorization.js";
import type {
  ActivatedMailboxDelivery,
  RemoteDispatchPersistencePort,
  RemoteOperationCandidatePort,
  RemoteDispatchReconciliationState
} from "./remoteBlockCoordinatorPorts.js";
import type { HostCapacityReservation } from "./hostReservations.js";
import { DurableMailbox } from "./mailbox.js";
import { RemoteOperationRepository, type RemoteOperation } from "./remoteOperations.js";
import type { RemoteExecutionActionRequest } from "./remoteExecutionLifecycle.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

function executeMailboxMessageId(dispatchId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(["execute-mailbox-message/v1", dispatchId]))
    .digest("hex");
  return `execute:v1:${digest}`;
}

export class SqliteRemoteOperationCandidateRepository implements RemoteOperationCandidatePort {
  constructor(private readonly database: SqliteDatabase) {}

  get(operationId: string) {
    const row = this.database
      .prepare("SELECT candidate_json FROM remote_operation_candidates WHERE operation_id=?")
      .get(operationId);
    if (!row) return undefined;
    try {
      return remoteBlockDispatchCandidateSchema.parse(JSON.parse(String(row.candidate_json)));
    } catch (error) {
      throw new Error("remote_operation_candidate_row_invalid", { cause: error });
    }
  }

  record(operationId: string, candidate: unknown): void {
    const parsed = remoteBlockDispatchCandidateSchema.parse(candidate);
    const canonical = JSON.stringify(parsed);
    const existing = this.database
      .prepare("SELECT candidate_json FROM remote_operation_candidates WHERE operation_id=?")
      .get(operationId);
    if (existing) {
      if (existing.candidate_json !== canonical) {
        throw new Error("remote_operation_candidate_conflict");
      }
      return;
    }
    this.database
      .prepare(
        `INSERT INTO remote_operation_candidates(operation_id,candidate_json,created_at)
         VALUES (?,?,?)`
      )
      .run(operationId, canonical, new Date().toISOString());
  }

  createWithCandidate(createOperation: () => RemoteOperation, candidate: unknown): RemoteOperation {
    return inWriteTransaction(this.database, () => {
      const operation = createOperation();
      this.record(operation.id, candidate);
      return operation;
    });
  }
}

export class SqliteRemoteDispatchPersistence implements RemoteDispatchPersistencePort {
  private readonly artifacts: ArtifactAuthorizationRepository;
  private readonly mailbox: DurableMailbox;
  private readonly operations: RemoteOperationRepository;

  constructor(private readonly database: SqliteDatabase) {
    this.artifacts = new ArtifactAuthorizationRepository(database);
    this.mailbox = new DurableMailbox(database);
    this.operations = new RemoteOperationRepository(database);
  }

  inspect(operation: RemoteOperation): RemoteDispatchReconciliationState {
    const dispatch = this.database
      .prepare(
        `SELECT status,result_json,failure_json,interruption_reason,interruption_resumable
         FROM dispatches WHERE id=?`
      )
      .get(operation.dispatchId);
    const envelope = this.database
      .prepare("SELECT envelope_digest FROM dispatch_execution_envelopes WHERE dispatch_id=?")
      .get(operation.dispatchId);
    const grantCount = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM artifact_grants
         WHERE dispatch_id=? AND permission='input_read'`
      )
      .get(operation.dispatchId);
    const mailboxRow = this.database
      .prepare(
        `SELECT message_id,host_id,command_json,published_at FROM mailbox_messages
         WHERE message_id=?`
      )
      .get(executeMailboxMessageId(operation.dispatchId));
    const mailbox = mailboxRow
      ? (() => {
          const command = mailboxCommandSchema.parse(JSON.parse(String(mailboxRow.command_json)));
          if (
            command.type !== "execute_block" ||
            command.dispatchId !== operation.dispatchId ||
            command.executionAttemptId !== operation.executionAttemptId ||
            mailboxRow.host_id !== operation.attempt.hostId
          ) {
            throw new Error("remote_mailbox_identity_conflict");
          }
          return {
            messageId: String(mailboxRow.message_id),
            publishedAt: mailboxRow.published_at
              ? z.iso.datetime().parse(mailboxRow.published_at)
              : undefined
          };
        })()
      : undefined;
    if (!dispatch) {
      if (envelope || Number(grantCount?.count ?? 0) !== 0 || mailbox) {
        throw new Error("remote_dispatch_persistence_orphaned");
      }
      return {};
    }
    const status = z
      .enum([
        "leased",
        "running",
        "interrupted",
        "cancelling",
        "awaiting_writeback",
        "completed",
        "failed",
        "cancelled"
      ])
      .parse(dispatch.status);
    const terminalAction =
      status === "awaiting_writeback"
        ? (() => {
            if (dispatch.result_json && !dispatch.failure_json) {
              return {
                kind: "complete" as const,
                reportArtifactRef: dispatchResultSchema.parse(
                  JSON.parse(String(dispatch.result_json))
                ).reportArtifactRef
              };
            }
            if (dispatch.failure_json && !dispatch.result_json) {
              return {
                kind: "fail" as const,
                failure: normalizedFailureSchema.parse(JSON.parse(String(dispatch.failure_json)))
              };
            }
            throw new Error("remote_dispatch_writeback_payload_invalid");
          })()
        : undefined;
    return {
      dispatch: {
        status,
        interruption: dispatch.interruption_reason
          ? {
              reason: interruptionReasonSchema.parse(dispatch.interruption_reason),
              resumable: dispatch.interruption_resumable === 1
            }
          : undefined,
        envelopeDigest: envelope
          ? z
              .string()
              .regex(/^envelope:sha256:[a-f0-9]{64}$/)
              .parse(envelope.envelope_digest)
          : undefined,
        inputGrantCount: z
          .number()
          .int()
          .nonnegative()
          .parse(Number(grantCount?.count ?? 0)),
        terminalAction
      },
      mailbox
    };
  }

  prepare(input: {
    operation: RemoteOperation;
    reservation: HostCapacityReservation;
    envelope: ExecutionEnvelope;
    envelopeDigest: string;
    validateBeforeCommit?: () => void;
  }): void {
    inWriteTransaction(this.database, () => {
      input.validateBeforeCommit?.();
      const existing = this.database
        .prepare("SELECT * FROM dispatches WHERE id=?")
        .get(input.operation.dispatchId);
      if (!existing) {
        this.database
          .prepare(
            `INSERT INTO dispatches(
              id,workspace_id,project_id,block_ref,host_id,required_capabilities_json,
              status,lease_id,execution_attempt_id,lease_expires_at,created_at
            ) VALUES (?,?,?,?,?,?,'leased',?,?,?,?)`
          )
          .run(
            input.operation.dispatchId,
            input.operation.workspaceId,
            input.operation.projectId,
            input.operation.blockRef,
            input.reservation.hostId,
            JSON.stringify(input.operation.requiredCapabilities),
            input.reservation.leaseId,
            input.operation.executionAttemptId,
            input.reservation.leaseExpiresAt,
            input.operation.createdAt
          );
        this.database
          .prepare(
            `INSERT INTO dispatch_events(dispatch_id,type,payload_json,occurred_at)
             VALUES (?,'dispatch.leased',?,?)`
          )
          .run(
            input.operation.dispatchId,
            JSON.stringify({
              hostId: input.reservation.hostId,
              leaseId: input.reservation.leaseId,
              leaseExpiresAt: input.reservation.leaseExpiresAt
            }),
            new Date().toISOString()
          );
      } else if (
        existing.project_id !== input.operation.projectId ||
        existing.workspace_id !== input.operation.workspaceId ||
        existing.block_ref !== input.operation.blockRef ||
        existing.host_id !== input.reservation.hostId ||
        existing.lease_id !== input.reservation.leaseId ||
        existing.execution_attempt_id !== input.operation.executionAttemptId
      ) {
        throw new Error("remote_dispatch_identity_conflict");
      }
      this.artifacts.recordExecutionEnvelope(
        input.operation.dispatchId,
        input.envelopeDigest,
        input.envelope
      );
      this.artifacts.grantDispatchInputs(
        {
          workspaceId: input.operation.workspaceId,
          projectId: input.operation.projectId,
          hostId: input.reservation.hostId,
          dispatchId: input.operation.dispatchId,
          leaseId: input.reservation.leaseId,
          executionAttemptId: input.operation.executionAttemptId
        },
        input.envelope
      );
    });
  }

  activate(input: {
    operation: RemoteOperation;
    reservation: HostCapacityReservation;
    command: unknown;
  }): ActivatedMailboxDelivery {
    const command = mailboxCommandSchema.parse(input.command);
    return inWriteTransaction(this.database, () => {
      const operation = this.operations.getRequired(input.operation.id);
      const delivery = this.mailbox.enqueueOnce(
        executeMailboxMessageId(operation.dispatchId),
        input.reservation.hostId,
        command
      );
      if (operation.attempt.status === "reserved") {
        const now = new Date().toISOString();
        const updated = this.database
          .prepare(
            `UPDATE remote_execution_attempts
             SET status='activated',state_version=state_version+1,updated_at=?
             WHERE execution_attempt_id=? AND status='reserved' AND lease_id=?
               AND lease_fencing_token=?`
          )
          .run(
            now,
            operation.executionAttemptId,
            input.reservation.leaseId,
            input.reservation.fencingToken
          );
        if (updated.changes !== 1) throw new Error("remote_attempt_activation_conflict");
        this.database
          .prepare("UPDATE remote_operations SET state='activated',updated_at=? WHERE id=?")
          .run(now, operation.id);
        this.operations.appendEvent(
          operation.id,
          operation.executionAttemptId,
          "remote.attempt.activated",
          now
        );
      } else if (operation.attempt.status !== "activated") {
        throw new Error("remote_attempt_activation_conflict");
      }
      return { operation: this.operations.getRequired(operation.id), message: delivery.message };
    });
  }

  actionSnapshot(operation: RemoteOperation) {
    const dispatch = this.database
      .prepare(
        `SELECT host_id,interruption_resumable,interruption_recovery_json
         FROM dispatches WHERE id=?`
      )
      .get(operation.dispatchId);
    const reservation = operation.attempt.leaseId
      ? this.database
          .prepare(
            `SELECT status,host_id,execution_attempt_id
             FROM host_capacity_reservations WHERE lease_id=?`
          )
          .get(operation.attempt.leaseId)
      : undefined;
    const preparationRecovery =
      !dispatch &&
      (operation.attempt.status === "interrupted" ||
        operation.attempt.status === "action_required") &&
      typeof operation.attempt.hostId === "string" &&
      typeof operation.attempt.leaseId === "string" &&
      reservation?.status !== "active" &&
      reservation?.host_id === operation.attempt.hostId &&
      reservation?.execution_attempt_id === operation.executionAttemptId;
    const hostId =
      dispatch && typeof dispatch.host_id === "string"
        ? dispatch.host_id
        : preparationRecovery
          ? operation.attempt.hostId
          : undefined;
    if (!hostId) throw new Error("remote_dispatch_not_found");
    const host = this.database
      .prepare("SELECT capabilities_json FROM agent_hosts WHERE id=?")
      .get(hostId);
    if (!host) throw new Error("remote_dispatch_host_not_found");
    const recovery = dispatch?.interruption_recovery_json
      ? acpRecoveryIdentitySchema.parse(JSON.parse(String(dispatch.interruption_recovery_json)))
      : undefined;
    return {
      dispatchState: preparationRecovery ? ("preparation" as const) : ("persisted" as const),
      operationId: operation.id,
      dispatchId: operation.dispatchId,
      executionAttemptId: operation.executionAttemptId,
      attemptStatus: operation.attempt.status,
      attemptVersion: operation.attempt.stateVersion,
      leaseId: operation.attempt.leaseId,
      leaseFenced: reservation?.status !== "active",
      interruption: preparationRecovery
        ? { resumable: false as const }
        : dispatch?.interruption_resumable === null ||
            dispatch?.interruption_resumable === undefined
          ? undefined
          : { resumable: dispatch.interruption_resumable === 1, recovery },
      hostCapabilities: capabilitiesSchema.parse(JSON.parse(String(host.capabilities_json)))
    };
  }

  enqueueCancel(input: {
    operation: RemoteOperation;
    action: Extract<RemoteExecutionActionRequest, { kind: "cancel" }>;
  }) {
    const attempt = input.operation.attempt;
    if (!attempt.hostId || !attempt.leaseId) throw new Error("remote_attempt_not_bound");
    const hostId = attempt.hostId;
    const leaseId = attempt.leaseId;
    return inWriteTransaction(this.database, () => {
      const updated = this.database
        .prepare(
          `UPDATE dispatches SET status='cancelling'
           WHERE id=? AND lease_id=? AND execution_attempt_id=? AND status IN ('leased','running')`
        )
        .run(input.operation.dispatchId, leaseId, input.operation.executionAttemptId);
      const current = this.database
        .prepare("SELECT status FROM dispatches WHERE id=?")
        .get(input.operation.dispatchId);
      if (updated.changes !== 1 && current?.status !== "cancelling") {
        throw new Error("remote_cancel_dispatch_conflict");
      }
      return this.mailbox.enqueueOnce(
        input.action.actionId,
        hostId,
        mailboxCommandSchema.parse({
          type: "cancel_execution",
          protocolVersion: agentHostProtocolVersion,
          dispatchId: input.operation.dispatchId,
          leaseId,
          executionAttemptId: input.operation.executionAttemptId,
          reason: input.action.reason
        })
      ).message;
    });
  }

  enqueueResume(input: {
    operation: RemoteOperation;
    action: Extract<RemoteExecutionActionRequest, { kind: "resume_same_session" }>;
  }) {
    const attempt = input.operation.attempt;
    if (!attempt.hostId || attempt.leaseId !== input.action.leaseId) {
      throw new Error("remote_resume_attempt_not_bound");
    }
    const hostId = attempt.hostId;
    return inWriteTransaction(this.database, () => {
      const updated = this.database
        .prepare(
          `UPDATE dispatches SET status='leased',lease_id=?,lease_expires_at=?,
             interruption_reason=NULL,interruption_resumable=NULL,interruption_recovery_json=NULL
           WHERE id=? AND execution_attempt_id=? AND status='interrupted'`
        )
        .run(
          input.action.leaseId,
          input.action.leaseExpiresAt,
          input.operation.dispatchId,
          input.operation.executionAttemptId
        );
      if (updated.changes !== 1) {
        const current = this.database
          .prepare("SELECT status,lease_id FROM dispatches WHERE id=? AND execution_attempt_id=?")
          .get(input.operation.dispatchId, input.operation.executionAttemptId);
        if (current?.status !== "leased" || current.lease_id !== input.action.leaseId) {
          throw new Error("remote_resume_dispatch_conflict");
        }
      }
      return this.mailbox.enqueueOnce(
        input.action.actionId,
        hostId,
        mailboxCommandSchema.parse({
          type: "resume_execution",
          protocolVersion: agentHostProtocolVersion,
          dispatchId: input.operation.dispatchId,
          leaseId: input.action.leaseId,
          executionAttemptId: input.operation.executionAttemptId,
          priorRecovery: input.action.recovery,
          leaseExpiresAt: input.action.leaseExpiresAt
        })
      ).message;
    });
  }

  markActionRequired(operation: RemoteOperation): void {
    const row = this.database
      .prepare("SELECT status FROM dispatches WHERE id=?")
      .get(operation.dispatchId);
    if (row?.status !== "interrupted") throw new Error("remote_block_dispatch_not_interrupted");
  }

  prepareManualFailure(input: { operation: RemoteOperation; failure: unknown }): void {
    const failure = normalizedFailureSchema.parse(input.failure);
    const updated = this.database
      .prepare(
        `UPDATE dispatches SET status='awaiting_writeback',failure_json=?,result_json=NULL
         WHERE id=? AND status='interrupted' AND execution_attempt_id=?`
      )
      .run(JSON.stringify(failure), input.operation.dispatchId, input.operation.executionAttemptId);
    if (updated.changes !== 1) throw new Error("remote_manual_failure_dispatch_conflict");
  }

  markMailboxPublished(messageId: string): void {
    this.mailbox.markPublished(messageId);
  }

  cancelInterruptedAfterRuntimeReset(operation: RemoteOperation): void {
    inWriteTransaction(this.database, () => {
      const current = this.operations.getRequired(operation.id);
      if (
        current.state !== "interrupted" ||
        current.attempt.status !== "interrupted" ||
        current.executionAttemptId !== operation.executionAttemptId ||
        current.attempt.leaseId === undefined
      ) {
        throw new Error("remote_runtime_reset_dispatch_conflict");
      }
      const reservation = this.database
        .prepare(
          "SELECT status FROM host_capacity_reservations WHERE lease_id=? AND execution_attempt_id=?"
        )
        .get(current.attempt.leaseId, current.executionAttemptId);
      if (!reservation || reservation.status === "active") {
        throw new Error("remote_runtime_reset_dispatch_not_fenced");
      }
      const activeAction = this.database
        .prepare(
          `SELECT 1 FROM remote_execution_actions
           WHERE operation_id=? AND execution_attempt_id=?
             AND state IN ('recorded','delivered','acknowledged') LIMIT 1`
        )
        .get(current.id, current.executionAttemptId);
      if (activeAction) throw new Error("remote_runtime_reset_action_active");

      const dispatch = this.database
        .prepare("SELECT status,lease_id,execution_attempt_id FROM dispatches WHERE id=?")
        .get(current.dispatchId);
      if (
        !dispatch ||
        dispatch.lease_id !== current.attempt.leaseId ||
        dispatch.execution_attempt_id !== current.executionAttemptId
      ) {
        throw new Error("remote_runtime_reset_dispatch_conflict");
      }
      if (dispatch.status === "cancelled") return;
      if (dispatch.status !== "interrupted") {
        throw new Error("remote_runtime_reset_dispatch_not_interrupted");
      }

      const failure = normalizedFailureSchema.parse({
        code: "execution_cancelled",
        message: "Runtime reset abandoned the interrupted remote execution.",
        retryable: false
      });
      const now = new Date().toISOString();
      const updated = this.database
        .prepare(
          `UPDATE dispatches
           SET status='cancelled',failure_json=?,result_json=NULL,finished_at=?
           WHERE id=? AND status='interrupted' AND lease_id=? AND execution_attempt_id=?`
        )
        .run(
          JSON.stringify(failure),
          now,
          current.dispatchId,
          current.attempt.leaseId,
          current.executionAttemptId
        );
      if (updated.changes !== 1) throw new Error("remote_runtime_reset_dispatch_conflict");
      this.database
        .prepare(
          `INSERT INTO dispatch_events(dispatch_id,type,payload_json,occurred_at)
           VALUES (?,'dispatch.cancelled',?,?)`
        )
        .run(current.dispatchId, JSON.stringify({ reason: "runtime_binding_reset" }), now);
    });
  }

  finishTerminal(input: {
    operation: RemoteOperation;
    status: "completed" | "failed" | "cancelled";
  }): void {
    inWriteTransaction(this.database, () => {
      const row = this.database
        .prepare("SELECT status,lease_id FROM dispatches WHERE id=?")
        .get(input.operation.dispatchId);
      if (!row) throw new Error("remote_dispatch_not_found");
      if (row.status === input.status) return;
      if (row.status !== "awaiting_writeback" || row.lease_id !== input.operation.attempt.leaseId) {
        throw new Error("remote_dispatch_not_awaiting_writeback");
      }
      const now = new Date().toISOString();
      const updated = this.database
        .prepare(
          `UPDATE dispatches SET status=?,finished_at=?
           WHERE id=? AND status='awaiting_writeback' AND lease_id=?`
        )
        .run(input.status, now, input.operation.dispatchId, input.operation.attempt.leaseId);
      if (updated.changes !== 1) throw new Error("remote_dispatch_terminal_conflict");
      this.database
        .prepare(
          `INSERT INTO dispatch_events(dispatch_id,type,payload_json,occurred_at)
           VALUES (?,?,?,?)`
        )
        .run(input.operation.dispatchId, `dispatch.${input.status}`, "{}", now);
    });
  }
}
