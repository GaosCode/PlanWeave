import type { Server as HttpServer } from "node:http";
import { serverConfigSchema, type ServerConfig } from "./config.js";
import { startRemoteBlockCoordinationServer } from "./distributedCoordination.js";
import { HostEnrollmentService } from "./hostEnrollment.js";
import type { HumanIdentityRepository } from "./identity/index.js";
import type { WorkspaceIdentityRepository } from "./identity/workspaceRepository.js";
import { serverPackageVersion } from "./packageInfo.js";
import { ServerReadinessController, type ServerReadiness } from "./readiness.js";
import type { RemoteCoordinationMaintenance } from "./remoteCoordinationMaintenance.js";
import {
  createTrustedProjectControlPort,
  type TrustedProjectControlPort
} from "./trustedProjectControl.js";
import { createTransportAdmissionPolicy } from "./insecureTransport.js";
import { SqliteExposureLeaseStore } from "./exposure/exposureLeaseRepository.js";
import type { ExposureLeaseStorePort } from "./exposure/types.js";
import {
  closeCompositionStorage,
  containsCleanupError,
  drainCompositionTransports
} from "./distributedCompositionLifecycle.js";
import { AuthorizationChangeSignal } from "./authorizationChangeSignal.js";
import {
  createActivityCommentsComposition,
  createActivityJournalComposition,
  type ActivityJournalComposition
} from "./composition/activityComments.js";
import {
  createIdentityAccessComposition,
  createIdentityServices,
  createRuntimeRegistryComposition
} from "./composition/identityAccess.js";
import {
  createRemoteCoordinationOptions,
  createRemoteExecutionComposition
} from "./composition/remoteExecution.js";
import {
  createTransportComposition,
  type TransportCompositionHandles
} from "./composition/transport.js";
import { createLocalFilesystemCanvasRuntimeAdapter } from "./canvas/localFilesystemRuntimeAdapter.js";
import { LocalFilesystemExecutionRuntimeAdapter } from "./canvas/localFilesystemExecutionRuntimeAdapter.js";
import {
  LocalFilesystemWorkRuntimeFactsAdapter,
  LocalFirstWorkRuntimeFactsAdapter
} from "./work/runtimeFactsAdapters.js";
import { RemoteHostWorkRuntimeFactsAdapter } from "./work/remoteHostRuntimeFactsAdapter.js";
import {
  LocalFirstCanvasExecutionRuntimeRouter,
  LocalFirstCanvasRuntimeRouter,
  RemoteHostCanvasRuntimeAdapter
} from "./canvas/remoteHostRuntimeAdapter.js";
import { CanvasRuntimeRpcBroker } from "./canvas/runtimeRpcBroker.js";
import { CanvasRuntimeHostLocator } from "./canvas/runtimeHostLocator.js";
import { RuntimeArtifactGrantRepository } from "./canvas/runtimeArtifactGrantRepository.js";
import { AuthoritativeExecutionRuntimeAdapter } from "./canvas/authoritativeExecutionRuntimeAdapter.js";
import { CanvasRuntimeStatusRepository } from "./canvas/runtimeStatusRepository.js";
import { ContentVersionRepository } from "./canvas/contentVersionRepository.js";
import { readStableCanvasContentFingerprint } from "./canvas/contentFingerprint.js";

export type DistributedServerCompositionOptions = {
  httpServer: HttpServer;
  config: ServerConfig;
  /** Owner control-plane runtime scopes. They never widen collaboration HTTP/WS authority. */
  ownerTrustedProjects?: ServerConfig["trustedProjects"];
  clock?: () => Date;
  readiness?: ServerReadinessController;
};

export type DistributedServerComposition = {
  readonly ownsHttpServer: false;
  readonly trustedProjectControl: TrustedProjectControlPort;
  readonly exposureLeaseStore: ExposureLeaseStorePort;
  readiness(): ServerReadiness;
  beginDrain(): void;
  drainTransports(): Promise<void>;
  close(): Promise<void>;
};

export async function createDistributedServerComposition(
  options: DistributedServerCompositionOptions
): Promise<DistributedServerComposition> {
  const config = serverConfigSchema.parse(options.config);
  const transportAdmission = createTransportAdmissionPolicy(config);
  const clock = options.clock ?? (() => new Date());
  const readiness = options.readiness ?? new ServerReadinessController();
  const registries = await createRuntimeRegistryComposition({
    trustedProjects: config.trustedProjects,
    ownerTrustedProjects: options.ownerTrustedProjects
  });
  const localCanvasRuntime = createLocalFilesystemCanvasRuntimeAdapter(registries.runtimeRegistry);
  const localExecutionRuntime = new LocalFilesystemExecutionRuntimeAdapter(
    registries.runtimeRegistry
  );
  const ownerExecutionRuntime = new LocalFilesystemExecutionRuntimeAdapter(
    registries.ownerRuntimeRegistry
  );
  const workRuntimeFacts = new LocalFirstWorkRuntimeFactsAdapter(
    new LocalFilesystemWorkRuntimeFactsAdapter(registries.runtimeRegistry)
  );
  const collaborationRuntime = new LocalFirstCanvasRuntimeRouter(
    localCanvasRuntime,
    localExecutionRuntime,
    localExecutionRuntime
  );
  const executionRuntime = new LocalFirstCanvasExecutionRuntimeRouter(
    ownerExecutionRuntime,
    ownerExecutionRuntime
  );
  let lifecycle: Awaited<ReturnType<typeof startRemoteBlockCoordinationServer>> | undefined;
  let activity: ActivityJournalComposition | undefined;
  let activityRetention:
    | Awaited<ReturnType<typeof createActivityCommentsComposition>>["retention"]
    | undefined;
  let remoteCoordinationMaintenance: RemoteCoordinationMaintenance | undefined;
  let runtimeRpc: CanvasRuntimeRpcBroker | undefined;
  const transportHandles: TransportCompositionHandles = {};
  let authorization: ReturnType<typeof createIdentityServices>["authorization"];
  let humanIdentityForInteractions: HumanIdentityRepository | undefined;
  let workspaceIdentityForInteractions: WorkspaceIdentityRepository;
  const inflightRequests = new Set<Promise<void>>();
  try {
    readiness.transition("migrating");
    lifecycle = await startRemoteBlockCoordinationServer(
      {
        dataDirectory: config.dataDirectory,
        databasePath: config.databasePath,
        busyTimeoutMs: config.limits.busyTimeoutMs
      },
      (database) => {
        readiness.transition("reconciling");
        activity = createActivityJournalComposition({ database, config, clock });
        const contentVersions = new ContentVersionRepository(database, clock);
        const authoritativeExecutionRuntime = new AuthoritativeExecutionRuntimeAdapter({
          delegate: executionRuntime,
          readContentFingerprint: (scope) =>
            readStableCanvasContentFingerprint(contentVersions, scope),
          runtimeStatuses: new CanvasRuntimeStatusRepository(database, clock)
        });
        return createRemoteCoordinationOptions({
          config,
          clock,
          ownerRuntimeLeases: authoritativeExecutionRuntime,
          ownerRuntimeAvailability: ownerExecutionRuntime,
          activity,
          getAuthorization: () => authorization,
          getHumanIdentity: () => humanIdentityForInteractions,
          getWorkspaceIdentity: () => workspaceIdentityForInteractions
        });
      }
    );
    if (!activity) throw new Error("activity_projection_not_initialized");
    const initializedActivity = activity;
    const { coordination, server } = lifecycle;
    const authorizationChanges = new AuthorizationChangeSignal();
    const schemaVersion = server.readiness().schemaVersion;
    readiness.transition("reconciling", schemaVersion);

    const enrollments = new HostEnrollmentService(server.database, clock, (hostId) =>
      transportHandles.webSockets?.disconnectHost(hostId)
    );
    const identityAccess = createIdentityAccessComposition({
      database: server.database,
      config,
      clock,
      runtimeRegistry: registries.runtimeRegistry,
      ownerRuntimeRegistry: registries.ownerRuntimeRegistry,
      packageSnapshotRuntime: localCanvasRuntime,
      onAuthorizationChange: (change) => authorizationChanges.publish(change)
    });
    const { workspaceIdentity, projectAccess, registryService, collaborationScopeAuthority } =
      identityAccess;
    localExecutionRuntime.attachCollaborationScopeResolution({
      workspaceIdentity,
      projectAccess
    });
    workspaceIdentityForInteractions = workspaceIdentity;
    runtimeRpc = new CanvasRuntimeRpcBroker(
      server.database,
      coordination.hosts,
      coordination.mailbox,
      { requestTimeoutMs: config.limits.leaseDurationMs, clock }
    );
    const runtimeHostLocator = new CanvasRuntimeHostLocator(
      coordination.hosts.runtimeBindings,
      coordination.hosts,
      runtimeRpc,
      projectAccess
    );
    const runtimeArtifactGrants = new RuntimeArtifactGrantRepository(server.database, {
      maxArtifactBytes: initializedActivity.artifactStore.maxArtifactBytes,
      clock,
      leaseActive: (lease) => {
        if (
          !runtimeRpc?.isActive(lease.hostId) ||
          runtimeRpc.attachmentVersion(lease.hostId) !== lease.attachmentVersion
        ) {
          return false;
        }
        const located = runtimeHostLocator.locate(lease);
        return located.kind === "available" && located.hostId === lease.hostId;
      }
    });
    runtimeArtifactGrants.revokeActiveAfterRestart();
    const remoteCanvasRuntime = new RemoteHostCanvasRuntimeAdapter(runtimeHostLocator, runtimeRpc, {
      grants: runtimeArtifactGrants,
      artifacts: initializedActivity.artifactStore
    });
    collaborationRuntime.attachRemote(remoteCanvasRuntime);
    executionRuntime.attachRemote(remoteCanvasRuntime);
    workRuntimeFacts.attachRemote(
      new RemoteHostWorkRuntimeFactsAdapter(runtimeHostLocator, runtimeRpc)
    );
    const identityServices = createIdentityServices({
      database: server.database,
      config,
      clock,
      runtimeRegistry: registries.runtimeRegistry,
      ownerRuntimeRegistry: registries.ownerRuntimeRegistry,
      workspaceIdentity,
      projectAccess,
      collaborationScopeAuthority,
      authorizationChanges,
      activity: initializedActivity,
      onHumanIdentityCreated: (identity) => {
        humanIdentityForInteractions = identity;
      }
    });
    authorization = identityServices.authorization;
    const { setupCodes, humanIdentity, humanMembership } = identityServices;
    const activityComments = createActivityCommentsComposition({
      database: server.database,
      config,
      clock,
      collaborationScopeAuthority,
      workspaceIdentity,
      projectAccess,
      humanIdentity,
      activity: initializedActivity
    });
    activityRetention = activityComments.retention;
    await activityRetention.start();
    const remoteExecution = createRemoteExecutionComposition({
      database: server.database,
      config,
      clock,
      coordination,
      runtimeAvailability: collaborationRuntime,
      ownerRuntimeScopes: ownerExecutionRuntime,
      workRuntimeFacts,
      workspaceIdentity,
      projectAccess,
      authorization,
      enrollments
    });

    const transport = await createTransportComposition({
      httpServer: options.httpServer,
      database: server.database,
      config,
      coordination,
      runtimeAttachments: registries.runtimeRegistry.locators,
      initialContentCapture: localCanvasRuntime,
      runtimeAvailability: collaborationRuntime,
      runtimeRpc,
      workspaceIdentity,
      projectAccess,
      humanIdentity,
      humanObserverJournal: initializedActivity.humanObserverJournal,
      authorizationChanges,
      transportAdmission,
      handles: transportHandles,
      readiness,
      inflightRequests,
      collaborationScopeAuthority,
      registryService,
      agentEndpointCatalog: coordination.agentEndpoints,
      humanRemoteControl: remoteExecution.humanRemoteControl,
      resolveAssignmentService: remoteExecution.resolveAssignmentService,
      acquireAuthorityService: remoteExecution.acquireAuthorityService,
      resolveCommentService: activityComments.resolveCommentService,
      enrollments,
      setupCodes,
      authorization,
      hosts: coordination.hosts,
      dispatches: coordination.dispatches,
      artifactAuthorization: coordination.artifactAuthorization,
      artifacts: initializedActivity.artifactStore,
      runtimeArtifactGrants,
      humanMembership,
      commentAttachments: activityComments.commentAttachments,
      createOperatorControl: remoteExecution.createOperatorControl,
      serverVersion: serverPackageVersion,
      maxArtifactBytes: config.limits.maxArtifactBytes,
      maxWebSocketPayloadBytes: config.limits.maxWebSocketPayloadBytes,
      clock
    });
    remoteCoordinationMaintenance = remoteExecution.createMaintenance();
    remoteCoordinationMaintenance.start();
    if (!options.readiness) readiness.transition("ready", schemaVersion);

    const attachedTransport = transport;
    let closePromise: Promise<void> | undefined;
    const beginDrain = () => {
      if (readiness.readiness().status !== "draining") {
        readiness.transition("draining", schemaVersion);
      }
    };
    let drainPromise: Promise<void> | undefined;
    const drainTransports = () => {
      beginDrain();
      drainPromise ??= drainAttachedTransports(
        options.httpServer,
        attachedTransport,
        inflightRequests,
        config.limits.shutdownTimeoutMs
      );
      return drainPromise;
    };
    return {
      ownsHttpServer: false,
      trustedProjectControl: createTrustedProjectControlPort({
        runtimeRegistry: registries.runtimeRegistry,
        projectAccess
      }),
      exposureLeaseStore: new SqliteExposureLeaseStore(server.database),
      readiness: () => readiness.readiness(),
      beginDrain,
      drainTransports,
      async close() {
        beginDrain();
        closePromise ??= (async () => {
          const errors: unknown[] = [];
          let transportDrainRequiresProcessExit = false;
          try {
            await remoteCoordinationMaintenance?.close();
          } catch (error) {
            errors.push(error);
          }
          runtimeRpc?.close();
          try {
            await activityRetention?.close();
          } catch (error) {
            errors.push(error);
          }
          try {
            await drainTransports();
          } catch (error) {
            if (containsCleanupError(error, "server_http_inflight_drain_timeout")) {
              transportDrainRequiresProcessExit = true;
            }
            errors.push(error);
          }
          try {
            await attachedTransport.canvasOperationRetentionMaintenance.close();
          } catch (error) {
            errors.push(error);
          }
          if (transportDrainRequiresProcessExit) {
            throw new AggregateError(errors, "server_shutdown_requires_process_exit", {
              cause: errors[0]
            });
          }
          try {
            closeCompositionStorage({
              closeLifecycle: server.close,
              closeRuntimeRegistry: registries.close
            });
          } catch (error) {
            errors.push(error);
          }
          if (errors.length > 0) {
            throw new AggregateError(errors, "distributed_server_cleanup_failed");
          }
        })();
        return closePromise;
      }
    };
  } catch (error) {
    if (readiness.readiness().status !== "draining") readiness.transition("draining");
    const cleanupErrors: unknown[] = [];
    try {
      await remoteCoordinationMaintenance?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    runtimeRpc?.close();
    try {
      await activityRetention?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await drainAttachedTransports(
        options.httpServer,
        transportHandles,
        inflightRequests,
        config.limits.shutdownTimeoutMs
      );
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await transportHandles.canvasOperationRetentionMaintenance?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    const requiresProcessExit = cleanupErrors.some((cleanupError) =>
      containsCleanupError(cleanupError, "server_http_inflight_drain_timeout")
    );
    if (!requiresProcessExit) {
      try {
        closeCompositionStorage({
          closeLifecycle: lifecycle?.server.close,
          closeRuntimeRegistry: registries.close
        });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "distributed_server_startup_and_cleanup_failed",
        { cause: error }
      );
    }
    throw error;
  }
}

function drainAttachedTransports(
  httpServer: HttpServer,
  transport: TransportCompositionHandles,
  inflightRequests: ReadonlySet<Promise<void>>,
  shutdownTimeoutMs: number
): Promise<void> {
  return drainCompositionTransports({
    httpServer,
    requestListener: transport?.requestListener,
    webSockets: transport?.webSockets,
    humanObserverWebSockets: transport?.humanObserverWebSockets,
    canvasPresenceWebSockets: transport?.canvasPresenceWebSockets,
    canvasCommandWebSockets: transport?.canvasCommandWebSockets,
    canvasLiveSyncWebSockets: transport?.canvasLiveSyncWebSockets,
    upgradeRouter: transport?.upgradeRouter,
    inflightRequests,
    shutdownTimeoutMs
  });
}
