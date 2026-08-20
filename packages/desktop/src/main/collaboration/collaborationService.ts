import {
  collaborationConnectionProfileSchema,
  type CollaborationConnectionProfile,
  type ActiveWorkspaceConnectionView,
  type WorkspacePickerPage
} from "@planweave-ai/collaboration-protocol/connection";
import {
  type HumanDevicePage,
  type HumanInvitationPage,
  type HumanInvitationView,
  type HumanMemberPage,
  type HumanPrincipalView
} from "@planweave-ai/collaboration-protocol/identity/workspace";
import {
  type ActivityListPage,
  type CommentDisplayProjection,
  type CommentListPage
} from "@planweave-ai/collaboration-protocol/activity/comments";
import {
  type AssignmentDisplayProjection,
  type AssignmentListPage,
  type EligibleAssigneesResponse,
  type EligibleHostBatchResponse
} from "@planweave-ai/collaboration-protocol/work/assignment";
import {
  type CollaborationWorkScope,
  type ResponsibilityReadModel
} from "@planweave-ai/collaboration-protocol/work/responsibility";
import {
  type FinalizePendingAttachmentResponse,
  type PendingAttachmentView
} from "@planweave-ai/collaboration-protocol/activity/attachments";
import {
  type RemoteActionView,
  type RemoteEventReplay,
  type RemoteInteractionPage,
  type RemoteInteractionView,
  type RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import { type ReviewAssignmentReadModel } from "@planweave-ai/collaboration-protocol/work/review";
import { type WorkAuthorityProjection } from "@planweave-ai/collaboration-protocol/work/authority";
import { type WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  type AccessMutationResult,
  type CurrentCanvasAccessView
} from "@planweave-ai/collaboration-protocol/access/control";
import {
  type CollaborationAuthHandoffView,
  type CollaborationCommentAttachmentBody,
  type CollaborationInvitationCreateView,
  type CollaborationObserverSignal,
  type CollaborationPresenceSignal,
  type CollaborationCanvasLiveSyncSignal,
  type CollaborationSessionPhase,
  type CollaborationStatus,
  type CollaborationUpsertProfileInput,
  type RememberedServerConnectionView
} from "../../shared/collaboration.js";
import { CollaborationClient } from "./CollaborationClient.js";
import { CollaborationRegistryService } from "./CollaborationRegistryService.js";
import {
  CollaborationCanvasCommandFacade,
  type CollaborationCanvasCommandSubmitResult,
  type CollaborationCanvasReconnectResult,
  type CollaborationCanvasCommandSessionView
} from "./collaborationCanvasCommands.js";
import { ContentVersionFacade } from "./ContentVersionFacade.js";
import { CollaborationRemoteOperationsFacade } from "./collaborationRemoteOperations.js";
import { CollaborationPresenceSession } from "./collaborationPresenceSession.js";
import { CollaborationCanvasLiveSyncSession } from "./collaborationCanvasLiveSyncSession.js";
import { CollaborationReadMutationsFacade } from "./collaborationReadMutations.js";
import { CollaborationClientError, collaborationErrorFromUnknown } from "./collaborationErrors.js";
import {
  CollaborationCredentialVault,
  collaborationCredentialVaultPaths
} from "./collaborationCredentialVault.js";
import {
  CollaborationProfileStore,
  collaborationProfileStorePaths
} from "./collaborationProfileStore.js";
import { CollaborationWorkspaceConnection } from "./collaborationWorkspaceConnection.js";
import { CollaborationWorkspaceConnectionFacade } from "./collaborationWorkspaceConnectionFacade.js";
import {
  buildLiveCollaborationProfile,
  listLiveRegistryProjects,
  pickLiveProjectId
} from "./liveServerBinding.js";
import { buildCollaborationStatus } from "./collaborationStatusView.js";
import {
  WorkspaceConnectionProfileStore,
  workspaceConnectionProfileStorePaths
} from "./workspaceConnectionProfileStore.js";
import { redactCollaborationText } from "./redaction.js";
import { CollaborationInvitationVault } from "./collaborationInvitationVault.js";
import { CollaborationIdentityOperations } from "./CollaborationIdentityOperations.js";
import { CollaborationProfileLifecycle } from "./CollaborationProfileLifecycle.js";
import { CollaborationSessionLifecycle } from "./CollaborationSessionLifecycle.js";
import { CanvasReplicaStore } from "./CanvasReplicaStore.js";
import { CanvasReplicaDiskMirror } from "./CanvasReplicaDiskMirror.js";
import type { CollaborationCanvasReplicaSignal } from "../../shared/canvasReplicaIpc.js";
import { resolveCollaborationAuthorityScope } from "./collaborationAuthorityScope.js";
import { CurrentCanvasAccessFacade } from "./CurrentCanvasAccessFacade.js";
import { CanvasRuntimeAvailabilityCoordinator } from "./CanvasRuntimeAvailabilityCoordinator.js";
import { CollaborationCanvasOperationsFacade } from "./CollaborationCanvasOperationsFacade.js";
import { CollaborationCanvasRealtimeFacade } from "./CollaborationCanvasRealtimeFacade.js";
import type {
  CollaborationClientFactory,
  CollaborationServiceOptions
} from "./collaborationServiceOptions.js";
export type {
  CollaborationClientFactory,
  CollaborationServiceOptions
} from "./collaborationServiceOptions.js";

/**
 * Electron-main orchestration for collaboration profiles, device credentials, and session lifecycle.
 * Renderer only sees public status/views — never tokens, ciphertext, paths, or Authorization headers.
 */
export class CollaborationService {
  private readonly profiles: CollaborationProfileStore;
  private readonly vault: CollaborationCredentialVault;
  private readonly invitationVault: CollaborationInvitationVault;
  private readonly createClient: CollaborationClientFactory;
  private readonly request?: typeof fetch;
  private readonly clock?: { now(): Date };
  private readonly onStatusChange?: (status: CollaborationStatus) => void;
  private readonly onObserverSignal?: (signal: CollaborationObserverSignal) => void;
  private readonly onPresenceSignal?: (signal: CollaborationPresenceSignal) => void;
  private readonly onCanvasLiveSyncSignal?: (signal: CollaborationCanvasLiveSyncSignal) => void;
  private readonly onCanvasReplicaSignal?: (signal: CollaborationCanvasReplicaSignal) => void;
  private readonly canvasReplicas: CanvasReplicaStore;
  private readonly canvasReplicaMirror: CanvasReplicaDiskMirror;
  private readonly registryService: CollaborationRegistryService;
  private readonly canvasCommands: CollaborationCanvasCommandFacade;
  private readonly contentVersions: ContentVersionFacade;
  private readonly remoteOperations: CollaborationRemoteOperationsFacade;
  private readonly readMutations: CollaborationReadMutationsFacade;
  private readonly workspaceConnection: CollaborationWorkspaceConnection;
  private readonly workspaceConnectionFacade: CollaborationWorkspaceConnectionFacade;
  private readonly profileLifecycle: CollaborationProfileLifecycle;
  private readonly identityOperations: CollaborationIdentityOperations;
  private readonly sessionLifecycle: CollaborationSessionLifecycle;
  private readonly currentCanvasAccess: CurrentCanvasAccessFacade;
  private readonly canvasRuntimeAvailability: CanvasRuntimeAvailabilityCoordinator;
  private readonly canvasOperations: CollaborationCanvasOperationsFacade;
  private readonly canvasRealtime: CollaborationCanvasRealtimeFacade;
  private readonly bindLiveOperatorToOrigin?: (serverBaseUrl: string) => Promise<void>;
  private workspaceHydrated = false;

  private client: CollaborationClient | null = null;
  private clientProfileId: string | null = null;
  private sessionPhase: CollaborationSessionPhase = "idle";
  private sessionDetail: string | null = null;
  private lastErrorCode: string | null = null;
  private lastErrorMessage: string | null = null;
  private readonly presenceSession: CollaborationPresenceSession;
  private readonly canvasLiveSyncSession: CollaborationCanvasLiveSyncSession;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private statusPublicationTransactionDepth = 0;
  private statusPublicationPending = false;

  constructor(options: CollaborationServiceOptions = {}) {
    const safeStorage = options.safeStorage ?? {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error("safeStorage is not configured");
      },
      decryptString: () => {
        throw new Error("safeStorage is not configured");
      }
    };
    this.profiles =
      options.profileStore ??
      new CollaborationProfileStore(options.profileStorePaths ?? collaborationProfileStorePaths());
    this.vault =
      options.vault ??
      new CollaborationCredentialVault({
        paths: options.credentialsPath
          ? collaborationCredentialVaultPaths(options.credentialsPath)
          : undefined,
        safeStorage
      });
    this.invitationVault =
      options.invitationVault ??
      new CollaborationInvitationVault({ path: options.invitationsPath, safeStorage });
    this.createClient =
      options.createClient ?? ((clientOptions) => new CollaborationClient(clientOptions));
    this.request = options.request;
    this.clock = options.clock;
    this.onStatusChange = options.onStatusChange;
    this.onObserverSignal = options.onObserverSignal;
    this.onPresenceSignal = options.onPresenceSignal;
    this.onCanvasLiveSyncSignal = options.onCanvasLiveSyncSignal;
    this.onCanvasReplicaSignal = options.onCanvasReplicaSignal;
    this.bindLiveOperatorToOrigin = options.bindLiveOperatorToOrigin;
    this.canvasReplicaMirror = new CanvasReplicaDiskMirror();
    this.canvasReplicas = new CanvasReplicaStore(
      (projection) => {
        if (!("bindingKind" in projection)) {
          this.onCanvasReplicaSignal?.({ type: "canvas.replica.changed", projection });
        }
      },
      (snapshot) => this.canvasReplicaMirror.capture(snapshot)
    );
    this.registryService = new CollaborationRegistryService(() => this.client);
    this.contentVersions = new ContentVersionFacade(
      () => this.client,
      undefined,
      async () => {
        const profileId = await this.profiles.getActiveProfileId();
        if (!profileId) return null;
        const profile = await this.profiles.get(profileId);
        return profile
          ? {
              profileId,
              serverOrigin: new URL(profile.serverBaseUrl).origin,
              projectId: profile.projectId
            }
          : null;
      }
    );
    this.canvasCommands = new CollaborationCanvasCommandFacade({
      resolveClient: () => this.client,
      resolveCanvasBinding: (input) => this.contentVersions.resolveCanvasBinding(input),
      resolveCanvasScope: (input) => this.contentVersions.resolveCanvasScope(input),
      resolveAuthorityId: () =>
        this.client ? this.contentVersions.authorityIdForClient(this.client) : null,
      store: this.canvasReplicas,
      mirror: this.canvasReplicaMirror
    });
    this.canvasRuntimeAvailability = new CanvasRuntimeAvailabilityCoordinator(
      () => this.client !== null,
      () => (this.client ? this.contentVersions.authorityIdForClient(this.client) : null),
      this.contentVersions,
      this.canvasCommands,
      this.canvasReplicas
    );
    this.canvasOperations = new CollaborationCanvasOperationsFacade({
      enqueue: (operation) => this.enqueue(operation),
      assertOpen: () => this.assertOpen(),
      commands: this.canvasCommands,
      runtimeAvailability: this.canvasRuntimeAvailability,
      contentVersions: this.contentVersions
    });
    this.remoteOperations = new CollaborationRemoteOperationsFacade((operation) =>
      this.withActiveClient((client) => operation(client.remoteOperations()))
    );
    this.presenceSession = new CollaborationPresenceSession({
      getClient: () => this.client,
      getClientProfileId: () => this.clientProfileId,
      publishPresenceSignal: (signal) => this.publishPresenceSignal(signal),
      setSessionError: (detail, error) => this.setSession("error", detail, error),
      clearDeviceCredential: (profileId) => this.vault.clear(profileId),
      publishStatus: () => this.publishStatus()
    });
    this.canvasLiveSyncSession = new CollaborationCanvasLiveSyncSession({
      getClient: () => this.client,
      getClientProfileId: () => this.clientProfileId,
      resolveCanvasBinding: (input) => this.contentVersions.resolveCanvasBinding(input),
      publishCanvasLiveSyncSignal: (signal) => this.publishCanvasLiveSyncSignal(signal),
      clearDeviceCredential: (profileId) => this.vault.clear(profileId),
      publishStatus: () => this.publishStatus()
    });
    this.canvasRealtime = new CollaborationCanvasRealtimeFacade({
      enqueue: (operation) => this.enqueue(operation),
      assertOpen: () => this.assertOpen(),
      presence: this.presenceSession,
      liveSync: this.canvasLiveSyncSession
    });
    this.readMutations = new CollaborationReadMutationsFacade(
      (operation) => this.withActiveClient(operation),
      (client, workItem) => this.toAuthorityScope(client, workItem)
    );
    this.workspaceConnection = new CollaborationWorkspaceConnection({
      store:
        options.workspaceProfileStore ??
        new WorkspaceConnectionProfileStore(
          options.workspaceProfileStorePaths ?? workspaceConnectionProfileStorePaths()
        ),
      exportedIdentityPath: options.exportedIdentityPath,
      vault: this.vault,
      request: options.request,
      clock: options.clock
    });
    this.workspaceConnectionFacade = new CollaborationWorkspaceConnectionFacade({
      connection: this.workspaceConnection,
      publishStatus: () => this.publishStatus(),
      setSession: (phase, detail, error) => this.setSession(phase, detail, error)
    });
    this.currentCanvasAccess = new CurrentCanvasAccessFacade({
      ensureWorkspaceHydrated: () => this.ensureWorkspaceHydrated(),
      buildWorkspaceConnectionView: () => this.workspaceConnection.buildView(),
      withActiveClient: (operation) => this.withActiveClient(operation)
    });
    this.sessionLifecycle = new CollaborationSessionLifecycle({
      profiles: this.profiles,
      vault: this.vault,
      presenceSession: this.presenceSession,
      canvasLiveSyncSession: this.canvasLiveSyncSession,
      canvasCommands: this.canvasCommands,
      enqueue: (operation) => this.enqueue(operation),
      assertOpen: () => this.assertOpen(),
      getClient: () => this.client,
      getClientProfileId: () => this.clientProfileId,
      setClient: (client, profileId) => {
        this.client = client;
        this.clientProfileId = profileId;
      },
      getSessionPhase: () => this.sessionPhase,
      setSession: (phase, detail, error) => this.setSession(phase, detail, error),
      clientForProfile: (profileId, requireCredential) =>
        this.clientForProfile(profileId, requireCredential),
      publishStatus: () => this.publishStatus(),
      publishObserverSignal: (signal) => this.publishObserverSignal(signal)
    });
    this.profileLifecycle = new CollaborationProfileLifecycle({
      profiles: this.profiles,
      vault: this.vault,
      invitationVault: this.invitationVault,
      enqueue: (operation) => this.enqueue(operation),
      assertOpen: () => this.assertOpen(),
      getClientProfileId: () => this.clientProfileId,
      getSessionPhase: () => this.sessionPhase,
      setSession: (phase, detail, error) => this.setSession(phase, detail, error),
      disposeClient: (reason) => this.disposeClient(reason),
      clearRememberedObserverCursor: (profileId) => this.clearRememberedObserverCursor(profileId),
      publishStatus: () => this.publishStatus(),
      clientForProfile: async (profileId, requireCredential) =>
        (await this.clientForProfile(profileId, requireCredential)).client,
      activateWorkspaceAuthority: (input) => this.activateWorkspaceAuthorityInternal(input)
    });
    this.identityOperations = new CollaborationIdentityOperations({
      invitationVault: this.invitationVault,
      profiles: this.profiles,
      getClientProfileId: () => this.clientProfileId,
      publishStatus: async () => {
        await this.publishStatus();
      },
      withActiveClient: (operation) => this.withActiveClient(operation)
    });
  }

  private async ensureWorkspaceHydrated(): Promise<void> {
    if (this.workspaceHydrated) return;
    await this.workspaceConnection.hydrate();
    this.workspaceHydrated = true;
  }

  /**
   * After the Workspace origin is live, members and operator must use that same Server.
   * Origin connect already succeeded; session bind failures stay on the session, not the origin.
   */
  private async activateLiveServerSurfacesWithinQueue(): Promise<void> {
    const view = await this.workspaceConnection.buildView();
    if (view.status !== "connected" || !view.profile || !view.workspaceId) return;
    const live = {
      profileId: view.profile.profileId,
      displayName: view.profile.displayName,
      serverBaseUrl: view.profile.serverBaseUrl,
      workspaceId: view.workspaceId,
      allowInsecureTransport: view.profile.allowInsecureTransport
    };
    if (this.bindLiveOperatorToOrigin) {
      await this.bindLiveOperatorToOrigin(live.serverBaseUrl);
    }
    try {
      await this.activateLiveCollaborationSessionWithinQueue(live);
    } catch (error) {
      const mapped = collaborationErrorFromUnknown(error);
      this.setSession("error", "live_session_bind_failed", {
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
    const existing = (await this.profiles.list()).find((profile) => {
      try {
        return new URL(profile.serverBaseUrl).origin === origin;
      } catch {
        return false;
      }
    });
    const registryProjects = await listLiveRegistryProjects({
      serverBaseUrl: live.serverBaseUrl,
      getDeviceToken: () => this.vault.getDeviceToken(live.profileId),
      request: this.request
    });
    const projectId = pickLiveProjectId({
      workspaceId: live.workspaceId,
      registryProjects,
      preferredProjectId: existing?.projectId ?? null
    });
    if (!projectId) return;
    await this.profiles.upsert(
      buildLiveCollaborationProfile({
        profileId: live.profileId,
        displayName: live.displayName,
        serverBaseUrl: live.serverBaseUrl,
        allowInsecureTransport: live.allowInsecureTransport,
        projectId
      })
    );
    await this.sessionLifecycle.connectWithinQueue(live.profileId, {
      preserveCredentialOnAuthFailure: true
    });
  }

  private async activateWorkspaceAuthorityInternal(input: {
    profileId: string;
    workspaceId: string;
    membershipRole: "owner" | "member";
  }): Promise<void> {
    await this.ensureWorkspaceHydrated();
    const stored = await this.profiles.get(input.profileId);
    if (!stored || stored.connectionState !== "ready") {
      throw new Error(`Collaboration profile is not ready: ${input.profileId}`);
    }
    const projectProfile = collaborationConnectionProfileSchema.parse({
      profileId: stored.profileId,
      displayName: stored.displayName,
      serverBaseUrl: stored.serverBaseUrl,
      projectId: stored.projectId,
      allowInsecureTransport: stored.allowInsecureTransport,
      endpoint: stored.endpoint
    });
    await this.workspaceConnection.adoptAuthenticatedProject({
      projectProfile,
      workspaceId: input.workspaceId,
      membershipRole: input.membershipRole
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(operation);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new Error("Collaboration service has been shut down.");
    }
  }

  private setSession(
    phase: CollaborationSessionPhase,
    detail: string | null = null,
    error?: { code: string; message: string } | null
  ): void {
    this.sessionPhase = phase;
    this.sessionDetail = detail;
    if (error === null) {
      this.lastErrorCode = null;
      this.lastErrorMessage = null;
    } else if (error) {
      this.lastErrorCode = error.code;
      this.lastErrorMessage = redactCollaborationText(error.message);
    }
  }

  private async buildStatus(): Promise<CollaborationStatus> {
    await this.ensureWorkspaceHydrated();
    return buildCollaborationStatus({
      profiles: this.profiles,
      vault: this.vault,
      workspaceConnection: this.workspaceConnection,
      session: {
        phase: this.sessionPhase,
        detail: this.sessionDetail,
        lastErrorCode: this.lastErrorCode,
        lastErrorMessage: this.lastErrorMessage,
        clientProfileId: this.clientProfileId,
        observerStatus: this.sessionLifecycle.getObserverStatus(),
        client: this.client
      },
      clock: this.clock
    });
  }

  private async publishStatus(): Promise<CollaborationStatus> {
    const status = await this.buildStatus();
    if (this.statusPublicationTransactionDepth > 0) {
      this.statusPublicationPending = true;
      return status;
    }
    this.onStatusChange?.(status);
    return status;
  }

  /** Main-only status transaction: nested operations publish one final renderer snapshot. */
  async runStatusPublicationTransaction<T>(operation: () => Promise<T>): Promise<T> {
    this.statusPublicationTransactionDepth += 1;
    try {
      return await operation();
    } finally {
      this.statusPublicationTransactionDepth -= 1;
      if (this.statusPublicationTransactionDepth === 0 && this.statusPublicationPending) {
        this.statusPublicationPending = false;
        const status = await this.buildStatus();
        this.onStatusChange?.(status);
      }
    }
  }

  async getStatus(): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      return this.buildStatus();
    });
  }

  async upsertProfile(input: unknown): Promise<CollaborationStatus> {
    return this.profileLifecycle.upsertProfile(input);
  }

  async removeProfile(input: unknown): Promise<CollaborationStatus> {
    return this.profileLifecycle.removeProfile(input);
  }

  async setActiveProfile(input: unknown): Promise<CollaborationStatus> {
    return this.profileLifecycle.setActiveProfile(input);
  }

  async clearActiveProfile(): Promise<CollaborationStatus> {
    return this.profileLifecycle.clearActiveProfile();
  }

  async importDeviceCredential(input: unknown): Promise<CollaborationStatus> {
    return this.profileLifecycle.importDeviceCredential(input);
  }

  async clearDeviceCredential(input: unknown): Promise<CollaborationStatus> {
    return this.profileLifecycle.clearDeviceCredential(input);
  }

  private async clientForProfile(
    profileId: string,
    requireCredential: boolean
  ): Promise<{ client: CollaborationClient; profile: CollaborationConnectionProfile }> {
    const stored = await this.profiles.get(profileId);
    if (!stored) {
      throw new Error(`Unknown collaboration profile: ${profileId}`);
    }
    const profile = collaborationConnectionProfileSchema.parse({
      profileId: stored.profileId,
      displayName: stored.displayName,
      serverBaseUrl: stored.serverBaseUrl,
      projectId: stored.projectId,
      allowInsecureTransport: stored.allowInsecureTransport,
      endpoint: stored.endpoint
    });
    if (requireCredential) {
      const token = await this.vault.getDeviceToken(profileId);
      if (!token) {
        throw new Error("Human device credential is not available for this profile.");
      }
    }
    const client = this.createClient({
      profile,
      credential: {
        getDeviceToken: () => this.vault.getDeviceToken(profileId)
      },
      request: this.request
    });
    return { client, profile };
  }

  async bootstrapOwner(input: unknown): Promise<CollaborationAuthHandoffView> {
    return this.profileLifecycle.bootstrapOwner(input);
  }

  /** Main-only identity lookup for local coordinator authorization; never crosses IPC. */
  async activeHumanPrincipalId(profileId: string): Promise<string | null> {
    return this.profileLifecycle.activeHumanPrincipalId(profileId);
  }

  /** Main-only compatibility migration from the former global loopback profile. */
  async migrateLocalProfileCredential(
    sourceProfileId: string,
    targetProfileId: string
  ): Promise<void> {
    return this.profileLifecycle.migrateLocalProfileCredential(sourceProfileId, targetProfileId);
  }

  /** Main-only migration from a hosted project route to the canonical Workspace connection. */
  async adoptWorkspaceAuthority(input: {
    profileId: string;
    workspaceId: string;
    membershipRole: "owner" | "member";
  }): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.activateWorkspaceAuthorityInternal(input);
      await this.publishStatus();
    });
  }

  async consumeInvitation(input: unknown): Promise<CollaborationAuthHandoffView> {
    return this.profileLifecycle.consumeInvitation(input);
  }
  async connectSession(input: unknown): Promise<CollaborationStatus> {
    return this.sessionLifecycle.connect(input);
  }

  async disconnectSession(): Promise<CollaborationStatus> {
    return this.sessionLifecycle.disconnect();
  }
  async redeemSetupCode(input: unknown): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.ensureWorkspaceHydrated();
      await this.workspaceConnectionFacade.redeemSetupCode(input);
      await this.activateLiveServerSurfacesWithinQueue();
      return this.publishStatus();
    });
  }

  async connectExistingServerByOrigin(input: unknown): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.ensureWorkspaceHydrated();
      await this.workspaceConnectionFacade.connectExistingServerByOrigin(input);
      await this.activateLiveServerSurfacesWithinQueue();
      return this.publishStatus();
    });
  }

  async getActiveWorkspaceConnection(): Promise<ActiveWorkspaceConnectionView> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.ensureWorkspaceHydrated();
      return this.workspaceConnectionFacade.getActiveWorkspaceConnection();
    });
  }

  async peekPersistedRemoteProfileId(): Promise<string | null> {
    return this.enqueue(async () => {
      this.assertOpen();
      return this.workspaceConnection.peekPersistedRemoteProfileId();
    });
  }

  async snapshotExportedServerDataIdentity(): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.workspaceConnection.snapshotExportedServerDataIdentity();
    });
  }

  async markLastServerConnectionLocal(): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.workspaceConnection.markLastConnectionLocal();
    });
  }

  async restorePersistedRemoteServerConnection(profileId: string): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.ensureWorkspaceHydrated();
      await this.workspaceConnectionFacade.selectWorkspaceConnection({ profileId });
      await this.activateLiveServerSurfacesWithinQueue();
      return this.publishStatus();
    });
  }

  async listRememberedServerConnections(): Promise<RememberedServerConnectionView[]> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.ensureWorkspaceHydrated();
      return this.workspaceConnectionFacade.listRememberedServerConnections();
    });
  }

  async listWorkspacePicker(input: unknown = {}): Promise<WorkspacePickerPage> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.ensureWorkspaceHydrated();
      return this.workspaceConnectionFacade.listWorkspacePicker(input);
    });
  }

  async selectWorkspaceConnection(input: unknown): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.ensureWorkspaceHydrated();
      await this.workspaceConnectionFacade.selectWorkspaceConnection(input);
      await this.activateLiveServerSurfacesWithinQueue();
      return this.publishStatus();
    });
  }

  async connectWorkspaceConnection(): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.ensureWorkspaceHydrated();
      await this.workspaceConnectionFacade.connectWorkspaceConnection();
      await this.activateLiveServerSurfacesWithinQueue();
      return this.publishStatus();
    });
  }

  async disconnectWorkspaceConnection(): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.ensureWorkspaceHydrated();
      await this.sessionLifecycle.disconnectWithinQueue();
      return this.workspaceConnectionFacade.disconnectWorkspaceConnection();
    });
  }

  async forgetRememberedServerConnection(input: unknown): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.ensureWorkspaceHydrated();
      return this.workspaceConnectionFacade.forgetRememberedServerConnection(input);
    });
  }

  async retryWorkspaceConnection(): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.ensureWorkspaceHydrated();
      await this.workspaceConnectionFacade.retryWorkspaceConnection();
      await this.activateLiveServerSurfacesWithinQueue();
      return this.publishStatus();
    });
  }

  async getCurrentCanvasAccess(input: unknown): Promise<CurrentCanvasAccessView> {
    return this.enqueue(async () => {
      this.assertOpen();
      return this.currentCanvasAccess.get(input);
    });
  }

  async mutateCurrentCanvasAccess(input: unknown): Promise<AccessMutationResult> {
    return this.enqueue(async () => {
      this.assertOpen();
      return this.currentCanvasAccess.mutate(input);
    });
  }

  async startPresence(input: unknown): Promise<void> {
    return this.canvasRealtime.startPresence(input);
  }

  async stopPresence(): Promise<void> {
    return this.canvasRealtime.stopPresence();
  }

  async startCanvasLiveSync(input: unknown): Promise<void> {
    return this.canvasRealtime.startLiveSync(input);
  }

  async stopCanvasLiveSync(): Promise<void> {
    return this.canvasRealtime.stopLiveSync();
  }

  async publishPresence(input: unknown): Promise<void> {
    return this.canvasRealtime.publishPresence(input);
  }

  async submitCanvasCommand(input: unknown): Promise<CollaborationCanvasCommandSubmitResult> {
    return this.canvasOperations.submitCommand(input);
  }

  async reconnectCanvas(input: unknown): Promise<CollaborationCanvasReconnectResult> {
    return this.canvasOperations.reconnect(input);
  }

  async bindCanvasCommandSession(input: unknown): Promise<CollaborationCanvasCommandSessionView> {
    return this.canvasOperations.bindCommandSession(input);
  }

  async getCanvasCommandSession(): Promise<CollaborationCanvasCommandSessionView> {
    return this.canvasOperations.getCommandSession();
  }

  async flushCanvasReplicaMaterialization(): Promise<void> {
    return this.canvasOperations.flushReplicaMaterialization();
  }

  async resolveCanvasScope(input: unknown) {
    return this.canvasOperations.resolveScope(input);
  }

  async readCanvasRuntimeAvailability(input: unknown) {
    return this.canvasOperations.readRuntimeAvailability(input);
  }

  async getCanvasReplicaProjection(input: unknown) {
    return this.canvasOperations.getReplicaProjection(input);
  }

  async bindContentAuthority(input: unknown) {
    return this.canvasOperations.bindContentAuthority(input);
  }

  async getContentAuthority() {
    return this.canvasOperations.getContentAuthority();
  }

  async refreshContentAuthority() {
    return this.canvasOperations.refreshContentAuthority();
  }

  async publishInitialContent() {
    return this.canvasOperations.publishInitialContent();
  }

  async materializeContentHead() {
    return this.canvasOperations.materializeContentHead();
  }

  async listContentBootstrapCandidates() {
    return this.canvasOperations.listContentBootstrapCandidates();
  }

  async bootstrapContent(input: unknown) {
    return this.canvasOperations.bootstrapContent(input);
  }

  async listMembers(input: unknown = {}): Promise<HumanMemberPage> {
    return this.identityOperations.listMembers(input);
  }

  async updateOwnDisplayName(input: unknown): Promise<HumanPrincipalView> {
    return this.identityOperations.updateOwnDisplayName(input);
  }

  async migrateLegacyLocalOwnerDisplayName(input: unknown): Promise<boolean> {
    return this.identityOperations.migrateLegacyLocalOwnerDisplayName(input);
  }

  registry(): CollaborationRegistryService {
    return this.registryService;
  }

  async listDevices(input: unknown = {}): Promise<HumanDevicePage> {
    return this.identityOperations.listDevices(input);
  }

  async listInvitations(input: unknown = {}): Promise<HumanInvitationPage> {
    return this.identityOperations.listInvitations(input);
  }

  async createInvitation(input: unknown = {}): Promise<CollaborationInvitationCreateView> {
    return this.identityOperations.createInvitation(input);
  }

  async getInvitationSecret(input: unknown): Promise<CollaborationInvitationCreateView> {
    return this.identityOperations.getInvitationSecret(input);
  }

  async revokeInvitation(input: unknown): Promise<HumanInvitationView> {
    return this.identityOperations.revokeInvitation(input);
  }

  async revokeInvitations(input: unknown) {
    return this.identityOperations.revokeInvitations(input);
  }

  async removeMember(input: unknown): Promise<void> {
    return this.identityOperations.removeMember(input);
  }

  async promoteOwner(input: unknown): Promise<void> {
    return this.identityOperations.promoteOwner(input);
  }

  async demoteOwner(input: unknown): Promise<void> {
    return this.identityOperations.demoteOwner(input);
  }

  async revokeDevice(input: unknown): Promise<void> {
    return this.identityOperations.revokeDevice(input);
  }

  async listAssignments(input: unknown = {}): Promise<AssignmentListPage> {
    return this.readMutations.listAssignments(input);
  }

  async getAssignment(input: unknown): Promise<AssignmentDisplayProjection> {
    return this.readMutations.getAssignment(input);
  }

  async listEligibleAssignees(input: unknown): Promise<EligibleAssigneesResponse> {
    return this.readMutations.listEligibleAssignees(input);
  }

  async listEligibleHostsBatch(input: unknown): Promise<EligibleHostBatchResponse> {
    return this.readMutations.listEligibleHostsBatch(input);
  }

  async getWorkAuthority(input: unknown): Promise<WorkAuthorityProjection> {
    return this.readMutations.getWorkAuthority(input);
  }

  async updateResponsibility(input: unknown): Promise<ResponsibilityReadModel> {
    return this.readMutations.updateResponsibility(input);
  }

  async updateReviewer(input: unknown): Promise<ReviewAssignmentReadModel> {
    return this.readMutations.updateReviewer(input);
  }

  async listComments(input: unknown): Promise<CommentListPage> {
    return this.readMutations.listComments(input);
  }

  async listActivity(input: unknown = {}): Promise<ActivityListPage> {
    return this.readMutations.listActivity(input);
  }

  async updateAssignment(input: unknown): Promise<AssignmentDisplayProjection> {
    return this.readMutations.updateAssignment(input);
  }

  async createComment(input: unknown): Promise<CommentDisplayProjection> {
    return this.readMutations.createComment(input);
  }

  async editComment(input: unknown): Promise<CommentDisplayProjection> {
    return this.readMutations.editComment(input);
  }

  async tombstoneComment(input: unknown): Promise<CommentDisplayProjection> {
    return this.readMutations.tombstoneComment(input);
  }

  async createPendingAttachment(input: unknown): Promise<PendingAttachmentView> {
    return this.readMutations.createPendingAttachment(input);
  }

  async uploadPendingAttachment(input: unknown): Promise<PendingAttachmentView> {
    return this.readMutations.uploadPendingAttachment(input);
  }

  async dispatchRemoteOperation(input: unknown): Promise<RemoteOperationObservation> {
    return this.remoteOperations.dispatch(input);
  }

  async listAgentEndpoints() {
    return this.remoteOperations.listAgentEndpoints();
  }

  async observeRemoteOperation(input: unknown): Promise<RemoteOperationObservation> {
    return this.remoteOperations.observe(input);
  }

  async executeRemoteOperationAction(input: unknown): Promise<RemoteActionView> {
    return this.remoteOperations.executeAction(input);
  }

  async replayRemoteOperationEvents(input: unknown): Promise<RemoteEventReplay> {
    return this.remoteOperations.replayEvents(input);
  }

  async listRemoteOperationInteractions(input: unknown): Promise<RemoteInteractionPage> {
    return this.remoteOperations.listInteractions(input);
  }

  async settleRemoteOperationInteraction(input: unknown): Promise<RemoteInteractionView> {
    return this.remoteOperations.settleInteraction(input);
  }

  async finalizePendingAttachment(input: unknown): Promise<FinalizePendingAttachmentResponse> {
    return this.readMutations.finalizePendingAttachment(input);
  }

  async readCommentAttachment(input: unknown): Promise<CollaborationCommentAttachmentBody> {
    return this.readMutations.readCommentAttachment(input);
  }

  private async withActiveClient<T>(
    operation: (client: CollaborationClient) => Promise<T>
  ): Promise<T> {
    this.assertOpen();
    const client = this.client;
    if (!client || !this.clientProfileId) {
      throw new CollaborationClientError({
        kind: "offline",
        code: "collaboration_session_inactive",
        message: "No active collaboration session. Connect a profile before loading read models.",
        retryable: false
      });
    }
    try {
      return await operation(client);
    } catch (error) {
      throw collaborationErrorFromUnknown(error);
    }
  }

  /**
   * Build a Server authority scope from a work item.
   * Workspace ID is resolved from the registry for the active project — never from local paths.
   */
  private async toAuthorityScope(
    client: CollaborationClient,
    workItem: WorkItemRef
  ): Promise<CollaborationWorkScope> {
    return resolveCollaborationAuthorityScope({
      registry: client.registry(),
      projectId: client.projectId,
      workItem
    });
  }

  private publishObserverSignal(signal: CollaborationObserverSignal): void {
    this.onObserverSignal?.(signal);
  }

  private publishPresenceSignal(signal: CollaborationPresenceSignal): void {
    this.onPresenceSignal?.(signal);
  }

  private publishCanvasLiveSyncSignal(signal: CollaborationCanvasLiveSyncSignal): void {
    this.onCanvasLiveSyncSignal?.(signal);
  }

  private clearRememberedObserverCursor(profileId?: string | null): void {
    this.sessionLifecycle.clearRememberedObserverCursor(profileId);
  }

  private async disposeClient(reason: string): Promise<void> {
    return this.sessionLifecycle.dispose(reason);
  }
  /** Abort live clients and clear process memory on app shutdown. Durable ciphertext is kept. */
  async shutdown(): Promise<void> {
    await this.enqueue(async () => {
      await this.disposeClient("shutdown");
      this.vault.clearSessionMemory();
      this.setSession("idle", "shutdown", null);
      this.disposed = true;
    });
  }
}

export type { CollaborationUpsertProfileInput };
