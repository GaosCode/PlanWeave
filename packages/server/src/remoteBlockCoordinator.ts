import {
  agentHostProtocolVersion,
  hashExecutionEnvelope,
  mailboxCommandSchema,
  userRequiredCapabilitiesSchema,
  WORKSPACE_CANVAS_EXECUTION_CAPABILITY,
  type OwnerPackageLocator
} from "@planweave-ai/agent-host-protocol";
import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  RemoteOwnershipConflictError,
  remoteBlockDispatchCandidateSchema,
  type RemoteBlockDispatchCandidate,
  type RemoteBlockRuntimePort
} from "@planweave-ai/runtime";
import type {
  RemoteArtifactContentPort,
  RemoteAcpTranscriptPort,
  RemoteCoordinatorCheckpoint,
  RemoteCoordinatorCheckpointPort,
  RemoteDispatchPersistencePort,
  RemoteInputArtifactPort,
  RemoteMailboxPublisherPort,
  RemoteOperationCandidatePort,
  RemoteRuntimeLocator
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
import type { RuntimeAttachmentRequest } from "./canvas/runtimeAttachment.js";
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
import { runtimeAuthoritySnapshotForTarget, runtimeControlPlane } from "./endpointSelection.js";
import type { AuthorizeRemoteAgentUseInput } from "./remoteAgent/accessPolicy.js";
import { RemoteAgentAuthorizationError } from "./remoteAgent/errors.js";
import {
  persistedRemoteAgentAccessSnapshotSchema,
  type AuthorizedRemoteAgentUse,
  type PersistedRemoteAgentAccessSnapshot
} from "./remoteAgent/schema.js";
import {
  deriveEndpointAvailabilityPolicyFromAuthorized,
  dispatchTarget,
  retryTarget
} from "./remoteAgent/dispatchTarget.js";
import { classifyReenterFailure, diagnosticFromReenterFailure } from "./remoteReenterRecovery.js";
import { RemoteBlockWritebackCoordinator } from "./remoteBlockWritebackCoordinator.js";
import {
  canonicalizeDispatchCaller,
  parseDispatchCaller,
  sameDispatchCaller
} from "./remoteBlockDispatchIdentity.js";
import {
  assertReservedDispatchEndpoint,
  candidateForIdentity,
  resolveDurableDispatchEndpoint,
  snapshotDispatchEndpoint
} from "./remoteBlockCoordinatorEndpoint.js";
import type { HumanPrincipalIdentity } from "./identity/humanPrincipalIdentity.js";
import {
  buildRemoteBlockExecutionEnvelope,
  inspectRemoteBlockDispatchCandidate
} from "./remoteBlockDispatchPreparation.js";

export type RemoteEndpointDispatchRequest = RemoteRuntimeLocator & {
  blockRef: string;
  idempotencyKey: string;
  agentEndpointId: string;
  expectedResponsibilityRevision: number;
  expectedReviewerRevision: number;
  /** Canvas locator kind. Not an Agent class or grant switch. */
  targetKind: "owner_canvas" | "workspace_canvas";
  /** Required for new dispatches. Never an operatorId. */
  callerHumanPrincipalId: string;
};

export type RemoteDispatchOutcome = {
  operation: RemoteOperation;
  status:
    | "awaiting_host"
    | "activated"
    | "active"
    | "wait_for_action"
    | "awaiting_writeback"
    | "terminal";
};

function candidateForRuntimeTarget(
  candidate: RemoteBlockDispatchCandidate,
  targetKind: RemoteEndpointDispatchRequest["targetKind"]
): RemoteBlockDispatchCandidate {
  const userRequiredCapabilities = userRequiredCapabilitiesSchema.parse(
    candidate.requiredCapabilities
  );
  if (targetKind === "owner_canvas") {
    return remoteBlockDispatchCandidateSchema.parse({
      ...candidate,
      requiredCapabilities: userRequiredCapabilities
    });
  }
  const requiredCapabilities = new Set(userRequiredCapabilities);
  requiredCapabilities.add(WORKSPACE_CANVAS_EXECUTION_CAPABILITY);
  return remoteBlockDispatchCandidateSchema.parse({
    ...candidate,
    requiredCapabilities: [...requiredCapabilities]
  });
}

export type RemoteBlockCoordinatorOptions = {
  runtimeLeases: CanvasExecutionRuntimeRoutePort;
  operations: RemoteOperationRepository;
  actions: RemoteExecutionActionRepository;
  candidates: RemoteOperationCandidatePort;
  reservations: HostReservationRepository;
  dispatches: RemoteDispatchPersistencePort;
  mailbox: RemoteMailboxPublisherPort;
  inputArtifacts: RemoteInputArtifactPort;
  artifactContent: RemoteArtifactContentPort;
  acpTranscript: RemoteAcpTranscriptPort;
  checkpoints?: RemoteCoordinatorCheckpointPort;
  /**
   * Optional assignment gate consulted before Host reservation.
   * When set, human/unassigned Blocks require allowHumanOverride; exact Host is pinned;
   * automatic uses the deterministic selector with package capabilities.
   */
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
  /** Final server-side HostAuthorization check after a lease exists and before activation. */
  finalAuthorize?: (input: {
    operation: RemoteOperation;
    reservation: HostCapacityReservation;
  }) => void;
  ownerPackageLocatorForHost?: (input: {
    hostId: string;
    candidate: RemoteBlockDispatchCandidate;
  }) => OwnerPackageLocator | undefined;
  /** Server-internal Canvas Runtime routing after authorize/reserve. Not a Desktop Host. */
  ensureRuntimeAttachment?: (input: RuntimeAttachmentRequest) => void;
  /**
   * Idempotent Host evidence → Server Runtime projection after attach.
   * Shares the initialize coordinator persist writer; never resets Host state.
   */
  ensureRuntimeProjection?: (
    input: RuntimeAttachmentRequest & { lease: CanvasExecutionRuntimeLease }
  ) => void | Promise<void>;
  serverInstanceOwnerToken: string;
  humanIdentity: HumanPrincipalIdentity;
};

export class RemoteBlockCoordinator {
  private actionsCoordinator: RemoteBlockActionCoordinator | undefined;
  private terminalWriteback: RemoteBlockWritebackCoordinator | undefined;

  constructor(private readonly options: RemoteBlockCoordinatorOptions) {}

  private async checkpoint(point: RemoteCoordinatorCheckpoint): Promise<void> {
    await this.options.checkpoints?.reached(point);
  }

  private async withRuntime<T>(
    locator: RemoteRuntimeLocator,
    operation: (runtime: RemoteBlockRuntimePort) => Promise<T>
  ): Promise<T> {
    const acquired = await acquireRemoteRuntimeLease(
      this.options.runtimeLeases,
      locator,
      undefined
    );
    try {
      return await operation(acquired.runtime);
    } finally {
      await acquired.release();
    }
  }

  /**
   * Expose the Host selection authorized at dispatch begin (or last retry resnapshot).
   * Prefer durable operation snapshot so restart and retry do not lose the fingerprint.
   * Same-attempt reenter never re-derives from a later assignment; retry_new_attempt does.
   */
  getAuthorizedHostSelection(operationId: string): DispatchHostSelectionSnapshot | undefined {
    return this.options.operations.get(operationId)?.hostSelection;
  }

  async dispatch(request: RemoteEndpointDispatchRequest): Promise<RemoteDispatchOutcome> {
    const requestedCaller = parseDispatchCaller(request.callerHumanPrincipalId);
    const target = dispatchTarget(request);
    const existing = this.options.operations.findByCallerIdentity(request);
    if (existing) {
      const originalCaller = existing.agentAccess?.callerHumanPrincipalId;
      if (!originalCaller) {
        throw new RemoteAgentAuthorizationError("remote_agent_access_snapshot_missing");
      }
      if (!sameDispatchCaller(this.options.humanIdentity, originalCaller, requestedCaller)) {
        throw new Error("remote_operation_idempotency_conflict");
      }
      if (
        existing.endpointSelection?.endpointId !== request.agentEndpointId ||
        existing.endpointSelection.authority.kind !== target.kind
      ) {
        throw new Error("remote_operation_idempotency_conflict");
      }
      return this.reenter(existing.id);
    }

    const callerHumanPrincipalId = canonicalizeDispatchCaller(
      this.options.humanIdentity,
      requestedCaller
    );
    let authorizedHostId: string | undefined;
    if (
      this.options.agentEndpoints &&
      this.options.endpointAuthorize &&
      this.options.authorizeRemoteAgentUse &&
      request.targetKind === "workspace_canvas"
    ) {
      const authorized = this.options.authorizeRemoteAgentUse({
        principal: { humanPrincipalId: callerHumanPrincipalId },
        endpointId: request.agentEndpointId,
        target,
        requiredCapabilities: [WORKSPACE_CANVAS_EXECUTION_CAPABILITY],
        runtimeWorkspaceId: request.workspaceId,
        blockRef: request.blockRef,
        expectedResponsibilityRevision: request.expectedResponsibilityRevision,
        expectedReviewerRevision: request.expectedReviewerRevision
      });
      authorizedHostId = authorized.remoteAgent.hostId;
    }
    const candidate = candidateForRuntimeTarget(
      await inspectRemoteBlockDispatchCandidate(
        this.options.runtimeLeases,
        request,
        authorizedHostId
      ),
      request.targetKind
    );
    if (
      candidate.workspaceId !== request.workspaceId ||
      candidate.projectId !== request.projectId ||
      candidate.canvasId !== request.canvasId
    ) {
      throw new Error("remote_runtime_locator_candidate_mismatch");
    }

    // Access + availability are captured before persistence. Reentry uses this snapshot.
    if (
      !this.options.agentEndpoints ||
      !this.options.endpointAuthorize ||
      !this.options.authorizeRemoteAgentUse
    ) {
      throw new Error("agent_endpoint_dispatch_not_configured");
    }
    const authorized = this.options.authorizeRemoteAgentUse({
      principal: { humanPrincipalId: callerHumanPrincipalId },
      endpointId: request.agentEndpointId,
      target,
      requiredCapabilities: candidate.requiredCapabilities,
      runtimeWorkspaceId: candidate.workspaceId,
      blockRef: candidate.blockRef,
      expectedResponsibilityRevision: request.expectedResponsibilityRevision,
      expectedReviewerRevision: request.expectedReviewerRevision
    });
    const endpointSelection = snapshotDispatchEndpoint(
      this.options.agentEndpoints.resolveForRun(
        request.agentEndpointId,
        target.kind === "workspace_canvas" ? target.workspaceId : candidate.workspaceId,
        candidate.requiredCapabilities,
        deriveEndpointAvailabilityPolicyFromAuthorized(authorized)
      ),
      candidate,
      runtimeAuthoritySnapshotForTarget(target, {
        responsibilityRevision: request.expectedResponsibilityRevision,
        reviewerRevision: request.expectedReviewerRevision
      })
    );
    const agentAccess = persistedRemoteAgentAccessSnapshotSchema.parse({
      callerHumanPrincipalId,
      authorized
    });

    await this.checkpoint("before_operation_commit");
    const operation = this.options.operations.create({
      workspaceId: workspaceIdSchema.parse(candidate.workspaceId),
      projectId: candidate.projectId,
      canvasId: candidate.canvasId,
      blockRef: candidate.blockRef,
      ownershipGeneration: candidate.sourceRevision,
      idempotencyKey: request.idempotencyKey,
      sourceFingerprint: candidate.graphFingerprint,
      requiredCapabilities: candidate.requiredCapabilities,
      endpointSelection,
      agentAccess
    });
    await this.checkpoint("after_operation_commit");
    this.options.candidates.record(operation.id, candidate);
    await this.checkpoint("after_candidate_persistence");
    return this.reenter(operation.id);
  }

  async reenter(operationId: string): Promise<RemoteDispatchOutcome> {
    const operation = this.options.operations.getRequired(operationId);
    if (["completed", "failed", "cancelled"].includes(operation.state)) {
      return { operation, status: "terminal" };
    }
    const lease = await acquireRemoteRuntimeLease(
      this.options.runtimeLeases,
      operation,
      authorizedOperationHostId(operation)
    );
    try {
      return await this.reenterWithLease(operationId, lease);
    } finally {
      await lease.release();
    }
  }

  private async reenterWithLease(
    operationId: string,
    runtimeLease: CanvasExecutionRuntimeLease
  ): Promise<RemoteDispatchOutcome> {
    let operation = this.options.operations.getRequired(operationId);
    if (["completed", "failed", "cancelled"].includes(operation.state)) {
      return { operation, status: "terminal" };
    }
    // Host already delivered a durable terminal payload: finish package writeback
    // before any live Host re-authorization. Lease expiry / endpoint blips must not
    // strand awaiting_writeback as interrupted forever.
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
    // Recheck Host authority only while an active attempt still holds a lease.
    // Interrupted / action_required recovery releases the prior lease and waits for
    // resume/retry; a new reservation path re-authorizes after it acquires a lease.
    const activeAuthorityAttempt = [
      "reserved",
      "activated",
      "running",
      "awaiting_writeback"
    ].includes(operation.attempt.status);
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
    if (operation.state !== "preparing") {
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

    if (operation.state === "preparing") {
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
      if (operation.state === "preparing") {
        operation = this.options.operations.markClaimed(operation.id);
      }
    }

    const ownerPackageLocator =
      operation.endpointSelection?.authority.kind !== "owner_canvas"
        ? undefined
        : this.options.ownerPackageLocatorForHost?.({
            hostId: operation.endpointSelection.hostId,
            candidate
          });
    const runtimeMaterialization =
      operation.endpointSelection?.authority.kind === "workspace_canvas"
        ? await runtimeLease.readInitializationEvidence?.()
        : undefined;
    if (
      operation.endpointSelection?.authority.kind === "workspace_canvas" &&
      runtimeMaterialization === undefined
    ) {
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

    const persisted = this.inspectPersistence(
      operation,
      envelopeDigest,
      candidate.inputArtifacts.length
    );
    if (persisted.dispatch?.status === "running" || persisted.dispatch?.status === "cancelling") {
      this.options.operations.recordDiagnosticStage(
        operation.id,
        persisted.dispatch.status === "running" ? "running" : "cancelling"
      );
      await this.checkpoint("after_host_acceptance_observed");
      return { operation: this.options.operations.getRequired(operation.id), status: "active" };
    }
    if (persisted.dispatch?.status === "leased" && operation.state === "activated") {
      return { operation: this.options.operations.getRequired(operation.id), status: "activated" };
    }
    if (persisted.dispatch?.status === "interrupted") {
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
    if (persisted.dispatch?.status === "awaiting_writeback") {
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
      persisted.dispatch?.status === "completed" ||
      persisted.dispatch?.status === "failed" ||
      persisted.dispatch?.status === "cancelled"
    ) {
      this.writebackCoordinator().finalizeOperationTerminal(operation, persisted.dispatch.status);
      return {
        operation: this.options.operations.getRequired(operation.id),
        status: "terminal"
      };
    }

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
          resolvedEndpoint?.hostId ?? this.resolvePreferredHostId(operation, candidate);
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
        // Legacy null host_selection recovery may revalidate assignment and find it no longer
        // agent-dispatchable. Record diagnostics and leave non-terminal — never abort other
        // operations' startup reconciliation.
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
    if (
      this.options.ensureRuntimeAttachment &&
      operation.endpointSelection?.authority.kind === "workspace_canvas"
    ) {
      this.options.operations.recordDiagnosticStage(operation.id, "attaching_runtime");
      this.options.ensureRuntimeAttachment({
        workspaceId: operation.workspaceId,
        projectId: operation.projectId,
        canvasId: operation.canvasId,
        hostId: reservation.hostId,
        operationId: operation.id,
        executionAttemptId: operation.executionAttemptId,
        graphFingerprint: operation.sourceFingerprint
      });
      await this.options.ensureRuntimeProjection?.({
        workspaceId: operation.workspaceId,
        projectId: operation.projectId,
        canvasId: operation.canvasId,
        hostId: reservation.hostId,
        operationId: operation.id,
        executionAttemptId: operation.executionAttemptId,
        graphFingerprint: operation.sourceFingerprint,
        lease: runtimeLease
      });
    }
    this.options.operations.recordDiagnosticStage(operation.id, "dispatching");
    this.options.dispatches.prepare({ operation, reservation, envelope, envelopeDigest });
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
      let runtimeLease: CanvasExecutionRuntimeLease | undefined;
      try {
        runtimeLease = await acquireRemoteRuntimeLease(
          this.options.runtimeLeases,
          operation,
          authorizedOperationHostId(operation)
        );
        outcomes.push(await this.reenterWithLease(operation.id, runtimeLease));
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
          await this.writebackCoordinator().sealOperationLocalFailure(
            operation,
            error,
            runtimeLease
          )
        );
      } finally {
        await runtimeLease?.release();
      }
    }
    return outcomes;
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
          operation.state === "claimed" &&
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
      acpTranscript: this.options.acpTranscript,
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

  /**
   * Prefer the Host selection authorized at dispatch begin (or last retry resnapshot).
   * Durable operation.hostSelection is authoritative for same-attempt reenter after restart;
   * never re-resolve from a later assignment while a snapshot exists.
   * Active reserved Host is never rewritten by reassignment (lease remains on reservation).
   *
   * Pre-v18 rows may have host_selection_json NULL after migration. Recover once by
   * revalidating current assignment and persisting — do not throw and block startup.
   * Post-v18 creates always snapshot at dispatch begin; this null path is legacy-only.
   */
  private resolvePreferredHostId(
    operation: RemoteOperation,
    candidate: RemoteBlockDispatchCandidate
  ): string | undefined {
    const durable = operation.hostSelection;
    if (durable) {
      return durable.preferredHostId;
    }
    if (!this.options.assignmentGate) {
      return undefined;
    }
    const snapshot = this.options.assignmentGate.resolve({
      workspaceId: candidate.workspaceId,
      projectId: operation.projectId,
      canvasId: operation.canvasId,
      blockRef: operation.blockRef,
      requiredCapabilities: operation.requiredCapabilities,
      agentId: candidate.agentId,
      agentProfileId: candidate.agentProfileId,
      allowHumanOverride: false,
      ...(operation.hostSelection?.authorityRevisions
        ? {
            expectedResponsibilityRevision:
              operation.hostSelection.authorityRevisions.responsibilityRevision,
            expectedReviewerRevision: operation.hostSelection.authorityRevisions.reviewerRevision,
            expectedExecutionTargetRevision:
              operation.hostSelection.authorityRevisions.executionTargetRevision
          }
        : {})
    });
    const persisted = this.options.operations.persistHostSelection(operation.id, snapshot);
    if (!persisted.hostSelection) {
      return this.recordInconsistency(
        persisted,
        "Host selection was not persisted for an actionable remote operation."
      );
    }
    return persisted.hostSelection.preferredHostId;
  }

  private authorizeReservedEndpoint(
    operation: RemoteOperation,
    candidate: RemoteBlockDispatchCandidate,
    reservation: HostCapacityReservation
  ): void {
    try {
      this.authorizeEndpointOperation(operation, reservation, candidate);
    } catch (error) {
      if (reservation.status === "active") {
        this.options.reservations.release({
          leaseId: reservation.leaseId,
          fencingToken: reservation.fencingToken,
          expectedVersion: reservation.version,
          reason: "expired"
        });
      }
      throw error;
    }
  }

  reauthorizeAgentAccessForRetry(operation: RemoteOperation): PersistedRemoteAgentAccessSnapshot {
    const snapshot = operation.agentAccess;
    if (!snapshot) {
      throw new RemoteAgentAuthorizationError("remote_agent_access_snapshot_missing");
    }
    if (!this.options.authorizeRemoteAgentUse) {
      throw new Error("agent_endpoint_dispatch_not_configured");
    }
    const endpointId =
      operation.endpointSelection?.endpointId ?? snapshot.authorized.remoteAgent.endpointId;
    const target = retryTarget(operation, snapshot.authorized);
    const authorized = this.options.authorizeRemoteAgentUse({
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

  authorizeEndpointOperation(
    operation: RemoteOperation,
    reservation?: HostCapacityReservation,
    candidate: RemoteBlockDispatchCandidate = candidateForIdentity(
      operation,
      this.options.candidates
    )
  ): void {
    const selection = operation.endpointSelection;
    if (!selection || !this.options.endpointAuthorize || !this.options.agentEndpoints) {
      throw new Error("agent_endpoint_dispatch_not_configured");
    }
    this.options.endpointAuthorize({
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
        agentEndpoints: this.options.agentEndpoints
      });
      return;
    }
    resolveDurableDispatchEndpoint({
      operation,
      candidate,
      agentEndpoints: this.options.agentEndpoints
    });
  }
}
