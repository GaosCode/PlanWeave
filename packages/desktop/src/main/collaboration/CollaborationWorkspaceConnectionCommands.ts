import {
  buildLiveCollaborationProfile,
  listLiveRegistryProjects,
  pickLiveProjectId
} from "./liveServerBinding.js";
import { collaborationErrorFromUnknown } from "./collaborationErrors.js";
import type { CollaborationProfileStore } from "./collaborationProfileStore.js";
import type { CollaborationCredentialVault } from "./collaborationCredentialVault.js";
import type { CollaborationSessionLifecycle } from "./CollaborationSessionLifecycle.js";
import type { CollaborationWorkspaceConnectionFacadeOptions } from "./collaborationWorkspaceConnectionFacade.js";
import type { ServerDataIdentitySnapshotResult } from "../../shared/serverDataMigration.js";
import type {
  ActiveWorkspaceConnectionView,
  WorkspaceConnectionMembersPage,
  WorkspaceConnectionSelfView,
  WorkspacePickerPage
} from "@planweave-ai/collaboration-protocol/connection";
import type {
  CollaborationStatus,
  RememberedServerConnectionView
} from "../../shared/collaboration.js";
import type { CollaborationWorkspaceConnection } from "./collaborationWorkspaceConnection.js";
import type { CollaborationWorkspaceConnectionFacade } from "./collaborationWorkspaceConnectionFacade.js";

type WorkspaceCommandsOptions = {
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>;
  assertOpen: () => void;
  ensureWorkspaceHydrated: () => Promise<void>;
  connection: CollaborationWorkspaceConnection;
  facade: CollaborationWorkspaceConnectionFacade;
  profiles: CollaborationProfileStore;
  vault: CollaborationCredentialVault;
  sessionLifecycle: CollaborationSessionLifecycle;
  request?: typeof fetch;
  bindLiveOperatorToOrigin?: (serverBaseUrl: string) => Promise<void>;
  setSession: CollaborationWorkspaceConnectionFacadeOptions["setSession"];
  disconnectSession: () => Promise<CollaborationStatus>;
  publishStatus: () => Promise<CollaborationStatus>;
};

/** Serializes connection changes while admitting bounded remote reads before releasing the queue. */
export class CollaborationWorkspaceConnectionCommands {
  constructor(private readonly options: WorkspaceCommandsOptions) {}

  async read<T>(prepare: () => Promise<() => Promise<T>>): Promise<T> {
    const run = await this.options.enqueue(async () => {
      this.options.assertOpen();
      await this.options.ensureWorkspaceHydrated();
      return prepare();
    });
    return run();
  }

  async redeemSetupCode(input: unknown): Promise<CollaborationStatus> {
    return this.options.enqueue(async () => {
      this.options.assertOpen();
      await this.options.ensureWorkspaceHydrated();
      await this.options.facade.redeemSetupCode(input);
      await this.activateLiveServerSurfacesWithinQueue();
      return this.options.publishStatus();
    });
  }

  async recoverHistoricalIdentities(input: unknown): Promise<CollaborationStatus> {
    return this.options.enqueue(async () => {
      this.options.assertOpen();
      await this.options.ensureWorkspaceHydrated();
      return this.options.facade.recoverHistoricalIdentities(input);
    });
  }

  async confirmIdentityMerge(input: unknown): Promise<CollaborationStatus> {
    return this.options.enqueue(async () => {
      this.options.assertOpen();
      await this.options.ensureWorkspaceHydrated();
      return this.options.facade.confirmIdentityMerge(input);
    });
  }

  async connectExistingServerByOrigin(input: unknown): Promise<CollaborationStatus> {
    return this.options.enqueue(async () => {
      this.options.assertOpen();
      await this.options.ensureWorkspaceHydrated();
      await this.options.facade.connectExistingServerByOrigin(input);
      await this.activateLiveServerSurfacesWithinQueue();
      return this.options.publishStatus();
    });
  }

  async getActiveWorkspaceConnection(): Promise<ActiveWorkspaceConnectionView> {
    return this.options.enqueue(async () => {
      this.options.assertOpen();
      await this.options.ensureWorkspaceHydrated();
      return this.options.facade.getActiveWorkspaceConnection();
    });
  }

  async peekPersistedRemoteProfileId(): Promise<string | null> {
    return this.options.enqueue(async () => {
      this.options.assertOpen();
      return this.options.connection.peekPersistedRemoteProfileId();
    });
  }

  async snapshotExportedServerDataIdentity(): Promise<ServerDataIdentitySnapshotResult> {
    return this.options.enqueue(async () => {
      this.options.assertOpen();
      return this.options.connection.snapshotExportedServerDataIdentity();
    });
  }

  async markLastServerConnectionLocal(): Promise<void> {
    return this.options.enqueue(async () => {
      this.options.assertOpen();
      await this.options.connection.markLastConnectionLocal();
    });
  }

  async restorePersistedRemoteServerConnection(profileId: string): Promise<CollaborationStatus> {
    return this.options.enqueue(async () => {
      this.options.assertOpen();
      await this.options.ensureWorkspaceHydrated();
      await this.options.facade.selectWorkspaceConnection({ profileId });
      await this.activateLiveServerSurfacesWithinQueue();
      return this.options.publishStatus();
    });
  }

  async listRememberedServerConnections(): Promise<RememberedServerConnectionView[]> {
    return this.options.enqueue(async () => {
      this.options.assertOpen();
      await this.options.ensureWorkspaceHydrated();
      return this.options.facade.listRememberedServerConnections();
    });
  }

  async listWorkspacePicker(input: unknown = {}): Promise<WorkspacePickerPage> {
    return this.read(() => this.options.facade.preparePickerRead(input));
  }

  async getWorkspaceConnectionSelf(): Promise<WorkspaceConnectionSelfView> {
    return this.read(() => this.options.facade.prepareSelfRead());
  }

  async updateWorkspaceConnectionSelf(input: unknown): Promise<WorkspaceConnectionSelfView> {
    return this.options.enqueue(async () => {
      this.options.assertOpen();
      await this.options.ensureWorkspaceHydrated();
      return this.options.facade.updateWorkspaceConnectionSelf(input);
    });
  }

  async listWorkspaceConnectionMembers(
    input: unknown = {}
  ): Promise<WorkspaceConnectionMembersPage> {
    return this.read(() => this.options.facade.prepareMembersRead(input));
  }

  async selectWorkspaceConnection(input: unknown): Promise<CollaborationStatus> {
    return this.options.enqueue(async () => {
      this.options.assertOpen();
      await this.options.ensureWorkspaceHydrated();
      await this.options.facade.selectWorkspaceConnection(input);
      await this.activateLiveServerSurfacesWithinQueue();
      return this.options.publishStatus();
    });
  }

  async connectWorkspaceConnection(): Promise<CollaborationStatus> {
    return this.options.enqueue(async () => {
      this.options.assertOpen();
      await this.options.ensureWorkspaceHydrated();
      await this.options.facade.connectWorkspaceConnection();
      await this.activateLiveServerSurfacesWithinQueue();
      return this.options.publishStatus();
    });
  }

  async disconnectWorkspaceConnection(): Promise<CollaborationStatus> {
    return this.options.enqueue(async () => {
      this.options.assertOpen();
      await this.options.ensureWorkspaceHydrated();
      await this.options.disconnectSession();
      return this.options.facade.disconnectWorkspaceConnection();
    });
  }

  async forgetRememberedServerConnection(input: unknown): Promise<CollaborationStatus> {
    return this.options.enqueue(async () => {
      this.options.assertOpen();
      await this.options.ensureWorkspaceHydrated();
      return this.options.facade.forgetRememberedServerConnection(input);
    });
  }

  async retryWorkspaceConnection(): Promise<CollaborationStatus> {
    return this.options.enqueue(async () => {
      this.options.assertOpen();
      await this.options.ensureWorkspaceHydrated();
      await this.options.facade.retryWorkspaceConnection();
      await this.activateLiveServerSurfacesWithinQueue();
      return this.options.publishStatus();
    });
  }
  /**
   * After the Workspace origin is live, members and operator must use that same Server.
   * Origin connect already succeeded; session bind failures stay on the session, not the origin.
   */
  private async activateLiveServerSurfacesWithinQueue(): Promise<void> {
    const view = await this.options.connection.buildView();
    if (view.status !== "connected" || !view.profile || !view.workspaceId) return;
    const live = {
      profileId: view.profile.profileId,
      displayName: view.profile.displayName,
      serverBaseUrl: view.profile.serverBaseUrl,
      workspaceId: view.workspaceId,
      allowInsecureTransport: view.profile.allowInsecureTransport
    };
    await this.options.sessionLifecycle.dispose("workspace_project_rebind");
    await this.options.profiles.setActiveProfileId(null);
    try {
      if (this.options.bindLiveOperatorToOrigin) {
        await this.options.bindLiveOperatorToOrigin(live.serverBaseUrl);
      }
      await this.activateLiveCollaborationSessionWithinQueue(live);
    } catch (error) {
      const mapped = collaborationErrorFromUnknown(error);
      this.options.setSession("error", "live_session_bind_failed", {
        code: mapped.code,
        message: mapped.message
      });
    }
  }

  private async activateLiveCollaborationSessionWithinQueue(live: {
    profileId: string;
    displayName: string;
    serverBaseUrl: string;
    workspaceId: string;
    allowInsecureTransport: boolean;
  }): Promise<void> {
    const origin = new URL(live.serverBaseUrl).origin;
    const existing = (await this.options.profiles.list()).find((profile) => {
      try {
        return new URL(profile.serverBaseUrl).origin === origin;
      } catch {
        return false;
      }
    });
    const registryProjects = await listLiveRegistryProjects({
      serverBaseUrl: live.serverBaseUrl,
      getDeviceToken: () => this.options.vault.getDeviceToken(live.profileId),
      request: this.options.request
    });
    const projectId = pickLiveProjectId({
      workspaceId: live.workspaceId,
      registryProjects,
      preferredProjectId: existing?.projectId ?? null
    });
    if (!projectId) {
      this.options.setSession("idle", "workspace_no_shared_projects", null);
      return;
    }
    await this.options.profiles.upsert(
      buildLiveCollaborationProfile({
        profileId: live.profileId,
        displayName: live.displayName,
        serverBaseUrl: live.serverBaseUrl,
        allowInsecureTransport: live.allowInsecureTransport,
        projectId
      })
    );
    await this.options.sessionLifecycle.connectWithinQueue(live.profileId);
  }
}
