import type {
  CanvasRuntimeStatusProjection,
  CanvasRuntimeStatusSnapshot
} from "@planweave-ai/collaboration-protocol/canvas/status";
import type { PlanPackageManifest, RemoteBlockRuntimePort } from "@planweave-ai/runtime";
import type {
  CanvasExecutionRuntimeLease,
  CanvasExecutionRuntimeRoutePort,
  RuntimeCanvasScope
} from "./executionRuntimePort.js";
import type { CanvasRuntimeResetBaseline } from "./runtimeCommandReceipts.js";

export type CanvasRuntimeStatusExecutionStore = {
  read(scope: RuntimeCanvasScope): CanvasRuntimeStatusSnapshot | null;
  mergeRemoteMutationFromExecution(
    status: CanvasRuntimeStatusProjection,
    blockRef: string,
    manifest: PlanPackageManifest
  ): unknown;
};

export type AuthoritativeExecutionRuntimeAdapterOptions = {
  delegate: CanvasExecutionRuntimeRoutePort;
  readContentAuthority(
    scope: RuntimeCanvasScope
  ): { packageFingerprint: string; manifest: PlanPackageManifest } | undefined;
  resetBaselines: {
    latestAcceptedBaseline(scope: RuntimeCanvasScope): CanvasRuntimeResetBaseline | null;
  };
  runtimeStatuses: CanvasRuntimeStatusExecutionStore;
};

function sameResetProjection(
  left: CanvasRuntimeStatusProjection,
  right: CanvasRuntimeStatusProjection
): boolean {
  const { capturedAt: _leftCapturedAt, ...leftStable } = left;
  const { capturedAt: _rightCapturedAt, ...rightStable } = right;
  return JSON.stringify(leftStable) === JSON.stringify(rightStable);
}

/** Mirrors successful Runtime mutations into the Server-owned shared status snapshot. */
export class AuthoritativeExecutionRuntimeAdapter implements CanvasExecutionRuntimeRoutePort {
  constructor(private readonly options: AuthoritativeExecutionRuntimeAdapterOptions) {}

  acquire(scope: RuntimeCanvasScope): Promise<CanvasExecutionRuntimeLease> {
    return this.acquireAndWrap(scope, this.options.delegate.acquire(scope));
  }

  acquireForHost(scope: RuntimeCanvasScope, hostId: string): Promise<CanvasExecutionRuntimeLease> {
    return this.acquireAndWrap(scope, this.options.delegate.acquireForHost(scope, hostId));
  }

  private async acquireAndWrap(
    scope: RuntimeCanvasScope,
    acquired: CanvasExecutionRuntimeLease | Promise<CanvasExecutionRuntimeLease>
  ): Promise<CanvasExecutionRuntimeLease> {
    const lease = await acquired;
    try {
      await this.applyCurrentResetBaseline(scope, lease);
    } catch (error) {
      try {
        await lease.release();
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          "canvas_runtime_reset_baseline_release_failed"
        );
      }
      throw error;
    }
    const persist = async (blockRef: string) => {
      const authority = this.options.readContentAuthority({
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        canvasId: scope.canvasId
      });
      if (!authority) return;
      if (!lease.readStatus) throw new Error("canvas_runtime_status_capture_unavailable");
      const status = await lease.readStatus();
      if (
        status.scope.workspaceId !== scope.workspaceId ||
        status.scope.projectId !== scope.projectId ||
        status.scope.canvasId !== scope.canvasId ||
        status.packageFingerprint !== authority.packageFingerprint
      ) {
        throw new Error("canvas_runtime_status_content_out_of_sync");
      }
      this.options.runtimeStatuses.mergeRemoteMutationFromExecution(
        status,
        blockRef,
        authority.manifest
      );
    };
    const reset = lease.reset;
    return {
      ...lease,
      runtime: wrapMutations(lease.runtime, persist),
      ...(reset ? { reset: (command) => reset(command) } : {})
    };
  }

  private async applyCurrentResetBaseline(
    scope: RuntimeCanvasScope,
    lease: CanvasExecutionRuntimeLease
  ): Promise<void> {
    const baseline = this.options.resetBaselines.latestAcceptedBaseline(scope);
    if (!baseline) return;
    const current = this.options.runtimeStatuses.read(scope);
    if (!current || current.runtimeRevision !== baseline.runtimeRevision) return;
    const authority = this.options.readContentAuthority(scope);
    if (
      !authority ||
      authority.packageFingerprint !== baseline.command.expectedGraphFingerprint ||
      current.status.packageFingerprint !== baseline.command.expectedGraphFingerprint ||
      !sameResetProjection(current.status, baseline.status)
    ) {
      throw new Error("canvas_runtime_reset_baseline_authority_mismatch");
    }
    if (!lease.reset) throw new Error("canvas_runtime_reset_baseline_unavailable");
    const applied = await lease.reset(baseline.command);
    if (
      applied.operationId !== baseline.command.operationId ||
      applied.sourceRevision !== baseline.command.expectedSourceRevision ||
      applied.graphFingerprint !== baseline.command.expectedGraphFingerprint ||
      !sameResetProjection(applied.status, baseline.status)
    ) {
      throw new Error("canvas_runtime_reset_baseline_result_mismatch");
    }
    const currentAfterReset = this.options.runtimeStatuses.read(scope);
    const authorityAfterReset = this.options.readContentAuthority(scope);
    if (
      !currentAfterReset ||
      currentAfterReset.runtimeRevision !== baseline.runtimeRevision ||
      !sameResetProjection(currentAfterReset.status, baseline.status) ||
      !authorityAfterReset ||
      authorityAfterReset.packageFingerprint !== baseline.command.expectedGraphFingerprint
    ) {
      throw new Error("canvas_runtime_reset_baseline_superseded");
    }
  }
}

function wrapMutations(
  runtime: RemoteBlockRuntimePort,
  persist: (blockRef: string) => Promise<void>
): RemoteBlockRuntimePort {
  const after = async <T>(blockRef: string, operation: () => Promise<T>): Promise<T> => {
    const result = await operation();
    await persist(blockRef);
    return result;
  };
  return {
    inspect: (input) => runtime.inspect(input),
    query: (input) => runtime.query(input),
    reconcile: (input) => runtime.reconcile(input),
    claim: (input) => after(input.ref, () => runtime.claim(input)),
    activate: (input) => after(input.ref, () => runtime.activate(input)),
    markInterrupted: (input) => after(input.ref, () => runtime.markInterrupted(input)),
    resumeAttempt: (input) => after(input.ref, () => runtime.resumeAttempt(input)),
    retryAttempt: (input) => after(input.ref, () => runtime.retryAttempt(input)),
    complete: (input) => after(input.ref, () => runtime.complete(input)),
    fail: (input) => after(input.ref, () => runtime.fail(input))
  };
}
