import type { CollaborationCanvasBindingReplicaSignal } from "../../shared/canvasReplicaIpc.js";
import type { WorkspaceCanvasLocator } from "../../shared/canvasLocator.js";
import type { WorkspaceCanvasProjection } from "../../shared/workspaceCanvasProjection.js";
import { CanvasReplicaDiskMirror } from "./CanvasReplicaDiskMirror.js";
import { CanvasReplicaStore } from "./CanvasReplicaStore.js";
import { CanvasRuntimeAvailabilityCoordinator } from "./CanvasRuntimeAvailabilityCoordinator.js";
import type { CollaborationClient } from "./CollaborationClient.js";
import { CollaborationCanvasOperationsFacade } from "./CollaborationCanvasOperationsFacade.js";
import type { ContentVersionFacade } from "./ContentVersionFacade.js";
import { WorkspaceAuthoritativeSnapshotCache } from "./WorkspaceAuthoritativeSnapshotCache.js";
import {
  workspaceRemoteAuthorityKeyFromProfile,
  workspaceRemoteAuthorityKeySchema
} from "./WorkspaceRemoteAuthorityIdentity.js";
import { CollaborationCanvasCommandFacade } from "./collaborationCanvasCommands.js";

type WorkspaceAuthorityProfile = {
  profileId: string;
  serverBaseUrl: string;
  projectId: string;
};

export type WorkspaceCanvasSnapshotSessionCompositionOptions = {
  snapshotCache?: WorkspaceAuthoritativeSnapshotCache;
  contentVersions: ContentVersionFacade;
  resolveClient(): CollaborationClient | null;
  resolveConnectedProfileId(): string | null;
  resolveProfile(profileId: string): Promise<WorkspaceAuthorityProfile | null>;
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  assertOpen(): void;
  onCanvasReplicaSignal?(signal: CollaborationCanvasBindingReplicaSignal): void;
  onWorkspaceCanvasProjection?(projection: WorkspaceCanvasProjection): void;
};

/** Owns Workspace replica recovery persistence and the session facades that consume it. */
export function createWorkspaceCanvasSnapshotSessionComposition(
  options: WorkspaceCanvasSnapshotSessionCompositionOptions
): {
  commands: CollaborationCanvasCommandFacade;
  operations: CollaborationCanvasOperationsFacade;
} {
  const mirror = new CanvasReplicaDiskMirror();
  const snapshotCache = options.snapshotCache ?? new WorkspaceAuthoritativeSnapshotCache();
  let operations: CollaborationCanvasOperationsFacade | null = null;
  const replicas = new CanvasReplicaStore(
    (projection) => {
      options.onCanvasReplicaSignal?.({ type: "canvas.replica.changed", projection });
      operations?.publishWorkspaceCanvasProjection();
    },
    (snapshot) => {
      mirror.capture(snapshot);
      const client = options.resolveClient();
      if (!client || snapshot.scope.bindingKind !== "remote") return;
      const profile = client.connectionProfile;
      snapshotCache.capture(
        workspaceRemoteAuthorityKeySchema.parse({
          connectionProfileId: profile.profileId,
          serverOrigin: new URL(profile.serverBaseUrl).origin,
          workspaceId: snapshot.scope.workspaceId,
          projectId: snapshot.scope.projectId,
          canvasId: snapshot.scope.canvasId
        }),
        snapshot
      );
    }
  );
  const commands = new CollaborationCanvasCommandFacade({
    resolveClient: options.resolveClient,
    resolveCanvasBinding: (input) => options.contentVersions.resolveCanvasBinding(input),
    resolveCanvasScope: (input) => options.contentVersions.resolveCanvasScope(input),
    resolveAuthorityId: () => {
      const client = options.resolveClient();
      return client ? options.contentVersions.authorityIdForClient(client) : null;
    },
    store: replicas,
    mirror,
    snapshotCache
  });
  const runtimeAvailability = new CanvasRuntimeAvailabilityCoordinator(
    () => options.resolveClient() !== null,
    () => {
      const client = options.resolveClient();
      return client ? options.contentVersions.authorityIdForClient(client) : null;
    },
    options.contentVersions,
    commands,
    replicas
  );
  operations = new CollaborationCanvasOperationsFacade({
    enqueue: options.enqueue,
    assertOpen: options.assertOpen,
    commands,
    runtimeAvailability,
    contentVersions: options.contentVersions,
    resolveConnectedProfileId: options.resolveConnectedProfileId,
    resolveSnapshotCacheKey: async (locator: WorkspaceCanvasLocator) => {
      const profile = await options.resolveProfile(locator.connectionProfileId);
      if (!profile) throw new Error("workspace_snapshot_cache_profile_missing");
      return workspaceRemoteAuthorityKeyFromProfile(locator, profile);
    },
    snapshotCache,
    onWorkspaceCanvasProjection: options.onWorkspaceCanvasProjection
  });
  return { commands, operations };
}
