import type { SqliteDatabase } from "../sqlite.js";
import type { ServerConfig } from "../config.js";
import type { startRemoteBlockCoordinationServer } from "../distributedCoordination.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import type { OperatorTokenRegistry } from "../operatorAuth.js";
import type { HostEnrollmentService } from "../hostEnrollment.js";
import { RemoteControlService } from "../remoteControlService.js";
import { HumanRemoteControlService } from "../humanRemoteControlService.js";
import { RemoteCoordinationMaintenance } from "../remoteCoordinationMaintenance.js";
import {
  assertHumanScopeAuthorized,
  AuthorityRepository,
  AuthorityService,
  createActiveDispatchResolver,
  createHostAssignmentPort,
  createIdentityMembershipPort,
  WorkAssignmentService
} from "../work/index.js";
import type { ActivityJournalComposition } from "./activityComments.js";
import { activitySubjectSchema } from "../comments/index.js";
import {
  ArtifactStoreRemoteContent,
  RuntimeInputArtifactMaterializer
} from "../runtimeArtifactAdapter.js";
import type { HumanIdentityRepository } from "../identity/index.js";
import { RemoteOperationRetention } from "../remoteOperationRetention.js";
import type { RuntimeAttachmentRequest } from "../canvas/runtimeAttachment.js";
import type {
  CanvasExecutionRuntimeLease,
  CanvasExecutionRuntimeRoutePort,
  CanvasRuntimeScopeAvailabilityPort,
  OwnerCanvasRuntimeScopeResolverPort
} from "../canvas/executionRuntimePort.js";
import type { AuthoritySelectingWorkRuntimeFactsAdapter } from "../work/runtimeFactsAdapters.js";
import type { RemoteRuntimeContentTargetPort } from "../remoteBlockCoordinatorPorts.js";
import type { RemoteArtifactContentPort } from "../remoteBlockCoordinatorPorts.js";
import type { OwnerCanvasMaterializationRepository } from "../canvas/ownerCanvasMaterializationRepository.js";
import type { OwnerCanvasMaterializationService } from "../canvas/ownerCanvasMaterializationService.js";
import { humanPrincipalIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";

export function createRemoteCoordinationOptions(input: {
  config: ServerConfig;
  clock: () => Date;
  ownerRuntimeLeases: CanvasExecutionRuntimeRoutePort;
  ownerRuntimeAvailability: CanvasRuntimeScopeAvailabilityPort;
  activity: ActivityJournalComposition;
  getAuthorization(): OperatorTokenRegistry;
  getHumanIdentity(): HumanIdentityRepository | undefined;
  getWorkspaceIdentity(): WorkspaceIdentityRepository;
  ensureRuntimeProjection?: (
    input: RuntimeAttachmentRequest & { lease: CanvasExecutionRuntimeLease }
  ) => void | Promise<void>;
  runtimeContentTargets?: RemoteRuntimeContentTargetPort;
  ownerMaterializedScopeAvailable?: (scope: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
  }) => boolean;
}) {
  return {
    leaseDurationMs: input.config.limits.leaseDurationMs,
    hostOfflineAfterMs: input.config.limits.hostOfflineAfterMs,
    clock: input.clock,
    runtimeLeases: input.ownerRuntimeLeases,
    ...(input.runtimeContentTargets ? { runtimeContentTargets: input.runtimeContentTargets } : {}),
    ...(input.ensureRuntimeProjection
      ? { ensureRuntimeProjection: input.ensureRuntimeProjection }
      : {}),
    inputArtifacts: new RuntimeInputArtifactMaterializer(input.activity.artifactStore),
    artifactContent: new ArtifactStoreRemoteContent(input.activity.artifactStore),
    ownerEndpointScopeAuthorized: (scope: {
      workspaceId: string;
      projectId: string;
      canvasId: string;
    }) =>
      input.ownerRuntimeAvailability.hasRuntimeScope(scope) ||
      input.ownerMaterializedScopeAvailable?.(scope) === true,
    interactionAuthorization: {
      canRespond: (interaction: {
        workspaceId: string;
        projectId: string;
        responderId: string;
      }) => {
        if (input.getAuthorization().canRespond(interaction)) return true;
        if (!input.getHumanIdentity()) throw new Error("human_identity_not_initialized");
        return input
          .getWorkspaceIdentity()
          .hasActiveMembership(interaction.workspaceId, interaction.responderId);
      }
    },
    eventRetentionMaxEvents: input.config.limits.eventRetentionMaxEvents,
    eventRetentionMaxBytes: input.config.limits.eventRetentionMaxBytes,
    onAssignmentUpdatedInTransaction: (
      record: Parameters<
        NonNullable<
          import("../distributedCoordination.js").RemoteBlockCoordinationOptions["onAssignmentUpdatedInTransaction"]
        >
      >[0]
    ) => {
      const actor = activitySubjectSchema.parse(
        record.updatedBy.kind === "human"
          ? {
              kind: "human" as const,
              humanPrincipalId: record.updatedBy.id,
              ...(record.updatedBy.displayName ? { displayName: record.updatedBy.displayName } : {})
            }
          : record.updatedBy.kind === "local_admin"
            ? {
                kind: "local_admin" as const,
                humanPrincipalId: record.updatedBy.id,
                ...(record.updatedBy.displayName
                  ? { displayName: record.updatedBy.displayName }
                  : {})
              }
            : { kind: "system" as const }
      );
      const targetHeadline =
        record.target.kind === "unassigned"
          ? "Assignment cleared"
          : record.target.kind === "human"
            ? "Assigned work item to a project member"
            : record.target.kind === "exact_host"
              ? "Assigned work item to an Agent Host"
              : "Assigned work item to automatic Host selection";
      input.activity
        .assignmentActivityProjection(record.workspaceId)
        .projectAssignmentEventInCallerTransaction({
          projectId: record.projectId,
          workItem: record.workItem,
          assignmentRevision: record.revision,
          actor,
          targetHeadline,
          occurredAt: record.updatedAt
        });
    },
    onDispatchActivityTransitionInTransaction: (
      transition: Parameters<
        NonNullable<
          import("../distributedCoordination.js").RemoteBlockCoordinationOptions["onDispatchActivityTransitionInTransaction"]
        >
      >[0]
    ) => {
      input.activity
        .assignmentActivityProjection(transition.dispatch.workspaceId)
        .projectRemoteRunEventInCallerTransaction({
          projectId: transition.dispatch.projectId,
          type: transition.type,
          dispatchId: transition.dispatch.id,
          hostId: transition.dispatch.hostId,
          occurredAt: transition.occurredAt
        });
    }
  };
}

type Coordination = Awaited<ReturnType<typeof startRemoteBlockCoordinationServer>>["coordination"];

export function createRemoteExecutionComposition(input: {
  database: SqliteDatabase;
  config: ServerConfig;
  clock: () => Date;
  coordination: Coordination;
  ownerRuntimeScopes: OwnerCanvasRuntimeScopeResolverPort;
  workRuntimeFacts: AuthoritySelectingWorkRuntimeFactsAdapter;
  workspaceIdentity: WorkspaceIdentityRepository;
  projectAccess: ProjectAccessRepository;
  authorization: OperatorTokenRegistry;
  enrollments: HostEnrollmentService;
  artifactContent: RemoteArtifactContentPort;
  ownerCanvasMaterializationScopes: OwnerCanvasMaterializationRepository;
  ownerCanvasMaterialization: OwnerCanvasMaterializationService;
}) {
  const membershipPort = createIdentityMembershipPort({
    workspaceIdentity: input.workspaceIdentity
  });
  const hostPort = createHostAssignmentPort({
    hosts: input.coordination.hosts,
    hostOfflineAfterMs: input.config.limits.hostOfflineAfterMs,
    clock: input.clock
  });
  const activeDispatch = createActiveDispatchResolver(input.database);
  const assignmentServices = new Map<string, WorkAssignmentService>();
  const authorityServices = new Map<string, AuthorityService>();
  const authorityRepository = new AuthorityRepository(input.database, { clock: input.clock });
  const runtimeFacts = input.workRuntimeFacts;
  const acquireAuthorityService = (workspaceId: string, projectId: string, canvasId: string) => {
    if (!input.workspaceIdentity.workspaceExists(workspaceId)) return undefined;
    const project = input.projectAccess.registry.projectInternal(workspaceId, projectId);
    const canvas = input.projectAccess.registry.canvasInternal(workspaceId, projectId, canvasId);
    if (!project || project.revokedAt !== null || !canvas || canvas.revokedAt !== null) {
      return undefined;
    }
    const key = assignmentServiceKey(workspaceId, projectId);
    let service = authorityServices.get(key);
    if (!service) {
      service = new AuthorityService({
        repository: authorityRepository,
        runtimeFacts,
        access: input.projectAccess,
        workspaceIdentity: input.workspaceIdentity,
        hosts: input.coordination.hosts,
        clock: input.clock
      });
      authorityServices.set(key, service);
    }
    return {
      service,
      release() {}
    };
  };
  const resolveAssignmentService = (workspaceId: string, projectId: string) => {
    const serviceKey = assignmentServiceKey(workspaceId, projectId);
    let service = assignmentServices.get(serviceKey);
    if (service) return service;
    if (!input.workspaceIdentity.workspaceExists(workspaceId)) return undefined;
    const project = input.projectAccess.registry.projectInternal(workspaceId, projectId);
    if (!project || project.revokedAt !== null) return undefined;
    service = new WorkAssignmentService({
      workspaceId,
      repository: input.coordination.workAssignments,
      runtimeFacts,
      membershipPort,
      hostPort,
      resolveActiveDispatch: activeDispatch,
      clock: input.clock
    });
    assignmentServices.set(serviceKey, service);
    return service;
  };

  const humanRemoteControl = new HumanRemoteControlService({
    operations: input.coordination.operations,
    dispatches: input.coordination.dispatches,
    coordinator: input.coordination.coordinator,
    events: input.coordination.acpEvents,
    interactions: input.coordination.interactions,
    authorizeCanvas: (context, scope) => {
      assertHumanScopeAuthorized({
        actor: context,
        scope,
        access: input.projectAccess,
        workspaceIdentity: input.workspaceIdentity
      });
    }
  });

  return {
    humanRemoteControl,
    resolveAssignmentService,
    acquireAuthorityService,
    createOperatorControl(disconnectHost: (hostId: string) => void) {
      return new RemoteControlService({
        authorization: input.authorization,
        enrollments: input.enrollments,
        hosts: input.coordination.hosts,
        agentEndpoints: input.coordination.agentEndpoints,
        remoteAgentAccess: input.coordination.remoteAgentAccess,
        remoteAgentRepository: input.coordination.remoteAgents,
        operations: input.coordination.operations,
        dispatches: input.coordination.dispatches,
        coordinator: input.coordination.coordinator,
        events: input.coordination.acpEvents,
        interactions: input.coordination.interactions,
        artifactContent: input.artifactContent,
        disconnectHost,
        workspaceIdentity: input.workspaceIdentity,
        authorizeProjectScope: (scope) => {
          if (!input.projectAccess.registry.hasActiveScope(scope)) {
            throw new Error("operator_project_forbidden");
          }
        },
        authorizeCanvas: (scope) => {
          if (!input.projectAccess.registry.hasActiveScope(scope)) {
            throw new Error("operator_project_forbidden");
          }
        },
        resolveOwnerRuntimeScope: ({ ownerHumanPrincipalId, projectId, canvasId }) => {
          return input.ownerCanvasMaterializationScopes.findScope({
            ownerHumanPrincipalId: humanPrincipalIdSchema.parse(ownerHumanPrincipalId),
            projectId,
            canvasId
          });
        },
        ownerCanvasMaterialization: input.ownerCanvasMaterialization,
        hostOfflineAfterMs: input.config.limits.hostOfflineAfterMs,
        clock: input.clock
      });
    },
    createMaintenance() {
      const retention = new RemoteOperationRetention(input.database, input.clock);
      return new RemoteCoordinationMaintenance(
        () => input.coordination.reconcile(),
        input.config.limits.heartbeatIntervalMs,
        () => retention.compactBatch()
      );
    }
  };
}

function assignmentServiceKey(workspaceId: string, projectId: string): string {
  return JSON.stringify([workspaceId, projectId]);
}
