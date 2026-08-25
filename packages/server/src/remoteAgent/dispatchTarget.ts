import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { RemoteOperation } from "../remoteOperations.js";
import type { AuthorizedRemoteAgentUse, RemoteAgentUseTarget } from "./schema.js";

export function dispatchTarget(request: {
  projectId: string;
  canvasId: string;
  workspaceId: string;
  controlPlane?: "collaboration" | "owner";
}): RemoteAgentUseTarget {
  if (request.controlPlane === "owner") {
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

export function controlPlaneForTarget(target: RemoteAgentUseTarget): "collaboration" | "owner" {
  return target.kind === "owner_canvas" ? "owner" : "collaboration";
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
