import { CANVAS_RUNTIME_EXECUTION_CAPABILITY } from "@planweave-ai/agent-host-protocol";
import type { RemoteOperation } from "./remoteOperations.js";

export function usesManagedCanvasRuntime(operation: RemoteOperation): boolean {
  return (
    operation.endpointSelection !== undefined &&
    operation.requiredCapabilities.includes(CANVAS_RUNTIME_EXECUTION_CAPABILITY)
  );
}

export function usesLegacyOwnerPackageRuntime(operation: RemoteOperation): boolean {
  const authorityKind =
    operation.endpointSelection?.authority.kind ??
    operation.agentAccess?.authorized.runtimeAuthority.kind;
  return !usesManagedCanvasRuntime(operation) && authorityKind === "owner_canvas";
}
