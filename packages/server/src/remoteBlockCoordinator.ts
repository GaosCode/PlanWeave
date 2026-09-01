import {
  agentHostProtocolVersion,
  hashExecutionEnvelope,
  mailboxCommandSchema,
  type OwnerPackageLocator
} from "@planweave-ai/agent-host-protocol";
import {
  RemoteOwnershipConflictError,
  type RemoteBlockDispatchCandidate,
  type RemoteBlockRuntimePort
} from "@planweave-ai/runtime";
import type {
  RemoteArtifactContentPort,
  RemoteCoordinatorCheckpoint,
  RemoteCoordinatorCheckpointPort,
  RemoteContentAuthorizePort,
  RemoteDispatchCandidateReaderPort,
  RemoteDispatchPersistencePort,
  RemoteInputArtifactPort,
  RemoteMailboxPublisherPort,
  RemoteOperationCandidatePort
} from "./remoteBlockCoordinatorPorts.js";
import {
  acquireRemoteRuntimeLease,
  authorizedOperationHostId
} from "./remoteBlockCoordinatorPorts.js";
import {
  CanvasRuntimeUnavailableError,
  type CanvasExecutionRuntimeLease,
  type CanvasExecutionRuntimeRoutePort
} from "./canvas/executionRuntimePort.js";
import type {
  RuntimeAttachmentRecordRequest,
  RuntimeAttachmentRequest
} from "./canvas/runtimeAttachment.js";
import {
  assertRuntimeAttachmentContentTarget,
  materializeAttachedWorkspaceRuntime
} from "./remoteRuntimeAttachmentCoordinator.js";
import { HostReservationRepository, type HostCapacityReservation } from "./hostReservations.js";
import { RemoteOperationRepository, type RemoteOperation } from "./remoteOperations.js";
import {
  RemoteExecutionActionRepository,
  type RemoteExecutionActionRecord
} from "./remoteExecutionActions.js";
import { RemoteBlockActionCoordinator } from "./remoteBlockActionCoordinator.js";
import { remoteBlockIdentity } from "./remoteBlockIdentity.js";
import {
  DispatchAssignmentError,
  type AssignmentDispatchGate,
  type DispatchHostSelectionSnapshot
} from "./work/dispatchIntegration.js";
import { AgentEndpointCatalogError, type AgentEndpointCatalog } from "./agentEndpointCatalog.js";
import { runtimeControlPlane } from "./endpointSelection.js";
import type { AuthorizeRemoteAgentUseInput } from "./remoteAgent/accessPolicy.js";
import {
  type AuthorizedRemoteAgentUse,
  type PersistedRemoteAgentAccessSnapshot
} from "./remoteAgent/schema.js";
import {
  classifyReenterFailure,
  diagnosticFromReenterFailure,
  type RemoteDispatchOutcome
} from "./remoteReenterRecovery.js";
export type { RemoteDispatchOutcome } from "./remoteReenterRecovery.js";
import { RemoteBlockWritebackCoordinator } from "./remoteBlockWritebackCoordinator.js";
import {
  candidateForIdentity,
  resolveDurableDispatchEndpoint
} from "./remoteBlockCoordinatorEndpoint.js";
import type { HumanPrincipalIdentity } from "./identity/humanPrincipalIdentity.js";
import { buildRemoteBlockExecutionEnvelope } from "./remoteBlockDispatchPreparation.js";
import { RemoteDispatchPreparationCoordinator } from "./remoteDispatchPreparationCoordinator.js";
import { RemoteEndpointExecutionAuthority } from "./remoteEndpointExecutionAuthority.js";
import {
  acceptRemoteBlockDispatch,
  type RemoteEndpointDispatchRequest
} from "./remoteBlockDispatchAcceptance.js";
export type { RemoteEndpointDispatchRequest } from "./remoteBlockDispatchAcceptance.js";
import {
  usesLegacyOwnerPackageRuntime,
  usesManagedCanvasRuntime
} from "./remoteBlockRuntimePolicy.js";

export type RemoteBlockCoordinatorOptions = {
  runtimeLeases: CanvasExecutionRuntimeRoutePort;
  dispatchCandidates: RemoteDispatchCandidateReaderPort;
  operations: RemoteOperationRepository;
  actions: RemoteExecutionActionRepository;
  candidates: RemoteOperationCandidatePort;
  reservations: HostReservationRepository;
  dispatches: RemoteDispatchPersistencePort;
  mailbox: RemoteMailboxPublisherPort;
  inputArtifacts: RemoteInputArtifactPort;
  artifactContent: RemoteArtifactContentPort;
  checkpoints?: RemoteCoordinatorCheckpointPort;
  assignmentGate?: AssignmentDispatchGate;
  agentEndpoints?: AgentEndpointCatalog;
  authorizeRemoteAgentUse?: (input: AuthorizeRemoteAgentUseInput) => AuthorizedRemoteAgentUse;
  authorizeRemoteAgentUseForSnapshot?: (
    input: AuthorizeRemoteAgentUseInput
  ) => AuthorizedRemoteAgentUse;
  endpointAuthorize?: (input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    blockRef: string;
    expectedResponsibilityRevision: number;
    expectedReviewerRevision: number;
    executionTargetRevision: number;
    controlPlane: "collaboration" | "owner";
  }) => void;
  contentAuthorize: RemoteContentAuthorizePort;
  finalAuthorize?: (input: {
    operation: RemoteOperation;
    reservation: HostCapacityReservation;
  }) => void;
  ownerPackageLocatorForHost?: (input: {
    hostId: string;
    candidate: RemoteBlockDispatchCandidate;
  }) => OwnerPackageLocator | undefined;
  ensureRuntimeAttachment?: (input: RuntimeAttachmentRecordRequest) => void;
  findRuntimeAttachment?: (
    operationId: string,
    executionAttemptId: string
  ) => RuntimeAttachmentRequest | undefined;
  runtimeContentTargets?: import("./remoteBlockCoordinatorPorts.js").RemoteRuntimeContentTargetPort;
  ensureRuntimeProjection?: (
    input: RuntimeAttachmentRequest & { lease: CanvasExecutionRuntimeLease }
  ) => void | Promise<void>;
  serverInstanceOwnerToken: string;
  humanIdentity: HumanPrincipalIdentity;
};

export class RemoteBlockCoordinator {
  private actionsCoordinator: RemoteBlockActionCoordinator | undefined;
  private terminalWriteback: RemoteBlockWritebackCoordinator | undefined;
  private dispatchPreparation: RemoteDispatchPreparationCoordinator | undefined;
  private endpointAuthority: RemoteEndpointExecutionAuthority | undefined;

  constructor(private readonly options: RemoteBlockCoordinatorOptions) {}

  private async checkpoint(point: RemoteCoordinatorCheckpoint): Promise<void> {
    await this.options.checkpoints?.reached(point);
  }

  private async withRuntime<T>(
    record: RemoteOperation,
    operation: (runtime: RemoteBlockRuntimePort) => Promise<T>
  ): Promise<T> {
    const hostId = record.attempt.hostId;
    if (!hostId) throw new CanvasRuntimeUnavailableError("runtime_not_attached");
    const acquired = await acquireRemoteRuntimeLease(this.options.runtimeLeases, record, hostId);
    try {
      return await operation(acquired.runtime);
    } finally {
      await acquired.release();
    }
  }

  getAuthorizedHostSelection(operationId: string): DispatchHostSelectionSnapshot | undefined {
    return this.options.operations.get(operationId)?.hostSelection;
  }

  async dispatch(request: RemoteEndpointDispatchRequest): Promise<RemoteDispatchOutcome> {
    const operation = await acceptRemoteBlockDispatch(request, {
      dispatchCandidates: this.options.dispatchCandidates,
      operations: this.options.operations,
      candidates: this.options.candidates,
      agentEndpoints: this.options.agentEndpoints,
      authorizeRemoteAgentUse: this.options.authorizeRemoteAgentUse,
      authorizeRemoteAgentUseForSnapshot: this.options.authorizeRemoteAgentUseForSnapshot,
      endpointAuthorize: this.options.endpointAuthorize,
      contentAuthorize: this.options.contentAuthorize,
      humanIdentity: this.options.humanIdentity,
      checkpoint: (point) => this.checkpoint(point)
    });
    return this.reenter(operation.id);
  }

  async reenter(operationId: string): Promise<RemoteDispatchOutcome> {
    const operation = this.options.operations.getRequired(operationId);
    const persisted = this.options.dispatches.inspect(operation);
    if (["completed", "failed", "cancelled"].includes(operation.state)) {
      return { operation, status: "terminal" };
    }
    if (
      !persisted.dispatch &&
      (operation.state === "interrupted" ||
        operation.state === "action_required" ||
        operation.attempt.status === "interrupted" ||
        operation.attempt.status === "action_required")
    ) {
      return { operation, status: "wait_for_action" };
    }
    const candidate = this.options.candidates.get(operation.id);
    if (!candidate) throw new Error("remote_operation_candidate_missing");
    if (persisted.dispatch) {
      if (
        persisted.dispatch.status === "completed" ||
        persisted.dispatch.status === "failed" ||
        persisted.dispatch.status === "cancelled"
      ) {
        this.writebackCoordinator().finalizeOperationTerminal(operation, persisted.dispatch.status);
        return { operation: this.options.operations.getRequired(operation.id), status: "terminal" };
      }
      if (!operation.attempt.leaseId) throw new Error("remote_attempt_reservation_missing");
      const reservation = this.options.reservations.getRequired(operation.attempt.leaseId);
      if (
        ["leased", "running", "cancelling"].includes(persisted.dispatch.status) &&
        (!operation.attempt.hostId ||
          !this.options.reservations.isActiveForAttempt({
            leaseId: reservation.leaseId,
            executionAttemptId: operation.executionAttemptId,
            hostId: operation.attempt.hostId
          }))
      ) {
        throw new CanvasRuntimeUnavailableError("host_offline");
      }
      if (["leased", "running", "cancelling"].includes(persisted.dispatch.status)) {
        if (operation.endpointSelection) {
          this.authorizeReservedEndpoint(operation, candidate, reservation);
        } else {
          this.options.finalAuthorize?.({ operation, reservation });
        }
      }
      const lease = await acquireRemoteRuntimeLease(
        this.options.runtimeLeases,
        operation,
        reservation.hostId
      );
      try {
        return await this.reenterWithLease(operation.id, lease, undefined, true);
      } finally {
        await lease.release();
      }
    }
    const managedRuntimeExecution = usesManagedCanvasRuntime(operation);
    const reservation = operation.endpointSelection
      ? await this.preparationCoordinator().reserve(operation, candidate)
      : undefined;
    let attachment: RuntimeAttachmentRequest | undefined;
    let lease: CanvasExecutionRuntimeLease;
    try {
      attachment =
        managedRuntimeExecution && reservation
          ? await this.preparationCoordinator().attach(operation, candidate, reservation)
          : undefined;
      lease = await acquireRemoteRuntimeLease(
        this.options.runtimeLeases,
        operation,
        reservation?.hostId ?? authorizedOperationHostId(operation)
      );
    } catch (error) {
      if (reservation)
        this.preparationCoordinator().releaseOnFailure(operation, reservation, error);
      throw error;
    }
    try {
      return await this.reenterWithLease(operationId, lease, attachment, false);
    } catch (error) {
      if (reservation)
        this.preparationCoordinator().releaseOnFailure(operation, reservation, error);
      throw error;
    } finally {
      await lease.release();
    }
  }

  private async reenterWithLease(
    operationId: string,
    runtimeLease: CanvasExecutionRuntimeLease,
    runtimeAttachment?: RuntimeAttachmentRequest,
    reusePersistedDispatch = false
  ): Promise<RemoteDispatchOutcome> {
    let operation = this.options.operations.getRequired(operationId);
    if (["completed", "failed", "cancelled"].includes(operation.state)) {
      return { operation, status: "terminal" };
    }
    const pendingWriteback = this.options.dispatches.inspect(operation).dispatch;
    if (pendingWriteback?.status === "awaiting_writeback" && pendingWriteback.terminalAction) {
      if (pendingWriteback.terminalAction.kind === "complete") {
        await this.complete(operation.id, runtimeLease);
      } else {
        await this.fail(operation.id, runtimeLease);
      }
      return {
        operation: this.options.operations.getRequired(operation.id),
        status: "terminal"
      };
    }
    const activeAuthorityAttempt =
      !reusePersistedDispatch &&
      ["reserved", "activated", "running", "awaiting_writeback"].includes(operation.attempt.status);
    if (activeAuthorityAttempt && operation.attempt.leaseId) {
      const reservation = this.options.reservations.getRequired(operation.attempt.leaseId);
      if (operation.endpointSelection) {
        this.authorizeReservedEndpoint(
          operation,
          candidateForIdentity(operation, this.options.candidates),
          reservation
        );
      } else if (this.options.finalAuthorize) {
        this.options.finalAuthorize({ operation, reservation });
      }
    }
    if (operation.state !== "preparing" && operation.state !== "reserved") {
      try {
        const binding = await runtimeLease.runtime.reconcile({
          ref: operation.blockRef,
          operationId: operation.id
        });
        if (binding.divergenceReason && !binding.interruption) {
          this.options.operations.recordDiagnostic(
            operation.id,
            "remote_source_changed",
            binding.divergenceReason
          );
          throw new Error("remote_source_changed");
        }
      } catch (error) {
        const recovered = this.recoverRuntimeBindingReset(operation, error);
        if (recovered) return recovered;
        this.options.operations.recordDiagnostic(
          operation.id,
          "runtime_reconciliation_conflict",
          error instanceof Error ? error.message : "Runtime reconciliation failed."
        );
        throw error;
      }
    }
    let candidate = this.options.candidates.get(operation.id);
    if (!candidate) {
      if (operation.state !== "preparing") throw new Error("remote_operation_candidate_missing");
      candidate = await runtimeLease.runtime.inspect({ ref: operation.blockRef });
      if (
        candidate.projectId !== operation.projectId ||
        candidate.canvasId !== operation.canvasId ||
        candidate.sourceRevision !== operation.ownershipGeneration ||
        candidate.graphFingerprint !== operation.sourceFingerprint
      ) {
        this.options.operations.recordDiagnostic(
          operation.id,
          "remote_source_changed",
          "The Runtime source changed before the durable candidate could be restored."
        );
        throw new Error("remote_source_changed");
      }
      this.options.candidates.record(operation.id, candidate);
      await this.checkpoint("after_candidate_persistence");
    }

    if (reusePersistedDispatch) {
      const persistedOutcome = await this.resumePersistedDispatch(
        operation,
        candidate,
        runtimeLease
      );
      if (!persistedOutcome) throw new Error("remote_dispatch_persistence_missing");
      return persistedOutcome;
    }

    if (operation.state === "preparing" || operation.state === "reserved") {
      this.options.operations.recordDiagnosticStage(operation.id, "preparing_runtime");
      try {
        await runtimeLease.runtime.claim({
          ref: operation.blockRef,
          operationId: operation.id,
          controlPlane: runtimeControlPlane(operation.endpointSelection?.authority),
          sourceRevision: operation.ownershipGeneration,
          graphFingerprint: operation.sourceFingerprint
        });
        await this.checkpoint("after_runtime_claim");
      } catch (error) {
        this.options.operations.recordDiagnostic(
          operation.id,
          "runtime_claim_conflict",
          error instanceof Error ? error.message : "Runtime claim failed."
        );
        throw error;
      }
      operation = this.options.operations.getRequired(operation.id);
      if (operation.state === "preparing" || operation.state === "reserved") {
        operation = this.options.operations.markClaimed(operation.id);
      }
    }

    const managedRuntimeExecution = usesManagedCanvasRuntime(operation);
    if (managedRuntimeExecution) {
      if (!runtimeAttachment) throw new Error("runtime_attachment_missing");
      const runtimeContentTargets = this.options.runtimeContentTargets;
      if (!runtimeContentTargets) throw new Error("runtime_content_target_port_missing");
      await materializeAttachedWorkspaceRuntime({
        attachment: runtimeAttachment,
        candidate,
        lease: runtimeLease,
        ports: {
          contentTargets: runtimeContentTargets,
          ...(this.options.ensureRuntimeProjection
            ? { project: this.options.ensureRuntimeProjection }
            : {})
        }
      });
    }

    let ownerPackageLocator: OwnerPackageLocator | undefined;
    if (usesLegacyOwnerPackageRuntime(operation)) {
      const hostId = authorizedOperationHostId(operation);
      if (!hostId) throw new Error("remote_operation_authorized_host_missing");
      ownerPackageLocator = this.options.ownerPackageLocatorForHost?.({ hostId, candidate });
      if (!ownerPackageLocator) throw new Error("owner_package_locator_unavailable");
    }
    const runtimeMaterialization = managedRuntimeExecution
      ? await runtimeLease.readInitializationEvidence?.()
      : undefined;
    if (managedRuntimeExecution && runtimeMaterialization === undefined) {
      throw new CanvasRuntimeUnavailableError();
    }
    const envelope = buildRemoteBlockExecutionEnvelope(
      operation,
      candidate,
      ownerPackageLocator,
      runtimeMaterialization
    );
    const envelopeDigest = hashExecutionEnvelope(envelope);
    operation = this.options.operations.recordEnvelope({
      operationId: operation.id,
      digest: envelopeDigest
    });
    await this.checkpoint("after_envelope_persistence");
    this.options.operations.recordDiagnosticStage(operation.id, "materializing");
    await this.options.inputArtifacts.materialize(candidate, runtimeLease.artifacts);
    await this.checkpoint("after_input_materialization");

    const persistedOutcome = await this.resumePersistedDispatch(
      operation,
      candidate,
      runtimeLease,
      envelopeDigest
    );
    if (persistedOutcome) return persistedOutcome;

    let reservation = operation.attempt.leaseId
      ? this.options.reservations.getRequired(operation.attempt.leaseId)
      : undefined;
    if (!reservation) {
      try {
        this.options.operations.recordDiagnosticStage(operation.id, "authorizing");
        if (operation.endpointSelection) this.authorizeEndpointOperation(operation);
        const agentEndpoints = this.options.agentEndpoints;
        this.options.operations.recordDiagnosticStage(operation.id, "resolving_endpoint");
        const resolvedEndpoint =
          operation.endpointSelection && agentEndpoints
            ? resolveDurableDispatchEndpoint({
                operation,
                candidate,
                agentEndpoints
              })
            : undefined;
        const preferredHostId =
          resolvedEndpoint?.hostId ?? this.authority().resolvePreferredHostId(operation, candidate);
        this.options.operations.recordDiagnosticStage(operation.id, "reserving_host");
        reservation = this.options.reservations.reserve(operation.id, {
          preferredHostId,
          agentId: resolvedEndpoint?.agentId ?? candidate.agentId,
          agentProfileId: resolvedEndpoint?.profileId ?? candidate.agentProfileId
        });
        const reservedOperation = this.options.operations.getRequired(operation.id);
        if (reservedOperation.endpointSelection) {
          this.authorizeReservedEndpoint(reservedOperation, candidate, reservation);
        } else {
          this.options.finalAuthorize?.({ operation: reservedOperation, reservation });
        }
        await this.checkpoint("after_host_reservation");
        this.options.operations.clearDiagnostic(operation.id);
      } catch (error) {
        if (error instanceof Error && error.message === "no_compatible_agent_host") {
          if (operation.endpointSelection) {
            throw new AgentEndpointCatalogError("agent_endpoint_unavailable");
          }
          this.options.operations.recordDiagnostic(
            operation.id,
            "no_compatible_agent_host",
            "No compatible online Agent Host currently has reservation capacity."
          );
          return {
            operation: this.options.operations.getRequired(operation.id),
            status: "awaiting_host"
          };
        }
        if (operation.endpointSelection && error instanceof AgentEndpointCatalogError) {
          throw error;
        }
        if (error instanceof DispatchAssignmentError) {
          this.options.operations.recordDiagnostic(operation.id, error.code, error.message);
          return {
            operation: this.options.operations.getRequired(operation.id),
            status: "awaiting_host"
          };
        }
        throw error;
      }
    }
    operation = this.options.operations.getRequired(operation.id);
    this.options.operations.recordDiagnosticStage(operation.id, "dispatching");
    const runtimeContentTargets = this.options.runtimeContentTargets;
    this.options.dispatches.prepare({
      operation,
      reservation,
      envelope,
      envelopeDigest,
      ...(runtimeAttachment && runtimeContentTargets
        ? {
            validateBeforeCommit: () =>
              assertRuntimeAttachmentContentTarget({
                attachment: runtimeAttachment,
                candidate,
                contentTargets: runtimeContentTargets
              })
          }
        : {})
    });
    await this.checkpoint("after_dispatch_persistence");

    try {
      await runtimeLease.runtime.activate(remoteBlockIdentity(operation));
      await this.checkpoint("after_runtime_binding");
    } catch (error) {
      this.options.operations.recordDiagnostic(
        operation.id,
        "runtime_activation_conflict",
        error instanceof Error ? error.message : "Runtime activation failed."
      );
      throw error;
    }
    const command = mailboxCommandSchema.parse({
      type: "execute_block",
      protocolVersion: agentHostProtocolVersion,
      dispatchId: operation.dispatchId,
      leaseId: reservation.leaseId,
      executionAttemptId: operation.executionAttemptId,
      leaseExpiresAt: reservation.leaseExpiresAt,
      envelopeDigest,
      envelope
    });
    const delivery = this.options.dispatches.activate({ operation, reservation, command });
    await this.checkpoint("after_mailbox_enqueue");
    if (!delivery.message.publishedAt) {
      this.options.mailbox.publish(delivery.message);
      await this.checkpoint("after_mailbox_publish");
      this.options.dispatches.markMailboxPublished(delivery.message.messageId);
    }
    this.options.operations.clearDiagnostic(operation.id);
    return { operation: this.options.operations.getRequired(operation.id), status: "activated" };
  }

  async reenterPending(): Promise<RemoteDispatchOutcome[]> {
    const outcomes: RemoteDispatchOutcome[] = [];
    for (const operation of this.options.operations.listNonTerminal()) {
      let legacyRuntimeLease: CanvasExecutionRuntimeLease | undefined;
      try {
        if (
          (operation.state === "preparing" || operation.state === "claimed") &&
          operation.attempt.status === "prepared" &&
          !operation.attempt.leaseId &&
          !operation.agentAccess
        ) {
          if (!operation.endpointSelection) {
            if (operation.state === "preparing") this.options.operations.markClaimed(operation.id);
            throw new Error("remote_operation_endpoint_selection_missing");
          }
          legacyRuntimeLease = await acquireRemoteRuntimeLease(
            this.options.runtimeLeases,
            operation,
            authorizedOperationHostId(operation)
          );
          const current = await legacyRuntimeLease.runtime.inspect({ ref: operation.blockRef });
          const candidate = candidateForIdentity(operation, this.options.candidates);
          if (
            current.sourceRevision !== candidate.sourceRevision ||
            current.graphFingerprint !== candidate.graphFingerprint
          ) {
            if (operation.state === "preparing") this.options.operations.markClaimed(operation.id);
            this.options.operations.recordDiagnostic(
              operation.id,
              "remote_source_changed",
              "The Runtime source changed before Host reservation."
            );
            throw new Error("remote_source_changed");
          }
          await legacyRuntimeLease.release();
          legacyRuntimeLease = undefined;
          outcomes.push(await this.reenter(operation.id));
        } else {
          outcomes.push(await this.reenter(operation.id));
        }
      } catch (error) {
        const decision = classifyReenterFailure(error);
        if (decision === "fatal") throw error;
        const diagnostic = diagnosticFromReenterFailure(error);
        this.options.operations.recordDiagnostic(operation.id, diagnostic.code, diagnostic.message);
        if (decision === "defer_host") {
          outcomes.push({
            operation: this.options.operations.getRequired(operation.id),
            status: "awaiting_host"
          });
          continue;
        }
        outcomes.push(
          await this.writebackCoordinator().sealOperationLocalFailure(operation, error)
        );
      } finally {
        await legacyRuntimeLease?.release();
      }
    }
    return outcomes;
  }

  private async resumePersistedDispatch(
    operation: RemoteOperation,
    candidate: RemoteBlockDispatchCandidate,
    runtimeLease: CanvasExecutionRuntimeLease,
    envelopeDigest = operation.envelopeDigest
  ): Promise<RemoteDispatchOutcome | undefined> {
    if (!envelopeDigest) throw new Error("remote_operation_envelope_missing");
    const persisted = this.inspectPersistence(
      operation,
      envelopeDigest,
      candidate.inputArtifacts.length
    );
    if (!persisted.dispatch) return undefined;
    if (persisted.dispatch.status === "running" || persisted.dispatch.status === "cancelling") {
      this.options.operations.recordDiagnosticStage(
        operation.id,
        persisted.dispatch.status === "running" ? "running" : "cancelling"
      );
      await this.checkpoint("after_host_acceptance_observed");
      return { operation: this.options.operations.getRequired(operation.id), status: "active" };
    }
    if (persisted.dispatch.status === "leased" && operation.state === "activated") {
      return { operation: this.options.operations.getRequired(operation.id), status: "activated" };
    }
    if (persisted.dispatch.status === "leased") {
      if (!operation.attempt.leaseId) throw new Error("remote_attempt_reservation_missing");
      const reservation = this.options.reservations.getRequired(operation.attempt.leaseId);
      const envelope = this.options.dispatches.readEnvelope(operation);
      if (hashExecutionEnvelope(envelope) !== envelopeDigest) {
        this.recordInconsistency(operation, "The persisted dispatch envelope digest changed.");
      }
      await runtimeLease.runtime.activate(remoteBlockIdentity(operation));
      await this.checkpoint("after_runtime_binding");
      const command = mailboxCommandSchema.parse({
        type: "execute_block",
        protocolVersion: agentHostProtocolVersion,
        dispatchId: operation.dispatchId,
        leaseId: reservation.leaseId,
        executionAttemptId: operation.executionAttemptId,
        leaseExpiresAt: reservation.leaseExpiresAt,
        envelopeDigest,
        envelope
      });
      const delivery = this.options.dispatches.activate({ operation, reservation, command });
      await this.checkpoint("after_mailbox_enqueue");
      if (!delivery.message.publishedAt) {
        this.options.mailbox.publish(delivery.message);
        await this.checkpoint("after_mailbox_publish");
        this.options.dispatches.markMailboxPublished(delivery.message.messageId);
      }
      this.options.operations.clearDiagnostic(operation.id);
      return { operation: this.options.operations.getRequired(operation.id), status: "activated" };
    }
    if (persisted.dispatch.status === "interrupted") {
      const interruption = persisted.dispatch.interruption;
      if (!interruption) {
        this.recordInconsistency(operation, "An interrupted dispatch has no interruption payload.");
      }
      await runtimeLease.runtime.markInterrupted({
        ...remoteBlockIdentity(operation),
        interruption,
        ...(operation.endpointSelection?.agentId
          ? { agentId: operation.endpointSelection.agentId }
          : {})
      });
      return {
        operation: this.options.operations.getRequired(operation.id),
        status: "wait_for_action"
      };
    }
    if (persisted.dispatch.status === "awaiting_writeback") {
      await this.checkpoint("after_terminal_event_persistence");
      const action = persisted.dispatch.terminalAction;
      if (!action) {
        this.recordInconsistency(
          operation,
          "An awaiting-writeback dispatch has no terminal payload."
        );
      }
      if (action.kind === "complete") {
        await this.complete(operation.id, runtimeLease);
      } else {
        await this.fail(operation.id, runtimeLease);
      }
      return {
        operation: this.options.operations.getRequired(operation.id),
        status: "terminal"
      };
    }
    if (
      persisted.dispatch.status === "completed" ||
      persisted.dispatch.status === "failed" ||
      persisted.dispatch.status === "cancelled"
    ) {
      this.writebackCoordinator().finalizeOperationTerminal(operation, persisted.dispatch.status);
      return {
        operation: this.options.operations.getRequired(operation.id),
        status: "terminal"
      };
    }
    return undefined;
  }

  private recoverRuntimeBindingReset(
    operation: RemoteOperation,
    error: unknown
  ): RemoteDispatchOutcome | undefined {
    if (
      !(error instanceof RemoteOwnershipConflictError) ||
      error.code !== "remote_ownership_not_active"
    ) {
      return undefined;
    }

    const persisted = this.options.dispatches.inspect(operation);
    if (
      operation.state === "claimed" &&
      operation.attempt.status === "prepared" &&
      operation.attempt.hostId === undefined &&
      operation.attempt.leaseId === undefined &&
      !persisted.dispatch &&
      !persisted.mailbox
    ) {
      const cancelled = this.options.operations.cancelClaimedAfterRuntimeReset({
        operationId: operation.id,
        executionAttemptId: operation.executionAttemptId
      });
      return { operation: cancelled, status: "terminal" };
    }

    if (
      operation.state !== "interrupted" ||
      operation.attempt.status !== "interrupted" ||
      operation.attempt.leaseId === undefined ||
      (persisted.dispatch?.status !== "interrupted" && persisted.dispatch?.status !== "cancelled")
    ) {
      return undefined;
    }
    const reservation = this.options.reservations.getRequired(operation.attempt.leaseId);
    if (reservation.status === "active") return undefined;
    if (persisted.dispatch.status === "interrupted") {
      this.options.dispatches.cancelInterruptedAfterRuntimeReset(operation);
    }
    this.options.operations.recordDiagnostic(
      operation.id,
      "runtime_binding_reset",
      "Runtime reset removed remote ownership after the remote execution was interrupted."
    );
    this.writebackCoordinator().finalizeOperationTerminal(operation, "cancelled");
    return {
      operation: this.options.operations.getRequired(operation.id),
      status: "terminal"
    };
  }

  async reenterWaitingForHost(hostId: string): Promise<RemoteDispatchOutcome[]> {
    const waiting = this.options.operations
      .listNonTerminal()
      .filter(
        (operation) =>
          (operation.state === "preparing" || operation.state === "claimed") &&
          operation.attempt.status === "prepared" &&
          operation.endpointSelection?.hostId === hostId
      );
    const outcomes: RemoteDispatchOutcome[] = [];
    for (const operation of waiting) {
      try {
        outcomes.push(await this.reenter(operation.id));
      } catch (error) {
        if (
          !(error instanceof AgentEndpointCatalogError) ||
          error.code !== "agent_endpoint_unavailable"
        ) {
          throw error;
        }
        this.options.operations.recordDiagnostic(operation.id, error.code, error.message);
        outcomes.push({
          operation: this.options.operations.getRequired(operation.id),
          status: "awaiting_host"
        });
      }
    }
    return outcomes;
  }

  async query(operationId: string) {
    const operation = this.options.operations.getRequired(operationId);
    return this.withRuntime(operation, (runtime) =>
      runtime.query({
        ref: operation.blockRef,
        operationId: operation.id
      })
    );
  }

  async executeAction(rawAction: unknown): Promise<RemoteExecutionActionRecord> {
    return this.actionCoordinator().execute(rawAction);
  }

  async executeHumanAction(rawCommand: unknown): Promise<RemoteExecutionActionRecord> {
    return this.actionCoordinator().executeHuman(rawCommand);
  }

  async reconcileActions(startupContext?: {
    serverInstanceOwnerToken: string;
  }): Promise<RemoteExecutionActionRecord[]> {
    return this.actionCoordinator().reconcile(startupContext);
  }

  async requestCancel(operationId: string, reason: string): Promise<void> {
    await this.actionCoordinator().requestCancel(operationId, reason);
  }

  private actionCoordinator(): RemoteBlockActionCoordinator {
    this.actionsCoordinator ??= new RemoteBlockActionCoordinator(this.options, {
      reenter: (operationId) => this.reenter(operationId),
      fail: (operationId) => this.fail(operationId),
      sealOperationLocalFailure: async (operation, error) => {
        await this.writebackCoordinator().sealOperationLocalFailure(operation, error);
      },
      authorizeEndpointOperation: (operation, reservation) =>
        this.authorizeEndpointOperation(operation, reservation),
      reauthorizeAgentAccessForRetry: (operation) => this.reauthorizeAgentAccessForRetry(operation),
      checkpoint: () => this.checkpoint("after_action_side_effect")
    });
    return this.actionsCoordinator;
  }

  private writebackCoordinator(): RemoteBlockWritebackCoordinator {
    this.terminalWriteback ??= new RemoteBlockWritebackCoordinator({
      runtimeLeases: this.options.runtimeLeases,
      operations: this.options.operations,
      candidates: this.options.candidates,
      reservations: this.options.reservations,
      dispatches: this.options.dispatches,
      artifactContent: this.options.artifactContent,
      checkpoint: (point) => this.checkpoint(point),
      authorizeActiveWriteback: (operation, candidate, reservation) => {
        if (operation.endpointSelection) {
          if (!candidate) throw new Error("remote_operation_candidate_missing");
          this.authorizeReservedEndpoint(operation, candidate, reservation);
          return;
        }
        this.options.finalAuthorize?.({ operation, reservation });
      }
    });
    return this.terminalWriteback;
  }

  private preparationCoordinator(): RemoteDispatchPreparationCoordinator {
    this.dispatchPreparation ??= new RemoteDispatchPreparationCoordinator({
      operations: this.options.operations,
      reservations: this.options.reservations,
      dispatches: this.options.dispatches,
      agentEndpoints: this.options.agentEndpoints,
      runtimeContentTargets: this.options.runtimeContentTargets,
      ensureRuntimeAttachment: this.options.ensureRuntimeAttachment,
      findRuntimeAttachment: this.options.findRuntimeAttachment,
      finalAuthorize: this.options.finalAuthorize,
      authorizeEndpointOperation: (operation) => this.authorizeEndpointOperation(operation),
      authorizeReservedEndpoint: (operation, candidate, reservation) =>
        this.authorizeReservedEndpoint(operation, candidate, reservation),
      checkpoint: (point) => this.checkpoint(point)
    });
    return this.dispatchPreparation;
  }

  private authority(): RemoteEndpointExecutionAuthority {
    this.endpointAuthority ??= new RemoteEndpointExecutionAuthority({
      operations: this.options.operations,
      candidates: this.options.candidates,
      reservations: this.options.reservations,
      assignmentGate: this.options.assignmentGate,
      agentEndpoints: this.options.agentEndpoints,
      authorizeRemoteAgentUse: this.options.authorizeRemoteAgentUse,
      endpointAuthorize: this.options.endpointAuthorize,
      recordInconsistency: (operation, message) => this.recordInconsistency(operation, message)
    });
    return this.endpointAuthority;
  }

  async complete(operationId: string, existingLease?: CanvasExecutionRuntimeLease): Promise<void> {
    await this.writebackCoordinator().complete(operationId, existingLease);
  }

  async fail(operationId: string, existingLease?: CanvasExecutionRuntimeLease): Promise<void> {
    await this.writebackCoordinator().fail(operationId, existingLease);
  }

  private inspectPersistence(
    operation: RemoteOperation,
    envelopeDigest: string,
    expectedInputGrantCount: number
  ) {
    try {
      const persisted = this.options.dispatches.inspect(operation);
      if (persisted.dispatch) {
        if (persisted.dispatch.envelopeDigest !== envelopeDigest) {
          this.recordInconsistency(
            operation,
            "The persisted dispatch envelope is missing or changed."
          );
        }
        if (persisted.dispatch.inputGrantCount !== expectedInputGrantCount) {
          this.recordInconsistency(
            operation,
            "The persisted dispatch input grants do not match the immutable envelope."
          );
        }
      }
      if (persisted.mailbox && !persisted.dispatch) {
        this.recordInconsistency(operation, "A mailbox command exists without a dispatch.");
      }
      if (operation.state === "activated" && !persisted.mailbox) {
        this.recordInconsistency(operation, "An activated attempt has no durable mailbox command.");
      }
      return persisted;
    } catch (error) {
      if (error instanceof Error && error.message === "remote_persistence_inconsistent") {
        throw error;
      }
      this.options.operations.recordDiagnostic(
        operation.id,
        "remote_persistence_inconsistent",
        error instanceof Error ? error.message : "Persisted coordinator state is invalid."
      );
      throw new Error("remote_persistence_inconsistent", { cause: error });
    }
  }

  private recordInconsistency(operation: RemoteOperation, message: string): never {
    this.options.operations.recordDiagnostic(
      operation.id,
      "remote_persistence_inconsistent",
      message
    );
    throw new Error("remote_persistence_inconsistent");
  }

  private authorizeReservedEndpoint(
    operation: RemoteOperation,
    candidate: RemoteBlockDispatchCandidate,
    reservation: HostCapacityReservation
  ): void {
    this.authority().authorizeReservedEndpoint(operation, candidate, reservation);
  }

  reauthorizeAgentAccessForRetry(operation: RemoteOperation): PersistedRemoteAgentAccessSnapshot {
    return this.authority().reauthorizeForRetry(operation);
  }

  authorizeEndpointOperation(
    operation: RemoteOperation,
    reservation?: HostCapacityReservation,
    candidate: RemoteBlockDispatchCandidate = candidateForIdentity(
      operation,
      this.options.candidates
    )
  ): void {
    this.authority().authorize(operation, reservation, candidate);
  }
}
