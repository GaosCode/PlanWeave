import type {
  CanvasExecutionRuntimeLeasePort,
  CanvasExecutionRuntimeRoutePort
} from "../../canvas/executionRuntimePort.js";

export function exactHostRuntimeRouteFixture(
  delegate: CanvasExecutionRuntimeLeasePort,
  observeHostId?: (hostId: string) => void
): CanvasExecutionRuntimeRoutePort {
  return {
    acquire: (scope) => delegate.acquire(scope),
    acquireForHost: (scope, hostId) => {
      observeHostId?.(hostId);
      return delegate.acquire(scope);
    }
  };
}
