import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { RemoteBlockArtifactSource, RemoteBlockRuntimePort } from "@planweave-ai/runtime";
import type { RuntimeReadAuthority } from "./runtimeAuthorityCandidates.js";

export type RuntimeCanvasScope = {
  workspaceId: string;
  projectId: string;
  canvasId: string;
};

/** @deprecated Use RuntimeCanvasScope. Acquire accepts only the logical Runtime scope. */
export type RuntimeCanvasAcquireRequest = RuntimeCanvasScope;

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

export type CanvasRuntimeInitializationEvidence = {
  sourceRevision: string;
  graphFingerprint: string;
  status: CanvasRuntimeStatusProjection;
};

export type CanvasExecutionRuntimeLease = {
  runtime: RemoteBlockRuntimePort;
  artifacts: RemoteBlockArtifactSource;
  readStatus?(): Promise<CanvasRuntimeStatusProjection>;
  readInitializationEvidence?(): Promise<CanvasRuntimeInitializationEvidence>;
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

/** Selects one exact execution cache using the current Server content authority. */
export interface CanvasRuntimeAuthorityWinnerLeasePort extends CanvasExecutionRuntimeLeasePort {
  acquireAuthorityWinner(
    scope: RuntimeCanvasScope,
    authority: RuntimeReadAuthority
  ): CanvasExecutionRuntimeLease | Promise<CanvasExecutionRuntimeLease>;
}

/** Execution-adapter routing seam. Host evidence never enters the logical Runtime scope. */
export interface CanvasExecutionRuntimeRoutePort extends CanvasExecutionRuntimeLeasePort {
  acquireForHost(
    scope: RuntimeCanvasScope,
    hostId: string
  ): CanvasExecutionRuntimeLease | Promise<CanvasExecutionRuntimeLease>;
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
