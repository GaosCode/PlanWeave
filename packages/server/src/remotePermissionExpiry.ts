import { createHash } from "node:crypto";
import { canonicalizeJson } from "@planweave-ai/agent-host-protocol";
import { SqliteRemoteDispatchPersistence } from "./remoteCoordinatorPersistence.js";
import { RemoteExecutionActionRepository } from "./remoteExecutionActions.js";
import {
  decideRemoteExecutionAction,
  remoteExecutionActionRequestSchema
} from "./remoteExecutionLifecycle.js";
import type { RemoteInteractionRecord } from "./remoteInteractions.js";
import { RemoteOperationRepository } from "./remoteOperations.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

/** Legacy ACP cancellation must stop the execution, never select a rejection option. */
export function enqueueExpiredLegacyPermissionCancellation(
  database: SqliteDatabase,
  interaction: RemoteInteractionRecord,
  clock: () => Date
) {
  return inWriteTransaction(database, () => {
    const operations = new RemoteOperationRepository(database, clock);
    const operation = operations.getRequired(interaction.operationId);
    const identity = interaction.request;
    if (
      operation.dispatchId !== identity.dispatchId ||
      operation.executionAttemptId !== identity.executionAttemptId ||
      operation.attempt.leaseId !== identity.leaseId ||
      operation.attempt.hostId !== interaction.hostId
    )
      throw new Error("remote_interaction_attempt_not_active");
    const actions = new RemoteExecutionActionRepository(database, clock);
    const actionId = `permission-expiry-${createHash("sha256").update(canonicalizeJson(identity)).digest("hex")}`;
    const action = actions.record(
      remoteExecutionActionRequestSchema.parse({
        actionId,
        operationId: operation.id,
        dispatchId: identity.dispatchId,
        executionAttemptId: identity.executionAttemptId,
        expectedAttemptVersion: operation.attempt.stateVersion,
        kind: "cancel",
        leaseId: identity.leaseId,
        reason: "Legacy permission request expired; stopping execution."
      })
    ).request;
    if (action.kind !== "cancel") throw new Error("remote_action_decision_mismatch");
    const persistence = new SqliteRemoteDispatchPersistence(database);
    const decision = decideRemoteExecutionAction(action, persistence.actionSnapshot(operation));
    if (decision.transition !== "cancel" || !decision.sendsCommand) {
      throw new Error("remote_interaction_attempt_not_active");
    }
    operations.recordDiagnosticStage(operation.id, "cancelling");
    const message = persistence.enqueueCancel({ operation, action });
    actions.transition(actionId, "delivered");
    return message;
  });
}
