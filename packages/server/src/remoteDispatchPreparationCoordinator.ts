import type { RemoteBlockDispatchCandidate } from "@planweave-ai/runtime";
import { AgentEndpointCatalogError, type AgentEndpointCatalog } from "./agentEndpointCatalog.js";
import { CanvasRuntimeUnavailableError } from "./canvas/executionRuntimePort.js";
import {
  CanvasRuntimeAttachmentConflictError,
  type RuntimeAttachmentRecordRequest,
  type RuntimeAttachmentRequest
} from "./canvas/runtimeAttachment.js";
import type { HostCapacityReservation, HostReservationRepository } from "./hostReservations.js";
import type {
  RemoteCoordinatorCheckpoint,
  RemoteDispatchPersistencePort,
  RemoteRuntimeContentTargetPort
} from "./remoteBlockCoordinatorPorts.js";
import { resolveDurableDispatchEndpoint } from "./remoteBlockCoordinatorEndpoint.js";
import type { RemoteOperation, RemoteOperationRepository } from "./remoteOperations.js";
import {
  attachWorkspaceRuntimeForAcceptedOperation,
  assertRuntimeAttachmentContentTarget,
  RuntimeAttachmentContentTargetError
} from "./remoteRuntimeAttachmentCoordinator.js";

type PreparationPorts = {
  operations: RemoteOperationRepository;
  reservations: HostReservationRepository;
  dispatches: RemoteDispatchPersistencePort;
  agentEndpoints?: AgentEndpointCatalog;
  runtimeContentTargets?: RemoteRuntimeContentTargetPort;
  ensureRuntimeAttachment?: (input: RuntimeAttachmentRecordRequest) => void;
  findRuntimeAttachment?: (
    operationId: string,
    executionAttemptId: string
  ) => RuntimeAttachmentRequest | undefined;
  finalAuthorize?: (input: {
    operation: RemoteOperation;
    reservation: HostCapacityReservation;
  }) => void;
  authorizeEndpointOperation: (operation: RemoteOperation) => void;
  authorizeReservedEndpoint: (
    operation: RemoteOperation,
    candidate: RemoteBlockDispatchCandidate,
    reservation: HostCapacityReservation
  ) => void;
  checkpoint: (point: RemoteCoordinatorCheckpoint) => Promise<void>;
};

export class RemoteDispatchPreparationCoordinator {
  constructor(private readonly ports: PreparationPorts) {}

  async reserve(
    operation: RemoteOperation,
    candidate: RemoteBlockDispatchCandidate
  ): Promise<HostCapacityReservation> {
    if (operation.attempt.leaseId) {
      const reservation = this.ports.reservations.getRequired(operation.attempt.leaseId);
      if (
        !operation.attempt.hostId ||
        !this.ports.reservations.isActiveForAttempt({
          leaseId: reservation.leaseId,
          executionAttemptId: operation.executionAttemptId,
          hostId: operation.attempt.hostId
        })
      ) {
        throw new CanvasRuntimeUnavailableError("host_offline");
      }
      if (operation.endpointSelection) {
        this.ports.authorizeReservedEndpoint(operation, candidate, reservation);
      } else {
        this.ports.finalAuthorize?.({ operation, reservation });
      }
      return reservation;
    }

    try {
      this.ports.operations.recordDiagnosticStage(operation.id, "authorizing");
      this.ports.authorizeEndpointOperation(operation);
      const agentEndpoints = this.ports.agentEndpoints;
      if (!agentEndpoints) throw new Error("agent_endpoint_dispatch_not_configured");
      this.ports.operations.recordDiagnosticStage(operation.id, "resolving_endpoint");
      const resolvedEndpoint = resolveDurableDispatchEndpoint({
        operation,
        candidate,
        agentEndpoints
      });
      this.ports.operations.recordDiagnosticStage(operation.id, "reserving_host");
      const reservation = this.ports.reservations.reserve(operation.id, {
        preferredHostId: resolvedEndpoint.hostId,
        agentId: resolvedEndpoint.agentId,
        agentProfileId: resolvedEndpoint.profileId
      });
      const reservedOperation = this.ports.operations.getRequired(operation.id);
      this.ports.authorizeReservedEndpoint(reservedOperation, candidate, reservation);
      await this.ports.checkpoint("after_host_reservation");
      this.ports.operations.clearDiagnostic(operation.id);
      return reservation;
    } catch (error) {
      if (error instanceof Error && error.message === "no_compatible_agent_host") {
        throw new AgentEndpointCatalogError("agent_endpoint_unavailable");
      }
      throw error;
    }
  }

  async attach(
    operation: RemoteOperation,
    candidate: RemoteBlockDispatchCandidate,
    reservation: HostCapacityReservation
  ): Promise<RuntimeAttachmentRequest> {
    const existing = this.ports.findRuntimeAttachment?.(operation.id, operation.executionAttemptId);
    const contentTargets = this.ports.runtimeContentTargets;
    if (!contentTargets) throw new Error("runtime_content_target_port_missing");
    if (existing) {
      if (
        existing.workspaceId !== operation.workspaceId ||
        existing.projectId !== operation.projectId ||
        existing.canvasId !== operation.canvasId ||
        existing.hostId !== reservation.hostId ||
        existing.graphFingerprint !== candidate.graphFingerprint
      ) {
        throw new Error("runtime_attachment_reentry_conflict");
      }
      assertRuntimeAttachmentContentTarget({ attachment: existing, candidate, contentTargets });
      await this.ports.checkpoint("after_runtime_attachment");
      return existing;
    }
    const record = this.ports.ensureRuntimeAttachment;
    if (!record) throw new Error("runtime_attachment_port_missing");
    this.ports.operations.recordDiagnosticStage(operation.id, "attaching_runtime");
    const attachment = await attachWorkspaceRuntimeForAcceptedOperation({
      operation: this.ports.operations.getRequired(operation.id),
      candidate,
      reservation,
      ports: { contentTargets, record }
    });
    await this.ports.checkpoint("after_runtime_attachment");
    return attachment;
  }

  releaseOnFailure(
    operation: RemoteOperation,
    reservation: HostCapacityReservation,
    error: unknown
  ): void {
    if (
      !(error instanceof RuntimeAttachmentContentTargetError) &&
      !(error instanceof CanvasRuntimeAttachmentConflictError) &&
      !(error instanceof CanvasRuntimeUnavailableError) &&
      !(error instanceof AgentEndpointCatalogError)
    ) {
      return;
    }
    if (this.ports.dispatches.inspect(operation).dispatch) return;
    const current = this.ports.reservations.getRequired(reservation.leaseId);
    const latestOperation = this.ports.operations.getRequired(operation.id);
    if (
      current.status !== "active" ||
      latestOperation.executionAttemptId !== current.executionAttemptId ||
      latestOperation.attempt.leaseId !== current.leaseId
    ) {
      return;
    }
    this.ports.reservations.release({
      leaseId: current.leaseId,
      fencingToken: current.fencingToken,
      expectedVersion: current.version,
      reason: "expired"
    });
  }
}
