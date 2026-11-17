import { withRemoteRuntimeLease } from "./remoteRuntimeLeaseCleanup.js";
import {
  RemoteExecutionActionRejectedError,
  RemoteExecutionActionService,
  type RemoteExecutionActionRecord
} from "./remoteExecutionActions.js";
import {
  remoteHumanExecutionActionCommandSchema,
  type RemoteHumanExecutionActionCommand,
  type RemoteHumanResumeCommand,
  type RemoteResumeStatus
} from "@planweave-ai/collaboration-protocol/remote-run";
import type {
  RemoteExecutionActionDecision,
  RemoteExecutionActionRequest
} from "./remoteExecutionLifecycle.js";
import {
  decideRemoteExecutionAction,
  remoteResumeEligibility,
  requireRemoteResumeRecovery,
  remoteExecutionActionRequestSchema
} from "./remoteExecutionLifecycle.js";
import { remoteBlockIdentity } from "./remoteBlockIdentity.js";
import { throwRemoteDispatchAdmissionError } from "./remoteDispatchAdmissionDenial.js";
import type {
  RemoteBlockCoordinatorOptions,
  RemoteDispatchOutcome
} from "./remoteBlockCoordinator.js";
import {
  RemoteBlockRuntimeError,
  RemoteOwnershipConflictError,
  type RemoteBlockRuntimePort
} from "@planweave-ai/runtime";
import { RemoteAgentAuthorizationError } from "./remoteAgent/errors.js";
import { retryTarget } from "./remoteAgent/dispatchTarget.js";
import { AgentEndpointCatalogError } from "./agentEndpointCatalog.js";
import { RemoteResumeLeaseExpiredError, type HostCapacityReservation } from "./hostReservations.js";
import type { MailboxMessage } from "./mailbox.js";
import type { RemoteOperation } from "./remoteOperations.js";
import type { PersistedRemoteAgentAccessSnapshot } from "./remoteAgent/schema.js";
import {
  acquireRemoteRuntimeLease,
  authorizedOperationHostId
} from "./remoteBlockCoordinatorPorts.js";
import {
  DispatchAssignmentError,
  dispatchHostSelectionSnapshotSchema,
  type DispatchHostSelectionSnapshot
} from "./work/dispatchIntegration.js";
import {
  classifyReenterFailure,
  diagnosticFromReenterFailure,
  isMissingActiveOwnership,
  isReplacedActiveOwnership
} from "./remoteReenterRecovery.js";

type ResumeAction = Extract<RemoteExecutionActionRequest, { kind: "resume_same_session" }>;
type RetryAction = Extract<RemoteExecutionActionRequest, { kind: "retry_new_attempt" }>;
type CancelAction = Extract<RemoteExecutionActionRequest, { kind: "cancel" }>;

class RemoteCancelResumePendingError extends Error {
  constructor() {
    super("remote_cancel_resume_pending");
    this.name = "RemoteCancelResumePendingError";
  }
}

function matchesCancelAttempt(action: CancelAction, operation: RemoteOperation): boolean {
  return (
    operation.dispatchId === action.dispatchId &&
    operation.executionAttemptId === action.executionAttemptId &&
    operation.attempt.stateVersion === action.expectedAttemptVersion &&
    operation.attempt.leaseId === action.leaseId
  );
}

function classifyActionDeferral(action: RemoteExecutionActionRequest, error: unknown) {
  if (error instanceof RemoteCancelResumePendingError) return "defer";
  if (
    action.kind === "resume_same_session" &&
    error instanceof Error &&
    (error.message === "remote_resume_host_unavailable" ||
      error.message === "remote_resume_host_capacity_exhausted")
  ) {
    return "defer";
  }
  const decision = classifyReenterFailure(error);
  if (decision === "admission_denied") return "defer";
  if (
    decision === "defer_host" ||
    decision === "defer_authorization" ||
    decision === "wait_for_action"
  ) {
    return "diagnose";
  }
  return undefined;
}

export class RemoteBlockActionCoordinator {
  private readonly actionService: RemoteExecutionActionService;

  constructor(
    private readonly options: RemoteBlockCoordinatorOptions,
    private readonly lifecycle: {
      reenter(operationId: string): Promise<RemoteDispatchOutcome>;
      fail(operationId: string): Promise<void>;
      sealOperationLocalFailure(operation: RemoteOperation, error: unknown): Promise<void>;
      authorizeEndpointOperation(
        operation: RemoteOperation,
        reservation?: HostCapacityReservation
      ): void;
      reauthorizeAgentAccessForRetry(
        operation: RemoteOperation
      ): PersistedRemoteAgentAccessSnapshot;
      checkpoint(): Promise<void>;
    }
  ) {
    this.actionService = new RemoteExecutionActionService(
      this.options.actions,
      {
        snapshot: (action) => {
          const operation = this.options.operations.getRequired(action.operationId);
          return action.kind === "resume_same_session"
            ? this.requireResumeSnapshot(action, operation)
            : this.options.dispatches.actionSnapshot(operation);
        },
        recover: (action) => this.recover(action),
        canRetryRecovery: (action, error) => classifyActionDeferral(action, error) !== undefined,
        isAppliedDespiteFailure: (action) => this.retryAdmissionError(action) !== undefined,
        prepare: (action, decision) => this.prepare(action, decision),
        apply: (action, decision, context) => this.apply(action, decision, context),
        afterApply: () => this.lifecycle.checkpoint()
      },
      this.options.serverInstanceOwnerToken
    );
  }

  async execute(rawAction: unknown): Promise<RemoteExecutionActionRecord> {
    const action = remoteExecutionActionRequestSchema.parse(rawAction);
    if (action.kind === "cancel" && !this.options.actions.get(action.actionId)) {
      const operation = this.options.operations.getRequired(action.operationId);
      if (matchesCancelAttempt(action, operation)) this.assertCancelResumePublished(action);
    }
    const record = await this.actionService.execute(action).catch((error: unknown) => {
      if (
        error instanceof RemoteExecutionActionRejectedError &&
        (error.cause instanceof RemoteAgentAuthorizationError ||
          (error.cause instanceof Error &&
            error.cause.message === "remote_preparation_action_requires_retry"))
      ) {
        throw error.cause;
      }
      throwRemoteDispatchAdmissionError(error);
    });
    const denial = this.retryAdmissionError(record.request);
    if (denial) throw denial;
    return record;
  }

  async executeHuman(rawCommand: unknown) {
    const command = remoteHumanExecutionActionCommandSchema.parse(rawCommand);
    const existing = this.options.actions.get(command.actionId);
    if (existing) assertHumanActionMatches(command, existing.request);
    const request =
      existing?.request ??
      (command.kind === "resume_same_session" ? this.materializeResumeAction(command) : command);
    const { requestFingerprint: _fingerprint, ...receipt } = await this.execute(request);
    if (receipt.request.kind !== "resume_same_session" || receipt.request.leaseExpiresAt)
      return receipt;
    const delivery = this.options.dispatches.readResumeDelivery(receipt.request);
    if (!delivery) throw new Error("remote_resume_delivery_missing");
    return {
      ...receipt,
      request: { ...receipt.request, leaseExpiresAt: delivery.command.leaseExpiresAt }
    };
  }

  readResume(operation: RemoteOperation, actionId?: string): RemoteResumeStatus {
    const action = actionId === undefined ? undefined : this.options.actions.get(actionId);
    const request = action?.request;
    const receipt =
      request?.kind === "resume_same_session" && request.operationId === operation.id && action
        ? {
            actionId: request.actionId,
            leaseId: request.leaseId,
            target: {
              operationId: request.operationId,
              dispatchId: request.dispatchId,
              executionAttemptId: request.executionAttemptId,
              expectedAttemptVersion: request.expectedAttemptVersion,
              priorLeaseId: request.priorLeaseId
            },
            state: action.state,
            ...(action.rejectionCode === undefined ? {} : { rejectionCode: action.rejectionCode })
          }
        : null;
    if (operation.attempt.status !== "interrupted") {
      return { capability: { available: false, reason: "not_interrupted" }, receipt };
    }
    let eligibility: ReturnType<typeof remoteResumeEligibility>;
    try {
      eligibility = remoteResumeEligibility(this.options.dispatches.actionSnapshot(operation));
    } catch (error) {
      if (!isMissingResumeDispatch(error)) throw error;
      return { capability: { available: false, reason: "recovery_evidence_missing" }, receipt };
    }
    if (!eligibility.available) return { capability: eligibility, receipt };
    this.authorizeResume(operation);
    return { capability: { available: true, target: eligibility.target }, receipt };
  }

  reconcile(startupContext?: {
    serverInstanceOwnerToken: string;
  }): Promise<RemoteExecutionActionRecord[]> {
    return this.actionService.reconcile(startupContext, (action, error) => {
      const deferral = classifyActionDeferral(action.request, error);
      if (deferral === "diagnose") {
        const diagnostic = diagnosticFromReenterFailure(error);
        this.options.operations.recordDiagnostic(
          action.request.operationId,
          diagnostic.code,
          diagnostic.message
        );
      }
      return deferral !== undefined;
    });
  }

  async requestCancel(operationId: string, reason: string): Promise<void> {
    const operation = this.options.operations.getRequired(operationId);
    if (!operation.attempt.leaseId) throw new Error("remote_attempt_not_bound");
    await this.execute({
      actionId: `cancel-${operation.executionAttemptId}`,
      operationId: operation.id,
      dispatchId: operation.dispatchId,
      executionAttemptId: operation.executionAttemptId,
      expectedAttemptVersion: operation.attempt.stateVersion,
      kind: "cancel",
      leaseId: operation.attempt.leaseId,
      reason
    });
  }

  private async recover(
    action: RemoteExecutionActionRequest
  ): Promise<"delivered" | "settled" | undefined> {
    if (action.kind === "retry_new_attempt") {
      if (this.retryAdmissionError(action)) return "settled";
      if (
        !this.options.operations.isRetryApplied({
          operationId: action.operationId,
          priorExecutionAttemptId: action.executionAttemptId,
          newDispatchId: action.newDispatchId,
          newExecutionAttemptId: action.newExecutionAttemptId,
          expectedAttemptVersion: action.expectedAttemptVersion
        })
      ) {
        return undefined;
      }
      await this.lifecycle.reenter(action.operationId);
      return "settled";
    }
    if (action.kind === "resume_same_session") {
      const delivery = this.options.dispatches.readResumeDelivery(action);
      if (delivery) {
        this.publish(delivery);
        return "delivered";
      }
      const reservation = this.options.reservations.findAppliedResume(action);
      if (!reservation) return undefined;
      const operation = this.requireAppliedResume(action);
      await this.withRuntime(operation, (runtime) => this.commitResumeRuntime(action, runtime));
      await this.deliverCommittedResume(action);
      return "delivered";
    }
    const operation = this.options.operations.getRequired(action.operationId);
    const persisted = this.options.dispatches.inspect(operation).dispatch;
    if (action.kind === "cancel") {
      const delivery = this.options.dispatches.readCancelDelivery(action);
      if (delivery) {
        this.publish(delivery);
        return "delivered";
      }
      if (
        !matchesCancelAttempt(action, operation) &&
        this.options.actions.hasResumeLeaseForCancel(action)
      ) {
        throw new RemoteExecutionActionRejectedError("remote_resume_attempt_conflict");
      }
      if (!persisted && operation.state === "cancelled") return "settled";
    }
    if (action.kind === "block" && operation.attempt.status === "action_required") {
      return "settled";
    }
    if (
      action.kind === "fail" &&
      (persisted?.status === "awaiting_writeback" ||
        persisted?.status === "failed" ||
        persisted?.status === "cancelled")
    ) {
      if (this.failActionApplied(action)) return "settled";
      try {
        await this.lifecycle.fail(operation.id);
      } catch (error) {
        if (classifyReenterFailure(error) === "defer_host" && this.failActionApplied(action)) {
          return "settled";
        }
        if (!isMissingActiveOwnership(error) && !isReplacedActiveOwnership(error)) throw error;
        await this.lifecycle.sealOperationLocalFailure(operation, error);
      }
      if (!this.failActionApplied(action)) {
        throw new Error("remote_action_failure_effect_mismatch");
      }
      return "settled";
    }
    return undefined;
  }

  private retryAdmissionError(action: RemoteExecutionActionRequest): Error | undefined {
    if (action.kind !== "retry_new_attempt") return undefined;
    return this.options.dispatches.readAdmissionError({
      operationId: action.operationId,
      dispatchId: action.newDispatchId,
      executionAttemptId: action.newExecutionAttemptId
    });
  }

  private failActionApplied(
    action: Extract<RemoteExecutionActionRequest, { kind: "fail" }>
  ): boolean {
    const operation = this.options.operations.getRequired(action.operationId);
    if (
      operation.dispatchId !== action.dispatchId ||
      operation.executionAttemptId !== action.executionAttemptId
    ) {
      throw new Error("remote_action_identity_mismatch");
    }
    if (operation.attempt.leaseId !== action.leaseId) {
      throw new Error("remote_action_lease_mismatch");
    }
    const persisted = this.options.dispatches.inspect(operation).dispatch;
    if (JSON.stringify(persisted?.failure) !== JSON.stringify(action.failure)) {
      throw new Error("remote_action_failure_effect_mismatch");
    }
    const status = action.failure.code === "execution_cancelled" ? "cancelled" : "failed";
    const terminal =
      operation.state === "completed" ||
      operation.state === "failed" ||
      operation.state === "cancelled";
    // Manual failure changes the dispatch only; terminal attempt finalization advances its CAS once.
    const expectedVersion = action.expectedAttemptVersion + (terminal ? 1 : 0);
    if (operation.attempt.stateVersion !== expectedVersion) {
      throw new Error("remote_action_attempt_version_conflict");
    }
    if (
      terminal &&
      (operation.state !== status ||
        operation.attempt.status !== status ||
        persisted?.status !== status)
    ) {
      throw new Error("remote_action_failure_effect_mismatch");
    }
    return terminal;
  }

  private materializeResumeAction(command: RemoteHumanResumeCommand): RemoteExecutionActionRequest {
    const operation = this.options.operations.getRequired(command.operationId);
    const snapshot = this.options.dispatches.actionSnapshot(operation);
    const recovery = requireRemoteResumeRecovery(command, snapshot);
    this.authorizeResume(operation);
    return remoteExecutionActionRequestSchema.parse({
      ...command,
      leaseId: this.options.reservations.createResumeLeaseId(),
      recovery
    });
  }

  private authorizeResume(operation: RemoteOperation): void {
    if (operation.agentAccess) this.lifecycle.reauthorizeAgentAccessForRetry(operation);
  }

  private assertCancelResumePublished(action: CancelAction): void {
    if (this.options.reservations.isUnpublishedResumeLease(action.leaseId)) {
      throw new RemoteCancelResumePendingError();
    }
  }

  private async apply(
    action: RemoteExecutionActionRequest,
    decision: RemoteExecutionActionDecision,
    context?: unknown
  ): Promise<"delivered" | "settled"> {
    const operation = this.options.operations.getRequired(action.operationId);
    switch (decision.transition) {
      case "cancel": {
        if (action.kind !== "cancel") throw new Error("remote_action_decision_mismatch");
        if (!decision.sendsCommand) {
          this.options.operations.recordDiagnosticStage(operation.id, "cancelling");
          await this.withRuntime(operation, async (runtime) => {
            let binding: Awaited<ReturnType<RemoteBlockRuntimePort["query"]>>;
            try {
              binding = await runtime.query({ ref: operation.blockRef, operationId: operation.id });
            } catch (error) {
              if (!isMissingActiveOwnership(error)) throw error;
              return;
            }
            if (binding.ownership?.phase === "preparing") {
              await runtime.activate(remoteBlockIdentity(operation));
            }
            await runtime.fail({
              ...remoteBlockIdentity(operation),
              failure: {
                code: "execution_cancelled",
                message: action.reason,
                retryable: true
              },
              ...(operation.endpointSelection?.agentId
                ? { agentId: operation.endpointSelection.agentId }
                : {})
            });
          });
          this.options.reservations.finalizeFencedAttempt({
            operationId: operation.id,
            executionAttemptId: operation.executionAttemptId,
            leaseId: action.leaseId,
            status: "cancelled"
          });
          this.options.operations.recordDiagnosticStage(operation.id, "terminal");
          return "settled";
        }
        if (!matchesCancelAttempt(action, operation)) {
          throw new RemoteExecutionActionRejectedError("remote_resume_attempt_conflict");
        }
        this.assertCancelResumePublished(action);
        this.options.operations.recordDiagnosticStage(operation.id, "cancelling");
        const message = this.options.dispatches.enqueueCancel({ operation, action });
        this.publish(message);
        return "delivered";
      }
      case "block":
        if (action.kind !== "block") throw new Error("remote_action_decision_mismatch");
        this.options.operations.markActionRequired({
          operationId: operation.id,
          executionAttemptId: operation.executionAttemptId,
          expectedAttemptVersion: action.expectedAttemptVersion
        });
        this.options.dispatches.markActionRequired(operation);
        return "settled";
      case "fail":
        if (action.kind !== "fail") throw new Error("remote_action_decision_mismatch");
        this.options.dispatches.prepareManualFailure({ operation, failure: action.failure });
        await this.lifecycle.fail(operation.id);
        return "settled";
      case "resume": {
        if (action.kind !== "resume_same_session")
          throw new Error("remote_action_decision_mismatch");
        this.requireResumeSnapshot(action, operation);
        try {
          this.options.reservations.assertResumeLeaseNotExpired(action.leaseExpiresAt);
          this.authorizeRecordedResume(operation);
          await this.withRuntime(operation, async (runtime) => {
            await runtime.query({ ref: operation.blockRef, operationId: operation.id });
            this.writeWithResumeClaim(action, () => {
              const current = this.options.operations.getRequired(action.operationId);
              this.requireResumeSnapshot(action, current);
              this.authorizeRecordedResume(current);
              this.options.reservations.resumeSameAttempt(action);
            });
            await this.commitResumeRuntime(action, runtime);
          });
        } catch (error) {
          if (!(error instanceof RemoteResumeLeaseExpiredError)) throw error;
          throw new RemoteExecutionActionRejectedError("remote_resume_attempt_conflict", {
            cause: error
          });
        }
        await this.deliverCommittedResume(action);
        return "delivered";
      }
      case "retry": {
        if (action.kind !== "retry_new_attempt") throw new Error("remote_action_decision_mismatch");
        if (
          operation.dispatchId !== action.dispatchId ||
          operation.executionAttemptId !== action.executionAttemptId ||
          operation.attempt.leaseId !== action.priorLeaseId
        ) {
          throw new Error("remote_action_identity_mismatch");
        }
        if (operation.attempt.stateVersion !== action.expectedAttemptVersion) {
          throw new Error("remote_action_attempt_version_conflict");
        }
        const hostSelection =
          context === undefined ? undefined : dispatchHostSelectionSnapshotSchema.parse(context);
        if (operation.endpointSelection) this.lifecycle.authorizeEndpointOperation(operation);
        const agentAccess = this.lifecycle.reauthorizeAgentAccessForRetry(operation);
        const allowUnbound = this.options.dispatches.inspect(operation).dispatch === undefined;
        await this.withRuntime(operation, (runtime) =>
          this.commitRetryRuntime(action, operation, runtime, allowUnbound)
        );
        this.options.operations.retryAttempt({
          operationId: operation.id,
          priorExecutionAttemptId: action.executionAttemptId,
          newDispatchId: action.newDispatchId,
          newExecutionAttemptId: action.newExecutionAttemptId,
          expectedAttemptVersion: action.expectedAttemptVersion,
          hostSelection,
          agentAccess
        });
        await this.lifecycle.reenter(operation.id);
        return "settled";
      }
    }
  }

  private async commitRetryRuntime(
    action: RetryAction,
    operation: RemoteOperation,
    runtime: RemoteBlockRuntimePort,
    allowUnbound: boolean
  ): Promise<void> {
    const identity = remoteBlockIdentity(operation);
    try {
      await runtime.retryAttempt({
        ...identity,
        newDispatchId: action.newDispatchId,
        newExecutionAttemptId: action.newExecutionAttemptId
      });
    } catch (error) {
      if (allowUnbound && isMissingActiveOwnership(error)) return;
      if (
        !(error instanceof RemoteBlockRuntimeError && error.code === "remote_block_source_changed")
      )
        throw error;
      throw new RemoteExecutionActionRejectedError("remote_resume_attempt_conflict", {
        cause: error
      });
    }
  }

  private requireResumeSnapshot(action: ResumeAction, operation: RemoteOperation) {
    if (
      operation.dispatchId !== action.dispatchId ||
      operation.executionAttemptId !== action.executionAttemptId ||
      operation.attempt.stateVersion !== action.expectedAttemptVersion ||
      operation.attempt.leaseId !== action.priorLeaseId ||
      operation.attempt.status !== "interrupted"
    ) {
      throw new RemoteExecutionActionRejectedError("remote_resume_attempt_conflict");
    }
    try {
      const snapshot = this.options.dispatches.actionSnapshot(operation);
      decideRemoteExecutionAction(action, snapshot);
      return snapshot;
    } catch (error) {
      if (
        isMissingResumeDispatch(error) ||
        (error instanceof Error &&
          [
            "remote_preparation_action_requires_retry",
            "remote_resume_attempt_not_interrupted_and_fenced",
            "remote_resume_recovery_evidence_missing",
            "remote_resume_recovery_identity_mismatch"
          ].includes(error.message))
      ) {
        throw new RemoteExecutionActionRejectedError("remote_resume_attempt_conflict", {
          cause: error
        });
      }
      throw error;
    }
  }

  private authorizeRecordedResume(operation: RemoteOperation): void {
    try {
      this.authorizeResume(operation);
    } catch (error) {
      if (!(error instanceof RemoteAgentAuthorizationError)) throw error;
      throw new RemoteExecutionActionRejectedError("remote_resume_authorization_changed", {
        cause: error
      });
    }
  }

  private authorizeAppliedResume(
    operation: RemoteOperation,
    reservation: HostCapacityReservation
  ): void {
    const access = operation.agentAccess;
    if (!access) return;
    try {
      this.options.assertRemoteAgentAccess({
        principal: { humanPrincipalId: access.callerHumanPrincipalId },
        endpointId: access.authorized.remoteAgent.endpointId,
        target: retryTarget(operation, access.authorized)
      });
      this.lifecycle.authorizeEndpointOperation(operation, reservation);
    } catch (error) {
      if (
        error instanceof AgentEndpointCatalogError &&
        error.unavailableReason === "host_offline"
      ) {
        throw new Error("remote_resume_host_unavailable", { cause: error });
      }
      if (
        !(error instanceof RemoteAgentAuthorizationError) &&
        !(error instanceof DispatchAssignmentError) &&
        !(error instanceof AgentEndpointCatalogError)
      )
        throw error;
      throw new RemoteExecutionActionRejectedError("remote_resume_authorization_changed", {
        cause: error
      });
    }
  }

  private requireAppliedResume(action: ResumeAction): RemoteOperation {
    const operation = this.options.operations.getRequired(action.operationId);
    if (
      operation.dispatchId !== action.dispatchId ||
      operation.executionAttemptId !== action.executionAttemptId ||
      operation.attempt.stateVersion !== action.expectedAttemptVersion + 1 ||
      operation.attempt.leaseId !== action.leaseId ||
      operation.attempt.status !== "activated"
    ) {
      throw new RemoteExecutionActionRejectedError("remote_resume_attempt_conflict");
    }
    return operation;
  }

  private validateAppliedResume(action: ResumeAction, operation: RemoteOperation): void {
    const reservation = this.options.reservations.getRequired(action.leaseId);
    this.authorizeAppliedResume(operation, reservation);
    if (
      reservation.status !== "active" ||
      (action.leaseExpiresAt !== undefined &&
        !this.options.reservations.isActiveForAttempt(reservation))
    ) {
      throw new RemoteExecutionActionRejectedError("remote_resume_attempt_conflict");
    }
  }

  private async discardAppliedResume(
    action: ResumeAction,
    runtime: RemoteBlockRuntimePort
  ): Promise<void> {
    this.options.actions.assertApplicationClaim(
      action.actionId,
      this.options.serverInstanceOwnerToken
    );
    const current = this.requireAppliedResume(action);
    const interruption = this.options.dispatches.inspect(current).dispatch?.interruption;
    if (!interruption?.resumable) throw new Error("remote_resume_interruption_missing");
    try {
      await runtime.markInterrupted({ ...remoteBlockIdentity(current), interruption });
    } catch (error) {
      if (
        !isMissingActiveOwnership(error) &&
        !isReplacedActiveOwnership(error) &&
        !(error instanceof RemoteBlockRuntimeError && error.code === "remote_block_source_changed")
      ) {
        throw error;
      }
    }
    this.writeWithResumeClaim(action, () =>
      this.options.reservations.discardUnpublishedResume(action)
    );
  }

  private async commitResumeRuntime(
    action: ResumeAction,
    runtime: RemoteBlockRuntimePort
  ): Promise<void> {
    this.options.actions.assertApplicationClaim(
      action.actionId,
      this.options.serverInstanceOwnerToken
    );
    const operation = this.requireAppliedResume(action);
    try {
      this.validateAppliedResume(action, operation);
      await runtime.resumeAttempt(remoteBlockIdentity(operation));
    } catch (error) {
      if (error instanceof RemoteExecutionActionRejectedError) {
        await this.discardAppliedResume(action, runtime);
        throw error;
      }
      if (
        error instanceof RemoteOwnershipConflictError ||
        (error instanceof RemoteBlockRuntimeError && error.code === "remote_block_source_changed")
      ) {
        this.writeWithResumeClaim(action, () =>
          this.options.reservations.discardUnpublishedResume(action)
        );
        throw new RemoteExecutionActionRejectedError("remote_resume_attempt_conflict", {
          cause: error
        });
      }
      throw error;
    }
  }

  private async deliverCommittedResume(action: ResumeAction): Promise<void> {
    const operation = this.requireAppliedResume(action);
    try {
      this.validateAppliedResume(action, operation);
    } catch (error) {
      if (error instanceof RemoteExecutionActionRejectedError) {
        await this.withRuntime(operation, (runtime) => this.discardAppliedResume(action, runtime));
      }
      throw error;
    }
    const message = this.writeWithResumeClaim(action, () =>
      this.options.dispatches.enqueueResume({
        operation,
        action,
        leaseExpiresAt:
          action.leaseExpiresAt ??
          this.options.reservations.refreshUnpublishedResume(action).leaseExpiresAt
      })
    );
    this.publish(message);
  }

  private writeWithResumeClaim<T>(action: ResumeAction, write: () => T): T {
    return this.options.actions.writeWithApplicationClaim(
      action.actionId,
      this.options.serverInstanceOwnerToken,
      write
    );
  }

  private async withRuntime<T>(
    locator: RemoteOperation,
    operation: (runtime: RemoteBlockRuntimePort) => Promise<T>
  ): Promise<T> {
    const acquired = await acquireRemoteRuntimeLease(
      this.options.runtimeLeases,
      locator,
      authorizedOperationHostId(locator)
    );
    return withRemoteRuntimeLease(this.options.operations, locator.id, acquired, () =>
      operation(acquired.runtime)
    );
  }

  private prepare(
    action: RemoteExecutionActionRequest,
    decision: RemoteExecutionActionDecision
  ): DispatchHostSelectionSnapshot | undefined {
    if (decision.transition !== "retry") return undefined;
    if (action.kind !== "retry_new_attempt") throw new Error("remote_action_decision_mismatch");
    const operation = this.options.operations.getRequired(action.operationId);
    this.lifecycle.reauthorizeAgentAccessForRetry(operation);
    if (operation.endpointSelection) {
      this.lifecycle.authorizeEndpointOperation(operation);
      return undefined;
    }
    // Prior authority-backed attempts must re-resolve against current OSS-003 tables, not
    // legacy work_assignments. Omit expected*Revision so the authority gate takes current
    // revisions (follow reassignment) and persists authorityRevisions on the new snapshot.
    const preferAuthority = operation.hostSelection?.authorityRevisions !== undefined;
    const workspaceId = operation.hostSelection?.workspaceId;
    if (!workspaceId) throw new DispatchAssignmentError("work_host_not_authorized");
    const candidate = this.options.candidates.get(operation.id);
    if (!candidate) throw new Error("remote_operation_candidate_missing");
    try {
      return this.options.assignmentGate?.resolve({
        workspaceId,
        projectId: operation.projectId,
        canvasId: operation.canvasId,
        blockRef: operation.blockRef,
        requiredCapabilities: operation.requiredCapabilities,
        agentId: candidate.agentId,
        agentProfileId: candidate.agentProfileId,
        allowHumanOverride: false,
        preferAuthority
      });
    } catch (error) {
      if (error instanceof DispatchAssignmentError && error.code === "work_not_agent_assigned") {
        throw new RemoteExecutionActionRejectedError(error.code, { cause: error });
      }
      throw error;
    }
  }

  private publish(message: MailboxMessage): void {
    if (message.publishedAt) return;
    this.options.mailbox.publish(message);
    this.options.dispatches.markMailboxPublished(message.messageId);
  }
}

function isMissingResumeDispatch(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "remote_dispatch_not_found" ||
      error.message === "remote_dispatch_host_not_found")
  );
}

function assertHumanActionMatches(
  command: RemoteHumanExecutionActionCommand,
  request: RemoteExecutionActionRequest
): void {
  if (command.kind !== request.kind) throw new Error("remote_action_idempotency_conflict");
  if (
    command.actionId !== request.actionId ||
    command.operationId !== request.operationId ||
    command.dispatchId !== request.dispatchId ||
    command.executionAttemptId !== request.executionAttemptId ||
    command.expectedAttemptVersion !== request.expectedAttemptVersion ||
    command.reason !== request.reason
  ) {
    throw new Error("remote_action_idempotency_conflict");
  }
  switch (command.kind) {
    case "resume_same_session":
      if (request.kind !== "resume_same_session" || command.priorLeaseId !== request.priorLeaseId) {
        throw new Error("remote_action_idempotency_conflict");
      }
      return;
    case "retry_new_attempt":
      if (
        request.kind !== "retry_new_attempt" ||
        command.priorLeaseId !== request.priorLeaseId ||
        command.newDispatchId !== request.newDispatchId ||
        command.newExecutionAttemptId !== request.newExecutionAttemptId
      ) {
        throw new Error("remote_action_idempotency_conflict");
      }
      return;
    case "fail":
      if (
        request.kind !== "fail" ||
        command.leaseId !== request.leaseId ||
        JSON.stringify(command.failure) !== JSON.stringify(request.failure)
      ) {
        throw new Error("remote_action_idempotency_conflict");
      }
      return;
    case "block":
      if (request.kind !== "block" || command.leaseId !== request.leaseId) {
        throw new Error("remote_action_idempotency_conflict");
      }
      return;
    case "cancel":
      if (request.kind !== "cancel" || command.leaseId !== request.leaseId) {
        throw new Error("remote_action_idempotency_conflict");
      }
      return;
  }
}
