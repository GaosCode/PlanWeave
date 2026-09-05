import {
  remoteBlockExecutionReadModelSchema,
  type RemoteBlockExecutionReadModel
} from "../schema/remoteExecutionReadModel.js";
import type { BlockState } from "../types.js";

/**
 * Canonical public projection of durable remote execution state.
 * Infrastructure addresses, credentials, leases, paths, and persistence details never enter it.
 */
export function projectRemoteBlockExecution(
  blockState: BlockState
): RemoteBlockExecutionReadModel | null {
  const ownership = blockState.remoteOwnership;
  if (ownership) {
    const interrupted = blockState.remoteInterruption !== undefined;
    const sourceDrift = blockState.status === "diverged" && !interrupted;
    return remoteBlockExecutionReadModelSchema.parse({
      identity: { operationId: ownership.operationId },
      controlPlane: ownership.controlPlane ?? "collaboration",
      phase: ownership.phase,
      status: interrupted ? "interrupted" : sourceDrift ? "source_drift" : "owned",
      actionRequired: interrupted || sourceDrift,
      source: {
        revision: ownership.sourceRevision,
        graphFingerprint: ownership.graphFingerprint
      },
      dispatchAttempt:
        ownership.phase === "active"
          ? {
              dispatchId: ownership.dispatchId,
              executionAttemptId: ownership.executionAttemptId
            }
          : null
    });
  }

  const receipt = blockState.remoteOperationReceipt;
  if (!receipt) {
    return null;
  }
  return remoteBlockExecutionReadModelSchema.parse({
    identity: { operationId: receipt.operationId },
    controlPlane: receipt.controlPlane ?? "collaboration",
    phase: "terminal",
    status:
      receipt.outcome === "failed" && receipt.failure.code === "execution_cancelled"
        ? "stopped"
        : receipt.outcome,
    actionRequired: receipt.outcome === "failed" && receipt.failure.code !== "execution_cancelled",
    source: {
      revision: receipt.sourceRevision,
      graphFingerprint: receipt.graphFingerprint
    },
    dispatchAttempt: {
      dispatchId: receipt.dispatchId,
      executionAttemptId: receipt.executionAttemptId
    }
  });
}
