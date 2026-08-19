import {
  activeWorkspaceConnectionViewSchema,
  workspaceConnectionProfileSchema,
  workspacePickerPageSchema,
  type ActiveWorkspaceConnectionError,
  type ActiveWorkspaceConnectionStatus,
  type ActiveWorkspaceConnectionView,
  type CollaborationConnectionProfile,
  type WorkspaceConnectionProfile,
  type WorkspacePickerPage
} from "@planweave-ai/collaboration-protocol/connection";
import { assertSetupViewRedacted } from "@planweave-ai/collaboration-protocol/setup";
import type { CollaborationCredentialVault } from "./collaborationCredentialVault.js";
import {
  CollaborationSetupCodeClient,
  setupCodeFailureMessage
} from "./collaborationSetupCodeClient.js";
import { isLocalCollaborationProfileId } from "./collaborationProfileEndpoint.js";
import {
  COLLABORATION_CONNECTION_ERROR_CODES,
  CollaborationClientError,
  collaborationConnectionErrorFromUnknown,
  collaborationErrorFromUnknown
} from "./collaborationErrors.js";
import {
  rememberedServerConnectionViewSchema,
  type RememberedServerConnectionView
} from "../../shared/collaboration.js";
import { CollaborationWorkspaceClient } from "./CollaborationWorkspaceClient.js";
import { redactCollaborationText } from "./redaction.js";
import { inferPersistedRemoteProfileId } from "./persistedServerConnectionPreference.js";
import {
  WorkspaceConnectionProfileStore,
  type StoredWorkspaceConnectionProfile,
  type WorkspaceConnectionProfileStorePaths,
  workspaceConnectionProfileStorePaths
} from "./workspaceConnectionProfileStore.js";
import {
  EXPORTED_SERVER_DATA_PROFILE_ID,
  ExportedServerDataIdentityStore,
  isExportedServerDataProfileId,
  type ExportedServerDataIdentity
} from "./exportedServerDataIdentity.js";

export type CollaborationWorkspaceConnectionOptions = {
  store?: WorkspaceConnectionProfileStore;
  storePaths?: WorkspaceConnectionProfileStorePaths;
  exportedIdentityStore?: ExportedServerDataIdentityStore;
  exportedIdentityPath?: string;
  vault: CollaborationCredentialVault;
  request?: typeof fetch;
  clock?: { now(): Date };
  onChange?: () => void;
};

function nowIso(clock?: { now(): Date }): string {
  return (clock?.now() ?? new Date()).toISOString();
}

function localOnlyView(): ActiveWorkspaceConnectionView {
  return activeWorkspaceConnectionViewSchema.parse({
    schemaVersion: "workspace-setup/v1",
    status: "local_only",
    profile: null,
    workspaceId: null,
    workspaceDisplayName: null,
    connectedAt: null,
    error: null
  });
}

function emptyWorkspacePickerPage(): WorkspacePickerPage {
  return workspacePickerPageSchema.parse({
    schemaVersion: "workspace-setup/v1",
    items: [],
    nextCursor: null
  });
}

function toPublicProfile(stored: StoredWorkspaceConnectionProfile): WorkspaceConnectionProfile {
  return {
    schemaVersion: stored.schemaVersion,
    profileId: stored.profileId,
    displayName: stored.displayName,
    serverBaseUrl: stored.serverBaseUrl,
    workspaceId: stored.workspaceId,
    allowInsecureTransport: stored.allowInsecureTransport
  };
}

function isRetargetableWorkspaceProfileId(profileId: string): boolean {
  return isLocalCollaborationProfileId(profileId) || isExportedServerDataProfileId(profileId);
}

function exportedIdentityAsStoredProfile(
  identity: ExportedServerDataIdentity
): StoredWorkspaceConnectionProfile {
  return {
    ...workspaceConnectionProfileSchema.parse({
      schemaVersion: "workspace-identity/v1",
      profileId: EXPORTED_SERVER_DATA_PROFILE_ID,
      displayName: identity.workspaceDisplayName,
      serverBaseUrl: "http://127.0.0.1/",
      workspaceId: identity.workspaceId,
      allowInsecureTransport: true
    }),
    workspaceDisplayName: identity.workspaceDisplayName,
    membershipRole: identity.membershipRole,
    membershipActive: true,
    updatedAt: identity.updatedAt
  };
}

function isRejectedWorkspaceCredential(error: unknown): boolean {
  if (!(error instanceof CollaborationClientError)) return false;
  if (error.httpStatus === 401 || error.httpStatus === 403) return true;
  return (
    error.code === COLLABORATION_CONNECTION_ERROR_CODES.workspaceUnauthorized ||
    error.code === COLLABORATION_CONNECTION_ERROR_CODES.workspaceForbidden ||
    error.kind === "auth" ||
    error.kind === "forbidden"
  );
}

/**
 * Single Server/Workspace connection session for Desktop.
 * Credentials stay in the vault; this module only builds redacted connection/picker views.
 */
export class CollaborationWorkspaceConnection {
  private readonly store: WorkspaceConnectionProfileStore;
  private readonly exportedIdentity: ExportedServerDataIdentityStore;
  private readonly vault: CollaborationCredentialVault;
  private readonly request?: typeof fetch;
  private readonly clock?: { now(): Date };
  private readonly onChange?: () => void;

  private status: ActiveWorkspaceConnectionStatus = "local_only";
  private activeProfileId: string | null = null;
  private connectedAt: string | null = null;
  private error: ActiveWorkspaceConnectionError | null = null;
  private workspaceDisplayName: string | null = null;
  private lastAuthoritativePicker: WorkspacePickerPage = emptyWorkspacePickerPage();

  constructor(options: CollaborationWorkspaceConnectionOptions) {
    this.store =
      options.store ??
      new WorkspaceConnectionProfileStore(
        options.storePaths ?? workspaceConnectionProfileStorePaths()
      );
    this.exportedIdentity =
      options.exportedIdentityStore ??
      new ExportedServerDataIdentityStore(
        options.exportedIdentityPath ?? ExportedServerDataIdentityStore.defaultPath()
      );
    this.vault = options.vault;
    this.request = options.request;
    this.clock = options.clock;
    this.onChange = options.onChange;
  }

  async hydrate(): Promise<void> {
    const activeId = await this.store.getActiveProfileId();
    if (!activeId) {
      this.status = "local_only";
      this.activeProfileId = null;
      this.connectedAt = null;
      this.error = null;
      this.workspaceDisplayName = null;
      return;
    }
    const stored = await this.store.get(activeId);
    if (!stored) {
      await this.store.setActiveProfileId(null);
      this.status = "local_only";
      this.activeProfileId = null;
      return;
    }
    const persistence = await this.vault.persistenceFor(activeId);
    this.activeProfileId = activeId;
    this.workspaceDisplayName = stored.workspaceDisplayName;
    if (persistence === "missing") {
      this.status = "disconnected";
      this.connectedAt = null;
      this.error = null;
      return;
    }
    // Restored profile remains disconnected until startup restore or an explicit connect.
    this.status = "disconnected";
    this.connectedAt = null;
    this.error = null;
  }

  async peekPersistedRemoteProfileId(): Promise<string | null> {
    const document = await this.store.read();
    const inferred = inferPersistedRemoteProfileId({
      lastConnection: document.lastConnection,
      activeProfileId: document.activeProfileId,
      profiles: document.profiles.map((profile) => ({
        profileId: profile.profileId,
        updatedAt: profile.updatedAt
      }))
    });
    if (
      inferred &&
      (document.lastConnection?.kind !== "remote" || document.lastConnection.profileId !== inferred)
    ) {
      await this.store.setLastConnection({ kind: "remote", profileId: inferred });
    }
    return inferred;
  }

  async markLastConnectionLocal(): Promise<void> {
    await this.store.setLastConnection({ kind: "local" });
  }

  async listRememberedServers(): Promise<RememberedServerConnectionView[]> {
    const remembered: RememberedServerConnectionView[] = [];
    const profiles = await this.store.list();
    const ordered = [...profiles].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );
    for (const profile of ordered) {
      if (isRetargetableWorkspaceProfileId(profile.profileId)) continue;
      const persistence = await this.vault.persistenceFor(profile.profileId);
      remembered.push(
        rememberedServerConnectionViewSchema.parse({
          profileId: profile.profileId,
          displayName: profile.displayName,
          workspaceDisplayName: profile.workspaceDisplayName,
          serverBaseUrl: profile.serverBaseUrl,
          hasDeviceCredential: persistence !== "missing"
        })
      );
    }
    return remembered;
  }

  async buildView(): Promise<ActiveWorkspaceConnectionView> {
    if (this.status === "local_only" || this.activeProfileId === null) {
      const view = localOnlyView();
      assertSetupViewRedacted(view);
      return view;
    }
    const stored = await this.store.get(this.activeProfileId);
    if (!stored) {
      const view = localOnlyView();
      assertSetupViewRedacted(view);
      return view;
    }
    const profile = toPublicProfile(stored);
    const view = activeWorkspaceConnectionViewSchema.parse({
      schemaVersion: "workspace-setup/v1",
      status: this.status,
      profile:
        this.status === "connected" ||
        this.status === "reconnecting" ||
        this.status === "connecting" ||
        this.status === "error" ||
        this.status === "disconnected"
          ? profile
          : null,
      workspaceId: stored.workspaceId,
      workspaceDisplayName: this.workspaceDisplayName ?? stored.workspaceDisplayName,
      connectedAt: this.connectedAt,
      error: this.error
    });
    // connected/reconnecting require profile+workspace; disconnected/error/connecting allow profile
    // Re-parse after adjusting for disconnected with profile
    if (this.status === "disconnected" || this.status === "connecting" || this.status === "error") {
      const relaxed = {
        schemaVersion: "workspace-setup/v1" as const,
        status: this.status,
        profile,
        workspaceId: stored.workspaceId,
        workspaceDisplayName: this.workspaceDisplayName ?? stored.workspaceDisplayName,
        connectedAt: this.connectedAt,
        error: this.error
      };
      // Schema only requires profile for connected/reconnecting; disconnected may include profile.
      const parsed = activeWorkspaceConnectionViewSchema.parse(relaxed);
      assertSetupViewRedacted(parsed);
      return parsed;
    }
    assertSetupViewRedacted(view);
    return view;
  }

  async buildPickerPage(cursor = 0, limit = 50): Promise<WorkspacePickerPage> {
    const activeId = this.activeProfileId ?? (await this.store.getActiveProfileId());
    if (!activeId) {
      const page = emptyWorkspacePickerPage();
      assertSetupViewRedacted(page);
      return page;
    }
    const stored = await this.store.get(activeId);
    if (!stored) {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "workspace_connection_profile_missing",
        message: "The active Workspace connection profile is unavailable.",
        retryable: false
      });
    }
    const page = await this.listAuthoritativeWorkspaces(stored, cursor, limit);
    assertSetupViewRedacted(page);
    return page;
  }

  buildCachedPickerPage(): WorkspacePickerPage {
    assertSetupViewRedacted(this.lastAuthoritativePicker);
    return this.lastAuthoritativePicker;
  }

  private async listAuthoritativeWorkspaces(
    stored: StoredWorkspaceConnectionProfile,
    cursor: number,
    limit: number
  ): Promise<WorkspacePickerPage> {
    const client = new CollaborationWorkspaceClient({
      profile: toPublicProfile(stored),
      credential: { getDeviceToken: () => this.vault.getDeviceToken(stored.profileId) },
      request: this.request
    });
    try {
      const page = await client.listWorkspaces({ cursor, limit });
      this.lastAuthoritativePicker = page;
      return page;
    } finally {
      client.dispose();
    }
  }

  private async findAuthoritativeWorkspace(
    stored: StoredWorkspaceConnectionProfile
  ): Promise<WorkspacePickerPage["items"][number] | null> {
    let cursor = 0;
    for (let pageCount = 0; pageCount < 100; pageCount += 1) {
      const page = await this.listAuthoritativeWorkspaces(stored, cursor, 100);
      const match = page.items.find(
        (item) =>
          item.workspaceId === stored.workspaceId &&
          item.membershipActive &&
          item.archivedAt === null
      );
      if (match) return match;
      if (page.nextCursor === null) return null;
      if (page.nextCursor <= cursor) {
        throw new CollaborationClientError({
          kind: "protocol",
          code: "workspace_connection_pagination_invalid",
          message: "Workspace picker pagination was invalid.",
          retryable: false
        });
      }
      cursor = page.nextCursor;
    }
    throw new CollaborationClientError({
      kind: "protocol",
      code: "workspace_connection_picker_limit_exceeded",
      message: "Workspace picker exceeded the supported page limit.",
      retryable: false
    });
  }

  /**
   * Keep a Workspace device credential that survives deleting this computer's Server data directory.
   * Tokens stay in the vault; they are never written into the export archive.
   */
  async snapshotExportedServerDataIdentity(): Promise<void> {
    const locals = (await this.store.list())
      .filter((profile) => isLocalCollaborationProfileId(profile.profileId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    for (const profile of locals) {
      if (await this.vault.getDeviceToken(profile.profileId)) {
        await this.snapshotWorkspaceCredential(profile);
        return;
      }
    }
  }

  private async snapshotWorkspaceCredential(
    profile: StoredWorkspaceConnectionProfile
  ): Promise<void> {
    const token = await this.vault.getDeviceToken(profile.profileId);
    if (!token) return;
    const metadata = await this.vault.getMetadata(profile.profileId);
    if (profile.profileId !== EXPORTED_SERVER_DATA_PROFILE_ID) {
      await this.vault.setDeviceToken(EXPORTED_SERVER_DATA_PROFILE_ID, token, {
        deviceCredentialId: metadata?.deviceCredentialId,
        humanPrincipalId: metadata?.humanPrincipalId
      });
    }
    await this.exportedIdentity.write({
      schemaVersion: "exported-server-data-identity/v1",
      workspaceId: profile.workspaceId,
      workspaceDisplayName: profile.workspaceDisplayName,
      membershipRole: profile.membershipRole,
      updatedAt: nowIso(this.clock)
    });
  }

  /**
   * Reconnect this device when a stored Workspace credential already exists for the origin.
   * After Server data is restored onto a different origin, the stored credential for that
   * URL is from the previous Server identity; retry this computer's local Workspace token.
   */
  async tryReconnectByOrigin(serverBaseUrl: string): Promise<boolean> {
    const origin = new URL(serverBaseUrl).origin;
    const targetBaseUrl = `${origin}/`;
    const originMatches: StoredWorkspaceConnectionProfile[] = [];
    const localMatches: StoredWorkspaceConnectionProfile[] = [];
    for (const profile of await this.store.list()) {
      if (!(await this.vault.getDeviceToken(profile.profileId))) continue;
      if (isRetargetableWorkspaceProfileId(profile.profileId)) {
        localMatches.push(profile);
        continue;
      }
      try {
        if (new URL(profile.serverBaseUrl).origin !== origin) continue;
      } catch {
        continue;
      }
      originMatches.push(profile);
    }
    const exported = await this.exportedIdentity.read();
    if (
      exported &&
      (await this.vault.getDeviceToken(EXPORTED_SERVER_DATA_PROFILE_ID)) &&
      !localMatches.some((profile) => profile.profileId === EXPORTED_SERVER_DATA_PROFILE_ID)
    ) {
      localMatches.push(exportedIdentityAsStoredProfile(exported));
    }
    originMatches.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    localMatches.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    for (const match of originMatches) {
      try {
        await this.store.setActiveProfileId(match.profileId);
        this.activeProfileId = match.profileId;
        this.workspaceDisplayName = match.workspaceDisplayName;
        await this.connectActiveProfile();
        return true;
      } catch (error) {
        if (!isRejectedWorkspaceCredential(error)) throw error;
      }
    }
    const originProfile = originMatches[0];
    if (!originProfile || isRetargetableWorkspaceProfileId(originProfile.profileId)) {
      return false;
    }
    for (const localProfile of localMatches) {
      if (
        await this.bindLocalWorkspaceCredentialToOrigin(localProfile, originProfile, targetBaseUrl)
      ) {
        return true;
      }
    }
    return false;
  }

  private async bindLocalWorkspaceCredentialToOrigin(
    localProfile: StoredWorkspaceConnectionProfile,
    originProfile: StoredWorkspaceConnectionProfile,
    serverBaseUrl: string
  ): Promise<boolean> {
    const token = await this.vault.getDeviceToken(localProfile.profileId);
    if (!token) return false;
    const retargeted: StoredWorkspaceConnectionProfile = {
      ...localProfile,
      serverBaseUrl
    };
    let authoritative: WorkspacePickerPage["items"][number] | null;
    try {
      authoritative = await this.findAuthoritativeWorkspace(retargeted);
    } catch (error) {
      if (isRejectedWorkspaceCredential(error)) return false;
      throw error;
    }
    if (!authoritative) return false;
    const metadata = await this.vault.getMetadata(localProfile.profileId);
    const bound = await this.store.upsert({
      profile: workspaceConnectionProfileSchema.parse({
        schemaVersion: originProfile.schemaVersion,
        profileId: originProfile.profileId,
        displayName: originProfile.displayName,
        serverBaseUrl,
        workspaceId: localProfile.workspaceId,
        allowInsecureTransport: originProfile.allowInsecureTransport
      }),
      workspaceDisplayName: localProfile.workspaceDisplayName,
      membershipRole: localProfile.membershipRole,
      membershipActive: true
    });
    await this.vault.setDeviceToken(bound.profileId, token, {
      deviceCredentialId: metadata?.deviceCredentialId,
      humanPrincipalId: metadata?.humanPrincipalId
    });
    await this.snapshotWorkspaceCredential(localProfile);
    await this.store.setActiveProfileId(bound.profileId);
    this.activeProfileId = bound.profileId;
    this.workspaceDisplayName = bound.workspaceDisplayName;
    await this.connectActiveProfile();
    return true;
  }

  /**
   * Redeem a one-time device setup code. Token stays in the vault; never returned.
   */
  async redeemDeviceSetupCode(input: {
    serverBaseUrl: string;
    allowInsecureTransport: boolean;
    setupCode: string;
    displayName: string;
    deviceLabel?: string;
  }): Promise<ActiveWorkspaceConnectionView> {
    this.status = "connecting";
    this.error = null;
    this.onChange?.();
    try {
      const client = new CollaborationSetupCodeClient({
        origin: {
          serverBaseUrl: input.serverBaseUrl,
          allowInsecureTransport: input.allowInsecureTransport
        },
        request: this.request
      });
      const response = await client.redeemDevice({
        schemaVersion: "workspace-setup/v1",
        purpose: "device_session",
        setupCode: input.setupCode,
        displayName: input.displayName,
        ...(input.deviceLabel ? { deviceLabel: input.deviceLabel } : {})
      });
      const stored = await this.store.upsert({
        profile: response.connectionProfile,
        workspaceDisplayName: response.workspaceDisplayName,
        membershipRole:
          response.role === "owner" || response.role === "member" ? response.role : null,
        membershipActive: true
      });
      await this.vault.setDeviceToken(stored.profileId, response.deviceToken, {
        deviceCredentialId: response.deviceSessionId,
        humanPrincipalId: response.humanPrincipalId
      });
      await this.store.setActiveProfileId(stored.profileId);
      this.activeProfileId = stored.profileId;
      this.workspaceDisplayName = response.workspaceDisplayName;
      return await this.connectActiveProfile();
    } catch (error) {
      const setupError = collaborationErrorFromUnknown(error);
      const mapped = setupError.code.startsWith("setup_code_")
        ? setupError
        : collaborationConnectionErrorFromUnknown(setupError);
      this.status = "error";
      this.error = {
        code: mapped.code,
        message: setupCodeFailureMessage(error),
        retryable: mapped.retryable !== false
      };
      this.onChange?.();
      throw mapped;
    }
  }

  /**
   * Promote an authenticated project route into the single Workspace authority.
   * The project profile remains a routing detail; its credential is shared by profileId.
   */
  async adoptAuthenticatedProject(input: {
    projectProfile: CollaborationConnectionProfile;
    workspaceId: string;
    membershipRole: "owner" | "member";
  }): Promise<ActiveWorkspaceConnectionView> {
    const profile = workspaceConnectionProfileSchema.parse({
      schemaVersion: "workspace-identity/v1",
      profileId: input.projectProfile.profileId,
      displayName: input.projectProfile.displayName,
      serverBaseUrl: input.projectProfile.serverBaseUrl,
      workspaceId: input.workspaceId,
      allowInsecureTransport: input.projectProfile.allowInsecureTransport
    });
    const stored = await this.store.upsert({
      profile,
      workspaceDisplayName: profile.displayName,
      membershipRole: input.membershipRole,
      membershipActive: true
    });
    await this.store.setActiveProfileId(stored.profileId);
    this.activeProfileId = stored.profileId;
    this.workspaceDisplayName = stored.workspaceDisplayName;
    this.status = "connected";
    this.connectedAt = nowIso(this.clock);
    this.error = null;
    this.onChange?.();
    return this.buildView();
  }

  async connectActiveProfile(): Promise<ActiveWorkspaceConnectionView> {
    const activeId = this.activeProfileId ?? (await this.store.getActiveProfileId());
    if (!activeId) {
      this.status = "local_only";
      return this.buildView();
    }
    const stored = await this.store.get(activeId);
    if (!stored) {
      this.status = "local_only";
      this.activeProfileId = null;
      return this.buildView();
    }
    this.status = "connecting";
    this.error = null;
    this.activeProfileId = activeId;
    this.workspaceDisplayName = stored.workspaceDisplayName;
    if (!isLocalCollaborationProfileId(activeId)) {
      await this.store.setLastConnection({ kind: "remote", profileId: activeId });
    }
    this.onChange?.();
    try {
      const token = await this.vault.getDeviceToken(activeId);
      if (!token) {
        throw new CollaborationClientError({
          kind: "auth",
          code: "collaboration_credential_missing",
          message: "Human device credential is not available for this Workspace.",
          retryable: false
        });
      }
      const authoritative = await this.findAuthoritativeWorkspace(stored);
      if (!authoritative) {
        throw new CollaborationClientError({
          kind: "forbidden",
          code: COLLABORATION_CONNECTION_ERROR_CODES.workspaceForbidden,
          message: "The Server did not authorize this Workspace for the active device.",
          retryable: false
        });
      }
      await this.store.upsert({
        profile: toPublicProfile(stored),
        workspaceDisplayName: authoritative.displayName,
        membershipRole: authoritative.role,
        membershipActive: authoritative.membershipActive
      });
      this.workspaceDisplayName = authoritative.displayName;
      this.status = "connected";
      this.connectedAt = nowIso(this.clock);
      this.error = null;
      await this.store.setActiveProfileId(activeId);
      this.onChange?.();
      return this.buildView();
    } catch (error) {
      const mapped = collaborationConnectionErrorFromUnknown(error);
      this.status = "error";
      this.connectedAt = null;
      this.error = {
        code: mapped.code,
        message: mapped.message,
        retryable: mapped.retryable
      };
      this.onChange?.();
      throw mapped;
    }
  }

  async selectWorkspace(profileId: string): Promise<ActiveWorkspaceConnectionView> {
    const stored = await this.store.get(profileId);
    if (!stored) {
      throw new Error(`Unknown workspace connection profile: ${profileId}`);
    }
    await this.store.setActiveProfileId(profileId);
    this.activeProfileId = profileId;
    this.workspaceDisplayName = stored.workspaceDisplayName;
    this.status = "disconnected";
    this.connectedAt = null;
    this.error = null;
    this.onChange?.();
    return this.connectActiveProfile();
  }

  async selectWorkspaceByWorkspaceId(workspaceId: string): Promise<ActiveWorkspaceConnectionView> {
    const profiles = await this.store.list();
    const stored = profiles.find((profile) => profile.workspaceId === workspaceId);
    if (!stored) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    return this.selectWorkspace(stored.profileId);
  }

  async disconnectToLocalOnly(): Promise<ActiveWorkspaceConnectionView> {
    await this.store.setLastConnection({ kind: "local" });
    await this.store.setActiveProfileId(null);
    this.activeProfileId = null;
    this.workspaceDisplayName = null;
    this.status = "local_only";
    this.connectedAt = null;
    this.error = null;
    this.lastAuthoritativePicker = emptyWorkspacePickerPage();
    this.onChange?.();
    return this.buildView();
  }

  async forgetRememberedServer(profileId: string): Promise<ActiveWorkspaceConnectionView> {
    if (isLocalCollaborationProfileId(profileId)) {
      throw new CollaborationClientError({
        kind: "validation",
        code: "remembered_server_local_profile_forbidden",
        message: "This computer is not a remembered Server.",
        retryable: false
      });
    }
    const stored = await this.store.get(profileId);
    if (!stored) {
      throw new CollaborationClientError({
        kind: "validation",
        code: "remembered_server_unknown",
        message: "That remembered Server is not available.",
        retryable: false
      });
    }
    const wasActive = this.activeProfileId === profileId;
    await this.vault.clear(profileId);
    await this.store.remove(profileId);
    if (wasActive) {
      return this.disconnectToLocalOnly();
    }
    this.onChange?.();
    return this.buildView();
  }

  async retry(): Promise<ActiveWorkspaceConnectionView> {
    if (this.status !== "error" && this.status !== "disconnected") {
      return this.buildView();
    }
    return this.connectActiveProfile();
  }

  markError(code: string, message: string, retryable: boolean): void {
    if (this.status === "local_only") return;
    this.status = "error";
    this.error = {
      code,
      message: redactCollaborationText(message),
      retryable
    };
    this.onChange?.();
  }

  getActiveProfileId(): string | null {
    return this.activeProfileId;
  }

  async getActiveStoredProfile(): Promise<StoredWorkspaceConnectionProfile | null> {
    if (!this.activeProfileId) return null;
    return this.store.get(this.activeProfileId);
  }
}
