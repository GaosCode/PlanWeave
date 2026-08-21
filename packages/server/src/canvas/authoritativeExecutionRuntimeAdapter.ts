import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { RemoteBlockRuntimePort } from "@planweave-ai/runtime";
import type {
  CanvasExecutionRuntimeLease,
  CanvasExecutionRuntimeLeasePort,
  RuntimeCanvasScope
} from "./executionRuntimePort.js";

export type CanvasRuntimeStatusExecutionStore = {
  replaceFromExecution(status: CanvasRuntimeStatusProjection): CanvasRuntimeStatusProjection;
};

export type AuthoritativeExecutionRuntimeAdapterOptions = {
  delegate: CanvasExecutionRuntimeLeasePort;
  readContentFingerprint(scope: RuntimeCanvasScope): string | undefined;
  runtimeStatuses: CanvasRuntimeStatusExecutionStore;
};

/** Mirrors successful Runtime mutations into the Server-owned shared status snapshot. */
export class AuthoritativeExecutionRuntimeAdapter implements CanvasExecutionRuntimeLeasePort {
  constructor(private readonly options: AuthoritativeExecutionRuntimeAdapterOptions) {}

  async acquire(scope: RuntimeCanvasScope): Promise<CanvasExecutionRuntimeLease> {
    const lease = await this.options.delegate.acquire(scope);
    const persist = async () => {
      const expectedFingerprint = this.options.readContentFingerprint(scope);
      if (!expectedFingerprint) return;
      if (!lease.readStatus) throw new Error("canvas_runtime_status_capture_unavailable");
      const status = await lease.readStatus();
      if (
        status.scope.workspaceId !== scope.workspaceId ||
        status.scope.projectId !== scope.projectId ||
        status.scope.canvasId !== scope.canvasId ||
        status.packageFingerprint !== expectedFingerprint
      ) {
        throw new Error("canvas_runtime_status_content_out_of_sync");
      }
      this.options.runtimeStatuses.replaceFromExecution(status);
    };
    return {
      ...lease,
      runtime: wrapMutations(lease.runtime, persist)
    };
  }
}

function wrapMutations(
  runtime: RemoteBlockRuntimePort,
  persist: () => Promise<void>
): RemoteBlockRuntimePort {
  const after = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = await operation();
    await persist();
    return result;
  };
  return {
    inspect: (input) => runtime.inspect(input),
    query: (input) => runtime.query(input),
    reconcile: (input) => runtime.reconcile(input),
    claim: (input) => after(() => runtime.claim(input)),
    activate: (input) => after(() => runtime.activate(input)),
    markInterrupted: (input) => after(() => runtime.markInterrupted(input)),
    resumeAttempt: (input) => after(() => runtime.resumeAttempt(input)),
    retryAttempt: (input) => after(() => runtime.retryAttempt(input)),
    complete: (input) => after(() => runtime.complete(input)),
    fail: (input) => after(() => runtime.fail(input))
  };
}
