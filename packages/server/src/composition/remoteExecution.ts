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
import type { TrustedRuntimeRegistry } from "./identityAccess.js";
import type { ActivityJournalComposition } from "./activityComments.js";
import { activitySubjectSchema } from "../comments/index.js";
import {
  ArtifactStoreRemoteContent,
  RuntimeInputArtifactMaterializer
} from "../runtimeArtifactAdapter.js";
import type { HumanIdentityRepository } from "../identity/index.js";
import { RemoteOperationRetention } from "../remoteOperationRetention.js";

export function createRemoteCoordinationOptions(input: {
  config: ServerConfig;
  clock: () => Date;
  ownerRuntimeRegistry: TrustedRuntimeRegistry;
  activity: ActivityJournalComposition;
  getAuthorization(): OperatorTokenRegistry;
  getHumanIdentity(): HumanIdentityRepository | undefined;
  getWorkspaceIdentity(): WorkspaceIdentityRepository;
}) {
  return {
    leaseDurationMs: input.config.limits.leaseDurationMs,
    hostOfflineAfterMs: input.config.limits.hostOfflineAfterMs,
    clock: input.clock,
    runtimeResolver: input.ownerRuntimeRegistry.registry,
    inputArtifacts: new RuntimeInputArtifactMaterializer(
      input.ownerRuntimeRegistry.registry,
      input.activity.artifactStore
    ),
    artifactContent: new ArtifactStoreRemoteContent(input.activity.artifactStore),
    ownerEndpointScopeAuthorized: (scope: {
      workspaceId: string;
      projectId: string;
      canvasId: string;
    }) => input.ownerRuntimeRegistry.hasScope(scope),
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
          .listMembershipViews(interaction.workspaceId)
          .some(
            (membership) =>
              membership.humanPrincipalId === interaction.responderId &&
              membership.revokedAt === null
          );
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
  runtimeRegistry: TrustedRuntimeRegistry;
  ownerRuntimeRegistry: TrustedRuntimeRegistry;
  workspaceIdentity: WorkspaceIdentityRepository;
  projectAccess: ProjectAccessRepository;
  authorization: OperatorTokenRegistry;
  enrollments: HostEnrollmentService;
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
  const authorityRepository = new AuthorityRepository(input.database, { clock: input.clock });
  const acquireAuthorityService = (workspaceId: string, projectId: string, canvasId: string) => {
    if (!input.workspaceIdentity.workspaceExists(workspaceId)) return undefined;
    const project = input.projectAccess.registry.projectInternal(workspaceId, projectId);
    const canvas = input.projectAccess.registry.canvasInternal(workspaceId, projectId, canvasId);
    if (!project || project.revokedAt !== null || !canvas || canvas.revokedAt !== null) {
      return undefined;
    }
    const acquired = input.runtimeRegistry.acquireScopedWorkItemPackagePort({
      workspaceId,
      projectId,
      canvasId
    });
    if (!acquired) return undefined;
    return {
      service: new AuthorityService({
        repository: authorityRepository,
        packagePort: acquired.port,
        access: input.projectAccess,
        workspaceIdentity: input.workspaceIdentity,
        hosts: input.coordination.hosts,
        clock: input.clock
      }),
      release: acquired.release
    };
  };
  for (const { workspaceId, projectId } of input.runtimeRegistry.locators) {
    const serviceKey = assignmentServiceKey(workspaceId, projectId);
    if (assignmentServices.has(serviceKey)) continue;
    const packagePort = input.runtimeRegistry.scopedProjectWorkItemPackagePort({
      workspaceId,
      projectId
    });
    if (!packagePort) throw new Error("trusted_project_work_item_port_missing");
    assignmentServices.set(
      serviceKey,
      new WorkAssignmentService({
        workspaceId,
        repository: input.coordination.workAssignments,
        packagePort,
        membershipPort,
        hostPort,
        resolveActiveDispatch: activeDispatch,
        clock: input.clock
      })
    );
  }

  const humanRemoteControl = new HumanRemoteControlService({
    operations: input.coordination.operations,
    dispatches: input.coordination.dispatches,
    coordinator: input.coordination.coordinator,
    events: input.coordination.acpEvents,
    interactions: input.coordination.interactions,
    runtimeAvailable: (scope) => input.runtimeRegistry.hasScope(scope),
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
    resolveAssignmentService: (workspaceId: string, projectId: string) =>
      assignmentServices.get(assignmentServiceKey(workspaceId, projectId)),
    acquireAuthorityService,
    createOperatorControl(disconnectHost: (hostId: string) => void) {
      return new RemoteControlService({
        authorization: input.authorization,
        enrollments: input.enrollments,
        hosts: input.coordination.hosts,
        agentEndpoints: input.coordination.agentEndpoints,
        operations: input.coordination.operations,
        dispatches: input.coordination.dispatches,
        coordinator: input.coordination.coordinator,
        events: input.coordination.acpEvents,
        interactions: input.coordination.interactions,
        disconnectHost,
        workspaceIdentity: input.workspaceIdentity,
        authorizeProjectScope: (scope) => {
          if (!input.runtimeRegistry.hasScope(scope)) throw new Error("operator_project_forbidden");
        },
        authorizeCanvas: (scope) => {
          if (!input.runtimeRegistry.hasScope(scope)) throw new Error("operator_project_forbidden");
        },
        resolveOwnerRuntimeScope: ({ projectId, canvasId }) => {
          const matches = input.ownerRuntimeRegistry.expansions.filter(
            (scope) => scope.projectId === projectId && scope.canvasId === canvasId
          );
          if (matches.length !== 1) return undefined;
          const match = matches[0]!;
          return {
            workspaceId: match.workspaceId,
            projectId: match.projectId,
            canvasId: match.canvasId
          };
        },
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
