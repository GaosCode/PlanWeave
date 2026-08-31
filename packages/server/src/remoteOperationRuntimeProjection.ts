import {
  remoteRuntimeBindingProjectionSchema,
  type RemoteRuntimeBindingProjection
} from "@planweave-ai/collaboration-protocol/remote-run";
import type { RemoteOperation } from "./remoteOperations.js";

type RemoteOperationRuntimeProjectionSource = {
  ref: string;
  status: string;
  ownership?: {
    operationId: string;
    phase?: "preparing" | "active";
    dispatchId?: string;
    executionAttemptId?: string;
  };
  interruption?: RemoteRuntimeBindingProjection["interruption"];
  terminalReceipt?: {
    operationId?: string;
    outcome?: "completed" | "failed" | "blocked" | "cancelled";
    summary?: string;
  };
  blockedReason?: string | null;
  divergenceReason?: string | null;
};

export function projectRemoteOperationRuntime(
  runtime: RemoteOperationRuntimeProjectionSource
): RemoteRuntimeBindingProjection {
  return remoteRuntimeBindingProjectionSchema.parse({
    ref: runtime.ref,
    status: runtime.status,
    ...(runtime.ownership
      ? {
          ownership: {
            operationId: runtime.ownership.operationId,
            ...(runtime.ownership.phase !== undefined ? { phase: runtime.ownership.phase } : {}),
            ...(runtime.ownership.phase === "active"
              ? {
                  dispatchId: runtime.ownership.dispatchId,
                  executionAttemptId: runtime.ownership.executionAttemptId
                }
              : {})
          }
        }
      : {}),
    ...(runtime.interruption ? { interruption: runtime.interruption } : {}),
    ...(runtime.terminalReceipt
      ? {
          terminalReceipt: {
            ...(runtime.terminalReceipt.operationId !== undefined
              ? { operationId: runtime.terminalReceipt.operationId }
              : {}),
            ...(runtime.terminalReceipt.outcome !== undefined
              ? { outcome: runtime.terminalReceipt.outcome }
              : {}),
            ...(runtime.terminalReceipt.summary !== undefined
              ? { summary: runtime.terminalReceipt.summary }
              : {})
          }
        }
      : {}),
    ...(runtime.blockedReason !== undefined ? { blockedReason: runtime.blockedReason } : {}),
    ...(runtime.divergenceReason !== undefined
      ? { divergenceReason: runtime.divergenceReason }
      : {})
  });
}

export function isTerminalRemoteOperation(operation: RemoteOperation): boolean {
  return (
    operation.state === "completed" ||
    operation.state === "failed" ||
    operation.state === "cancelled"
  );
}

export function projectTerminalRemoteOperationRuntime(
  operation: RemoteOperation
): RemoteRuntimeBindingProjection {
  if (!isTerminalRemoteOperation(operation)) {
    throw new Error("terminal_runtime_projection_requires_terminal_operation");
  }
  return projectRemoteOperationRuntime({
    ref: operation.blockRef,
    status:
      operation.state === "completed"
        ? "completed"
        : operation.state === "failed"
          ? "blocked"
          : "cancelled",
    terminalReceipt: {
      operationId: operation.id,
      outcome:
        operation.state === "completed"
          ? "completed"
          : operation.state === "failed"
            ? "failed"
            : "cancelled"
    }
  });
}
