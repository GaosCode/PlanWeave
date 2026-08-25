import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { RemoteOperation } from "../remoteOperations.js";
import type { AuthorizedRemoteAgentUse, RemoteAgentUseTarget } from "./schema.js";

export function dispatchTarget(request: {
  projectId: string;
  canvasId: string;
  workspaceId: string;
  targetKind: RemoteAgentUseTarget["kind"];
}): RemoteAgentUseTarget {
  if (request.targetKind === "owner_canvas") {
    return {
      kind: "owner_canvas",
      projectId: request.projectId,
      canvasId: request.canvasId
    };
  }
  return {
    kind: "workspace_canvas",
    workspaceId: workspaceIdSchema.parse(request.workspaceId),
    projectId: request.projectId,
    canvasId: request.canvasId
  };
}

/** Adapter for Host/runtime ports that still speak owner|collaboration. */
export function controlPlaneForTarget(target: RemoteAgentUseTarget): "collaboration" | "owner" {
  return target.kind === "owner_canvas" ? "owner" : "collaboration";
}

/**
 * Host availability overlay is orthogonal to Runtime Authority.
 * Unrestricted owners resolve against the fleet even when writing back to a
 * Workspace canvas that the Host is not mapped into.
 */
export function availabilityScopeForAuthorized(
  authorized: AuthorizedRemoteAgentUse
): RemoteAgentUseTarget["kind"] {
  if (
    authorized.agentAccessAuthority.kind === "agent_owner" &&
    authorized.agentAccessAuthority.workspaceId === undefined
  ) {
    return "owner_canvas";
  }
  return authorized.runtimeAuthority.kind;
}

export function retryTarget(
  operation: RemoteOperation,
  authorized: AuthorizedRemoteAgentUse
): RemoteAgentUseTarget {
  if (authorized.runtimeAuthority.kind === "owner_canvas") {
    return {
      kind: "owner_canvas",
      projectId: operation.projectId,
      canvasId: operation.canvasId
    };
  }
  return {
    kind: "workspace_canvas",
    workspaceId: authorized.runtimeAuthority.workspaceId,
    projectId: operation.projectId,
    canvasId: operation.canvasId
  };
}
