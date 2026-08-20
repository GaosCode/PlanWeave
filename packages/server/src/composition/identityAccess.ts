import type { ServerConfig } from "../config.js";
import { createTrustedRuntimeRegistry } from "../runtimeProjectRegistry.js";
import type { SqliteDatabase } from "../sqlite.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { PackageSnapshotRepository } from "../packageSnapshotRepository.js";
import type { RegistryHttpService } from "../registryHttp.js";
import {
  HumanIdentityRepository,
  HumanMembershipService,
  type CollaborationScopeAuthority
} from "../identity/index.js";
import type { ProjectRegistryRepository } from "../projectRegistryRepository.js";
import { SetupCodeService } from "../identity/setupCodeService.js";
import { provisionConfiguredOperatorSessions } from "../identity/operatorSessionProvisioning.js";
import { OperatorTokenRegistry } from "../operatorAuth.js";
import type { AuthorizationChangeSignal } from "../authorizationChangeSignal.js";
import type { ActivityJournalComposition } from "./activityComments.js";
import {
  readAclRegistryMigration,
  repairAclRegistryMigration,
  retryAclRegistryMigration
} from "../migrations.js";
import type { CanvasPackageSnapshotRuntimePort } from "../canvas/runtimePort.js";

export type TrustedRuntimeRegistry = Awaited<ReturnType<typeof createTrustedRuntimeRegistry>>;

/** Collaboration identity and ACL scope existence comes only from the SQLite registry. */
export function createRegistryCollaborationScopeAuthority(
  registry: ProjectRegistryRepository
): CollaborationScopeAuthority {
  return {
    hasProject(projectId) {
      return registry.hasActiveProject(projectId);
    },
    hasScope(input) {
      return registry.hasActiveScope(input);
    }
  };
}

export async function createRuntimeRegistryComposition(input: {
  trustedProjects: ServerConfig["trustedProjects"];
  ownerTrustedProjects?: ServerConfig["trustedProjects"];
}) {
  const runtimeRegistry = await createTrustedRuntimeRegistry(input.trustedProjects);
  let ownerRuntimeRegistry = runtimeRegistry;
  try {
    if (input.ownerTrustedProjects) {
      ownerRuntimeRegistry = await createTrustedRuntimeRegistry(input.ownerTrustedProjects);
    }
  } catch (error) {
    runtimeRegistry.close();
    throw error;
  }
  return {
    runtimeRegistry,
    ownerRuntimeRegistry,
    close() {
      const errors: unknown[] = [];
      if (ownerRuntimeRegistry !== runtimeRegistry) {
        try {
          ownerRuntimeRegistry.close();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        runtimeRegistry.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) throw new AggregateError(errors, "runtime_registry_cleanup_failed");
    }
  };
}

export function createIdentityAccessComposition(input: {
  database: SqliteDatabase;
  config: ServerConfig;
  clock: () => Date;
  runtimeRegistry: TrustedRuntimeRegistry;
  ownerRuntimeRegistry: TrustedRuntimeRegistry;
  packageSnapshotRuntime: CanvasPackageSnapshotRuntimePort;
  onAuthorizationChange: ConstructorParameters<typeof ProjectAccessRepository>[2];
}) {
  const workspaceIdentity = new WorkspaceIdentityRepository(input.database);
  const projectAccess = new ProjectAccessRepository(
    input.database,
    input.clock,
    input.onAuthorizationChange
  );
  for (const workspaceId of new Set(
    input.ownerRuntimeRegistry.expansions.map((scope) => scope.workspaceId)
  )) {
    workspaceIdentity.ensureConfiguredWorkspace(workspaceId);
  }
  const canvasesByProjectScope = new Map<
    string,
    {
      workspaceId: string;
      projectId: string;
      projectRoot: string;
      canvases: TrustedRuntimeRegistry["expansions"];
    }
  >();
  for (const expansion of input.runtimeRegistry.expansions) {
    const projectScopeKey = `${expansion.workspaceId}\0${expansion.projectId}`;
    const current = canvasesByProjectScope.get(projectScopeKey);
    if (current) current.canvases = [...current.canvases, expansion];
    else {
      canvasesByProjectScope.set(projectScopeKey, {
        workspaceId: expansion.workspaceId,
        projectId: expansion.projectId,
        projectRoot: expansion.projectRoot,
        canvases: [expansion]
      });
    }
  }
  for (const project of canvasesByProjectScope.values()) {
    const { workspaceId, projectId } = project;
    workspaceIdentity.ensureConfiguredWorkspace(workspaceId);
    prepareAclRegistryMigrationForStartup({
      database: input.database,
      workspaceId,
      projectId,
      sourceKind: "trusted_project"
    });
    const existingProject = projectAccess.registry.projectInternal(workspaceId, projectId);
    if (existingProject?.projectRoot === null) {
      projectAccess.bindProjectPath(workspaceId, projectId, project.projectRoot);
    }
    projectAccess.registerProjectInternal({
      workspaceId,
      projectId,
      projectRoot: project.projectRoot,
      visibility: existingProject?.visibility ?? "private"
    });
    for (const canvas of project.canvases) {
      prepareAclRegistryMigrationForStartup({
        database: input.database,
        workspaceId,
        projectId,
        canvasId: canvas.canvasId,
        sourceKind: "trusted_canvas"
      });
      const existingCanvas = projectAccess.registry.canvasInternal(
        workspaceId,
        projectId,
        canvas.canvasId
      );
      projectAccess.registerCanvasInternal({
        workspaceId,
        projectId,
        canvasId: canvas.canvasId,
        packageDir: canvas.packageDir,
        visibility: existingCanvas?.visibility ?? "private"
      });
      projectAccess.markCanvasCutover(workspaceId, projectId, canvas.canvasId);
    }
    projectAccess.reconcileRuntimeCanvases(
      workspaceId,
      projectId,
      project.canvases.map((canvas) => canvas.canvasId)
    );
    projectAccess.finalizeProjectCutover(workspaceId, projectId);
  }
  for (const projectId of new Set(
    input.runtimeRegistry.expansions.map((scope) => scope.projectId)
  )) {
    const workspaceId = uniqueConfiguredWorkspaceId(input.runtimeRegistry, projectId);
    if (workspaceId) workspaceIdentity.ensureLegacyProjectAdapter(projectId, workspaceId);
  }

  const packageSnapshots = new PackageSnapshotRepository(
    input.database,
    projectAccess,
    input.config.dataDirectory,
    input.packageSnapshotRuntime,
    input.clock
  );
  const collaborationScopeAuthority = createRegistryCollaborationScopeAuthority(
    projectAccess.registry
  );
  const registryService = createRegistryService(
    collaborationScopeAuthority,
    projectAccess,
    packageSnapshots
  );
  return { workspaceIdentity, projectAccess, registryService, collaborationScopeAuthority };
}

export function createIdentityServices(input: {
  database: SqliteDatabase;
  config: ServerConfig;
  clock: () => Date;
  runtimeRegistry: TrustedRuntimeRegistry;
  ownerRuntimeRegistry: TrustedRuntimeRegistry;
  workspaceIdentity: WorkspaceIdentityRepository;
  projectAccess: ProjectAccessRepository;
  collaborationScopeAuthority: CollaborationScopeAuthority;
  authorizationChanges: AuthorizationChangeSignal;
  activity: ActivityJournalComposition;
  onHumanIdentityCreated(identity: HumanIdentityRepository): void;
}) {
  const setupCodes = new SetupCodeService({
    database: input.database,
    serverBaseUrl: input.config.transport.advertisedOrigin.endsWith("/")
      ? input.config.transport.advertisedOrigin
      : `${input.config.transport.advertisedOrigin}/`,
    allowInsecureTransport: input.config.insecurePolicy.allowInsecureTransport,
    clock: input.clock,
    operatorSessionTtlMs: input.config.operatorSessionTtlMs,
    onWorkspaceDeviceMembershipCreated: ({ workspaceId, humanPrincipalId, role }) => {
      const projectIds = new Set<string>();
      for (const scope of input.runtimeRegistry.expansions) {
        if (scope.workspaceId !== workspaceId || projectIds.has(scope.projectId)) continue;
        projectIds.add(scope.projectId);
        input.projectAccess.synchronizeHumanMembershipOwnerInCallerTransaction({
          workspaceId,
          projectId: scope.projectId,
          humanPrincipalId,
          transition: "member_joined",
          membershipRole: role
        });
      }
    }
  });
  const authorization = new OperatorTokenRegistry(
    input.database,
    input.config.operatorCredentials,
    input.clock
  );
  const serverAdminAnchorWorkspaceId =
    input.runtimeRegistry.expansions[0]?.workspaceId ??
    input.ownerRuntimeRegistry.expansions[0]?.workspaceId ??
    input.workspaceIdentity.ensureConfiguredWorkspace("workspace-self-host");
  provisionConfiguredOperatorSessions({
    database: input.database,
    credentials: input.config.operatorCredentials,
    trustedProjectIds: [
      ...new Set(input.runtimeRegistry.expansions.map((canvas) => canvas.projectId))
    ],
    serverAdminAnchorWorkspaceId,
    workspaceForProject: (projectId) => {
      const scopes = input.runtimeRegistry.expansions.filter(
        (expansion) => expansion.projectId === projectId
      );
      const workspaceIds = [...new Set(scopes.map((scope) => scope.workspaceId))];
      return workspaceIds.length === 1 ? workspaceIds[0] : undefined;
    },
    operatorSessionTtlMs: input.config.operatorSessionTtlMs,
    clock: input.clock
  });
  const humanIdentity = new HumanIdentityRepository(input.database, input.clock, {
    onMembershipTransitionInTransaction: ({ type, membership, principal }) => {
      const workspaceId = input.workspaceIdentity.workspaceForLegacyProject(membership.projectId);
      if (!workspaceId) throw new Error("workspace_not_found");
      input.projectAccess.synchronizeHumanMembershipOwnerInCallerTransaction({
        workspaceId,
        projectId: membership.projectId,
        humanPrincipalId: principal.humanPrincipalId,
        transition: type,
        membershipRole: membership.role
      });
      input.activity.activityProjection.projectMembershipEventInCallerTransaction({
        projectId: membership.projectId,
        type,
        membershipId: membership.membershipId,
        transitionRevision: membership.revision,
        humanPrincipalId: membership.humanPrincipalId,
        displayName: principal.displayName,
        membershipRole: membership.role,
        occurredAt: membership.updatedAt
      });
    },
    onInvitationTransitionInTransaction: ({ invitation }) => {
      const workspaceId = input.workspaceIdentity.workspaceForLegacyProject(invitation.projectId);
      if (!workspaceId) throw new Error("human_observer_workspace_scope_unresolved");
      input.activity.humanObserverJournal.appendInCallerTransaction(
        { workspaceId, projectId: invitation.projectId },
        { kind: "invitation" },
        invitation.consumedAt ?? invitation.revokedAt ?? invitation.createdAt
      );
    },
    onAuthorizationChangeAfterCommit: (change) => input.authorizationChanges.publish(change)
  });
  input.onHumanIdentityCreated(humanIdentity);
  const humanMembership = new HumanMembershipService({
    repository: humanIdentity,
    collaborationScopeAuthority: input.collaborationScopeAuthority,
    workspaceForProject: (projectId) =>
      input.workspaceIdentity.ensureWorkspaceForLegacyProject(projectId),
    clock: input.clock
  });
  return {
    setupCodes,
    authorization,
    humanIdentity,
    humanMembership,
    collaborationScopeAuthority: input.collaborationScopeAuthority
  };
}

function createRegistryService(
  collaborationScopeAuthority: CollaborationScopeAuthority,
  projectAccess: ProjectAccessRepository,
  packageSnapshots: PackageSnapshotRepository
): RegistryHttpService {
  const assertCanvasScope = (scope: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
  }) => {
    if (!collaborationScopeAuthority.hasScope(scope)) throw new Error("registry_canvas_not_found");
  };
  return {
    listProjects(input) {
      const items = projectAccess.listAuthorizedProjects({
        workspaceId: input.workspaceId,
        actor: input.actor,
        limit: input.limit,
        offset: input.cursor
      });
      return {
        items,
        nextCursor: items.length === input.limit ? input.cursor + input.limit : null
      };
    },
    listCanvases(input) {
      const items = projectAccess.listAuthorizedCanvases({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        actor: input.actor,
        limit: input.limit,
        offset: input.cursor
      });
      return {
        items,
        nextCursor: items.length === input.limit ? input.cursor + input.limit : null
      };
    },
    readSnapshot(input) {
      assertCanvasScope(input);
      return packageSnapshots.read(input);
    },
    createSnapshot(input) {
      assertCanvasScope(input);
      return packageSnapshots.create(input);
    },
    restoreSnapshot(input) {
      assertCanvasScope(input);
      return packageSnapshots.restore(input);
    }
  };
}

function prepareAclRegistryMigrationForStartup(input: {
  database: SqliteDatabase;
  workspaceId: string;
  projectId: string;
  canvasId?: string;
  sourceKind: "trusted_project" | "trusted_canvas";
}): void {
  const scope = {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    ...(input.canvasId === undefined ? {} : { canvasId: input.canvasId }),
    sourceKind: input.sourceKind
  } as const;
  const migration = readAclRegistryMigration(input.database, scope);
  if (!migration || migration.status === "completed") return;
  if (migration.status === "interrupted" || migration.status === "repair_required") {
    repairAclRegistryMigration(input.database, scope);
  }
  retryAclRegistryMigration(input.database, scope);
}

function uniqueConfiguredWorkspaceId(
  runtimeRegistry: TrustedRuntimeRegistry,
  projectId: string
): string | undefined {
  const workspaceIds = [
    ...new Set(
      runtimeRegistry.expansions
        .filter((scope) => scope.projectId === projectId)
        .map((scope) => scope.workspaceId)
    )
  ];
  return workspaceIds.length === 1 ? workspaceIds[0] : undefined;
}
