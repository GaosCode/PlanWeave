import type { RemoteBlockDispatchCandidate } from "@planweave-ai/runtime";
import type { AgentEndpointCatalog } from "./agentEndpointCatalog.js";
import { runtimeControlPlane } from "./endpointSelection.js";
import type { HostCapacityReservation, HostReservationRepository } from "./hostReservations.js";
import type { AuthorizeRemoteAgentUseInput } from "./remoteAgent/accessPolicy.js";
import { retryTarget } from "./remoteAgent/dispatchTarget.js";
import { RemoteAgentAuthorizationError } from "./remoteAgent/errors.js";
import {
  persistedRemoteAgentAccessSnapshotSchema,
  type AuthorizedRemoteAgentUse,
  type PersistedRemoteAgentAccessSnapshot
} from "./remoteAgent/schema.js";
import type { RemoteOperationCandidatePort } from "./remoteBlockCoordinatorPorts.js";
import {
  assertReservedDispatchEndpoint,
  candidateForIdentity,
  resolveDurableDispatchEndpoint
} from "./remoteBlockCoordinatorEndpoint.js";
import type { RemoteOperation, RemoteOperationRepository } from "./remoteOperations.js";
import type { AssignmentDispatchGate } from "./work/dispatchIntegration.js";

type AuthorityPorts = {
  operations: RemoteOperationRepository;
  candidates: RemoteOperationCandidatePort;
  reservations: HostReservationRepository;
  assignmentGate?: AssignmentDispatchGate;
  agentEndpoints?: AgentEndpointCatalog;
  authorizeRemoteAgentUse?: (input: AuthorizeRemoteAgentUseInput) => AuthorizedRemoteAgentUse;
  endpointAuthorize?: (input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    blockRef: string;
    expectedResponsibilityRevision: number;
    expectedReviewerRevision: number;
    controlPlane: "collaboration" | "owner";
  }) => void;
  recordInconsistency: (operation: RemoteOperation, message: string) => never;
};

export class RemoteEndpointExecutionAuthority {
  constructor(private readonly ports: AuthorityPorts) {}

  resolvePreferredHostId(
    operation: RemoteOperation,
    candidate: RemoteBlockDispatchCandidate
  ): string | undefined {
    if (operation.hostSelection) return operation.hostSelection.preferredHostId;
    if (!this.ports.assignmentGate) return undefined;
    const snapshot = this.ports.assignmentGate.resolve({
      workspaceId: candidate.workspaceId,
      projectId: operation.projectId,
      canvasId: operation.canvasId,
      blockRef: operation.blockRef,
      requiredCapabilities: operation.requiredCapabilities,
      agentId: candidate.agentId,
      agentProfileId: candidate.agentProfileId,
      allowHumanOverride: false
    });
    const persisted = this.ports.operations.persistHostSelection(operation.id, snapshot);
    if (!persisted.hostSelection) {
      return this.ports.recordInconsistency(
        persisted,
        "Host selection was not persisted for an actionable remote operation."
      );
    }
    return persisted.hostSelection.preferredHostId;
  }

  authorizeReservedEndpoint(
    operation: RemoteOperation,
    candidate: RemoteBlockDispatchCandidate,
    reservation: HostCapacityReservation
  ): void {
    try {
      this.authorize(operation, reservation, candidate);
    } catch (error) {
      if (reservation.status === "active") {
        this.ports.reservations.release({
          leaseId: reservation.leaseId,
          fencingToken: reservation.fencingToken,
          expectedVersion: reservation.version,
          reason: "expired"
        });
      }
      throw error;
    }
  }

  reauthorizeForRetry(operation: RemoteOperation): PersistedRemoteAgentAccessSnapshot {
    const snapshot = operation.agentAccess;
    if (!snapshot) {
      throw new RemoteAgentAuthorizationError("remote_agent_access_snapshot_missing");
    }
    if (!this.ports.authorizeRemoteAgentUse) {
      throw new Error("agent_endpoint_dispatch_not_configured");
    }
    const endpointId =
      operation.endpointSelection?.endpointId ?? snapshot.authorized.remoteAgent.endpointId;
    const target = retryTarget(operation, snapshot.authorized);
    const authorized = this.ports.authorizeRemoteAgentUse({
      principal: { humanPrincipalId: snapshot.callerHumanPrincipalId },
      endpointId,
      target,
      requiredCapabilities: operation.requiredCapabilities,
      runtimeWorkspaceId: operation.workspaceId,
      blockRef: operation.blockRef,
      expectedResponsibilityRevision:
        operation.endpointSelection?.authority.responsibilityRevision ?? 0,
      expectedReviewerRevision: operation.endpointSelection?.authority.reviewerRevision ?? 0
    });
    return persistedRemoteAgentAccessSnapshotSchema.parse({
      callerHumanPrincipalId: snapshot.callerHumanPrincipalId,
      authorized
    });
  }

  authorize(
    operation: RemoteOperation,
    reservation?: HostCapacityReservation,
    candidate: RemoteBlockDispatchCandidate = candidateForIdentity(operation, this.ports.candidates)
  ): void {
    const selection = operation.endpointSelection;
    if (!selection || !this.ports.endpointAuthorize || !this.ports.agentEndpoints) {
      throw new Error("agent_endpoint_dispatch_not_configured");
    }
    this.ports.endpointAuthorize({
      workspaceId: operation.workspaceId,
      projectId: operation.projectId,
      canvasId: operation.canvasId,
      blockRef: operation.blockRef,
      expectedResponsibilityRevision: selection.authority.responsibilityRevision,
      expectedReviewerRevision: selection.authority.reviewerRevision,
      controlPlane: runtimeControlPlane(selection.authority)
    });
    if (reservation) {
      assertReservedDispatchEndpoint({
        operation,
        candidate,
        reservation,
        agentEndpoints: this.ports.agentEndpoints
      });
      return;
    }
    resolveDurableDispatchEndpoint({
      operation,
      candidate,
      agentEndpoints: this.ports.agentEndpoints
    });
  }
}
