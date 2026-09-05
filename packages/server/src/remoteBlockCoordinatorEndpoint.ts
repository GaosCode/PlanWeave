import type { RemoteBlockDispatchCandidate } from "@planweave-ai/runtime";
import {
  AgentEndpointCatalogError,
  type AgentEndpointCatalog,
  type ResolvedAgentEndpoint
} from "./agentEndpointCatalog.js";
import {
  writeEndpointSelectionSnapshotSchema,
  type EndpointSelectionSnapshot,
  type ReadableEndpointSelectionSnapshot,
  type RuntimeAuthoritySnapshot
} from "./endpointSelection.js";
import {
  deriveEndpointAvailabilityPolicyFromAuthorized,
  type EndpointAvailabilityPolicy
} from "./remoteAgent/dispatchTarget.js";
import type { RemoteOperationCandidatePort } from "./remoteBlockCoordinatorPorts.js";
import type { HostCapacityReservation } from "./hostReservations.js";
import type { RemoteOperation } from "./remoteOperations.js";

export function snapshotDispatchEndpoint(
  resolved: ResolvedAgentEndpoint,
  candidate: RemoteBlockDispatchCandidate,
  authority: RuntimeAuthoritySnapshot
): EndpointSelectionSnapshot {
  if (resolved.agentId !== candidate.agentId) {
    throw new AgentEndpointCatalogError("agent_endpoint_incompatible");
  }
  return writeEndpointSelectionSnapshotSchema.parse({
    schemaVersion: "endpoint-selection/v1",
    ...resolved,
    authority
  });
}

/**
 * Host overlay is Agent Access, not Runtime Authority. Unrestricted owners
 * stay on the fleet even when writeback targets a Workspace canvas.
 * Fleet lookup does not skip Host capacity for Workspace canvas runs.
 */
export function dispatchAvailabilityPolicy(
  operation: RemoteOperation,
  selection: ReadableEndpointSelectionSnapshot
): EndpointAvailabilityPolicy {
  return operation.agentAccess
    ? deriveEndpointAvailabilityPolicyFromAuthorized(operation.agentAccess.authorized)
    : selection.authority.kind === "owner_canvas"
      ? { kind: "owner_fleet" }
      : { kind: "workspace" };
}

export function assertDispatchEndpointIdentity(
  selection: ReadableEndpointSelectionSnapshot,
  resolved: ResolvedAgentEndpoint,
  candidate: RemoteBlockDispatchCandidate
): void {
  if (
    resolved.endpointId !== selection.endpointId ||
    resolved.hostId !== selection.hostId ||
    resolved.profileId !== selection.profileId ||
    resolved.agentId !== selection.agentId ||
    resolved.displayName !== selection.displayName ||
    resolved.hostDisplayName !== selection.hostDisplayName ||
    resolved.capabilities.length !== selection.capabilities.length ||
    resolved.capabilities.some((capability) => !selection.capabilities.includes(capability)) ||
    resolved.agentId !== candidate.agentId
  ) {
    throw new AgentEndpointCatalogError("agent_endpoint_incompatible");
  }
}

export function candidateForIdentity(
  operation: RemoteOperation,
  candidates: RemoteOperationCandidatePort
): RemoteBlockDispatchCandidate {
  const candidate = candidates.get(operation.id);
  if (!candidate) throw new Error("remote_operation_candidate_missing");
  return candidate;
}

export function resolveDurableDispatchEndpoint(input: {
  operation: RemoteOperation;
  candidate: RemoteBlockDispatchCandidate;
  agentEndpoints: AgentEndpointCatalog;
}): ResolvedAgentEndpoint {
  const selection = input.operation.endpointSelection;
  if (!selection) {
    throw new Error("agent_endpoint_dispatch_not_configured");
  }
  const resolved = input.agentEndpoints.resolveForRun(
    selection.endpointId,
    selection.authority.kind === "workspace_canvas"
      ? selection.authority.workspaceId
      : input.operation.workspaceId,
    input.operation.requiredCapabilities,
    dispatchAvailabilityPolicy(input.operation, selection)
  );
  assertDispatchEndpointIdentity(selection, resolved, input.candidate);
  return resolved;
}

export function assertReservedDispatchEndpoint(input: {
  operation: RemoteOperation;
  candidate: RemoteBlockDispatchCandidate;
  reservation: HostCapacityReservation;
  agentEndpoints: AgentEndpointCatalog;
}): void {
  const selection = input.operation.endpointSelection;
  if (!selection) {
    throw new Error("agent_endpoint_dispatch_not_configured");
  }
  const resolved = input.agentEndpoints.resolveForReservedRun(
    selection.endpointId,
    selection.authority.kind === "workspace_canvas"
      ? selection.authority.workspaceId
      : input.operation.workspaceId,
    input.operation.requiredCapabilities,
    input.reservation.hostId,
    dispatchAvailabilityPolicy(input.operation, selection)
  );
  assertDispatchEndpointIdentity(selection, resolved, input.candidate);
}
