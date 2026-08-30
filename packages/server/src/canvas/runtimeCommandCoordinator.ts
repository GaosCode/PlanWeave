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
import { readStableCanvasRuntimeEvidence } from "./contentFingerprint.js";
import type { ContentAuthorityStore } from "./contentAuthorityStore.js";
import {
  type CanvasRuntimeAuthorityWinnerLeasePort,
  type CanvasRuntimeResetCommand,
  type RuntimeCanvasScope
} from "./executionRuntimePort.js";
import type { RuntimeReadAuthority } from "./runtimeAuthorityCandidates.js";
import { authorizeCanvasCommand } from "./policy.js";
import type {
  CanvasRuntimeResetReceipt,
  CanvasRuntimeResetReceiptRepository
} from "./runtimeCommandReceipts.js";
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
  executionLeases: CanvasRuntimeAuthorityWinnerLeasePort;
  hasConflictingLease(scope: RuntimeCanvasScope): boolean;
  commitTransaction<T>(action: () => T): T;
  cleanupDiagnosticSink?: CanvasRuntimeCleanupDiagnosticSink;
};

export type CanvasRuntimeCleanupDiagnostic = {
  operationId: string;
  scope: CanvasScopeRef;
  stage: "acquire" | "reset" | "release";
  code:
    | "runtime_cleanup_acquire_failed"
    | "runtime_cleanup_reset_failed"
    | "runtime_cleanup_release_failed";
};

export type CanvasRuntimeCleanupDiagnosticSink = (
  diagnostic: CanvasRuntimeCleanupDiagnostic
) => void;

export const logCanvasRuntimeCleanupDiagnostic: CanvasRuntimeCleanupDiagnosticSink = (
  diagnostic
) => {
  console.warn(
    JSON.stringify({
      scope: "canvas-runtime",
      event: "runtime_reset_cleanup_failed",
      operationId: diagnostic.operationId,
      canvasScope: diagnostic.scope,
      stage: diagnostic.stage,
      code: diagnostic.code
    })
  );
};

function authorizationError(code: string): CanvasRuntimeResetError {
  if (code === "forbidden" || code === "unauthorized" || code === "cross_scope") {
    return new CanvasRuntimeResetError("forbidden");
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
    // A completed durable receipt is authoritative; cache cleanup is never replayed on duplicate.
    if (receipt.kind === "completed") return receipt.outcome;
    if (receipt.kind === "busy") return rejected(request.operationId, "active_lease");

    const key = `${scope.workspaceId}\u0000${scope.projectId}\u0000${scope.canvasId}\u0000${request.operationId}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const operation = this.runReset(scope, request);
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }
  }

  private async runReset(
    scope: CanvasScopeRef,
    request: ReturnType<typeof canvasRuntimeResetRequestSchema.parse>
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

    const command = {
      operationId: request.operationId,
      expectedSourceRevision: request.expectedSourceRevision,
      expectedGraphFingerprint: request.expectedGraphFingerprint,
      ...(request.reason ? { reason: request.reason } : {})
    };
    let committed: { outcome: CanvasRuntimeResetAccepted; authority: RuntimeReadAuthority };
    try {
      committed = this.options.commitTransaction(() => {
        const evidence = readStableCanvasRuntimeEvidence(this.options.contentVersions, scope);
        if (
          !evidence ||
          evidence.target.revision !== request.expectedContentRevision ||
          evidence.sourceRevision !== request.expectedSourceRevision ||
          evidence.target.graphFingerprint !== request.expectedGraphFingerprint
        ) {
          throw new CanvasRuntimeContentSupersededError();
        }
        if (this.options.hasConflictingLease(scope)) {
          throw new CanvasRuntimeResetError("active_lease");
        }
        const authoritative = this.options.contentVersions.readVersion(
          scope,
          evidence.target.content
        );
        const status = buildResetCanvasRuntimeStatusProjection({
          content: authoritative.content,
          scope,
          packageFingerprint: evidence.target.graphFingerprint
        });
        const snapshot = this.options.runtimeStatuses.replaceFromExecution(status);
        const accepted: CanvasRuntimeResetAccepted = {
          type: "canvas.runtime.reset.accepted",
          operationId: request.operationId,
          runtimeRevision: snapshot.runtimeRevision,
          sourceRevision: evidence.sourceRevision,
          graphFingerprint: evidence.target.graphFingerprint,
          status: snapshot.status
        };
        const completed = this.options.receipts.complete(scope, request.operationId, accepted);
        if (completed.type !== "canvas.runtime.reset.accepted") {
          throw new Error("canvas_runtime_reset_receipt_outcome_mismatch");
        }
        return { outcome: completed, authority: evidence };
      });
    } catch (error) {
      if (error instanceof CanvasRuntimeContentSupersededError) {
        return rejectAndComplete("source_drift");
      }
      if (error instanceof CanvasRuntimeResetError && error.code === "active_lease") {
        return rejectAndComplete("active_lease");
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
    this.startHostRuntimeCleanup(scope, command, committed.authority);
    return committed.outcome;
  }

  private startHostRuntimeCleanup(
    scope: CanvasScopeRef,
    command: CanvasRuntimeResetCommand,
    authority: RuntimeReadAuthority
  ): void {
    void this.clearHostRuntimeBestEffort(scope, command, authority).catch(() => {
      this.reportCleanupFailure({
        operationId: command.operationId,
        scope,
        stage: "reset",
        code: "runtime_cleanup_reset_failed"
      });
    });
  }

  private async clearHostRuntimeBestEffort(
    scope: CanvasScopeRef,
    command: CanvasRuntimeResetCommand,
    authority: RuntimeReadAuthority
  ): Promise<void> {
    let lease:
      | Awaited<ReturnType<CanvasRuntimeAuthorityWinnerLeasePort["acquireAuthorityWinner"]>>
      | undefined;
    try {
      lease = await this.options.executionLeases.acquireAuthorityWinner(scope, authority);
    } catch {
      this.reportCleanupFailure({
        operationId: command.operationId,
        scope,
        stage: "acquire",
        code: "runtime_cleanup_acquire_failed"
      });
      return;
    }
    try {
      if (!lease.reset) {
        this.reportCleanupFailure({
          operationId: command.operationId,
          scope,
          stage: "reset",
          code: "runtime_cleanup_reset_failed"
        });
      } else {
        await lease.reset(command);
      }
    } catch {
      this.reportCleanupFailure({
        operationId: command.operationId,
        scope,
        stage: "reset",
        code: "runtime_cleanup_reset_failed"
      });
    } finally {
      try {
        await lease.release();
      } catch {
        this.reportCleanupFailure({
          operationId: command.operationId,
          scope,
          stage: "release",
          code: "runtime_cleanup_release_failed"
        });
      }
    }
  }

  private reportCleanupFailure(diagnostic: CanvasRuntimeCleanupDiagnostic): void {
    try {
      (this.options.cleanupDiagnosticSink ?? logCanvasRuntimeCleanupDiagnostic)(diagnostic);
    } catch {
      // Diagnostics are observational and cannot invalidate an accepted durable reset receipt.
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
