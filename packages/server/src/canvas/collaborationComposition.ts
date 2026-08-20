import type { CollaborationScopeAuthority } from "../identity/index.js";
import type { HumanIdentityRepository } from "../identity/repository.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { TransportAdmissionPolicy } from "../insecureTransport.js";
import type { HumanObserverJournal } from "../humanObserverJournal.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import type { SqliteDatabase } from "../sqlite.js";
import type { WebSocketUpgradeRouter } from "../webSocketUpgradeRouter.js";
import {
  attachCanvasCommandWebSocketServer,
  attachCanvasLiveSyncWebSocketServer,
  CanvasCommandRepository,
  CanvasCommandService,
  CanvasOperationRetentionMaintenance,
  ContentVersionRepository,
  ContentVersionService,
  SqliteAuthoritativeCanvasCommitStore
} from "./index.js";
import { attachCanvasPresenceWebSocketServer } from "../presenceWebSocket.js";
import type { AuthorizationChangeSignal } from "../authorizationChangeSignal.js";
import type { CompleteContentVersion } from "@planweave-ai/collaboration-protocol/content/version";
import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { CanvasInitialContentCapturePort, CanvasRuntimeStatusPort } from "./runtimePort.js";

export type CanvasRuntimeAttachment = {
  workspaceId: string;
  projectId: string;
  canvasId: string;
};

export type CanvasCollaborationCompositionOptions = {
  database: SqliteDatabase;
  upgradeRouter: WebSocketUpgradeRouter;
  identity: HumanIdentityRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  projectAccess: ProjectAccessRepository;
  collaborationScopeAuthority: CollaborationScopeAuthority;
  authorizationChanges: AuthorizationChangeSignal;
  runtimeAttachments: readonly CanvasRuntimeAttachment[];
  initialContentCapture: CanvasInitialContentCapturePort;
  runtimeStatus: CanvasRuntimeStatusPort;
  observerJournal: HumanObserverJournal;
  transportAdmission: TransportAdmissionPolicy;
  maxPayloadBytes: number;
  shutdownTimeoutMs: number;
  allowedClientOrigins?: readonly string[];
  clock: () => Date;
};

/** Compose the complete Canvas collaboration runtime and its transport endpoints. */
export async function createCanvasCollaborationComposition(
  options: CanvasCollaborationCompositionOptions
) {
  const presenceWebSockets = attachCanvasPresenceWebSocketServer({
    upgradeRouter: options.upgradeRouter,
    repository: options.identity,
    workspaceIdentity: options.workspaceIdentity,
    collaborationScopeAuthority: options.collaborationScopeAuthority,
    authorizationChanges: options.authorizationChanges,
    maxPayloadBytes: options.maxPayloadBytes,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
    transportAdmission: options.transportAdmission,
    allowedClientOrigins: options.allowedClientOrigins,
    clock: options.clock
  });
  let liveSyncWebSockets: ReturnType<typeof attachCanvasLiveSyncWebSocketServer> | undefined;
  let operationRetentionMaintenance: CanvasOperationRetentionMaintenance | undefined;
  try {
    const commandRepository = new CanvasCommandRepository(options.database, {
      clock: options.clock
    });
    const attachedLiveSyncWebSockets = attachCanvasLiveSyncWebSocketServer({
      upgradeRouter: options.upgradeRouter,
      repository: commandRepository,
      identityRepository: options.identity,
      workspaceIdentity: options.workspaceIdentity,
      projectAccess: options.projectAccess,
      collaborationScopeAuthority: options.collaborationScopeAuthority,
      authorizationChanges: options.authorizationChanges,
      maxPayloadBytes: options.maxPayloadBytes,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
      transportAdmission: options.transportAdmission,
      allowedClientOrigins: options.allowedClientOrigins,
      clock: options.clock
    });
    liveSyncWebSockets = attachedLiveSyncWebSockets;
    const contentVersions = new ContentVersionRepository(options.database, options.clock);
    for (const attachment of options.runtimeAttachments) {
      const scope = canvasScopeRefSchema.parse(attachment);
      if (contentVersions.head(scope)) continue;
      let content: CompleteContentVersion;
      try {
        content = await options.initialContentCapture.captureInitialContent(scope);
      } catch (error) {
        throw new Error(`initial_content_publish_failed:${scope.canvasId}`, { cause: error });
      }
      contentVersions.publishInitial({
        scope,
        content,
        createdBy: { kind: "system", id: "server-bootstrap" }
      });
    }
    const authoritativeCommits = new SqliteAuthoritativeCanvasCommitStore(
      options.database,
      contentVersions,
      commandRepository,
      (accepted) => {
        options.observerJournal.appendInCallerTransaction(
          {
            workspaceId: accepted.scope.workspaceId,
            projectId: accepted.scope.projectId
          },
          {
            kind: "canvas",
            canvasId: accepted.scope.canvasId,
            canvasRevision: accepted.revision,
            canvasContentDigest: accepted.contentDigest
          }
        );
      }
    );
    const contentVersionService = new ContentVersionService({
      repository: contentVersions,
      access: options.projectAccess,
      workspaceIdentity: options.workspaceIdentity
    });
    const commandService = new CanvasCommandService({
      repository: commandRepository,
      access: options.projectAccess,
      workspaceIdentity: options.workspaceIdentity,
      runtimeStatus: options.runtimeStatus,
      contentVersions,
      authoritativeCommits,
      onAcceptedEntry: (entry) => attachedLiveSyncWebSockets.publishAcceptedEntry(entry),
      onAcceptedEntryUnavailable: (input) => attachedLiveSyncWebSockets.invalidateScope(input),
      clock: options.clock
    });
    operationRetentionMaintenance = new CanvasOperationRetentionMaintenance(
      commandRepository.operationRetention,
      (remainingBudget) => commandService.recoverInterrupted(remainingBudget)
    );
    await operationRetentionMaintenance.start();
    const commandWebSockets = attachCanvasCommandWebSocketServer({
      upgradeRouter: options.upgradeRouter,
      service: commandService,
      repository: options.identity,
      workspaceIdentity: options.workspaceIdentity,
      collaborationScopeAuthority: options.collaborationScopeAuthority,
      authorizationChanges: options.authorizationChanges,
      maxPayloadBytes: options.maxPayloadBytes,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
      transportAdmission: options.transportAdmission,
      allowedClientOrigins: options.allowedClientOrigins,
      clock: options.clock
    });
    return {
      presenceWebSockets,
      liveSyncWebSockets: attachedLiveSyncWebSockets,
      commandWebSockets,
      contentVersions,
      contentVersionService,
      commandService,
      operationRetentionMaintenance
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await operationRetentionMaintenance?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    for (const transport of [liveSyncWebSockets, presenceWebSockets]) {
      try {
        await transport?.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "canvas_collaboration_startup_and_cleanup_failed",
        { cause: error }
      );
    }
    throw error;
  }
}
