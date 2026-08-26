import { buildResetCanvasRuntimeStatusProjection } from "@planweave-ai/runtime";
import {
  canvasRuntimeResetRejectedSchema,
  canvasRuntimeResetRequestSchema,
  type CanvasRuntimeResetAccepted,
  type CanvasRuntimeResetFailureCode,
  type CanvasRuntimeResetOutcome
} from "@planweave-ai/collaboration-protocol/canvas/runtime-control";
import {
  canvasScopeRefSchema,
  type CanvasScopeRef
} from "@planweave-ai/collaboration-protocol/core/primitives";
import type { CollaborationAuthContext } from "../identity/auth.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import { readStableCanvasContentFingerprint } from "./contentFingerprint.js";
import type { ContentAuthorityStore } from "./contentAuthorityStore.js";
import {
  CanvasRuntimeResetConflictError,
  CanvasRuntimeUnavailableError,
  type CanvasExecutionRuntimeLeasePort,
  type RuntimeCanvasScope
} from "./executionRuntimePort.js";
import { authorizeCanvasCommand } from "./policy.js";
import type {
  CanvasRuntimeResetReceipt,
  CanvasRuntimeResetReceiptRepository
} from "./runtimeCommandReceipts.js";
import { CanvasRuntimeRpcError } from "./runtimeRpcBroker.js";
import type { CanvasRuntimeStatusRepository } from "./runtimeStatusRepository.js";

export class CanvasRuntimeResetError extends Error {
  constructor(
    readonly code:
      | "forbidden"
      | "host_offline"
      | "active_lease"
      | "source_drift"
      | "persist_failed"
      | "reconcile_required"
      | "unavailable"
      | "conflict"
  ) {
    super(`canvas_runtime_reset_${code}`);
    this.name = "CanvasRuntimeResetError";
  }
}

class CanvasRuntimeContentSupersededError extends Error {
  constructor() {
    super("canvas_runtime_reset_content_superseded");
    this.name = "CanvasRuntimeContentSupersededError";
  }
}

export type CanvasRuntimeCommandCoordinatorOptions = {
  access: ProjectAccessRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  contentVersions: ContentAuthorityStore;
  runtimeStatuses: CanvasRuntimeStatusRepository;
  receipts: CanvasRuntimeResetReceiptRepository;
  executionLeases: CanvasExecutionRuntimeLeasePort;
  hasConflictingLease(scope: RuntimeCanvasScope): boolean;
  commitTransaction<T>(action: () => T): T;
};

function authorizationError(code: string): CanvasRuntimeResetError {
  if (code === "forbidden" || code === "unauthorized" || code === "cross_scope") {
    return new CanvasRuntimeResetError("forbidden");
  }
  return new CanvasRuntimeResetError("unavailable");
}

function hostFailure(error: unknown): CanvasRuntimeResetError {
  if (error instanceof CanvasRuntimeResetError) return error;
  if (error instanceof CanvasRuntimeResetConflictError) {
    return new CanvasRuntimeResetError(error.code);
  }
  if (error instanceof CanvasRuntimeUnavailableError) {
    return new CanvasRuntimeResetError(
      error.reason === "host_offline" ? "host_offline" : "unavailable"
    );
  }
  if (error instanceof CanvasRuntimeRpcError) {
    if (error.reconcileRequired) {
      return new CanvasRuntimeResetError("reconcile_required");
    }
    if (
      error.code === "canvas_runtime_host_offline" ||
      error.code === "canvas_runtime_host_disconnected"
    ) {
      return new CanvasRuntimeResetError("host_offline");
    }
    if (error.code === "content_out_of_sync") {
      return new CanvasRuntimeResetError("source_drift");
    }
    if (error.code === "active_lease") {
      return new CanvasRuntimeResetError("active_lease");
    }
  }
  if (error instanceof Error) {
    if (error.message === "content_out_of_sync") return new CanvasRuntimeResetError("source_drift");
    if (error.message === "active_lease" || /active work exists/i.test(error.message)) {
      return new CanvasRuntimeResetError("active_lease");
    }
  }
  return new CanvasRuntimeResetError("unavailable");
}

function rejected(
  operationId: string,
  code: CanvasRuntimeResetFailureCode
): CanvasRuntimeResetOutcome {
  return canvasRuntimeResetRejectedSchema.parse({
    type: "canvas.runtime.reset.rejected",
    operationId,
    code
  });
}

/** Authorizes, fences, and persists one shared Runtime reset without transport details. */
export class CanvasRuntimeCommandCoordinator {
  private readonly inFlight = new Map<string, Promise<CanvasRuntimeResetOutcome>>();

  constructor(private readonly options: CanvasRuntimeCommandCoordinatorOptions) {}

  async reset(
    actor: CollaborationAuthContext,
    input: { projectId: string; canvasId: string; body: unknown }
  ): Promise<CanvasRuntimeResetOutcome> {
    const request = canvasRuntimeResetRequestSchema.parse(input.body);
    const authorization = authorizeCanvasCommand({
      actor,
      projectId: input.projectId,
      canvasId: input.canvasId,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity
    });
    if (!authorization.ok) {
      return rejected(request.operationId, authorizationError(authorization.code).code);
    }
    const scope = canvasScopeRefSchema.parse(authorization.scope);
    let receipt: CanvasRuntimeResetReceipt;
    try {
      receipt = this.options.receipts.begin(scope, request);
    } catch (error) {
      if (error instanceof Error && error.message === "canvas_runtime_reset_conflict") {
        return rejected(request.operationId, "conflict");
      }
      return rejected(request.operationId, "persist_failed");
    }
    if (receipt.kind === "completed") return receipt.outcome;
    if (receipt.kind === "busy") return rejected(request.operationId, "active_lease");

    const key = `${scope.workspaceId}\u0000${scope.projectId}\u0000${scope.canvasId}\u0000${request.operationId}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const operation = this.runReset(scope, request, receipt);
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }
  }

  private async runReset(
    scope: CanvasScopeRef,
    request: ReturnType<typeof canvasRuntimeResetRequestSchema.parse>,
    receipt: Exclude<CanvasRuntimeResetReceipt, { kind: "completed" | "busy" }>
  ): Promise<CanvasRuntimeResetOutcome> {
    const rejectAndComplete = (code: CanvasRuntimeResetFailureCode) => {
      try {
        return this.options.receipts.complete(
          scope,
          request.operationId,
          rejected(request.operationId, code)
        );
      } catch {
        return rejected(request.operationId, "persist_failed");
      }
    };

    let hostResult = receipt.kind === "recover" ? receipt.hostResult : undefined;
    const command = {
      operationId: request.operationId,
      expectedSourceRevision: request.expectedSourceRevision,
      expectedGraphFingerprint: request.expectedGraphFingerprint,
      ...(request.reason ? { reason: request.reason } : {})
    };
    if (receipt.kind === "accepted") {
      const head = this.options.contentVersions.head(scope);
      const contentFingerprint = readStableCanvasContentFingerprint(
        this.options.contentVersions,
        scope
      );
      if (
        !head ||
        head.revision !== request.expectedContentRevision ||
        !contentFingerprint ||
        contentFingerprint !== request.expectedGraphFingerprint
      ) {
        return rejectAndComplete("source_drift");
      }
      if (this.options.hasConflictingLease(scope)) {
        return rejectAndComplete("active_lease");
      }
      let lease: Awaited<ReturnType<CanvasExecutionRuntimeLeasePort["acquire"]>> | undefined;
      try {
        lease = await this.options.executionLeases.acquire(scope);
        if (!lease.reset) throw new CanvasRuntimeUnavailableError();
        hostResult = await lease.reset(command);
      } catch (error) {
        if (
          error instanceof CanvasRuntimeUnavailableError &&
          error.reason === "runtime_not_attached"
        ) {
          const authoritative = this.options.contentVersions.readVersion(scope, head.content);
          hostResult = {
            operationId: request.operationId,
            sourceRevision: request.expectedSourceRevision,
            graphFingerprint: request.expectedGraphFingerprint,
            status: buildResetCanvasRuntimeStatusProjection({
              content: authoritative.content,
              scope,
              packageFingerprint: request.expectedGraphFingerprint
            })
          };
        } else {
          const failure = hostFailure(error);
          if (failure.code !== "reconcile_required") {
            return rejectAndComplete(failure.code);
          }
          this.markUnknown(scope, request.operationId);
        }
      } finally {
        if (lease) {
          try {
            await lease.release();
          } catch {
            // The reset result, not lease cleanup, determines Runtime authority.
          }
        }
      }
    }
    if (!hostResult) {
      const reconciliation = this.options.executionLeases.reconcileReset;
      if (!reconciliation) {
        this.markUnknown(scope, request.operationId);
        return rejected(request.operationId, "reconcile_required");
      }
      try {
        const reconciled = await reconciliation.call(this.options.executionLeases, scope, command);
        if (reconciled.kind === "succeeded") {
          hostResult = reconciled.result;
        } else if (reconciled.kind === "failed" && !reconciled.error.reconcileRequired) {
          return rejectAndComplete(
            hostFailure(
              new CanvasRuntimeRpcError(reconciled.error.code, reconciled.error.retryable, false)
            ).code
          );
        } else {
          this.markUnknown(scope, request.operationId);
          return rejected(request.operationId, "reconcile_required");
        }
      } catch {
        this.markUnknown(scope, request.operationId);
        return rejected(request.operationId, "reconcile_required");
      }
    }
    try {
      hostResult = this.options.receipts.recordHostResult(scope, request.operationId, hostResult);
    } catch {
      this.markUnknown(scope, request.operationId);
      return rejected(request.operationId, "reconcile_required");
    }
    if (
      hostResult.operationId !== request.operationId ||
      hostResult.sourceRevision !== request.expectedSourceRevision ||
      hostResult.graphFingerprint !== request.expectedGraphFingerprint ||
      hostResult.status.packageFingerprint !== request.expectedGraphFingerprint ||
      hostResult.status.scope.workspaceId !== scope.workspaceId ||
      hostResult.status.scope.projectId !== scope.projectId ||
      hostResult.status.scope.canvasId !== scope.canvasId
    ) {
      this.markUnknown(scope, request.operationId);
      return rejected(request.operationId, "reconcile_required");
    }
    try {
      return this.options.commitTransaction(() => {
        const head = this.options.contentVersions.head(scope);
        const fingerprint = readStableCanvasContentFingerprint(this.options.contentVersions, scope);
        if (
          !head ||
          head.revision !== request.expectedContentRevision ||
          fingerprint !== request.expectedGraphFingerprint
        ) {
          throw new CanvasRuntimeContentSupersededError();
        }
        const snapshot = this.options.runtimeStatuses.replaceFromExecution(hostResult.status);
        const outcome: CanvasRuntimeResetAccepted = {
          type: "canvas.runtime.reset.accepted",
          operationId: request.operationId,
          runtimeRevision: snapshot.runtimeRevision,
          sourceRevision: hostResult.sourceRevision,
          graphFingerprint: hostResult.graphFingerprint,
          status: snapshot.status
        };
        const completed = this.options.receipts.complete(scope, request.operationId, outcome);
        if (completed.type !== "canvas.runtime.reset.accepted") {
          throw new Error("canvas_runtime_reset_receipt_outcome_mismatch");
        }
        return completed;
      });
    } catch (error) {
      if (error instanceof CanvasRuntimeContentSupersededError) {
        return rejectAndComplete("source_drift");
      }
      try {
        const latest = this.options.receipts.begin(scope, request);
        if (latest.kind === "completed") return latest.outcome;
      } catch {
        // The durable Host result remains queryable under the operation ID.
      }
      this.markUnknown(scope, request.operationId);
      return rejected(request.operationId, "reconcile_required");
    }
  }

  private markUnknown(scope: CanvasScopeRef, operationId: string): void {
    try {
      this.options.receipts.markUnknown(scope, operationId);
    } catch {
      // A completed receipt or a failed persistence transaction is resolved on the next retry.
    }
  }
}
