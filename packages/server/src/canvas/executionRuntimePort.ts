import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { RemoteBlockArtifactSource, RemoteBlockRuntimePort } from "@planweave-ai/runtime";

export type RuntimeCanvasScope = {
  workspaceId: string;
  projectId: string;
  canvasId: string;
};

export class CanvasRuntimeUnavailableError extends Error {
  constructor(readonly reason: "runtime_not_attached" | "host_offline" = "runtime_not_attached") {
    super("canvas_runtime_unavailable");
    this.name = "CanvasRuntimeUnavailableError";
  }
}

export class CanvasRuntimeResetConflictError extends Error {
  constructor(readonly code: "active_lease" | "source_drift") {
    super(`canvas_runtime_reset_${code}`);
    this.name = "CanvasRuntimeResetConflictError";
  }
}

export type CanvasRuntimeResetCommand = {
  operationId: string;
  expectedSourceRevision: string;
  expectedGraphFingerprint: string;
  reason?: string;
};

export type CanvasRuntimeResetHostResult = {
  operationId: string;
  sourceRevision: string;
  graphFingerprint: string;
  status: CanvasRuntimeStatusProjection;
};

export type CanvasRuntimeResetReconciliation =
  | { kind: "not_found" | "pending" }
  | { kind: "succeeded"; result: CanvasRuntimeResetHostResult }
  | {
      kind: "failed";
      error: { code: string; retryable: boolean; reconcileRequired?: boolean };
    };

export type CanvasExecutionRuntimeLease = {
  runtime: RemoteBlockRuntimePort;
  artifacts: RemoteBlockArtifactSource;
  readStatus?(): Promise<CanvasRuntimeStatusProjection>;
  reset?(command: CanvasRuntimeResetCommand): Promise<CanvasRuntimeResetHostResult>;
  release(): void | Promise<void>;
};

export interface CanvasExecutionRuntimeLeasePort {
  acquire(
    scope: RuntimeCanvasScope
  ): CanvasExecutionRuntimeLease | Promise<CanvasExecutionRuntimeLease>;
  reconcileReset?(
    scope: RuntimeCanvasScope,
    command: CanvasRuntimeResetCommand
  ): Promise<CanvasRuntimeResetReconciliation>;
}

export interface CanvasRuntimeScopeAvailabilityPort {
  hasRuntimeProject(scope: { workspaceId: string; projectId: string }): boolean;
  hasRuntimeScope(scope: RuntimeCanvasScope): boolean;
}

export interface OwnerCanvasRuntimeScopeResolverPort {
  resolveUniqueOwnerScope(scope: {
    projectId: string;
    canvasId: string;
  }): RuntimeCanvasScope | undefined;
}
