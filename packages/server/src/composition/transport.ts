import type { Server as HttpServer } from "node:http";
import type { ServerConfig } from "../config.js";
import type { startRemoteBlockCoordinationServer } from "../distributedCoordination.js";
import { createDistributedHttpRequestListener } from "../distributedHttpRequestListener.js";
import { attachAgentHostWebSocketServer } from "../wsServer.js";
import { attachHumanObserverWebSocketServer } from "../humanObserverWs.js";
import { createCanvasCollaborationComposition } from "../canvas/collaborationComposition.js";
import { WebSocketUpgradeRouter } from "../webSocketUpgradeRouter.js";
import { attachReverseProxyWebSocketReadiness } from "../exposure/reverseProxyWebSocketReadiness.js";
import type { TransportAdmissionPolicy } from "../insecureTransport.js";
import type { HumanObserverJournal } from "../humanObserverJournal.js";
import type { HumanIdentityRepository } from "../identity/index.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import type { AuthorizationChangeSignal } from "../authorizationChangeSignal.js";
import type { TrustedRuntimeRegistry } from "./identityAccess.js";
import type { SqliteDatabase } from "../sqlite.js";

type Coordination = Awaited<ReturnType<typeof startRemoteBlockCoordinationServer>>["coordination"];
type HttpListenerOptions = Omit<
  Parameters<typeof createDistributedHttpRequestListener>[0],
  "operatorControl" | "contentVersionService" | "contentVersions" | "canvasCommandService"
>;

export async function createTransportComposition(
  input: HttpListenerOptions & {
    httpServer: HttpServer;
    database: SqliteDatabase;
    config: ServerConfig;
    coordination: Coordination;
    runtimeRegistry: TrustedRuntimeRegistry;
    workspaceIdentity: WorkspaceIdentityRepository;
    projectAccess: ProjectAccessRepository;
    humanIdentity: HumanIdentityRepository;
    humanObserverJournal: HumanObserverJournal;
    authorizationChanges: AuthorizationChangeSignal;
    transportAdmission: TransportAdmissionPolicy;
    createOperatorControl(
      disconnectHost: (hostId: string) => void
    ): Parameters<typeof createDistributedHttpRequestListener>[0]["operatorControl"];
    handles: TransportCompositionHandles;
  }
) {
  const upgradeRouter = new WebSocketUpgradeRouter(input.httpServer);
  input.handles.upgradeRouter = upgradeRouter;
  attachReverseProxyWebSocketReadiness({
    config: input.config,
    upgradeRouter,
    transportAdmission: input.transportAdmission
  });
  const webSockets = attachAgentHostWebSocketServer({
    server: input.httpServer,
    upgradeRouter,
    hosts: input.coordination.hosts,
    mailbox: input.coordination.mailbox,
    dispatches: input.coordination.dispatches,
    acpEvents: input.coordination.acpEvents,
    interactions: input.coordination.interactions,
    actions: input.coordination.actions,
    heartbeatIntervalMs: input.config.limits.heartbeatIntervalMs,
    leaseDurationMs: input.config.limits.leaseDurationMs,
    maxPayloadBytes: input.config.limits.maxWebSocketPayloadBytes,
    shutdownTimeoutMs: input.config.limits.shutdownTimeoutMs,
    onHostAvailable: async (hostId) => {
      await input.coordination.coordinator.reenterWaitingForHost(hostId);
    },
    transportAdmission: input.transportAdmission
  });
  input.handles.webSockets = webSockets;
  const humanObserverWebSockets = attachHumanObserverWebSocketServer({
    upgradeRouter,
    journal: input.humanObserverJournal,
    repository: input.humanIdentity,
    workspaceIdentity: input.workspaceIdentity,
    projectAccess: input.projectAccess,
    projectAuthority: input.runtimeRegistry,
    authorizationChanges: input.authorizationChanges,
    maxPayloadBytes: input.config.limits.maxWebSocketPayloadBytes,
    shutdownTimeoutMs: input.config.limits.shutdownTimeoutMs,
    transportAdmission: input.transportAdmission,
    allowedClientOrigins: input.config.allowedClientOrigins ?? undefined,
    clock: input.clock
  });
  input.handles.humanObserverWebSockets = humanObserverWebSockets;
  const canvasCollaboration = await createCanvasCollaborationComposition({
    database: input.database,
    upgradeRouter,
    identity: input.humanIdentity,
    workspaceIdentity: input.workspaceIdentity,
    projectAccess: input.projectAccess,
    projectAuthority: input.runtimeRegistry,
    expansions: input.runtimeRegistry.expansions,
    observerJournal: input.humanObserverJournal,
    transportAdmission: input.transportAdmission,
    maxPayloadBytes: input.config.limits.maxWebSocketPayloadBytes,
    shutdownTimeoutMs: input.config.limits.shutdownTimeoutMs,
    allowedClientOrigins: input.config.allowedClientOrigins ?? undefined,
    clock: input.clock
  });
  input.handles.canvasPresenceWebSockets = canvasCollaboration.presenceWebSockets;
  input.handles.canvasCommandWebSockets = canvasCollaboration.commandWebSockets;
  input.handles.canvasLiveSyncWebSockets = canvasCollaboration.liveSyncWebSockets;
  input.handles.canvasOperationRetentionMaintenance =
    canvasCollaboration.operationRetentionMaintenance;
  const operatorControl = input.createOperatorControl((hostId) =>
    webSockets.disconnectHost(hostId)
  );
  const requestListener = createDistributedHttpRequestListener({
    readiness: input.readiness,
    inflightRequests: input.inflightRequests,
    workspaceIdentity: input.workspaceIdentity,
    projectAccess: input.projectAccess,
    humanIdentity: input.humanIdentity,
    projectAuthority: input.projectAuthority,
    transportAdmission: input.transportAdmission,
    registryService: input.registryService,
    agentEndpointCatalog: input.agentEndpointCatalog,
    humanRemoteControl: input.humanRemoteControl,
    resolveAssignmentService: input.resolveAssignmentService,
    acquireAuthorityService: input.acquireAuthorityService,
    contentVersionService: canvasCollaboration.contentVersionService,
    contentVersions: canvasCollaboration.contentVersions,
    canvasCommandService: canvasCollaboration.commandService,
    resolveCommentService: input.resolveCommentService,
    enrollments: input.enrollments,
    setupCodes: input.setupCodes,
    authorization: input.authorization,
    hosts: input.hosts,
    dispatches: input.dispatches,
    artifactAuthorization: input.artifactAuthorization,
    artifacts: input.artifacts,
    humanMembership: input.humanMembership,
    commentAttachments: input.commentAttachments,
    operatorControl,
    serverVersion: input.serverVersion,
    maxArtifactBytes: input.maxArtifactBytes,
    maxWebSocketPayloadBytes: input.maxWebSocketPayloadBytes,
    clock: input.clock
  });
  input.httpServer.on("request", requestListener);
  input.handles.requestListener = requestListener;
  return {
    requestListener,
    webSockets,
    humanObserverWebSockets,
    canvasPresenceWebSockets: canvasCollaboration.presenceWebSockets,
    canvasCommandWebSockets: canvasCollaboration.commandWebSockets,
    canvasLiveSyncWebSockets: canvasCollaboration.liveSyncWebSockets,
    canvasOperationRetentionMaintenance: canvasCollaboration.operationRetentionMaintenance,
    upgradeRouter
  };
}

export type TransportComposition = Awaited<ReturnType<typeof createTransportComposition>>;

export type TransportCompositionHandles = Partial<TransportComposition>;
