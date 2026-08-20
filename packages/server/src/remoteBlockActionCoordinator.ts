import {
  RemoteExecutionActionRejectedError,
  RemoteExecutionActionService,
  type RemoteExecutionActionRecord
} from "./remoteExecutionActions.js";
import {
  remoteHumanExecutionActionCommandSchema,
  type RemoteHumanExecutionActionCommand
} from "@planweave-ai/collaboration-protocol/remote-run";
import type {
  RemoteExecutionActionDecision,
  RemoteExecutionActionRequest
} from "./remoteExecutionLifecycle.js";
import {
  decideRemoteExecutionAction,
  remoteExecutionActionRequestSchema
} from "./remoteExecutionLifecycle.js";
import { remoteBlockIdentity } from "./remoteBlockIdentity.js";
import type {
  RemoteBlockCoordinatorOptions,
  RemoteDispatchOutcome
} from "./remoteBlockCoordinator.js";
import type { RemoteBlockRuntimePort } from "@planweave-ai/runtime";
import type { MailboxMessage } from "./mailbox.js";
import type { HostCapacityReservation } from "./hostReservations.js";
import type { RemoteOperation } from "./remoteOperations.js";
import {
  DispatchAssignmentError,
  dispatchHostSelectionSnapshotSchema,
  type DispatchHostSelectionSnapshot
} from "./work/dispatchIntegration.js";

export class RemoteBlockActionCoordinator {
  private readonly actionService: RemoteExecutionActionService;

  constructor(
    private readonly options: RemoteBlockCoordinatorOptions,
    private readonly lifecycle: {
      reenter(operationId: string): Promise<RemoteDispatchOutcome>;
      fail(operationId: string): Promise<void>;
      authorizeEndpointOperation(
        operation: RemoteOperation,
        reservation?: HostCapacityReservation
      ): void;
      checkpoint(): Promise<void>;
    }
  ) {
    this.actionService = new RemoteExecutionActionService(
      this.options.actions,
      {
        snapshot: (action) => {
          const operation = this.options.operations.getRequired(action.operationId);
          return this.options.dispatches.actionSnapshot(operation);
        },
        recover: (action) => this.recover(action),
        prepare: (action, decision) => this.prepare(action, decision),
        apply: (action, decision, context) => this.apply(action, decision, context),
        afterApply: () => this.lifecycle.checkpoint()
      },
      this.options.serverInstanceOwnerToken
    );
  }

  execute(rawAction: unknown): Promise<RemoteExecutionActionRecord> {
    return this.actionService.execute(rawAction);
  }

  executeHuman(rawCommand: unknown): Promise<RemoteExecutionActionRecord> {
    const command = remoteHumanExecutionActionCommandSchema.parse(rawCommand);
    const existing = this.options.actions.get(command.actionId);
    if (existing) {
      assertHumanActionMatches(command, existing.request);
      return this.actionService.execute(existing.request);
    }
    if (command.kind !== "resume_same_session") return this.execute(command);
    return this.execute(this.materializeResumeAction(command));
  }

  reconcile(startupContext?: {
    serverInstanceOwnerToken: string;
  }): Promise<RemoteExecutionActionRecord[]> {
    return this.actionService.reconcile(startupContext);
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
      const operation = this.options.operations.getRequired(action.operationId);
      if (operation.endpointSelection) this.lifecycle.authorizeEndpointOperation(operation);
      await this.lifecycle.reenter(action.operationId);
      return "settled";
    }
    if (action.kind === "resume_same_session") {
      if (
        !this.options.reservations.isResumeApplied({
          priorLeaseId: action.priorLeaseId,
          leaseId: action.leaseId,
          executionAttemptId: action.executionAttemptId,
          leaseExpiresAt: action.leaseExpiresAt
        })
      ) {
        return undefined;
      }
      const operation = this.options.operations.getRequired(action.operationId);
      const message = this.options.dispatches.enqueueResume({ operation, action });
      this.publish(message);
      return "delivered";
    }
    const operation = this.options.operations.getRequired(action.operationId);
    const persisted = this.options.dispatches.inspect(operation).dispatch;
    if (action.kind === "cancel" && persisted?.status === "cancelling") {
      const message = this.options.dispatches.enqueueCancel({ operation, action });
      this.publish(message);
      return "delivered";
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
      await this.lifecycle.fail(operation.id);
      return "settled";
    }
    return undefined;
  }

  private materializeResumeAction(
    command: Extract<RemoteHumanExecutionActionCommand, { kind: "resume_same_session" }>
  ): RemoteExecutionActionRequest {
    const operation = this.options.operations.getRequired(command.operationId);
    const snapshot = this.options.dispatches.actionSnapshot(operation);
    const recovery = snapshot.interruption?.recovery;
    if (!recovery) throw new Error("remote_resume_recovery_evidence_missing");

    // Validate the human intent against the authoritative interruption/CAS snapshot before
    // issuing a fresh lease. The placeholder is never persisted or sent to a Host mailbox.
    const validationLeaseId =
      command.priorLeaseId === "lease-resume-validation"
        ? "lease-resume-validation-2"
        : "lease-resume-validation";
    const provisional = remoteExecutionActionRequestSchema.parse({
      ...command,
      leaseId: validationLeaseId,
      leaseExpiresAt: "1970-01-01T00:00:00.000Z",
      recovery
    });
    decideRemoteExecutionAction(provisional, snapshot);

    const lease = this.options.reservations.createResumeLease();
    return remoteExecutionActionRequestSchema.parse({
      ...command,
      leaseId: lease.leaseId,
      leaseExpiresAt: lease.leaseExpiresAt,
      recovery
    });
  }

  private async apply(
    action: RemoteExecutionActionRequest,
    decision: RemoteExecutionActionDecision,
    context?: unknown
  ): Promise<"delivered" | "settled"> {
    let operation = this.options.operations.getRequired(action.operationId);
    switch (decision.transition) {
      case "cancel": {
        if (action.kind !== "cancel") throw new Error("remote_action_decision_mismatch");
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
        await this.withRuntime(operation, (runtime) =>
          runtime.resumeAttempt(remoteBlockIdentity(operation))
        );
        this.options.reservations.resumeSameAttempt({
          priorLeaseId: action.priorLeaseId,
          leaseId: action.leaseId,
          leaseExpiresAt: action.leaseExpiresAt,
          expectedAttemptVersion: action.expectedAttemptVersion
        });
        operation = this.options.operations.getRequired(operation.id);
        const message = this.options.dispatches.enqueueResume({ operation, action });
        this.publish(message);
        return "delivered";
      }
      case "retry": {
        if (action.kind !== "retry_new_attempt") throw new Error("remote_action_decision_mismatch");
        const hostSelection =
          context === undefined ? undefined : dispatchHostSelectionSnapshotSchema.parse(context);
        if (operation.endpointSelection) this.lifecycle.authorizeEndpointOperation(operation);
        await this.withRuntime(operation, (runtime) =>
          runtime.retryAttempt({
            ...remoteBlockIdentity(operation),
            newDispatchId: action.newDispatchId,
            newExecutionAttemptId: action.newExecutionAttemptId
          })
        );
        this.options.operations.retryAttempt({
          operationId: operation.id,
          priorExecutionAttemptId: operation.executionAttemptId,
          newDispatchId: action.newDispatchId,
          newExecutionAttemptId: action.newExecutionAttemptId,
          expectedAttemptVersion: action.expectedAttemptVersion,
          hostSelection
        });
        await this.lifecycle.reenter(operation.id);
        return "settled";
      }
    }
  }

  private async withRuntime<T>(
    locator: { workspaceId: string; projectId: string; canvasId: string },
    operation: (runtime: RemoteBlockRuntimePort) => Promise<T>
  ): Promise<T> {
    const acquired = await this.options.runtimeLeases.acquire(locator);
    try {
      return await operation(acquired.runtime);
    } finally {
      await acquired.release();
    }
  }

  private prepare(
    action: RemoteExecutionActionRequest,
    decision: RemoteExecutionActionDecision
  ): DispatchHostSelectionSnapshot | undefined {
    if (decision.transition !== "retry") return undefined;
    if (action.kind !== "retry_new_attempt") throw new Error("remote_action_decision_mismatch");
    const operation = this.options.operations.getRequired(action.operationId);
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
