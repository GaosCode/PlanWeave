import { createHash } from "node:crypto";
import {
  canonicalizeJson,
  type HistoricalInteractionRequest
} from "@planweave-ai/agent-host-protocol";
import { DurableMailbox } from "./mailbox.js";
import { SqliteRemoteDispatchPersistence } from "./remoteCoordinatorPersistence.js";
import { RemoteExecutionActionRepository } from "./remoteExecutionActions.js";
import {
  decideRemoteExecutionAction,
  remoteExecutionActionRequestSchema
} from "./remoteExecutionLifecycle.js";
import { RemoteOperationRepository } from "./remoteOperations.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

/** Persist one cancellation per fenced execution, independently of old event receipts. */
export function enqueueHistoricalPermissionCancellation(
  database: SqliteDatabase,
  input: { operationId: string; hostId: string; request: HistoricalInteractionRequest },
  clock: () => Date
) {
  return inWriteTransaction(database, () => {
    const operations = new RemoteOperationRepository(database, clock);
    const operation = operations.getRequired(input.operationId);
    const identity = input.request;
    if (
      operation.dispatchId !== identity.dispatchId ||
      operation.executionAttemptId !== identity.executionAttemptId ||
      operation.attempt.leaseId !== identity.leaseId ||
      operation.attempt.hostId !== input.hostId
    )
      return undefined;
    const execution = {
      hostId: input.hostId,
      dispatchId: identity.dispatchId,
      leaseId: identity.leaseId,
      executionAttemptId: identity.executionAttemptId
    };
    const actionId = `permission-history-${createHash("sha256").update(canonicalizeJson(execution)).digest("hex")}`;
    const actions = new RemoteExecutionActionRepository(database, clock);
    const existing = actions.get(actionId);
    if (existing) {
      if (
        existing.request.kind !== "cancel" ||
        existing.request.operationId !== operation.id ||
        existing.request.dispatchId !== identity.dispatchId ||
        existing.request.executionAttemptId !== identity.executionAttemptId ||
        existing.request.leaseId !== identity.leaseId
      )
        throw new Error("historical_permission_cancellation_conflict");
      if (existing.state === "settled") return undefined;
      if (existing.state === "rejected")
        throw new Error("historical_permission_cancellation_rejected");
      const message = new DurableMailbox(database).get(actionId);
      if (!message || existing.state === "recorded")
        throw new Error("historical_permission_cancellation_incomplete");
      if (
        message.hostId !== input.hostId ||
        message.command.type !== "cancel_execution" ||
        message.command.dispatchId !== identity.dispatchId ||
        message.command.executionAttemptId !== identity.executionAttemptId ||
        message.command.leaseId !== identity.leaseId ||
        message.command.reason !== existing.request.reason
      )
        throw new Error("historical_permission_cancellation_conflict");
      return message;
    }
    const action = actions.record(
      remoteExecutionActionRequestSchema.parse({
        actionId,
        operationId: operation.id,
        dispatchId: identity.dispatchId,
        executionAttemptId: identity.executionAttemptId,
        expectedAttemptVersion: operation.attempt.stateVersion,
        kind: "cancel",
        leaseId: identity.leaseId,
        reason: "Historical permission request cannot authorize execution."
      })
    ).request;
    if (action.kind !== "cancel") throw new Error("remote_action_decision_mismatch");
    const persistence = new SqliteRemoteDispatchPersistence(database);
    const decision = decideRemoteExecutionAction(action, persistence.actionSnapshot(operation));
    if (decision.transition !== "cancel" || !decision.sendsCommand)
      throw new Error("remote_interaction_attempt_not_active");
    operations.recordDiagnosticStage(operation.id, "cancelling");
    const message = persistence.enqueueCancel({ operation, action });
    actions.transition(actionId, "delivered");
    return message;
  });
}
