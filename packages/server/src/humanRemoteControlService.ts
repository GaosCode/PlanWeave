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
  remoteOperationLookupQuerySchema,
  remoteOperationObservationSchema,
  remoteRuntimeBindingProjectionSchema,
  type RemoteRuntimeBindingProjection
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
import { CanvasRuntimeRpcError } from "./canvas/runtimeRpcBroker.js";
import { buildRemoteOperationDiagnostics } from "./remoteOperationDiagnostics.js";
import { RemoteOperationLookupConflictError } from "./remoteOperationLookup.js";
import {
  isTerminalRemoteOperation,
  projectRemoteOperationRuntime,
  projectTerminalRemoteOperationRuntime
} from "./remoteOperationRuntimeProjection.js";

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

function throwMappedDispatchRuntimeFailure(error: unknown): never {
  if (error instanceof CanvasRuntimeUnavailableError) {
    throw new HumanRemoteControlError(
      error.reason === "host_offline"
        ? "human_remote_host_offline"
        : "human_remote_runtime_unavailable"
    );
  }
  if (error instanceof CanvasRuntimeRpcError) {
    if (error.code === "content_out_of_sync") {
      throw new HumanRemoteControlError("human_remote_revision_drift");
    }
    throw new HumanRemoteControlError("human_remote_materialization_failed");
  }
  if (error instanceof Error) {
    if (
      error.message === "canvas_content_head_changed" ||
      error.message === "canvas_runtime_status_content_out_of_sync"
    ) {
      throw new HumanRemoteControlError("human_remote_revision_drift");
    }
    if (error.message === "canvas_content_head_missing") {
      throw new HumanRemoteControlError("human_remote_materialization_failed");
    }
  }
  throw error;
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
        executionTargetRevision: request.executionTargetRevision,
        contentRevision: request.contentRevision,
        graphFingerprint: request.graphFingerprint,
        targetKind: "workspace_canvas",
        callerHumanPrincipalId: context.humanPrincipalId
      });
    } catch (error) {
      throwMappedDispatchRuntimeFailure(error);
    }
    const runtime =
      outcome.status === "activated"
        ? remoteRuntimeBindingProjectionSchema.parse({
            ref: outcome.operation.blockRef,
            status: "in_progress",
            ownership: {
              operationId: outcome.operation.id,
              phase: "active",
              dispatchId: outcome.operation.dispatchId,
              executionAttemptId: outcome.operation.executionAttemptId
            }
          })
        : undefined;
    return this.observeOperation(scope, outcome.operation.id, runtime);
  }

  async observeOperation(
    scope: AuthenticatedCollaborationScope,
    operationId: string,
    dispatchedRuntime?: RemoteRuntimeBindingProjection
  ) {
    const operation = this.operationFor(scope, operationId);
    const dispatch = this.options.dispatches.get(operation.dispatchId);
    const runtime = projectRemoteOperationRuntime(
      isTerminalRemoteOperation(operation)
        ? projectTerminalRemoteOperationRuntime(operation)
        : (dispatchedRuntime ?? (await this.options.coordinator.query(operation.id)))
    );
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
      diagnostics: buildRemoteOperationDiagnostics({
        operation,
        revision: this.options.operations.observationRevision(operation.id),
        runtime,
        dispatchStatus: dispatch?.status,
        failure: dispatch?.failure,
        diagnostic: this.options.operations.getRequiredDiagnostic(operation.id)
      }),
      runtime
    };
    return operation.endpointSelection
      ? remoteEndpointOperationObservationSchema.parse(observation)
      : remoteOperationObservationSchema.parse(observation);
  }

  async lookupLatestOperation(scope: AuthenticatedCollaborationScope, rawQuery: unknown) {
    const { actor: context, projectId, workspaceId } = scope;
    this.authorize(context, projectId);
    const query = remoteOperationLookupQuerySchema.parse(rawQuery);
    if (!query.canvasId || !query.blockRef) {
      throw new HumanRemoteControlError("human_remote_operation_scope_required");
    }
    this.options.authorizeCanvas?.(context, { workspaceId, projectId, canvasId: query.canvasId });
    let operation: RemoteOperation | undefined;
    try {
      operation = query.operationId
        ? this.options.operations.findByOperationIdInScope({
            workspaceId,
            projectId,
            canvasId: query.canvasId,
            blockRef: query.blockRef,
            operationId: query.operationId
          })
        : query.idempotencyKey
          ? this.options.operations.findByIdempotencyKeyInScope({
              workspaceId,
              projectId,
              canvasId: query.canvasId,
              blockRef: query.blockRef,
              idempotencyKey: query.idempotencyKey
            })
          : this.options.operations.findLatestByScope({
              workspaceId,
              projectId,
              canvasId: query.canvasId,
              blockRef: query.blockRef
            });
    } catch (error) {
      if (error instanceof RemoteOperationLookupConflictError) {
        throw new HumanRemoteControlError("human_remote_operation_conflict");
      }
      throw error;
    }
    return operation ? this.observeOperation(scope, operation.id) : null;
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
    try {
      return toHumanInteractionView(
        this.options.interactions.settle({
          hostId: operation.attempt.hostId,
          responderId: scope.actor.humanPrincipalId,
          settlement
        })
      );
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "remote_interaction_expired") {
          throw new HumanRemoteControlError("remote_interaction_expired");
        }
        if (error.message === "remote_interaction_settlement_conflict") {
          throw new HumanRemoteControlError("remote_interaction_already_settled");
        }
        if (error.message === "remote_interaction_not_found") {
          throw new HumanRemoteControlError("remote_interaction_not_found");
        }
        if (error.message === "remote_interaction_responder_unauthorized") {
          throw new HumanRemoteControlError("human_cross_project_forbidden");
        }
      }
      throw error;
    }
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
