import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { RemoteBlockArtifactSource, RemoteBlockRuntimePort } from "@planweave-ai/runtime";

export type RuntimeCanvasScope = {
  workspaceId: string;
  projectId: string;
  canvasId: string;
};

export class CanvasRuntimeUnavailableError extends Error {
  constructor() {
    super("canvas_runtime_unavailable");
    this.name = "CanvasRuntimeUnavailableError";
  }
}

export type CanvasExecutionRuntimeLease = {
  runtime: RemoteBlockRuntimePort;
  artifacts: RemoteBlockArtifactSource;
  readStatus?(): Promise<CanvasRuntimeStatusProjection>;
  release(): void | Promise<void>;
};

export interface CanvasExecutionRuntimeLeasePort {
  acquire(
    scope: RuntimeCanvasScope
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
