import { ownerPackageLocatorForRun } from "@planweave-ai/agent-host-protocol";
import { DispatchService, type DispatchRecord } from "./dispatches.js";
import { ArtifactAuthorizationRepository } from "./artifactAuthorization.js";
import {
  AgentHostRepository,
  hostExecutionProfileAvailability,
  isAgentHostOnline
} from "./hosts.js";
import { DurableMailbox } from "./mailbox.js";
import type { SqliteDatabase } from "./sqlite.js";
import { RemoteBlockCoordinator } from "./remoteBlockCoordinator.js";
import type { RemoteBlockCoordinatorOptions } from "./remoteBlockCoordinator.js";
import { ensureRuntimeAttachmentForOperation } from "./canvas/runtimeAttachment.js";
import type {
  RemoteArtifactContentPort,
  RemoteContentAuthorizePort,
  RemoteCoordinatorCheckpointPort,
  RemoteInputArtifactPort,
  RemoteRuntimeContentTargetPort
} from "./remoteBlockCoordinatorPorts.js";
import { CanvasRuntimeOperationAttachmentRepository } from "./canvas/runtimeOperationAttachmentRepository.js";
import { ServerCanvasDispatchCandidateReader } from "./canvas/remoteDispatchCandidateReader.js";
import { dispatchResultSchema } from "./protocol.js";
import { ContentVersionRepository } from "./canvas/contentVersionRepository.js";
import { readStableCanvasRuntimeContentTarget } from "./canvas/contentFingerprint.js";
import type { CanvasExecutionRuntimeRoutePort } from "./canvas/executionRuntimePort.js";
import {
  SqliteRemoteDispatchPersistence,
  SqliteRemoteOperationCandidateRepository
} from "./remoteCoordinatorPersistence.js";
import { HostReservationRepository } from "./hostReservations.js";
import { RemoteOperationRepository } from "./remoteOperations.js";
import { RemoteExecutionActionRepository } from "./remoteExecutionActions.js";
import { RemoteAcpEventRepository } from "./remoteAcpEvents.js";
import {
  RemoteInteractionService,
  type RemoteInteractionAuthorizationPort
} from "./remoteInteractions.js";
import { startPlanweaveServer, type PlanweaveServer, type StartupContext } from "./lifecycle.js";
import type { ServerStorageConfig } from "./config.js";
import {
  createAssignmentDispatchGate,
  createAuthorityDispatchGate,
  DispatchAssignmentError,
  type AssignmentDispatchGate
} from "./work/dispatchIntegration.js";
import { WorkAssignmentRepository } from "./work/repository.js";
import { createHostAssignmentPort } from "./work/ports.js";
import type { AssignmentRecord } from "./work/schemas.js";
import { AuthorityRepository } from "./work/authorityRepository.js";
import { WorkspaceIdentityRepository } from "./identity/workspaceRepository.js";
import { HumanPrincipalIdentity } from "./identity/humanPrincipalIdentity.js";
import { ProjectAccessRepository } from "./projectAccessRepository.js";
import { evaluateHostAuthorization } from "./work/authorityPolicy.js";
import { hostAuthorizationFactsSchema } from "@planweave-ai/collaboration-protocol/work/host-authorization";
import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { AgentEndpointCatalog } from "./agentEndpointCatalog.js";
import { RemoteAgentAccessPolicy, RemoteAgentRepository } from "./remoteAgent/index.js";
import { syncRemoteAgentsFromHost } from "./remoteAgent/sync.js";

export type RemoteBlockCoordinationOptions = {
  leaseDurationMs: number;
  hostOfflineAfterMs: number;
  clock?: () => Date;
  runtimeLeases: CanvasExecutionRuntimeRoutePort;
  inputArtifacts: RemoteInputArtifactPort;
  artifactContent: RemoteArtifactContentPort;
  checkpoints?: RemoteCoordinatorCheckpointPort;
  interactionAuthorization?: RemoteInteractionAuthorizationPort;
  /** Owner-canvas runtime authority adapter; workspace-canvas dispatches never consult this port. */
  ownerEndpointScopeAuthorized?(input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
  }): boolean;
  /** Idempotent Host evidence → Server Runtime projection after workspace attach. */
  ensureRuntimeProjection?: RemoteBlockCoordinatorOptions["ensureRuntimeProjection"];
  runtimeContentTargets?: RemoteRuntimeContentTargetPort;
  eventRetentionMaxEvents?: number;
  eventRetentionMaxBytes?: number;
  /**
   * When true (default), wire assignment→dispatch gate with operator-compatible override default.
   * Set false only for low-level tests that intentionally bypass assignment policy.
   */
  enableAssignmentDispatchGate?: boolean;
  /** Override the default assignment gate (e.g. strict human collaboration path). */
  assignmentGate?: AssignmentDispatchGate;
  onAssignmentUpdatedInTransaction?: (record: AssignmentRecord) => void;
  onDispatchActivityTransitionInTransaction?: (input: {
    type:
      | "remote_run_started"
      | "remote_run_succeeded"
      | "remote_run_failed"
      | "remote_run_interrupted";
    dispatch: DispatchRecord;
    occurredAt: string;
  }) => void;
};

export function createRemoteBlockCoordination(
  database: SqliteDatabase,
  options: RemoteBlockCoordinationOptions,
  startupContext: StartupContext
) {
  const clock = options.clock ?? (() => new Date());
  const hosts = new AgentHostRepository(database, clock, (host) => {
    syncRemoteAgentsFromHost({ database, host, clock });
  });
  const runtimeOperationAttachments = new CanvasRuntimeOperationAttachmentRepository(
    database,
    hosts,
    clock,
    options.runtimeContentTargets
  );
  const mailbox = new DurableMailbox(database);
  const artifactAuthorization = new ArtifactAuthorizationRepository(database);
  const operations = new RemoteOperationRepository(database, options.clock);
  const candidates = new SqliteRemoteOperationCandidateRepository(database);
  const actions = new RemoteExecutionActionRepository(database, options.clock);
  const reservations = new HostReservationRepository(database, {
    leaseDurationMs: options.leaseDurationMs,
    hostOfflineAfterMs: options.hostOfflineAfterMs,
    clock: options.clock
  });
  const agentEndpoints = new AgentEndpointCatalog({
    hosts,
    capacities: reservations,
    hostOfflineAfterMs: options.hostOfflineAfterMs,
    clock: options.clock
  });
  const remoteAgents = new RemoteAgentRepository(database, clock);
  const acpEvents = new RemoteAcpEventRepository(database, {
    clock: options.clock,
    maxEvents: options.eventRetentionMaxEvents,
    maxBytes: options.eventRetentionMaxBytes
  });
  const interactions = new RemoteInteractionService(database, {
    authorization: options.interactionAuthorization ?? { canRespond: () => false },
    publisher: mailbox,
    clock: options.clock
  });
  const workAssignments = new WorkAssignmentRepository(database, {
    onAssignmentUpdatedInTransaction: options.onAssignmentUpdatedInTransaction
  });
  const legacyAssignmentGate =
    options.assignmentGate ??
    (options.enableAssignmentDispatchGate === false
      ? undefined
      : createAssignmentDispatchGate({
          repository: workAssignments,
          hostPort: createHostAssignmentPort({
            hosts,
            hostOfflineAfterMs: options.hostOfflineAfterMs,
            clock: options.clock
          }),
          // Operator / existing remote paths may dispatch unassigned Blocks; exact Host
          // assignments still pin selection. Strict callers pass allowHumanOverride:false.
          defaultAllowHumanOverride: true
        }));
  const authorityGate = createAuthorityDispatchGate({
    repository: new AuthorityRepository(database, { clock: options.clock }),
    database,
    workspaceIdentity: new WorkspaceIdentityRepository(database),
    hosts,
    access: new ProjectAccessRepository(database, options.clock),
    hostOfflineAfterMs: options.hostOfflineAfterMs,
    clock: options.clock
  });
  const authorityRepository = new AuthorityRepository(database, { clock: options.clock });
  const contentVersions = new ContentVersionRepository(database, clock);
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const humanIdentity = new HumanPrincipalIdentity(database);
  const projectAccess = new ProjectAccessRepository(database, options.clock);
  const endpointAuthorize: NonNullable<
    ConstructorParameters<typeof RemoteBlockCoordinator>[0]["endpointAuthorize"]
  > = (input) => {
    const scope = {
      kind: "block" as const,
      workspaceId: workspaceIdSchema.parse(input.workspaceId),
      projectId: input.projectId,
      canvasId: input.canvasId,
      blockRef: input.blockRef
    };
    if (!workspaceIdentity.workspaceExists(scope.workspaceId)) {
      throw new DispatchAssignmentError("work_host_not_authorized");
    }
    const authorized =
      input.controlPlane === "owner"
        ? options.ownerEndpointScopeAuthorized?.(scope) === true
        : (() => {
            const project = projectAccess.registry.projectInternal(
              scope.workspaceId,
              scope.projectId
            );
            const canvas = projectAccess.registry.canvasInternal(
              scope.workspaceId,
              scope.projectId,
              scope.canvasId
            );
            return !!project && project.revokedAt === null && !!canvas && canvas.revokedAt === null;
          })();
    if (!authorized) {
      throw new DispatchAssignmentError("work_host_not_authorized");
    }
    const current = authorityRepository.currentRevisions(scope);
    if (
      current.responsibilityRevision !== input.expectedResponsibilityRevision ||
      current.reviewerRevision !== input.expectedReviewerRevision ||
      current.executionTargetRevision !== input.executionTargetRevision
    ) {
      throw new DispatchAssignmentError("work_revision_conflict");
    }
  };
  const remoteAgentAccess = new RemoteAgentAccessPolicy({
    database,
    agents: remoteAgents,
    catalog: agentEndpoints,
    authorizeTarget: endpointAuthorize,
    clock: options.clock
  });
  const contentAuthorize: RemoteContentAuthorizePort = (input) => {
    const current = readStableCanvasRuntimeContentTarget(contentVersions, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId
    });
    if (
      String(current.revision) !== input.contentRevision ||
      current.graphFingerprint !== input.graphFingerprint
    ) {
      throw new Error("canvas_content_revision_conflict");
    }
  };
  const assignmentGate: AssignmentDispatchGate | undefined = legacyAssignmentGate
    ? {
        resolve(input) {
          const preferAuthority =
            input.preferAuthority === true ||
            input.expectedResponsibilityRevision !== undefined ||
            input.expectedReviewerRevision !== undefined ||
            input.expectedExecutionTargetRevision !== undefined ||
            (() => {
              const workspaceId = workspaceIdentity.workspaceForLegacyProject(input.projectId);
              if (!workspaceId) return false;
              return (
                authorityRepository.migrationState(workspaceId, input.projectId)
                  ?.authoritativeReadVersion === "oss003_authorities"
              );
            })();
          return preferAuthority
            ? authorityGate.resolve(input)
            : legacyAssignmentGate.resolve(input);
        }
      }
    : authorityGate;
  const finalAuthorize = ({
    operation,
    reservation
  }: {
    operation: import("./remoteOperations.js").RemoteOperation;
    reservation: import("./hostReservations.js").HostCapacityReservation;
  }) => {
    try {
      const expected = operation.hostSelection?.authorityRevisions;
      if (!expected) return;
      const candidate = candidates.get(operation.id);
      if (!candidate) throw new Error("remote_operation_candidate_missing");
      const scope = {
        kind: "block" as const,
        workspaceId: operation.workspaceId,
        projectId: operation.projectId,
        canvasId: operation.canvasId,
        blockRef: operation.blockRef
      };
      const host = hosts.get(reservation.hostId);
      const project = projectAccess.registry.projectInternal(scope.workspaceId, scope.projectId);
      const canvas = projectAccess.registry.canvasInternal(
        scope.workspaceId,
        scope.projectId,
        scope.canvasId
      );
      const currentRevisions = authorityRepository.currentRevisions(scope);
      const now = (options.clock ?? (() => new Date()))();
      const online =
        !!host && isAgentHostOnline(host, { now, hostOfflineAfterMs: options.hostOfflineAfterMs });
      const fleetUnbound = host ? workspaceIdentity.workspaceForHost(host.id) === undefined : false;
      if (
        !host ||
        hostExecutionProfileAvailability(host, {
          workspaceId: scope.workspaceId,
          online,
          agentId: candidate.agentId,
          agentProfileId: candidate.agentProfileId,
          requiredCapabilities: operation.requiredCapabilities,
          fleetUnbound
        }).status !== "available"
      ) {
        throw new Error("host_authorization_denied:capability_mismatch");
      }
      const activeReservations = Number(
        (
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM host_capacity_reservations WHERE host_id=? AND status='active'"
            )
            .get(reservation.hostId) as { count: number }
        ).count
      );
      const capacityRemaining = host
        ? Math.max(0, host.capacity - Math.max(0, activeReservations - 1))
        : 0;
      const facts = hostAuthorizationFactsSchema.parse({
        schemaVersion: "host-authorization/v1",
        scope,
        hostId: reservation.hostId,
        hostWorkspaceId: host ? (workspaceIdentity.workspaceForHost(host.id) ?? "") : "",
        workspaceAcl: {
          revision: 0,
          allowed: workspaceIdentity.workspaceExists(scope.workspaceId)
        },
        projectAcl: {
          revision: project?.aclRevision ?? 0,
          allowed: !!project && project.revokedAt === null
        },
        canvasAcl: {
          revision: canvas?.aclRevision ?? 0,
          allowed: !!canvas && canvas.revokedAt === null
        },
        requiredCapabilities: operation.requiredCapabilities,
        advertisedCapabilities: host?.capabilities ?? [],
        revoked: !host || host.revokedAt !== undefined,
        online,
        capacityRemaining,
        lease:
          reservation.status === "active" && Date.parse(reservation.leaseExpiresAt) > now.getTime()
            ? {
                status: "active",
                leaseId: reservation.leaseId,
                expiresAt: reservation.leaseExpiresAt
              }
            : {
                status: "expired",
                leaseId: reservation.leaseId,
                expiresAt: reservation.leaseExpiresAt
              },
        attempt: ["reserved", "activated", "running", "awaiting_writeback"].includes(
          operation.attempt.status
        )
          ? {
              status: operation.attempt.status,
              dispatchId: operation.dispatchId,
              executionAttemptId: operation.executionAttemptId
            }
          : {
              status: "prepared",
              dispatchId: operation.dispatchId,
              executionAttemptId: operation.executionAttemptId
            },
        expectedRevisions: expected,
        currentRevisions,
        evaluatedAt: now.toISOString()
      });
      const decision = evaluateHostAuthorization({ facts });
      if (decision.decision !== "allow") {
        throw new Error(`host_authorization_denied:${decision.reason}`);
      }
    } catch (error) {
      if (reservation.status === "active") {
        reservations.release({
          leaseId: reservation.leaseId,
          fencingToken: reservation.fencingToken,
          expectedVersion: reservation.version,
          reason: "expired"
        });
      }
      throw error;
    }
  };
  const remoteDispatchPersistence = new SqliteRemoteDispatchPersistence(database);
  const coordinator = new RemoteBlockCoordinator({
    runtimeLeases: options.runtimeLeases,
    dispatchCandidates: new ServerCanvasDispatchCandidateReader(contentVersions, {
      read: async (scope) => {
        const dependency = operations.findLatestByScope(scope);
        if (!dependency || !["completed", "failed", "cancelled"].includes(dependency.state)) {
          return undefined;
        }
        const row = database
          .prepare("SELECT result_json FROM dispatches WHERE id=?")
          .get(dependency.dispatchId);
        const result = row?.result_json
          ? dispatchResultSchema.parse(JSON.parse(String(row.result_json)))
          : undefined;
        const reportBytes = result
          ? await options.artifactContent.readReport(result.reportArtifactRef)
          : undefined;
        const reportMediaType = result
          ? await options.artifactContent.readReportMediaType?.(result.reportArtifactRef)
          : undefined;
        return {
          state: dependency.state as "completed" | "failed" | "cancelled",
          ...(result && reportBytes
            ? {
                reportArtifactRef: result.reportArtifactRef,
                reportBytes,
                ...(reportMediaType ? { reportMediaType } : {})
              }
            : {})
        };
      }
    }),
    operations,
    actions,
    candidates,
    reservations,
    dispatches: remoteDispatchPersistence,
    mailbox,
    inputArtifacts: options.inputArtifacts,
    artifactContent: options.artifactContent,
    acpTranscript: acpEvents,
    checkpoints: options.checkpoints,
    assignmentGate,
    agentEndpoints,
    authorizeRemoteAgentUse: (input) => remoteAgentAccess.authorizeRemoteAgentUse(input),
    authorizeRemoteAgentUseForSnapshot: (input) =>
      remoteAgentAccess.authorizeRemoteAgentUseForSnapshot(input),
    endpointAuthorize,
    contentAuthorize,
    finalAuthorize,
    ownerPackageLocatorForHost: ({ hostId, candidate }) => {
      if (workspaceIdentity.workspaceForHost(hostId) !== undefined) return undefined;
      return ownerPackageLocatorForRun({
        projectId: candidate.projectId,
        canvasId: candidate.canvasId
      });
    },
    ensureRuntimeAttachment: (input) =>
      ensureRuntimeAttachmentForOperation(
        { attachments: runtimeOperationAttachments, database, clock },
        input
      ),
    findRuntimeAttachment: (operationId, executionAttemptId) =>
      runtimeOperationAttachments.get(operationId, executionAttemptId),
    ...(options.runtimeContentTargets
      ? { runtimeContentTargets: options.runtimeContentTargets }
      : {}),
    ...(options.ensureRuntimeProjection
      ? { ensureRuntimeProjection: options.ensureRuntimeProjection }
      : {}),
    serverInstanceOwnerToken: startupContext.serverInstanceOwnerToken,
    humanIdentity
  });
  const dispatches = new DispatchService(database, hosts, artifactAuthorization, {
    leaseDurationMs: options.leaseDurationMs,
    hostOfflineAfterMs: options.hostOfflineAfterMs,
    writeback: {
      complete: async (input) => {
        const operation = operations.getByDispatchId(input.dispatchId);
        if (!operation) throw new Error("remote_operation_not_found_for_dispatch");
        if (
          operation.attempt.hostId !== input.hostId ||
          operation.attempt.leaseId !== input.leaseId ||
          operation.executionAttemptId !== input.executionAttemptId
        ) {
          throw new Error("remote_writeback_identity_mismatch");
        }
        artifactAuthorization.requireResultProvenance(
          {
            workspaceId: operation.workspaceId,
            projectId: input.projectId,
            hostId: input.hostId,
            dispatchId: input.dispatchId,
            leaseId: input.leaseId,
            executionAttemptId: input.executionAttemptId
          },
          input.result
        );
        await coordinator.complete(operation.id);
      },
      fail: async (input) => {
        const operation = operations.getByDispatchId(input.dispatchId);
        if (!operation) throw new Error("remote_operation_not_found_for_dispatch");
        if (
          operation.attempt.hostId !== input.hostId ||
          operation.attempt.leaseId !== input.leaseId ||
          operation.executionAttemptId !== input.executionAttemptId
        ) {
          throw new Error("remote_writeback_identity_mismatch");
        }
        await coordinator.fail(operation.id);
      }
    },
    onActivityTransitionInTransaction: options.onDispatchActivityTransitionInTransaction
  });
  const reconcile = async (context?: StartupContext) => {
    await dispatches.recoverExpiredLeases();
    reservations.expireDue();
    interactions.expireDue();
    await coordinator.reconcileActions(context);
    return coordinator.reenterPending();
  };
  return {
    hosts,
    mailbox,
    artifactAuthorization,
    runtimeOperationAttachments,
    operations,
    actions,
    acpEvents,
    interactions,
    reservations,
    agentEndpoints,
    remoteAgents,
    remoteAgentAccess,
    coordinator,
    dispatches,
    workAssignments,
    assignmentGate,
    reconcile
  };
}

export async function startRemoteBlockCoordinationServer(
  config: ServerStorageConfig,
  createOptions: (database: SqliteDatabase) => RemoteBlockCoordinationOptions
): Promise<{
  server: PlanweaveServer;
  coordination: ReturnType<typeof createRemoteBlockCoordination>;
}> {
  let coordination: ReturnType<typeof createRemoteBlockCoordination> | undefined;
  const server = await startPlanweaveServer(config, [
    async (database, startupContext) => {
      const created = createRemoteBlockCoordination(
        database,
        createOptions(database),
        startupContext
      );
      await created.reconcile(startupContext);
      coordination = created;
    }
  ]);
  if (!coordination) {
    server.close();
    throw new Error("remote_coordination_startup_not_initialized");
  }
  return { server, coordination };
}
