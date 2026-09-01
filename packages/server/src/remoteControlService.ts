import {
  operatorActionRequestSchema,
  operatorActionViewSchema,
  operatorDispatchRequestSchema,
  operatorEnrollmentGrantRequestSchema,
  operatorEnrollmentGrantResponseSchema,
  operatorEventQuerySchema,
  operatorEventReplaySchema,
  operatorHostViewSchema,
  operatorHostPageSchema,
  operatorHostRenewalRequestSchema,
  operatorInteractionPageSchema,
  operatorInteractionResponseSchema,
  operatorInteractionViewSchema,
  operatorLegacyOperationViewSchema,
  operatorOwnerTerminalResultMetadataSchema,
  operatorPublicOperationViewSchema,
  operatorPageQuerySchema,
  type OperatorOperationRuntimeWire,
  type OperatorOperationView,
  type OperatorOwnerTerminalResultPayload
} from "./operatorDtos.js";
import {
  humanPrincipalIdSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  remoteAgentEndpointListSchema,
  type RemoteAgentEndpointList
} from "@planweave-ai/collaboration-protocol/agent-endpoint";
import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import { z } from "zod";
import { buildRemoteOperationDiagnostics } from "./remoteOperationDiagnostics.js";
import { AgentEndpointCatalog } from "./agentEndpointCatalog.js";
import { listAuthorizedRemoteAgentEndpoints } from "./remoteAgent/catalog.js";
import type { RemoteAgentAccessPolicy } from "./remoteAgent/accessPolicy.js";
import { RemoteAgentAuthorizationError } from "./remoteAgent/errors.js";
import { HumanPrincipalIdentity } from "./identity/humanPrincipalIdentity.js";
import { RemoteAgentManagementService } from "./remoteAgent/management.js";
import {
  operatorRemoteAgentAccessModeRequestSchema,
  operatorRemoteAgentActorRequestSchema,
  operatorRemoteAgentGrantRequestSchema,
  operatorRemoteAgentListQuerySchema,
  operatorRemoteAgentRepairOwnershipRequestSchema,
  toRemoteAgentManagementAgentView,
  toRemoteAgentManagementList
} from "./remoteAgent/managementDtos.js";
import { RemoteAgentRepository } from "./remoteAgent/repository.js";
import { HostEnrollmentService } from "./hostEnrollment.js";
import {
  DEFAULT_HOST_OFFLINE_AFTER_MS,
  AgentHostRepository,
  fleetHostAvailability,
  isAgentHostOnline,
  operatorHostAvailability,
  type AgentHost
} from "./hosts.js";
import {
  OperatorTokenRegistry,
  type OperatorPrincipal,
  type OperatorRequestPrincipal
} from "./operatorAuth.js";
import { RemoteAcpEventRepository } from "./remoteAcpEvents.js";
import { RemoteBlockCoordinator } from "./remoteBlockCoordinator.js";
import type { RemoteArtifactContentPort } from "./remoteBlockCoordinatorPorts.js";
import { RemoteInteractionService } from "./remoteInteractions.js";
import { RemoteOperationRepository, type RemoteOperation } from "./remoteOperations.js";
import { DispatchService } from "./dispatches.js";
import { toHumanEndpointSnapshot } from "./endpointSelection.js";
import { WorkspaceIdentityRepository } from "./identity/workspaceRepository.js";
import {
  ownerCanvasMaterializationRequestSchema,
  ownerCanvasMaterializationScopeSchema,
  type OwnerCanvasMaterializationRequest
} from "@planweave-ai/collaboration-protocol/owner-canvas/materialization";
import type { OwnerCanvasMaterializationService } from "./canvas/ownerCanvasMaterializationService.js";
import {
  isTerminalRemoteOperation,
  projectRemoteOperationRuntime,
  projectTerminalRemoteOperationRuntime
} from "./remoteOperationRuntimeProjection.js";

export type RemoteControlServiceOptions = {
  authorization: OperatorTokenRegistry;
  enrollments: HostEnrollmentService;
  hosts: AgentHostRepository;
  agentEndpoints: AgentEndpointCatalog;
  remoteAgentAccess: RemoteAgentAccessPolicy;
  operations: RemoteOperationRepository;
  dispatches: DispatchService;
  coordinator: RemoteBlockCoordinator;
  events: RemoteAcpEventRepository;
  interactions: RemoteInteractionService;
  artifactContent: RemoteArtifactContentPort;
  disconnectHost(hostId: string): void;
  hostOfflineAfterMs?: number;
  clock?: () => Date;
  workspaceIdentity: WorkspaceIdentityRepository;
  authorizeProjectScope(scope: { workspaceId: string; projectId: string }): void;
  authorizeCanvas?: (scope: { workspaceId: string; projectId: string; canvasId: string }) => void;
  resolveOwnerRuntimeScope?: (scope: {
    ownerHumanPrincipalId: string;
    projectId: string;
    canvasId: string;
  }) => { workspaceId: string; projectId: string; canvasId: string } | undefined;
  ownerCanvasMaterialization?: OwnerCanvasMaterializationService;
  remoteAgentRepository?: RemoteAgentRepository;
};

const operatorAgentEndpointQuerySchema = z
  .object({
    projectId: opaqueIdentifierSchema.optional(),
    humanPrincipalId: humanPrincipalIdSchema.optional(),
    canvasId: opaqueIdentifierSchema.optional(),
    workspaceId: workspaceIdSchema.optional()
  })
  .strict();

const emptyAgentEndpointList = (): RemoteAgentEndpointList =>
  remoteAgentEndpointListSchema.parse({
    schemaVersion: "agent-endpoint-list/v1",
    items: []
  });

export class RemoteControlService {
  private readonly clock: () => Date;
  private readonly hostOfflineAfterMs: number;
  private readonly remoteAgents: RemoteAgentManagementService | null;
  private readonly humanIdentity: HumanPrincipalIdentity | null;

  constructor(private readonly options: RemoteControlServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.hostOfflineAfterMs = options.hostOfflineAfterMs ?? DEFAULT_HOST_OFFLINE_AFTER_MS;
    this.humanIdentity = options.remoteAgentRepository
      ? new HumanPrincipalIdentity(options.remoteAgentRepository.database)
      : null;
    this.remoteAgents =
      options.remoteAgentRepository && this.humanIdentity
        ? new RemoteAgentManagementService(options.remoteAgentRepository, this.humanIdentity)
        : null;
  }

  remoteRunnerEventCapability() {
    return {
      available: true as const,
      acceptedVersions: [2] as const,
      preferredVersion: 2 as const,
      ...this.options.events.metrics()
    };
  }

  createEnrollmentGrant(principal: OperatorRequestPrincipal, rawRequest: unknown) {
    this.options.authorization.requireServerAdmin(principal);
    const request = operatorEnrollmentGrantRequestSchema.parse(rawRequest);
    const ownerHumanPrincipalId = request.ownerHumanPrincipalId ?? principal.humanPrincipalId;
    if (!ownerHumanPrincipalId) {
      throw new RemoteAgentAuthorizationError("remote_agent_owner_required");
    }
    this.authorizeOwnerHuman(principal, ownerHumanPrincipalId);
    const accessMode = request.accessMode ?? "unrestricted";
    const workspaceId =
      request.workspaceId === undefined
        ? undefined
        : this.resolveWorkspace(principal, request.workspaceId);
    return operatorEnrollmentGrantResponseSchema.parse(
      this.options.enrollments.createGrant({
        ...(workspaceId === undefined ? {} : { workspaceId }),
        expiresAt: new Date(request.expiresAt),
        credentialPolicy: request.credentialPolicy,
        ownerHumanPrincipalId,
        accessMode,
        ...(request.createWorkspaceGrant === undefined
          ? {}
          : { createWorkspaceGrant: request.createWorkspaceGrant })
      })
    );
  }

  listHosts(principal: OperatorPrincipal, rawQuery: unknown) {
    this.options.authorization.requireServerAdmin(principal);
    const query = operatorPageQuerySchema.parse(rawQuery);
    if (query.workspaceId !== undefined) {
      const workspaceId = this.resolveWorkspace(principal, query.workspaceId);
      const hosts = this.options.workspaceIdentity.listHostViews(
        workspaceId,
        query.limit + 1,
        query.cursor
      );
      return operatorHostPageSchema.parse({
        items: hosts
          .slice(0, query.limit)
          .map((host) =>
            this.toOperatorHostView(this.options.hosts.getRequired(host.hostId), workspaceId)
          ),
        nextCursor: hosts.length > query.limit ? query.cursor + query.limit : null
      });
    }
    const hosts = this.options.hosts.list(query.limit + 1, query.cursor);
    return operatorHostPageSchema.parse({
      items: hosts
        .slice(0, query.limit)
        .map((host) => this.toOperatorHostView(host, this.workspaceIdForHost(host.id))),
      nextCursor: hosts.length > query.limit ? query.cursor + query.limit : null
    });
  }

  listAgentEndpoints(
    principal: OperatorRequestPrincipal,
    rawQuery: unknown
  ): RemoteAgentEndpointList {
    const query = operatorAgentEndpointQuerySchema.parse(rawQuery);
    const hasLocator =
      query.humanPrincipalId !== undefined ||
      query.projectId !== undefined ||
      query.canvasId !== undefined ||
      query.workspaceId !== undefined;
    if (!hasLocator) {
      this.options.authorization.requireServerAdmin(principal);
      return emptyAgentEndpointList();
    }
    if (
      query.humanPrincipalId === undefined ||
      query.projectId === undefined ||
      query.canvasId === undefined
    ) {
      throw new Error("operator_query_invalid");
    }
    this.authorizeOwnerHuman(principal, query.humanPrincipalId);
    if (query.workspaceId !== undefined) {
      const workspaceId = this.authorizeWorkspaceRuntimeScope(principal, {
        workspaceId: query.workspaceId,
        projectId: query.projectId,
        canvasId: query.canvasId
      });
      return listAuthorizedRemoteAgentEndpoints({
        policy: this.options.remoteAgentAccess,
        catalog: this.options.agentEndpoints,
        principal: { humanPrincipalId: query.humanPrincipalId },
        target: {
          kind: "workspace_canvas",
          workspaceId: workspaceIdSchema.parse(workspaceId),
          projectId: query.projectId,
          canvasId: query.canvasId
        }
      });
    }
    return listAuthorizedRemoteAgentEndpoints({
      policy: this.options.remoteAgentAccess,
      catalog: this.options.agentEndpoints,
      principal: { humanPrincipalId: query.humanPrincipalId },
      target: {
        kind: "owner_canvas",
        projectId: query.projectId,
        canvasId: query.canvasId
      }
    });
  }

  inspectOwnerCanvasMaterializationHead(principal: OperatorRequestPrincipal, rawScope: unknown) {
    const scope = ownerCanvasMaterializationScopeSchema.parse(rawScope);
    this.authorizeOwnerHuman(principal, scope.ownerHumanPrincipalId);
    return this.requireOwnerCanvasMaterialization().inspectHead(scope);
  }

  materializeOwnerCanvas(
    principal: OperatorRequestPrincipal,
    request: OwnerCanvasMaterializationRequest
  ) {
    const parsed = ownerCanvasMaterializationRequestSchema.parse(request);
    this.authorizeOwnerHuman(principal, parsed.scope.ownerHumanPrincipalId);
    return this.requireOwnerCanvasMaterialization().materialize(parsed);
  }

  getHost(principal: OperatorPrincipal, hostId: string) {
    this.options.authorization.requireServerAdmin(principal);
    const host = this.options.hosts.getRequired(hostId);
    const workspaceId = this.authorizeHostAccess(principal, hostId);
    return this.toOperatorHostView(host, workspaceId);
  }

  revokeHost(principal: OperatorPrincipal, hostId: string) {
    this.options.authorization.requireServerAdmin(principal);
    const workspaceId = this.authorizeHostAccess(principal, hostId);
    this.options.hosts.revoke(hostId);
    this.options.disconnectHost(hostId);
    return this.toOperatorHostView(this.options.hosts.getRequired(hostId), workspaceId);
  }

  requestHostCredentialRenewal(principal: OperatorPrincipal, hostId: string, rawRequest: unknown) {
    this.options.authorization.requireServerAdmin(principal);
    operatorHostRenewalRequestSchema.parse(rawRequest);
    const workspaceId = this.authorizeHostAccess(principal, hostId);
    return this.toOperatorHostView(
      this.options.hosts.requestCredentialRenewal(hostId),
      workspaceId
    );
  }

  async dispatch(
    principal: OperatorRequestPrincipal,
    rawRequest: unknown,
    runtimeWire: OperatorOperationRuntimeWire = "legacy-rich"
  ) {
    if (
      rawRequest !== null &&
      typeof rawRequest === "object" &&
      (!("schemaVersion" in rawRequest) || rawRequest.schemaVersion !== "remote-run/v3")
    ) {
      throw new Error("remote_run_v3_required");
    }
    const request = operatorDispatchRequestSchema.parse(rawRequest);
    if (request.humanPrincipalId === undefined) {
      throw new RemoteAgentAuthorizationError("remote_agent_not_found");
    }
    this.authorizeOwnerHuman(principal, request.humanPrincipalId);
    if (request.workspaceId !== undefined) {
      const workspaceId = this.authorizeWorkspaceRuntimeScope(principal, {
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        canvasId: request.canvasId
      });
      const outcome = await this.options.coordinator.dispatch({
        workspaceId,
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
        callerHumanPrincipalId: request.humanPrincipalId
      });
      return this.observeOperation(principal, outcome.operation.id, runtimeWire);
    }
    const ownerScope = this.options.resolveOwnerRuntimeScope?.({
      ownerHumanPrincipalId: request.humanPrincipalId,
      projectId: request.projectId,
      canvasId: request.canvasId
    });
    if (this.options.resolveOwnerRuntimeScope && !ownerScope) {
      throw new Error("operator_project_forbidden");
    }
    const workspaceId = ownerScope?.workspaceId ?? this.resolveWorkspace(principal);
    if (!ownerScope) {
      this.options.authorizeCanvas?.({
        workspaceId,
        projectId: request.projectId,
        canvasId: request.canvasId
      });
    }
    const outcome = await this.options.coordinator.dispatch({
      workspaceId,
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
      targetKind: ownerScope ? "owner_canvas" : "workspace_canvas",
      callerHumanPrincipalId: request.humanPrincipalId
    });
    return this.observeOperation(principal, outcome.operation.id, runtimeWire);
  }

  async observeOperation(
    principal: OperatorRequestPrincipal,
    operationId: string,
    runtimeWire: OperatorOperationRuntimeWire = "legacy-rich"
  ): Promise<OperatorOperationView> {
    const operation = this.operationFor(principal, operationId);
    const queriedRuntime =
      runtimeWire === "public-runtime-v1" && isTerminalRemoteOperation(operation)
        ? projectTerminalRemoteOperationRuntime(operation)
        : await this.options.coordinator.query(operation.id);
    const runtime =
      runtimeWire === "public-runtime-v1"
        ? projectRemoteOperationRuntime(queriedRuntime)
        : queriedRuntime;
    const dispatch = this.options.dispatches.get(operation.dispatchId);
    const view = {
      operationId: operation.id,
      projectId: operation.projectId,
      canvasId: operation.canvasId,
      blockRef: operation.blockRef,
      state: operation.state,
      dispatchId: operation.dispatchId,
      executionAttemptId: operation.executionAttemptId,
      envelopeDigest: operation.envelopeDigest,
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
    return runtimeWire === "public-runtime-v1"
      ? operatorPublicOperationViewSchema.parse(view)
      : operatorLegacyOperationViewSchema.parse(view);
  }

  async readOwnerOperationTerminalResult(
    principal: OperatorRequestPrincipal,
    operationId: string
  ): Promise<OperatorOwnerTerminalResultPayload> {
    const operation = this.operationFor(principal, operationId);
    if (
      operation.endpointSelection?.authority.schemaVersion !== "endpoint-authority/v2" ||
      operation.endpointSelection.authority.kind !== "owner_canvas" ||
      operation.state !== "completed"
    ) {
      throw new Error("operator_terminal_result_invalid_state");
    }
    const dispatch = this.options.dispatches.get(operation.dispatchId);
    if (
      !dispatch ||
      dispatch.id !== operation.dispatchId ||
      dispatch.status !== "completed" ||
      !dispatch.result ||
      dispatch.workspaceId !== operation.workspaceId ||
      dispatch.projectId !== operation.projectId ||
      dispatch.blockRef !== operation.blockRef ||
      dispatch.executionAttemptId !== operation.executionAttemptId
    ) {
      throw new Error("operator_terminal_result_mismatch");
    }
    const reportBytes = await this.options.artifactContent.readReport(
      dispatch.result.reportArtifactRef
    );
    return {
      metadata: operatorOwnerTerminalResultMetadataSchema.parse({
        operationId: operation.id,
        projectId: operation.projectId,
        canvasId: operation.canvasId,
        blockRef: operation.blockRef,
        controlPlane: "owner",
        sourceRevision: operation.ownershipGeneration,
        graphFingerprint: operation.sourceFingerprint,
        dispatchId: operation.dispatchId,
        executionAttemptId: operation.executionAttemptId,
        reportArtifactRef: dispatch.result.reportArtifactRef
      }),
      reportBytes
    };
  }

  async executeAction(
    principal: OperatorRequestPrincipal,
    operationId: string,
    rawAction: unknown
  ) {
    const operation = this.operationFor(principal, operationId);
    const action = operatorActionRequestSchema.parse(rawAction);
    if (action.operationId !== operation.id) throw new Error("operator_action_operation_mismatch");
    const record = await this.options.coordinator.executeAction(action);
    return operatorActionViewSchema.parse({
      request: record.request,
      state: record.state,
      createdAt: record.createdAt,
      deliveredAt: record.deliveredAt,
      acknowledgedAt: record.acknowledgedAt,
      settledAt: record.settledAt,
      rejectedAt: record.rejectedAt,
      rejectionCode: record.rejectionCode
    });
  }

  replayEvents(principal: OperatorRequestPrincipal, operationId: string, rawAfterCursor: unknown) {
    const operation = this.operationFor(principal, operationId);
    const query = operatorEventQuerySchema.parse({ afterCursor: rawAfterCursor });
    return operatorEventReplaySchema.parse(
      this.options.events.replayAvailable(operation.executionAttemptId, query.afterCursor)
    );
  }

  listPendingInteractions(
    principal: OperatorRequestPrincipal,
    operationId: string,
    rawQuery: unknown
  ) {
    const operation = this.operationFor(principal, operationId);
    const query = operatorPageQuerySchema.parse(rawQuery);
    const interactions = this.options.interactions.listPending(
      operation.id,
      query.limit + 1,
      query.cursor
    );
    return operatorInteractionPageSchema.parse({
      items: interactions.slice(0, query.limit).map(toOperatorInteractionView),
      nextCursor: interactions.length > query.limit ? query.cursor + query.limit : null
    });
  }

  listRemoteAgents(principal: OperatorRequestPrincipal, rawQuery: unknown) {
    const query = operatorRemoteAgentListQuerySchema.parse(rawQuery);
    this.authorizeOwnerHuman(principal, query.humanPrincipalId);
    return toRemoteAgentManagementList(
      this.requireRemoteAgents().listManaged(query.humanPrincipalId)
    );
  }

  setRemoteAgentAccessMode(
    principal: OperatorRequestPrincipal,
    endpointId: string,
    rawRequest: unknown
  ) {
    const request = operatorRemoteAgentAccessModeRequestSchema.parse(rawRequest);
    this.authorizeOwnerHuman(principal, request.humanPrincipalId);
    return this.toManagedAgentView(
      this.requireRemoteAgents().setAccessMode({
        endpointId,
        actorHumanPrincipalId: request.humanPrincipalId,
        accessMode: request.accessMode,
        ...(request.expectedPolicyRevision === undefined
          ? {}
          : { expectedPolicyRevision: request.expectedPolicyRevision })
      })
    );
  }

  grantRemoteAgentWorkspace(
    principal: OperatorRequestPrincipal,
    endpointId: string,
    rawRequest: unknown
  ) {
    const request = operatorRemoteAgentGrantRequestSchema.parse(rawRequest);
    this.authorizeOwnerHuman(principal, request.humanPrincipalId);
    this.requireRemoteAgents().grantWorkspace({
      endpointId,
      actorHumanPrincipalId: request.humanPrincipalId,
      workspaceId: request.workspaceId,
      ...(request.expectedGrantRevision === undefined
        ? {}
        : { expectedGrantRevision: request.expectedGrantRevision })
    });
    return this.managedAgent(endpointId, request.humanPrincipalId);
  }

  revokeRemoteAgentGrant(
    principal: OperatorRequestPrincipal,
    endpointId: string,
    workspaceId: string,
    rawRequest: unknown
  ) {
    const request = operatorRemoteAgentActorRequestSchema.parse(rawRequest);
    this.authorizeOwnerHuman(principal, request.humanPrincipalId);
    this.requireRemoteAgents().revokeGrant({
      endpointId,
      actorHumanPrincipalId: request.humanPrincipalId,
      workspaceId
    });
    return this.managedAgent(endpointId, request.humanPrincipalId);
  }

  revokeRemoteAgent(principal: OperatorRequestPrincipal, endpointId: string, rawRequest: unknown) {
    const request = operatorRemoteAgentActorRequestSchema.parse(rawRequest);
    this.authorizeOwnerHuman(principal, request.humanPrincipalId);
    return this.toManagedAgentView(
      this.requireRemoteAgents().revokeAgent({
        endpointId,
        actorHumanPrincipalId: request.humanPrincipalId
      })
    );
  }

  repairRemoteAgentOwnership(
    principal: OperatorPrincipal,
    endpointId: string,
    rawRequest: unknown
  ) {
    this.options.authorization.requireServerAdmin(principal);
    const request = operatorRemoteAgentRepairOwnershipRequestSchema.parse(rawRequest);
    return this.toManagedAgentView(
      this.requireRemoteAgents().repairOwnership({
        endpointId,
        ownerHumanPrincipalId: request.ownerHumanPrincipalId
      })
    );
  }

  settleInteraction(
    principal: OperatorRequestPrincipal,
    operationId: string,
    rawSettlement: unknown
  ) {
    const operation = this.operationFor(principal, operationId);
    const settlement = operatorInteractionResponseSchema.parse(rawSettlement);
    if (
      settlement.dispatchId !== operation.dispatchId ||
      settlement.executionAttemptId !== operation.executionAttemptId ||
      !operation.attempt.hostId
    ) {
      throw new Error("operator_interaction_operation_mismatch");
    }
    const interaction = this.options.interactions.settle({
      hostId: operation.attempt.hostId,
      responderId: principal.operatorId,
      settlement
    });
    return toOperatorInteractionView(interaction);
  }

  private requireRemoteAgents(): RemoteAgentManagementService {
    if (!this.remoteAgents) throw new RemoteAgentAuthorizationError("remote_agent_not_found");
    return this.remoteAgents;
  }

  private requireOwnerCanvasMaterialization(): OwnerCanvasMaterializationService {
    const service = this.options.ownerCanvasMaterialization;
    if (!service) throw new Error("owner_canvas_materialization_unavailable");
    return service;
  }

  private toManagedAgentView(agent: Parameters<typeof toRemoteAgentManagementAgentView>[0]) {
    return toRemoteAgentManagementAgentView(
      agent,
      this.options.remoteAgentRepository?.listGrants(agent.endpointId) ?? []
    );
  }

  private managedAgent(endpointId: string, actorHumanPrincipalId: string) {
    return this.toManagedAgentView(
      this.requireRemoteAgents().get({ endpointId, actorHumanPrincipalId })
    );
  }

  private operationFor(principal: OperatorRequestPrincipal, operationId: string): RemoteOperation {
    const operation = this.options.operations.getRequired(operationId);
    if (!operation.agentAccess) {
      this.options.authorization.requireServerAdmin(principal);
      this.options.authorization.authorizeProject(principal, operation.projectId);
      return operation;
    }
    if (operation.agentAccess?.authorized.runtimeAuthority.kind === "workspace_canvas") {
      this.authorizeWorkspace(principal, operation.workspaceId);
      this.options.authorizeProjectScope({
        workspaceId: operation.workspaceId,
        projectId: operation.projectId
      });
      this.options.authorizeCanvas?.({
        workspaceId: operation.workspaceId,
        projectId: operation.projectId,
        canvasId: operation.canvasId
      });
      return operation;
    }
    const ownerHumanPrincipalId = operation.agentAccess?.callerHumanPrincipalId;
    if (!ownerHumanPrincipalId) throw new Error("operator_human_identity_forbidden");
    this.authorizeOwnerHuman(principal, ownerHumanPrincipalId);
    if (this.options.resolveOwnerRuntimeScope) {
      const ownerScope = this.options.resolveOwnerRuntimeScope({
        ownerHumanPrincipalId,
        projectId: operation.projectId,
        canvasId: operation.canvasId
      });
      if (!ownerScope || ownerScope.workspaceId !== operation.workspaceId) {
        throw new Error("operator_human_identity_forbidden");
      }
    }
    return operation;
  }

  private authorizeOwnerHuman(
    principal: OperatorRequestPrincipal,
    requestedHumanPrincipalId: string
  ): void {
    if (
      !principal.humanPrincipalId ||
      !this.humanIdentity?.areEquivalent(
        principal.humanPrincipalId,
        humanPrincipalIdSchema.parse(requestedHumanPrincipalId)
      )
    ) {
      throw new Error("operator_human_identity_forbidden");
    }
  }

  private toOperatorHostView(host: AgentHost, workspaceId?: string) {
    return toOperatorHostView(host, workspaceId, this.clock(), this.hostOfflineAfterMs);
  }

  private workspaceIdForHost(hostId: string): string | undefined {
    return this.options.workspaceIdentity.workspaceForHost(hostId);
  }

  private authorizeHostAccess(principal: OperatorPrincipal, hostId: string): string | undefined {
    const workspaceId = this.workspaceIdForHost(hostId);
    if (workspaceId !== undefined) {
      this.authorizeWorkspace(principal, workspaceId);
    }
    return workspaceId;
  }

  private authorizeWorkspace(principal: OperatorPrincipal, workspaceId: string): void {
    if (principal.serverAdmin) return;
    if (principal.workspaceId !== workspaceId) {
      throw new Error("operator_workspace_forbidden");
    }
  }

  private authorizeWorkspaceRuntimeScope(
    principal: OperatorPrincipal,
    scope: { workspaceId: string; projectId: string; canvasId: string }
  ): string {
    const workspaceId = this.resolveWorkspace(principal, scope.workspaceId);
    this.options.authorizeProjectScope({ workspaceId, projectId: scope.projectId });
    this.options.authorizeCanvas?.({
      workspaceId,
      projectId: scope.projectId,
      canvasId: scope.canvasId
    });
    return workspaceId;
  }

  private resolveWorkspace(principal: OperatorPrincipal, requestedWorkspaceId?: string): string {
    const workspaceIds = this.options.workspaceIdentity.listWorkspaceIds();
    const workspaceId = requestedWorkspaceId ?? principal.workspaceId;
    if (!workspaceId || !workspaceIds.includes(workspaceId)) {
      throw new Error("operator_workspace_required");
    }
    this.options.workspaceIdentity.assertReadCutover(workspaceId);
    this.authorizeWorkspace(principal, workspaceId);
    return workspaceId;
  }
}

function toOperatorHostView(
  host: AgentHost,
  workspaceId: string | undefined,
  now: Date,
  hostOfflineAfterMs: number
) {
  const online = isAgentHostOnline(host, { now, hostOfflineAfterMs });
  const availability =
    workspaceId === undefined
      ? fleetHostAvailability(host, online)
      : operatorHostAvailability(host, workspaceId, online);
  return operatorHostViewSchema.parse({
    id: host.id,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    displayName: host.displayName,
    capabilities: host.capabilities,
    capacity: host.capacity,
    online,
    lastSeenAt: host.lastSeenAt,
    revokedAt: host.revokedAt,
    credentialExpiresAt: host.credentialExpiresAt,
    credentialPolicy: host.credentialPolicy,
    credentialRenewalRequestedAt: host.credentialRenewalRequestedAt,
    readinessObservation: host.readinessObservation,
    availability
  });
}

function toOperatorInteractionView(
  interaction: ReturnType<RemoteInteractionService["getRequired"]>
) {
  return operatorInteractionViewSchema.parse({
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
