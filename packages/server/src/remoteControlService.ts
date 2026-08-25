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
  operatorOperationViewSchema,
  operatorPageQuerySchema,
  type OperatorOperationView
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
import { AgentEndpointCatalog } from "./agentEndpointCatalog.js";
import { listAuthorizedRemoteAgentEndpoints } from "./remoteAgent/catalog.js";
import type { RemoteAgentAccessPolicy } from "./remoteAgent/accessPolicy.js";
import { RemoteAgentAuthorizationError } from "./remoteAgent/errors.js";
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
import { OperatorTokenRegistry, type OperatorPrincipal } from "./operatorAuth.js";
import { RemoteAcpEventRepository } from "./remoteAcpEvents.js";
import { RemoteBlockCoordinator } from "./remoteBlockCoordinator.js";
import { RemoteInteractionService } from "./remoteInteractions.js";
import { RemoteOperationRepository, type RemoteOperation } from "./remoteOperations.js";
import { DispatchService } from "./dispatches.js";
import { toHumanEndpointSnapshot } from "./endpointSelection.js";
import { WorkspaceIdentityRepository } from "./identity/workspaceRepository.js";

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
  disconnectHost(hostId: string): void;
  hostOfflineAfterMs?: number;
  clock?: () => Date;
  workspaceIdentity: WorkspaceIdentityRepository;
  authorizeProjectScope(scope: { workspaceId: string; projectId: string }): void;
  authorizeCanvas?: (scope: { workspaceId: string; projectId: string; canvasId: string }) => void;
  resolveOwnerRuntimeScope?: (scope: {
    projectId: string;
    canvasId: string;
  }) => { workspaceId: string; projectId: string; canvasId: string } | undefined;
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

  constructor(private readonly options: RemoteControlServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.hostOfflineAfterMs = options.hostOfflineAfterMs ?? DEFAULT_HOST_OFFLINE_AFTER_MS;
    this.remoteAgents = options.remoteAgentRepository
      ? new RemoteAgentManagementService(options.remoteAgentRepository)
      : null;
  }

  createEnrollmentGrant(principal: OperatorPrincipal, rawRequest: unknown) {
    this.options.authorization.requireServerAdmin(principal);
    const request = operatorEnrollmentGrantRequestSchema.parse(rawRequest);
    const workspaceId =
      request.workspaceId === undefined
        ? undefined
        : this.resolveWorkspace(principal, request.workspaceId);
    return operatorEnrollmentGrantResponseSchema.parse(
      this.options.enrollments.createGrant({
        ...(workspaceId === undefined ? {} : { workspaceId }),
        expiresAt: new Date(request.expiresAt),
        credentialPolicy: request.credentialPolicy,
        ...(request.ownerHumanPrincipalId === undefined
          ? {}
          : { ownerHumanPrincipalId: request.ownerHumanPrincipalId }),
        ...(request.accessMode === undefined ? {} : { accessMode: request.accessMode }),
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

  listAgentEndpoints(principal: OperatorPrincipal, rawQuery: unknown): RemoteAgentEndpointList {
    this.options.authorization.requireServerAdmin(principal);
    const query = operatorAgentEndpointQuerySchema.parse(rawQuery);
    if (
      query.humanPrincipalId === undefined ||
      query.projectId === undefined ||
      query.canvasId === undefined
    ) {
      return emptyAgentEndpointList();
    }
    this.options.authorization.authorizeProject(principal, query.projectId);
    if (query.workspaceId !== undefined) {
      const workspaceId = this.resolveWorkspace(principal, query.workspaceId);
      this.options.authorizeProjectScope({ workspaceId, projectId: query.projectId });
      this.options.authorizeCanvas?.({
        workspaceId,
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
    const ownerScope = this.options.resolveOwnerRuntimeScope?.({
      projectId: query.projectId,
      canvasId: query.canvasId
    });
    if (!ownerScope) return emptyAgentEndpointList();
    return listAuthorizedRemoteAgentEndpoints({
      policy: this.options.remoteAgentAccess,
      catalog: this.options.agentEndpoints,
      principal: { humanPrincipalId: query.humanPrincipalId },
      target: {
        kind: "owner_canvas",
        projectId: ownerScope.projectId,
        canvasId: ownerScope.canvasId
      }
    });
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

  async dispatch(principal: OperatorPrincipal, rawRequest: unknown) {
    if (
      rawRequest !== null &&
      typeof rawRequest === "object" &&
      (!("schemaVersion" in rawRequest) || rawRequest.schemaVersion !== "remote-run/v3")
    ) {
      throw new Error("remote_run_v3_required");
    }
    const request = operatorDispatchRequestSchema.parse(rawRequest);
    this.options.authorization.authorizeProject(principal, request.projectId);
    if (request.humanPrincipalId === undefined) {
      throw new RemoteAgentAuthorizationError("remote_agent_not_found");
    }
    if (request.workspaceId !== undefined) {
      this.options.authorization.requireServerAdmin(principal);
      const workspaceId = this.resolveWorkspace(principal, request.workspaceId);
      this.options.authorizeCanvas?.({
        workspaceId,
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
        controlPlane: "collaboration",
        callerHumanPrincipalId: request.humanPrincipalId
      });
      return this.observeOperation(principal, outcome.operation.id);
    }
    const ownerScope = this.options.resolveOwnerRuntimeScope?.({
      projectId: request.projectId,
      canvasId: request.canvasId
    });
    if (this.options.resolveOwnerRuntimeScope && !ownerScope) {
      throw new Error("operator_project_forbidden");
    }
    if (ownerScope) this.options.authorization.requireServerAdmin(principal);
    const workspaceId = this.resolveWorkspace(
      principal,
      ownerScope?.workspaceId ?? principal.workspaceId
    );
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
      controlPlane: ownerScope ? "owner" : "collaboration",
      callerHumanPrincipalId: request.humanPrincipalId
    });
    return this.observeOperation(principal, outcome.operation.id);
  }

  async observeOperation(
    principal: OperatorPrincipal,
    operationId: string
  ): Promise<OperatorOperationView> {
    const operation = this.operationFor(principal, operationId);
    const runtime = await this.options.coordinator.query(operation.id);
    const dispatch = this.options.dispatches.get(operation.dispatchId);
    return operatorOperationViewSchema.parse({
      operationId: operation.id,
      projectId: operation.projectId,
      canvasId: operation.canvasId,
      blockRef: operation.blockRef,
      state: operation.state,
      dispatchId: operation.dispatchId,
      executionAttemptId: operation.executionAttemptId,
      envelopeDigest: operation.envelopeDigest,
      reportArtifactRef: dispatch?.result?.reportArtifactRef,
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
      runtime
    });
  }

  async executeAction(principal: OperatorPrincipal, operationId: string, rawAction: unknown) {
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

  replayEvents(principal: OperatorPrincipal, operationId: string, rawAfterCursor: unknown) {
    const operation = this.operationFor(principal, operationId);
    const query = operatorEventQuerySchema.parse({ afterCursor: rawAfterCursor });
    return operatorEventReplaySchema.parse(
      this.options.events.replayAvailable(operation.executionAttemptId, query.afterCursor)
    );
  }

  listPendingInteractions(principal: OperatorPrincipal, operationId: string, rawQuery: unknown) {
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

  listRemoteAgents(principal: OperatorPrincipal, rawQuery: unknown) {
    this.options.authorization.requireServerAdmin(principal);
    const query = operatorRemoteAgentListQuerySchema.parse(rawQuery);
    return toRemoteAgentManagementList(
      this.requireRemoteAgents().listManaged(query.humanPrincipalId)
    );
  }

  setRemoteAgentAccessMode(principal: OperatorPrincipal, endpointId: string, rawRequest: unknown) {
    this.options.authorization.requireServerAdmin(principal);
    const request = operatorRemoteAgentAccessModeRequestSchema.parse(rawRequest);
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

  grantRemoteAgentWorkspace(principal: OperatorPrincipal, endpointId: string, rawRequest: unknown) {
    this.options.authorization.requireServerAdmin(principal);
    const request = operatorRemoteAgentGrantRequestSchema.parse(rawRequest);
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
    principal: OperatorPrincipal,
    endpointId: string,
    workspaceId: string,
    rawRequest: unknown
  ) {
    this.options.authorization.requireServerAdmin(principal);
    const request = operatorRemoteAgentActorRequestSchema.parse(rawRequest);
    this.requireRemoteAgents().revokeGrant({
      endpointId,
      actorHumanPrincipalId: request.humanPrincipalId,
      workspaceId
    });
    return this.managedAgent(endpointId, request.humanPrincipalId);
  }

  revokeRemoteAgent(principal: OperatorPrincipal, endpointId: string, rawRequest: unknown) {
    this.options.authorization.requireServerAdmin(principal);
    const request = operatorRemoteAgentActorRequestSchema.parse(rawRequest);
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

  settleInteraction(principal: OperatorPrincipal, operationId: string, rawSettlement: unknown) {
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

  private operationFor(principal: OperatorPrincipal, operationId: string): RemoteOperation {
    const operation = principal.serverAdmin
      ? this.options.operations.getRequired(operationId)
      : this.options.operations.getRequiredInWorkspace(principal.workspaceId, operationId);
    this.options.authorization.authorizeProject(principal, operation.projectId);
    this.authorizeWorkspace(principal, operation.workspaceId);
    if (this.options.resolveOwnerRuntimeScope) {
      const ownerScope = this.options.resolveOwnerRuntimeScope({
        projectId: operation.projectId,
        canvasId: operation.canvasId
      });
      if (!ownerScope || ownerScope.workspaceId !== operation.workspaceId) {
        throw new Error("operator_project_forbidden");
      }
    }
    return operation;
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
    this.options.authorization.authorizeWorkspace(principal, workspaceId, (projectId) =>
      principal.projectIds.includes(projectId) ? principal.workspaceId : undefined
    );
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
