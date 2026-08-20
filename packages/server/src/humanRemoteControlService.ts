import {
  remoteActionViewSchema,
  remoteDispatchIntentV3Schema,
  remoteEventQuerySchema,
  remoteEventReplaySchema,
  remoteHumanExecutionActionCommandSchema,
  remoteInteractionPageQuerySchema,
  remoteInteractionPageSchema,
  remoteInteractionResponseSchema,
  remoteInteractionViewSchema,
  remoteEndpointOperationObservationSchema,
  remoteOperationObservationSchema
} from "@planweave-ai/collaboration-protocol/remote-run";
import type {
  AuthenticatedCollaborationScope,
  CollaborationAuthContext
} from "./identity/index.js";
import { authorizeHumanAction } from "./identity/policy.js";
import { RemoteAcpEventRepository } from "./remoteAcpEvents.js";
import { RemoteBlockCoordinator } from "./remoteBlockCoordinator.js";
import { RemoteInteractionService } from "./remoteInteractions.js";
import { RemoteOperationRepository, type RemoteOperation } from "./remoteOperations.js";
import { DispatchService } from "./dispatches.js";
import { toHumanEndpointSnapshot } from "./endpointSelection.js";
import { CanvasRuntimeUnavailableError } from "./canvas/executionRuntimePort.js";

export class HumanRemoteControlError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HumanRemoteControlError";
  }
}

export type HumanRemoteControlServiceOptions = {
  operations: RemoteOperationRepository;
  dispatches: DispatchService;
  coordinator: RemoteBlockCoordinator;
  events: RemoteAcpEventRepository;
  interactions: RemoteInteractionService;
  runtimeAvailable(scope: { workspaceId: string; projectId: string; canvasId: string }): boolean;
  authorizeCanvas?: (
    context: CollaborationAuthContext,
    scope: { workspaceId: string; projectId: string; canvasId: string }
  ) => void;
};

function isWorkspaceDeviceContext(
  context: CollaborationAuthContext
): context is Extract<CollaborationAuthContext, { kind: "workspace_device" }> {
  return "kind" in context && context.kind === "workspace_device";
}

export class HumanRemoteControlService {
  constructor(private readonly options: HumanRemoteControlServiceOptions) {}

  async dispatch(scope: AuthenticatedCollaborationScope, rawRequest: unknown) {
    const { actor: context, projectId } = scope;
    this.authorize(context, projectId);
    if (rawRequest !== null && typeof rawRequest === "object") {
      if (
        "projectId" in rawRequest &&
        typeof rawRequest.projectId === "string" &&
        rawRequest.projectId !== projectId
      ) {
        throw new HumanRemoteControlError("human_remote_project_mismatch");
      }
      if (
        "projectId" in rawRequest &&
        typeof rawRequest.projectId === "string" &&
        "canvasId" in rawRequest &&
        typeof rawRequest.canvasId === "string"
      ) {
        this.options.authorizeCanvas?.(context, {
          workspaceId: scope.workspaceId,
          projectId: rawRequest.projectId,
          canvasId: rawRequest.canvasId
        });
      }
    }
    if (
      rawRequest !== null &&
      typeof rawRequest === "object" &&
      (!("schemaVersion" in rawRequest) || rawRequest.schemaVersion !== "remote-run/v3")
    ) {
      throw new HumanRemoteControlError("remote_run_v3_required");
    }
    const request = remoteDispatchIntentV3Schema.parse(rawRequest);
    if (request.projectId !== projectId)
      throw new HumanRemoteControlError("human_remote_project_mismatch");
    if (
      !this.options.runtimeAvailable({
        workspaceId: scope.workspaceId,
        projectId: request.projectId,
        canvasId: request.canvasId
      })
    ) {
      throw new HumanRemoteControlError("human_remote_runtime_unavailable");
    }
    let outcome: Awaited<ReturnType<RemoteBlockCoordinator["dispatch"]>>;
    try {
      outcome = await this.options.coordinator.dispatch({
        workspaceId: scope.workspaceId,
        projectId: request.projectId,
        canvasId: request.canvasId,
        blockRef: request.blockRef,
        idempotencyKey: request.idempotencyKey,
        agentEndpointId: request.agentEndpointId,
        expectedResponsibilityRevision: request.expectedResponsibilityRevision,
        expectedReviewerRevision: request.expectedReviewerRevision,
        controlPlane: "collaboration"
      });
    } catch (error) {
      if (error instanceof CanvasRuntimeUnavailableError) {
        throw new HumanRemoteControlError("human_remote_runtime_unavailable");
      }
      throw error;
    }
    return this.observeOperation(scope, outcome.operation.id);
  }

  async observeOperation(scope: AuthenticatedCollaborationScope, operationId: string) {
    const operation = this.operationFor(scope, operationId);
    const runtime = await this.options.coordinator.query(operation.id);
    const dispatch = this.options.dispatches.get(operation.dispatchId);
    const observation = {
      operationId: operation.id,
      projectId: operation.projectId,
      canvasId: operation.canvasId,
      blockRef: operation.blockRef,
      state: operation.state,
      dispatchId: operation.dispatchId,
      executionAttemptId: operation.executionAttemptId,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      terminalAt: operation.terminalAt,
      ...(operation.endpointSelection
        ? { agentEndpoint: toHumanEndpointSnapshot(operation.endpointSelection) }
        : {}),
      attempt: {
        executionAttemptId: operation.attempt.executionAttemptId,
        dispatchId: operation.attempt.dispatchId,
        status: operation.attempt.status,
        ...(operation.endpointSelection ? {} : { hostId: operation.attempt.hostId }),
        leaseId: operation.attempt.leaseId,
        leaseExpiresAt: operation.attempt.leaseExpiresAt,
        stateVersion: operation.attempt.stateVersion
      },
      dispatchStatus: dispatch?.status,
      ...(dispatch?.failure ? { failure: dispatch.failure } : {}),
      runtime: {
        ref: runtime.ref,
        status: runtime.status,
        ...(runtime.ownership
          ? {
              ownership: {
                operationId: runtime.ownership.operationId,
                phase: runtime.ownership.phase,
                ...(runtime.ownership.phase === "active"
                  ? {
                      dispatchId: runtime.ownership.dispatchId,
                      executionAttemptId: runtime.ownership.executionAttemptId
                    }
                  : {})
              }
            }
          : {}),
        ...(runtime.interruption ? { interruption: runtime.interruption } : {}),
        ...(runtime.terminalReceipt
          ? {
              terminalReceipt: {
                operationId: runtime.terminalReceipt.operationId,
                outcome: runtime.terminalReceipt.outcome
              }
            }
          : {}),
        ...(runtime.blockedReason !== undefined ? { blockedReason: runtime.blockedReason } : {}),
        ...(runtime.divergenceReason !== undefined
          ? { divergenceReason: runtime.divergenceReason }
          : {})
      }
    };
    return operation.endpointSelection
      ? remoteEndpointOperationObservationSchema.parse(observation)
      : remoteOperationObservationSchema.parse(observation);
  }

  async executeAction(
    scope: AuthenticatedCollaborationScope,
    operationId: string,
    rawAction: unknown
  ) {
    const operation = this.operationFor(scope, operationId);
    const command = remoteHumanExecutionActionCommandSchema.parse(rawAction);
    if (command.operationId !== operation.id) {
      throw new HumanRemoteControlError("human_remote_operation_mismatch");
    }
    const record = await this.options.coordinator.executeHumanAction(command);
    return remoteActionViewSchema.parse({
      request: record.request,
      state: record.state,
      createdAt: record.createdAt,
      deliveredAt: record.deliveredAt,
      acknowledgedAt: record.acknowledgedAt,
      settledAt: record.settledAt
    });
  }

  replayEvents(scope: AuthenticatedCollaborationScope, operationId: string, rawQuery: unknown) {
    const operation = this.operationFor(scope, operationId);
    const query = remoteEventQuerySchema.parse(rawQuery);
    return remoteEventReplaySchema.parse(
      this.options.events.replayAvailable(operation.executionAttemptId, query.afterCursor)
    );
  }

  listPendingInteractions(
    scope: AuthenticatedCollaborationScope,
    operationId: string,
    rawQuery: unknown
  ) {
    const operation = this.operationFor(scope, operationId);
    const query = remoteInteractionPageQuerySchema.parse(rawQuery);
    const interactions = this.options.interactions.listPending(
      operation.id,
      query.limit + 1,
      query.cursor
    );
    return remoteInteractionPageSchema.parse({
      items: interactions.slice(0, query.limit).map(toHumanInteractionView),
      nextCursor: interactions.length > query.limit ? query.cursor + query.limit : null
    });
  }

  settleInteraction(
    scope: AuthenticatedCollaborationScope,
    operationId: string,
    rawSettlement: unknown
  ) {
    const operation = this.operationFor(scope, operationId);
    const settlement = remoteInteractionResponseSchema.parse(rawSettlement);
    if (
      settlement.dispatchId !== operation.dispatchId ||
      settlement.executionAttemptId !== operation.executionAttemptId ||
      !operation.attempt.hostId
    ) {
      throw new HumanRemoteControlError("human_remote_interaction_operation_mismatch");
    }
    return toHumanInteractionView(
      this.options.interactions.settle({
        hostId: operation.attempt.hostId,
        responderId: scope.actor.humanPrincipalId,
        settlement
      })
    );
  }

  private authorize(context: CollaborationAuthContext, projectId: string): void {
    if (context.projectId !== projectId) {
      throw new HumanRemoteControlError("human_remote_project_mismatch");
    }
    if (isWorkspaceDeviceContext(context)) return;
    const decision = authorizeHumanAction({
      action: "remote_run_control",
      subject: { kind: "human", context },
      facts: { targetProjectId: projectId }
    });
    if (!decision.allowed) throw new HumanRemoteControlError(decision.code);
  }

  private operationFor(
    scope: AuthenticatedCollaborationScope,
    operationId: string
  ): RemoteOperation {
    const { actor: context, projectId } = scope;
    this.authorize(context, projectId);
    const operation = this.options.operations.getRequiredInWorkspace(
      scope.workspaceId,
      operationId
    );
    if (operation.projectId !== projectId || operation.workspaceId !== scope.workspaceId) {
      throw new HumanRemoteControlError("human_cross_project_forbidden");
    }
    this.options.authorizeCanvas?.(context, {
      workspaceId: operation.workspaceId,
      projectId: operation.projectId,
      canvasId: operation.canvasId
    });
    return operation;
  }
}

function toHumanInteractionView(interaction: ReturnType<RemoteInteractionService["getRequired"]>) {
  return remoteInteractionViewSchema.parse({
    request: interaction.request,
    operationId: interaction.operationId,
    hostId: interaction.hostId,
    status: interaction.status,
    createdAt: interaction.createdAt,
    settlement: interaction.settlement,
    settledBy: interaction.settledBy,
    settledAt: interaction.settledAt
  });
}
