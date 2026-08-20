import {
  OUTPUT_MAX_ARTIFACT_BYTES,
  OUTPUT_MAX_ARTIFACT_COUNT,
  agentHostProtocolVersion,
  assertAgentHostProtocolCompatible,
  executionEnvelopeSchema,
  hashExecutionEnvelope,
  mailboxCommandSchema,
  type OwnerPackageLocator
} from "@planweave-ai/agent-host-protocol";
import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { RemoteBlockDispatchCandidate, RemoteBlockRuntimePort } from "@planweave-ai/runtime";
import {
  RemoteBlockRuntimeError,
  RemoteOwnershipConflictError,
  remoteBlockFailureInputSchema
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
import type {
  CanvasExecutionRuntimeLease,
  CanvasExecutionRuntimeLeasePort
} from "./canvas/executionRuntimePort.js";
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
import {
  AgentEndpointCatalog,
  AgentEndpointCatalogError,
  type ResolvedAgentEndpoint
} from "./agentEndpointCatalog.js";
import {
  endpointSelectionSnapshotSchema,
  type EndpointSelectionSnapshot
} from "./endpointSelection.js";
import {
  classifyReenterFailure,
  diagnosticFromReenterFailure,
  isMissingActiveOwnership,
  isWritebackDomainFailure
} from "./remoteReenterRecovery.js";

export type RemoteEndpointDispatchRequest = RemoteRuntimeLocator & {
  blockRef: string;
  idempotencyKey: string;
  agentEndpointId: string;
  expectedResponsibilityRevision: number;
  expectedReviewerRevision: number;
  controlPlane?: "collaboration" | "owner";
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

export type RemoteBlockCoordinatorOptions = {
  runtimeLeases: CanvasExecutionRuntimeLeasePort;
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
  serverInstanceOwnerToken: string;
};

function buildEnvelope(
  operation: RemoteOperation,
  candidate: RemoteBlockDispatchCandidate,
  ownerPackageLocator?: OwnerPackageLocator
) {
  const protocolCheck = assertAgentHostProtocolCompatible(agentHostProtocolVersion);
  if (!protocolCheck.ok) {
    throw new Error(`${protocolCheck.code}:${protocolCheck.message}`);
  }
  return executionEnvelopeSchema.parse({
    protocolVersion: agentHostProtocolVersion,
    execution: {
      dispatchId: operation.dispatchId,
      attemptId: operation.executionAttemptId
    },
    projectId: candidate.projectId,
    canvasId: candidate.canvasId,
    taskId: candidate.taskId,
    blockRef: candidate.blockRef,
    blockType: candidate.blockType,
    sourceRevision: candidate.sourceRevision,
    graphFingerprint: candidate.graphFingerprint,
    renderedPrompt: candidate.renderedPrompt,
    acceptance: candidate.acceptance,
    dependencySummaries: candidate.dependencySummaries,
    inputArtifacts: candidate.inputArtifacts,
    workspaceId: candidate.workspaceId,
    ...(ownerPackageLocator === undefined ? {} : { ownerPackageLocator }),
    agentId: operation.endpointSelection?.agentId ?? candidate.agentId,
    agentProfileId: operation.endpointSelection?.profileId ?? candidate.agentProfileId,
    session: candidate.session,
    requiredCapabilities: candidate.requiredCapabilities,
    output: {
      reportRequired: true,
      maxArtifactBytes: OUTPUT_MAX_ARTIFACT_BYTES,
      maxArtifactCount: OUTPUT_MAX_ARTIFACT_COUNT
    },
    trace: { correlationId: operation.id }
  });
}

export class RemoteBlockCoordinator {
  private actionsCoordinator: RemoteBlockActionCoordinator | undefined;

  constructor(private readonly options: RemoteBlockCoordinatorOptions) {}

  private async checkpoint(point: RemoteCoordinatorCheckpoint): Promise<void> {
    await this.options.checkpoints?.reached(point);
  }

  private async withRuntime<T>(
    locator: RemoteRuntimeLocator,
    operation: (runtime: RemoteBlockRuntimePort) => Promise<T>
  ): Promise<T> {
    const acquired = await this.options.runtimeLeases.acquire(locator);
    try {
      return await operation(acquired.runtime);
    } finally {
      await acquired.release();
    }
  }

  private async inspectDispatchCandidate(
    request: RemoteEndpointDispatchRequest
  ): Promise<RemoteBlockDispatchCandidate> {
    try {
      return await this.withRuntime(request, (runtime) =>
        runtime.inspect({ ref: request.blockRef })
      );
    } catch (error) {
      if (
        !(error instanceof RemoteBlockRuntimeError) ||
        error.code !== "remote_block_source_changed"
      ) {
        throw error;
      }
      return this.withRuntime(request, (runtime) => runtime.inspect({ ref: request.blockRef }));
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
    const controlPlane = request.controlPlane ?? "collaboration";
    const existing = this.options.operations.findByCallerIdentity(request);
    if (existing) {
      if (
        existing.endpointSelection?.endpointId !== request.agentEndpointId ||
        existing.endpointSelection.authority.controlPlane !== controlPlane
      ) {
        throw new Error("remote_operation_idempotency_conflict");
      }
      return this.reenter(existing.id);
    }

    const candidate = await this.inspectDispatchCandidate(request);
    if (
      candidate.workspaceId !== request.workspaceId ||
      candidate.projectId !== request.projectId ||
      candidate.canvasId !== request.canvasId
    ) {
      throw new Error("remote_runtime_locator_candidate_mismatch");
    }

    // Endpoint authorization and the redacted route snapshot are captured before persistence.
    // Reentry always uses this durable exact Endpoint identity.
    if (!this.options.agentEndpoints || !this.options.endpointAuthorize) {
      throw new Error("agent_endpoint_dispatch_not_configured");
    }
    this.options.endpointAuthorize({
      workspaceId: candidate.workspaceId,
      projectId: candidate.projectId,
      canvasId: candidate.canvasId,
      blockRef: candidate.blockRef,
      expectedResponsibilityRevision: request.expectedResponsibilityRevision,
      expectedReviewerRevision: request.expectedReviewerRevision,
      controlPlane
    });
    const endpointSelection = this.snapshotEndpoint(
      this.options.agentEndpoints.resolveForRun(
        request.agentEndpointId,
        candidate.workspaceId,
        candidate.requiredCapabilities,
        controlPlane
      ),
      candidate,
      {
        responsibilityRevision: request.expectedResponsibilityRevision,
        reviewerRevision: request.expectedReviewerRevision,
        controlPlane
      }
    );

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
      endpointSelection
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
    const lease = await this.options.runtimeLeases.acquire(operation);
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
      try {
        await runtimeLease.runtime.claim({
          ref: operation.blockRef,
          operationId: operation.id,
          controlPlane: operation.endpointSelection?.authority.controlPlane ?? "collaboration",
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
      operation.endpointSelection?.authority.controlPlane !== "owner"
        ? undefined
        : this.options.ownerPackageLocatorForHost?.({
            hostId: operation.endpointSelection.hostId,
            candidate
          });
    const envelope = buildEnvelope(operation, candidate, ownerPackageLocator);
    const envelopeDigest = hashExecutionEnvelope(envelope);
    operation = this.options.operations.recordEnvelope({
      operationId: operation.id,
      digest: envelopeDigest
    });
    await this.checkpoint("after_envelope_persistence");
    await this.options.inputArtifacts.materialize(candidate, runtimeLease.artifacts);
    await this.checkpoint("after_input_materialization");

    const persisted = this.inspectPersistence(
      operation,
      envelopeDigest,
      candidate.inputArtifacts.length
    );
    if (persisted.dispatch?.status === "running" || persisted.dispatch?.status === "cancelling") {
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
      this.finalizeOperationTerminal(operation, persisted.dispatch.status);
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
        if (operation.endpointSelection) this.authorizeEndpointOperation(operation);
        const resolvedEndpoint = operation.endpointSelection
          ? this.resolveDurableEndpoint(operation, candidate)
          : undefined;
        const preferredHostId =
          resolvedEndpoint?.hostId ?? this.resolvePreferredHostId(operation, candidate);
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
        runtimeLease = await this.options.runtimeLeases.acquire(operation);
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
        outcomes.push(await this.sealOperationLocalFailure(operation, error, runtimeLease));
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
    this.finalizeOperationTerminal(operation, "cancelled");
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
        if (!(error instanceof AgentEndpointCatalogError)) throw error;
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
      authorizeEndpointOperation: (operation) => this.authorizeEndpointOperation(operation),
      checkpoint: () => this.checkpoint("after_action_side_effect")
    });
    return this.actionsCoordinator;
  }

  async complete(operationId: string, existingLease?: CanvasExecutionRuntimeLease): Promise<void> {
    if (existingLease) {
      await this.completeWithLease(operationId, existingLease);
      return;
    }
    const operation = this.options.operations.getRequired(operationId);
    const lease = await this.options.runtimeLeases.acquire(operation);
    try {
      await this.completeWithLease(operationId, lease);
    } finally {
      await lease.release();
    }
  }

  private async completeWithLease(
    operationId: string,
    runtimeLease: CanvasExecutionRuntimeLease
  ): Promise<void> {
    let operation = this.options.operations.getRequired(operationId);
    if (this.reconcileTerminalOperationReplay(operation)) return;
    this.authorizeWritebackIfLeaseActive(operation);
    const terminal = this.options.dispatches.inspect(operation).dispatch;
    if (terminal?.status !== "awaiting_writeback" || terminal.terminalAction?.kind !== "complete") {
      throw new Error("remote_completion_evidence_missing");
    }
    await this.checkpoint("after_terminal_event_persistence");
    const reportArtifactRef = terminal.terminalAction.reportArtifactRef;
    const reportBytes = new Uint8Array(
      await this.options.artifactContent.readReport(reportArtifactRef)
    );
    const candidate = this.options.candidates.get(operation.id);
    if (!candidate) throw new Error("remote_operation_candidate_missing");
    const observedTranscript = this.options.acpTranscript.readCompletionTranscript(
      operation.executionAttemptId
    );
    const transcript = observedTranscript
      ? {
          ...observedTranscript,
          executor: candidate.effectiveExecutor,
          agentId: candidate.agentId
        }
      : null;
    await this.checkpoint("before_runtime_writeback");
    try {
      await runtimeLease.runtime.complete({
        ...remoteBlockIdentity(operation),
        reportArtifactRef,
        reportBytes,
        ...(transcript ? { transcript } : {})
      });
    } catch (error) {
      if (!isWritebackDomainFailure(error)) throw error;
      await this.sealRejectedWriteback(operation, error, runtimeLease.runtime);
      return;
    }
    await this.checkpoint("after_runtime_writeback");
    operation = this.options.operations.getRequired(operation.id);
    this.options.dispatches.finishTerminal({ operation, status: "completed" });
    await this.checkpoint("after_dispatch_terminal_persistence");
    this.finalizeOperationTerminal(operation, "completed");
    await this.checkpoint("after_terminal_persistence");
  }

  /**
   * Host parked durable complete evidence, but package writeback rejected it.
   * Seal Server terminal state as failed so one bad report cannot wedge startup.
   */
  private async sealRejectedWriteback(
    operation: RemoteOperation,
    error: unknown,
    runtime: RemoteBlockRuntimePort
  ): Promise<void> {
    const diagnostic = diagnosticFromReenterFailure(error);
    this.options.operations.recordDiagnostic(operation.id, diagnostic.code, diagnostic.message);
    try {
      await runtime.fail(
        remoteBlockFailureInputSchema.parse({
          ...remoteBlockIdentity(operation),
          failure: {
            code: "protocol_error",
            message: diagnostic.message,
            retryable: false
          },
          ...(operation.endpointSelection?.agentId
            ? { agentId: operation.endpointSelection.agentId }
            : {})
        })
      );
    } catch (failError) {
      if (!isMissingActiveOwnership(failError)) throw failError;
    }
    await this.checkpoint("after_runtime_writeback");
    const current = this.options.operations.getRequired(operation.id);
    this.options.dispatches.finishTerminal({ operation: current, status: "failed" });
    await this.checkpoint("after_dispatch_terminal_persistence");
    this.finalizeOperationTerminal(current, "failed");
    await this.checkpoint("after_terminal_persistence");
  }

  private async sealOperationLocalFailure(
    operation: RemoteOperation,
    error: unknown,
    existingLease?: CanvasExecutionRuntimeLease
  ): Promise<RemoteDispatchOutcome> {
    const current = this.options.operations.getRequired(operation.id);
    if (["completed", "failed", "cancelled"].includes(current.state)) {
      return { operation: current, status: "terminal" };
    }
    const persisted = this.options.dispatches.inspect(current).dispatch;
    if (
      persisted?.status === "awaiting_writeback" &&
      persisted.terminalAction?.kind === "complete"
    ) {
      if (existingLease) {
        await this.sealRejectedWriteback(current, error, existingLease.runtime);
      } else {
        const runtimeLease = await this.options.runtimeLeases.acquire(current);
        try {
          await this.sealRejectedWriteback(current, error, runtimeLease.runtime);
        } finally {
          await runtimeLease.release();
        }
      }
      return {
        operation: this.options.operations.getRequired(current.id),
        status: "terminal"
      };
    }
    if (persisted?.status === "awaiting_writeback" && persisted.terminalAction?.kind === "fail") {
      try {
        await this.fail(current.id, existingLease);
      } catch (failError) {
        if (!isMissingActiveOwnership(failError) && !isWritebackDomainFailure(failError)) {
          throw failError;
        }
        this.forceFailedTerminal(current);
      }
      return {
        operation: this.options.operations.getRequired(current.id),
        status: "terminal"
      };
    }
    this.forceFailedTerminal(current);
    return {
      operation: this.options.operations.getRequired(current.id),
      status: "terminal"
    };
  }

  private forceFailedTerminal(operation: RemoteOperation): void {
    const current = this.options.operations.getRequired(operation.id);
    if (["completed", "failed", "cancelled"].includes(current.state)) return;
    const persisted = this.options.dispatches.inspect(current).dispatch;
    if (persisted?.status === "awaiting_writeback") {
      this.options.dispatches.finishTerminal({ operation: current, status: "failed" });
    }
    if (current.attempt.leaseId) {
      this.finalizeOperationTerminal(current, "failed");
      return;
    }
    if (
      current.state === "claimed" &&
      current.attempt.status === "prepared" &&
      current.attempt.hostId === undefined &&
      !persisted
    ) {
      this.options.operations.cancelClaimedAfterRuntimeReset({
        operationId: current.id,
        executionAttemptId: current.executionAttemptId
      });
    }
  }

  async fail(operationId: string, existingLease?: CanvasExecutionRuntimeLease): Promise<void> {
    if (existingLease) {
      await this.failWithLease(operationId, existingLease);
      return;
    }
    const operation = this.options.operations.getRequired(operationId);
    const lease = await this.options.runtimeLeases.acquire(operation);
    try {
      await this.failWithLease(operationId, lease);
    } finally {
      await lease.release();
    }
  }

  private async failWithLease(
    operationId: string,
    runtimeLease: CanvasExecutionRuntimeLease
  ): Promise<void> {
    let operation = this.options.operations.getRequired(operationId);
    if (this.reconcileTerminalOperationReplay(operation)) return;
    this.authorizeWritebackIfLeaseActive(operation);
    const terminal = this.options.dispatches.inspect(operation).dispatch;
    if (terminal?.status !== "awaiting_writeback" || terminal.terminalAction?.kind !== "fail") {
      const current = this.options.dispatches.inspect(operation).dispatch;
      if (current?.status === "failed" || current?.status === "cancelled") {
        this.finalizeOperationTerminal(operation, current.status);
        return;
      }
      throw new Error("remote_failure_evidence_missing");
    }
    await this.checkpoint("after_terminal_event_persistence");
    const failure = terminal.terminalAction.failure;
    await this.checkpoint("before_runtime_writeback");
    await runtimeLease.runtime.fail(
      remoteBlockFailureInputSchema.parse({
        ...remoteBlockIdentity(operation),
        failure,
        ...(operation.endpointSelection?.agentId
          ? { agentId: operation.endpointSelection.agentId }
          : {})
      })
    );
    await this.checkpoint("after_runtime_writeback");
    operation = this.options.operations.getRequired(operation.id);
    const status = failure.code === "execution_cancelled" ? "cancelled" : "failed";
    this.options.dispatches.finishTerminal({ operation, status });
    await this.checkpoint("after_dispatch_terminal_persistence");
    this.finalizeOperationTerminal(operation, status);
    await this.checkpoint("after_terminal_persistence");
  }

  private reconcileTerminalOperationReplay(operation: RemoteOperation): boolean {
    if (
      operation.state !== "completed" &&
      operation.state !== "failed" &&
      operation.state !== "cancelled"
    ) {
      return false;
    }
    const dispatch = this.options.dispatches.inspect(operation).dispatch;
    if (!dispatch) throw new Error("remote_dispatch_not_found");
    if (dispatch.status === "awaiting_writeback") {
      this.options.dispatches.finishTerminal({ operation, status: operation.state });
    } else if (dispatch.status !== operation.state) {
      throw new Error("remote_terminal_persistence_conflict");
    }
    this.finalizeOperationTerminal(operation, operation.state);
    return true;
  }

  private finalizeOperationTerminal(
    operation: RemoteOperation,
    status: "completed" | "failed" | "cancelled"
  ): void {
    if (!operation.attempt.leaseId) throw new Error("remote_terminal_attempt_not_bound");
    const reservation = this.options.reservations.getRequired(operation.attempt.leaseId);
    if (reservation.status === "active") {
      this.options.reservations.release({
        leaseId: reservation.leaseId,
        fencingToken: reservation.fencingToken,
        expectedVersion: reservation.version,
        reason: status
      });
      return;
    }
    const current = this.options.operations.getRequired(operation.id);
    this.options.reservations.finalizeFencedAttempt({
      operationId: current.id,
      executionAttemptId: current.executionAttemptId,
      leaseId: reservation.leaseId,
      status
    });
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
   * Writeback uses durable dispatch terminal evidence. Re-authorize only while the
   * attempt lease is still active; an expired reservation must not block package seal.
   */
  private authorizeWritebackIfLeaseActive(operation: RemoteOperation): void {
    if (!operation.attempt.leaseId) return;
    const reservation = this.options.reservations.getRequired(operation.attempt.leaseId);
    if (reservation.status !== "active") return;
    const candidate = this.options.candidates.get(operation.id);
    if (operation.endpointSelection) {
      if (!candidate) throw new Error("remote_operation_candidate_missing");
      this.authorizeReservedEndpoint(operation, candidate, reservation);
      return;
    }
    this.options.finalAuthorize?.({ operation, reservation });
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

  private snapshotEndpoint(
    resolved: ResolvedAgentEndpoint,
    candidate: RemoteBlockDispatchCandidate,
    revisions: {
      responsibilityRevision: number;
      reviewerRevision: number;
      controlPlane: "collaboration" | "owner";
    }
  ): EndpointSelectionSnapshot {
    if (resolved.agentId !== candidate.agentId) {
      throw new AgentEndpointCatalogError("agent_endpoint_incompatible");
    }
    return endpointSelectionSnapshotSchema.parse({
      schemaVersion: "endpoint-selection/v1",
      ...resolved,
      authority: {
        schemaVersion: "endpoint-authority/v1",
        ...revisions
      }
    });
  }

  private resolveDurableEndpoint(
    operation: RemoteOperation,
    candidate: RemoteBlockDispatchCandidate
  ): ResolvedAgentEndpoint {
    const selection = operation.endpointSelection;
    if (!selection || !this.options.agentEndpoints) {
      throw new Error("agent_endpoint_dispatch_not_configured");
    }
    const resolved = this.options.agentEndpoints.resolveForRun(
      selection.endpointId,
      operation.workspaceId,
      operation.requiredCapabilities,
      selection.authority.controlPlane
    );
    this.assertEndpointIdentity(selection, resolved, candidate);
    return resolved;
  }

  private assertReservedEndpoint(
    operation: RemoteOperation,
    candidate: RemoteBlockDispatchCandidate,
    reservation: HostCapacityReservation
  ): void {
    const selection = operation.endpointSelection;
    if (!selection || !this.options.agentEndpoints) {
      throw new Error("agent_endpoint_dispatch_not_configured");
    }
    const resolved = this.options.agentEndpoints.resolveForReservedRun(
      selection.endpointId,
      operation.workspaceId,
      operation.requiredCapabilities,
      reservation.hostId,
      selection.authority.controlPlane
    );
    this.assertEndpointIdentity(selection, resolved, candidate);
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
      controlPlane: selection.authority.controlPlane
    });
    if (reservation) {
      this.assertReservedEndpoint(operation, candidate, reservation);
      return;
    }
    this.resolveDurableEndpoint(operation, candidate);
  }

  private assertEndpointIdentity(
    selection: EndpointSelectionSnapshot,
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
}

function candidateForIdentity(
  operation: RemoteOperation,
  candidates: RemoteOperationCandidatePort
): RemoteBlockDispatchCandidate {
  const candidate = candidates.get(operation.id);
  if (!candidate) throw new Error("remote_operation_candidate_missing");
  return candidate;
}
