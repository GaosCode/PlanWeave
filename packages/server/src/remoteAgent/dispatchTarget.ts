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
 * Closed set of Host mapping + capacity combinations.
 * Catalog, authorize, dispatch, retry, and reservation all consume this.
 */
export type EndpointAvailabilityPolicy =
  | { kind: "owner_fleet" }
  | { kind: "owner_workspace" }
  | { kind: "workspace" };

export function deriveEndpointAvailabilityPolicy(input: {
  accessMode: "unrestricted" | "workspace_restricted";
  agentAccessAuthority: AuthorizedRemoteAgentUse["agentAccessAuthority"];
  target: RemoteAgentUseTarget;
}): EndpointAvailabilityPolicy {
  if (input.target.kind === "owner_canvas") return { kind: "owner_fleet" };
  const usesOwnerFleetMapping =
    input.accessMode === "unrestricted" &&
    input.agentAccessAuthority.kind === "agent_owner" &&
    input.agentAccessAuthority.workspaceId === undefined;
  return usesOwnerFleetMapping ? { kind: "owner_workspace" } : { kind: "workspace" };
}

export function deriveEndpointAvailabilityPolicyFromAuthorized(
  authorized: AuthorizedRemoteAgentUse
): EndpointAvailabilityPolicy {
  if (authorized.runtimeAuthority.kind === "owner_canvas") return { kind: "owner_fleet" };
  const usesOwnerFleetMapping =
    authorized.agentAccessAuthority.kind === "agent_owner" &&
    authorized.agentAccessAuthority.workspaceId === undefined;
  return usesOwnerFleetMapping ? { kind: "owner_workspace" } : { kind: "workspace" };
}

export function endpointMappingScope(
  policy: EndpointAvailabilityPolicy
): RemoteAgentUseTarget["kind"] {
  return policy.kind === "workspace" ? "workspace_canvas" : "owner_canvas";
}

export function endpointOccupiesHostCapacity(policy: EndpointAvailabilityPolicy): boolean {
  return policy.kind !== "owner_fleet";
}

/**
 * Host visibility overlay is orthogonal to Runtime Authority.
 * Unrestricted owners may look up Hosts from the owner fleet even when
 * writeback targets a Workspace canvas that the Host is not mapped into.
 * Fleet visibility does not skip Host capacity; see occupiesHostCapacity().
 */
export function availabilityScopeForAuthorized(
  authorized: AuthorizedRemoteAgentUse
): RemoteAgentUseTarget["kind"] {
  return endpointMappingScope(deriveEndpointAvailabilityPolicyFromAuthorized(authorized));
}

/**
 * Workspace canvas and workspace-restricted Endpoint runs occupy advertised
 * Host capacity. Owner-canvas fleet runs do not; they share the Host with
 * collaboration capacity instead of consuming it.
 */
export function occupiesHostCapacity(authorized: AuthorizedRemoteAgentUse): boolean {
  return endpointOccupiesHostCapacity(deriveEndpointAvailabilityPolicyFromAuthorized(authorized));
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
