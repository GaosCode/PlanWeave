import { createHash } from "node:crypto";
import {
  remoteOperationDiagnosticsSchema,
  type RemoteOperationDiagnosticStage,
  type RemoteOperationDiagnostics,
  type RemoteRuntimeBindingProjection
} from "@planweave-ai/collaboration-protocol/remote-run";
import type { NormalizedFailure } from "@planweave-ai/agent-host-protocol";
import type { RemoteOperation } from "./remoteOperations.js";

type RuntimeProjection = Pick<RemoteRuntimeBindingProjection, "ownership">;

function diagnosticStage(
  operation: RemoteOperation,
  dispatchStatus: string | undefined
): RemoteOperationDiagnosticStage {
  if (["completed", "failed", "cancelled"].includes(operation.state)) return "terminal";
  if (dispatchStatus === "cancelling") return "cancelling";
  if (operation.state === "awaiting_writeback") return "writing_back";
  if (["running", "interrupted", "action_required"].includes(operation.state)) return "running";
  if (operation.state === "activated") return "dispatching";
  if (operation.state === "reserved") return "attaching_runtime";
  if (operation.state === "claimed") return "materializing";
  return "preparing_runtime";
}

function redactedHostGeneration(operation: RemoteOperation): string | undefined {
  const hostGeneration = operation.endpointSelection?.hostId ?? operation.attempt.hostId;
  if (!hostGeneration) return undefined;
  const digest = createHash("sha256").update(hostGeneration).digest("hex").slice(0, 16);
  return `hostgen:sha256:${digest}`;
}

export function buildRemoteOperationDiagnostics(input: {
  operation: RemoteOperation;
  revision: number;
  runtime: RuntimeProjection;
  dispatchStatus?: string;
  failure?: NormalizedFailure;
}): RemoteOperationDiagnostics {
  const { operation } = input;
  const terminal = ["completed", "failed", "cancelled"].includes(operation.state);
  const ownership = input.runtime.ownership;
  const authority = operation.endpointSelection?.authority;
  const executionTargetRevision =
    operation.hostSelection?.authorityRevisions?.executionTargetRevision;
  return remoteOperationDiagnosticsSchema.parse({
    stage: diagnosticStage(operation, input.dispatchStatus),
    revision: input.revision,
    attemptId: operation.executionAttemptId,
    locator: {
      workspaceId: operation.workspaceId,
      projectId: operation.projectId,
      canvasId: operation.canvasId
    },
    ...(operation.endpointSelection ? { endpointId: operation.endpointSelection.endpointId } : {}),
    ...(redactedHostGeneration(operation)
      ? { hostGeneration: redactedHostGeneration(operation) }
      : {}),
    ...(authority
      ? {
          authorityRevisions: {
            responsibility: authority.responsibilityRevision,
            reviewer: authority.reviewerRevision,
            ...(executionTargetRevision === undefined
              ? {}
              : { executionTarget: executionTargetRevision })
          }
        }
      : {}),
    content: {
      revision: operation.ownershipGeneration,
      fingerprint: operation.sourceFingerprint
    },
    ...(operation.state === "preparing" || operation.state === "claimed"
      ? { reservation: { status: "pending" } }
      : operation.attempt.leaseId
        ? { reservation: { status: terminal ? "released" : "active" } }
        : {}),
    ...(ownership?.operationId === operation.id
      ? { attachment: { status: ownership.phase === "active" ? "active" : "preparing" } }
      : {}),
    ...(operation.attempt.leaseId
      ? {
          lease: {
            status: terminal ? "released" : "active",
            ...(operation.attempt.leaseExpiresAt
              ? { expiresAt: operation.attempt.leaseExpiresAt }
              : {})
          }
        }
      : {}),
    startedAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    ...(operation.terminalAt ? { terminalAt: operation.terminalAt } : {}),
    ...(operation.attempt.leaseExpiresAt ? { timeoutAt: operation.attempt.leaseExpiresAt } : {}),
    ...(input.failure
      ? { error: { code: input.failure.code, retryable: input.failure.retryable } }
      : {})
  });
}
