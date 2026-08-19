import { serializeCollaborationSetupHandoffV1 } from "@planweave-ai/collaboration-protocol/handoff/setup";
import { operatorTokenSchema } from "@planweave-ai/agent-host-protocol";
import { randomBytes } from "node:crypto";
import {
  assertNoSmuggledOperatorSecrets,
  operatorControlProfileSchema,
  operatorControlProfileInputSchema,
  operatorCreateEnrollmentGrantInputSchema,
  operatorCopyHostBootstrapHandoffInputSchema,
  operatorHostBootstrapHandoffViewSchema,
  operatorCopyMemberSetupCodeInputSchema,
  operatorMemberSetupCodeHandoffViewSchema,
  operatorImportCredentialInputSchema,
  operatorListHostsInputSchema,
  operatorListAgentEndpointsInputSchema,
  operatorGetLocalAgentHostStatusInputSchema,
  operatorRepairLocalAgentHostInputSchema,
  operatorEnrollLocalAgentHostInputSchema,
  operatorRegisterLocalAgentHostInputSchema,
  operatorProfileIdInputSchema,
  operatorRevokeHostInputSchema,
  operatorRenewHostCredentialInputSchema,
  operatorDispatchOwnerFleetRemoteOperationInputSchema,
  operatorObserveOwnerFleetRemoteOperationInputSchema,
  operatorReplayOwnerFleetRemoteOperationEventsInputSchema,
  operatorExecuteOwnerFleetRemoteOperationActionInputSchema,
  OperatorControlError,
  type OperatorControlProfile,
  type OperatorControlStatus,
  type OperatorCredentialPersistence,
  type OperatorProfileView
} from "../../shared/operatorControl.js";
import {
  buildHostBootstrapHandoff,
  buildHostBootstrapHandoffPayload
} from "./hostBootstrapHandoff.js";
import {
  type LocalAgentHostProvisioner,
  unavailableLocalAgentHostProvisioner
} from "./localAgentHostProvisioner.js";
import { parseAgentHostHandoffInput } from "./localAgentHostHandoff.js";
import {
  OperatorControlClient,
  type OperatorControlClientOptions
} from "./OperatorControlClient.js";
import {
  getLocalOperatorBackendPort,
  isLocalOwnedOperatorProfile,
  LOCAL_OPERATOR_PROFILE_ID,
  resolveEffectiveOperatorServerBaseUrl,
  type LocalOperatorBackendPort
} from "./localOperatorBackend.js";
import {
  operatorCredentialVaultPaths,
  OperatorCredentialVault,
  type OperatorCredentialVaultOptions,
  type OperatorSafeStoragePort
} from "./operatorCredentialVault.js";
import {
  operatorProfileStorePaths,
  OperatorProfileStore,
  type OperatorProfileStorePaths
} from "./operatorProfileStore.js";

const operatorCredentialMaterialInputSchema = operatorImportCredentialInputSchema.extend({
  operatorToken: operatorTokenSchema
});

export const OPERATOR_SESSION_ONLY_WARNING =
  "Operator credential is held for this session only because configured credential storage is unavailable.";

export type OperatorControlClientFactory = (
  options: OperatorControlClientOptions
) => OperatorControlClient;

export type OperatorControlServiceOptions = {
  profileStore?: OperatorProfileStore;
  vault?: OperatorCredentialVault;
  safeStorage?: OperatorSafeStoragePort;
  profileStorePaths?: OperatorProfileStorePaths;
  credentialsPath?: string;
  createClient?: OperatorControlClientFactory;
  request?: typeof fetch;
  clock?: { now(): Date };
  onStatusChange?: (status: OperatorControlStatus) => void;
  localAgentHost?: LocalAgentHostProvisioner;
  /** Test injection; production uses the coordinator-registered backend port. */
  localOperatorBackend?: LocalOperatorBackendPort | null;
};

function nowIso(clock?: { now(): Date }): string {
  return (clock?.now() ?? new Date()).toISOString();
}

const localAgentHostErrorCodePattern = /^(?:agent_host|local_agent_host)_[a-z0-9_]+$/;

function localAgentHostErrorFromUnknown(error: unknown): OperatorControlError {
  if (error instanceof OperatorControlError) return error;
  const code =
    error instanceof Error && localAgentHostErrorCodePattern.test(error.message)
      ? error.message
      : "local_agent_host_registration_failed";
  return new OperatorControlError({ kind: "unknown", code, cause: error });
}

function isRejectedByTargetServer(error: unknown): boolean {
  return (
    error instanceof OperatorControlError &&
    (error.kind === "unauthorized" || error.kind === "forbidden")
  );
}

function toPublicProfile(
  profile: OperatorControlProfile & { updatedAt: string },
  hostedByThisDesktop: boolean,
  credential: {
    hasOperatorCredential: boolean;
    operatorCredentialPersistence: OperatorCredentialPersistence;
    operatorId: string | null;
  }
): OperatorProfileView {
  return {
    profileId: profile.profileId,
    displayName: profile.displayName,
    serverBaseUrl: profile.serverBaseUrl,
    allowInsecureTransport: profile.allowInsecureTransport,
    hostedByThisDesktop,
    ...(profile.endpoint ? { endpoint: profile.endpoint } : {}),
    operatorId: credential.operatorId ?? profile.operatorId ?? null,
    hasOperatorCredential: credential.hasOperatorCredential,
    operatorCredentialPersistence: credential.operatorCredentialPersistence,
    updatedAt: profile.updatedAt
  };
}

/** Electron-main orchestration for isolated operator profiles and Host control calls. */
export class OperatorControlService {
  private readonly profiles: OperatorProfileStore;
  private readonly vault: OperatorCredentialVault;
  private readonly createClient: OperatorControlClientFactory;
  private readonly request?: typeof fetch;
  private readonly clock?: { now(): Date };
  private readonly onStatusChange?: (status: OperatorControlStatus) => void;
  private readonly localAgentHost: LocalAgentHostProvisioner;
  private readonly localOperatorBackend: LocalOperatorBackendPort | null | undefined;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private lastErrorCode: string | null = null;
  private lastErrorMessage: string | null = null;

  constructor(options: OperatorControlServiceOptions = {}) {
    this.profiles =
      options.profileStore ??
      new OperatorProfileStore(options.profileStorePaths ?? operatorProfileStorePaths());
    const vaultOptions: OperatorCredentialVaultOptions = {
      safeStorage: options.safeStorage,
      ...(options.credentialsPath
        ? { paths: operatorCredentialVaultPaths(options.credentialsPath) }
        : {})
    };
    this.vault = options.vault ?? new OperatorCredentialVault(vaultOptions);
    this.createClient =
      options.createClient ?? ((clientOptions) => new OperatorControlClient(clientOptions));
    this.request = options.request;
    this.clock = options.clock;
    this.onStatusChange = options.onStatusChange;
    this.localAgentHost = options.localAgentHost ?? unavailableLocalAgentHostProvisioner();
    this.localOperatorBackend = options.localOperatorBackend;
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
    if (this.disposed)
      throw new OperatorControlError({ kind: "offline", code: "operator_service_closed" });
  }

  private resolveLocalOperatorBackend(): LocalOperatorBackendPort | null {
    return this.localOperatorBackend === undefined
      ? getLocalOperatorBackendPort()
      : this.localOperatorBackend;
  }

  private async buildStatus(): Promise<OperatorControlStatus> {
    const profiles = await this.profiles.list();
    const activeProfileId = await this.profiles.getActiveProfileId();
    const localBackend = this.resolveLocalOperatorBackend();
    const localBackendSnapshot = localBackend?.getSnapshot() ?? null;
    const views: OperatorProfileView[] = [];
    for (const profile of profiles) {
      const persistence = await this.vault.persistenceFor(profile.profileId);
      const metadata = await this.vault.getMetadata(profile.profileId);
      views.push(
        toPublicProfile(profile, isLocalOwnedOperatorProfile(profile, localBackendSnapshot), {
          hasOperatorCredential: persistence !== "missing",
          operatorCredentialPersistence: persistence,
          operatorId: metadata?.operatorId ?? null
        })
      );
    }
    const sessionOnly =
      views.some((profile) => profile.operatorCredentialPersistence === "session-only") ||
      (await this.vault.hasAnySessionOnlyCredential());
    const activeProfile = views.find((profile) => profile.profileId === activeProfileId) ?? null;
    const localServerNotReady =
      localBackend !== null &&
      activeProfile?.hostedByThisDesktop === true &&
      (!localBackendSnapshot?.running || !localBackendSnapshot.loopbackBaseUrl);
    const localServerRecovered =
      activeProfile?.hostedByThisDesktop === true &&
      localBackendSnapshot?.running === true &&
      Boolean(localBackendSnapshot.loopbackBaseUrl) &&
      this.lastErrorCode === "operator_local_server_not_ready";
    const lastErrorCode = localServerNotReady
      ? "operator_local_server_not_ready"
      : localServerRecovered
        ? null
        : this.lastErrorCode;
    const lastErrorMessage = localServerNotReady
      ? "operator_local_server_not_ready"
      : localServerRecovered
        ? null
        : this.lastErrorMessage;
    return {
      profiles: views,
      activeProfileId,
      credentialStorage: this.vault.storageAvailability(),
      nonPersistenceWarning: sessionOnly ? OPERATOR_SESSION_ONLY_WARNING : null,
      lastErrorCode,
      lastErrorMessage,
      updatedAt: nowIso(this.clock)
    };
  }

  private async publishStatus(): Promise<OperatorControlStatus> {
    const status = await this.buildStatus();
    this.onStatusChange?.(status);
    return status;
  }

  private rememberError(error: unknown): void {
    if (error instanceof OperatorControlError) {
      this.lastErrorCode = error.code;
      this.lastErrorMessage = error.message;
    } else {
      this.lastErrorCode = "operator_request_failed";
      this.lastErrorMessage = "Operator request failed.";
    }
  }

  async getStatus(): Promise<OperatorControlStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      return this.buildStatus();
    });
  }

  async upsertProfile(input: unknown): Promise<OperatorControlStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      assertNoSmuggledOperatorSecrets(input, "upsertOperatorProfile");
      const profile = operatorControlProfileInputSchema.parse(input);
      const existing = await this.profiles.get(profile.profileId);
      await this.profiles.upsert({
        ...profile,
        ...(existing?.endpoint ? { endpoint: existing.endpoint } : {})
      });
      return this.publishStatus();
    });
  }

  /** Main-only provisioning for Desktop-generated self-host deployments. */
  async ensureDeploymentProfile(input: {
    profile: OperatorControlProfile;
    operatorId: string;
  }): Promise<string> {
    return this.enqueue(async () => {
      this.assertOpen();
      const profile = operatorControlProfileSchema.parse(input.profile);
      const operatorId = input.operatorId.trim();
      if (!operatorId) {
        throw new OperatorControlError({
          kind: "validation",
          code: "deployment_operator_id_required"
        });
      }
      const existingToken = await this.vault.getOperatorToken(profile.profileId);
      if (existingToken) {
        if ((await this.vault.persistenceFor(profile.profileId)) !== "persisted") {
          throw new Error("deployment_operator_credential_persistence_required");
        }
        await this.profiles.upsert(profile);
        return existingToken;
      }
      const operatorToken = `pw_operator_${randomBytes(32).toString("base64url")}`;
      const persistence = await this.vault.setOperatorToken(
        profile.profileId,
        operatorToken,
        operatorId
      );
      if (persistence !== "persisted") {
        await this.vault.clear(profile.profileId);
        throw new Error("deployment_operator_credential_persistence_required");
      }
      try {
        await this.profiles.upsert(profile);
      } catch (error) {
        await this.vault.clear(profile.profileId);
        throw error;
      }
      return operatorToken;
    });
  }

  /** Main-only registration for an already-running Desktop-owned server and its existing token. */
  async ensureMainOwnedServerProfile(input: {
    profile: OperatorControlProfile;
    operatorId: string;
    operatorToken: string;
  }): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      const profile = operatorControlProfileSchema.parse(input.profile);
      if (!profile.endpoint) throw new Error("operator_deployment_endpoint_required");
      const operatorId = input.operatorId.trim();
      const operatorToken = operatorTokenSchema.parse(input.operatorToken);
      if (!operatorId) throw new Error("deployment_operator_id_required");
      await this.vault.setOperatorToken(profile.profileId, operatorToken, operatorId);
      await this.profiles.upsert(profile);
      if ((await this.profiles.getActiveProfileId()) === null) {
        await this.profiles.setActiveProfileId(profile.profileId);
      }
      if (this.lastErrorCode === "operator_local_server_not_ready") {
        this.lastErrorCode = null;
        this.lastErrorMessage = null;
      }
      await this.publishStatus();
    });
  }

  async removeProfile(input: unknown): Promise<OperatorControlStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      assertNoSmuggledOperatorSecrets(input, "removeOperatorProfile");
      const { profileId } = operatorProfileIdInputSchema.parse(input);
      await this.vault.clear(profileId);
      await this.profiles.remove(profileId);
      return this.publishStatus();
    });
  }

  async setActiveProfile(input: unknown): Promise<OperatorControlStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      assertNoSmuggledOperatorSecrets(input, "setActiveOperatorProfile");
      const { profileId } = operatorProfileIdInputSchema.parse(input);
      await this.profiles.setActiveProfileId(profileId);
      return this.publishStatus();
    });
  }

  /** Point Agent Host administration at the live Server origin; clear it when this Desktop is not that Server's operator. */
  async bindActiveProfileToLiveOrigin(serverBaseUrl: string): Promise<OperatorControlStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      const origin = new URL(serverBaseUrl).origin;
      const matches = await this.operatorProfilesForOrigin(origin);
      if (matches.length === 0) {
        const activeId = await this.profiles.getActiveProfileId();
        if (activeId) {
          const active = await this.profiles.get(activeId);
          let activeOrigin: string | null = null;
          try {
            activeOrigin = active ? new URL(active.serverBaseUrl).origin : null;
          } catch {
            activeOrigin = null;
          }
          if (activeOrigin !== origin) {
            await this.profiles.setActiveProfileId(null);
          }
        }
        return this.publishStatus();
      }
      const activeId = await this.profiles.getActiveProfileId();
      if (!matches.some((match) => match.profileId === activeId)) {
        await this.profiles.setActiveProfileId(matches[0].profileId);
      }
      this.lastErrorCode = null;
      this.lastErrorMessage = null;
      return this.publishStatus();
    });
  }

  async clearActiveProfile(): Promise<OperatorControlStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.profiles.setActiveProfileId(null);
      return this.publishStatus();
    });
  }

  async importCredential(input: unknown): Promise<OperatorControlStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      if (!input || typeof input !== "object") {
        throw new OperatorControlError({ kind: "validation", code: "operator_import_invalid" });
      }
      const raw = input as Record<string, unknown>;
      for (const key of [
        "encryptedOperatorToken",
        "authorization",
        "Authorization",
        "credentialPath",
        "credentialsPath",
        "headers",
        "url",
        "path",
        "command"
      ]) {
        if (key in raw && raw[key] !== undefined) {
          throw new OperatorControlError({
            kind: "validation",
            code: "operator_ipc_payload_forbidden",
            message: `Operator IPC rejected importCredential: field "${key}" is not allowed.`
          });
        }
      }
      const parsed = operatorCredentialMaterialInputSchema.parse(input);
      if (!(await this.profiles.get(parsed.profileId))) {
        throw new OperatorControlError({ kind: "validation", code: "operator_profile_not_found" });
      }
      await this.vault.setOperatorToken(parsed.profileId, parsed.operatorToken, parsed.operatorId);
      return this.publishStatus();
    });
  }

  async clearCredential(input: unknown): Promise<OperatorControlStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      assertNoSmuggledOperatorSecrets(input, "clearOperatorCredential");
      const { profileId } = operatorProfileIdInputSchema.parse(input);
      await this.vault.clear(profileId);
      return this.publishStatus();
    });
  }

  async listHosts(
    input: unknown
  ): Promise<Awaited<ReturnType<OperatorControlClient["listHosts"]>>> {
    assertNoSmuggledOperatorSecrets(input, "listHosts");
    const parsed = operatorListHostsInputSchema.parse(input);
    return this.enqueue(() =>
      this.withProfile(parsed, (client, value) => client.listHosts(value.query ?? {}))
    );
  }

  async listAgentEndpoints(
    input: unknown
  ): Promise<Awaited<ReturnType<OperatorControlClient["listAgentEndpoints"]>>> {
    assertNoSmuggledOperatorSecrets(input, "listAgentEndpoints");
    const parsed = operatorListAgentEndpointsInputSchema.parse(input);
    return this.enqueue(async () => {
      try {
        return await this.withProfile(parsed, (client) => client.listAgentEndpoints());
      } catch (error) {
        if (
          error instanceof OperatorControlError &&
          error.code === "operator_local_server_not_ready"
        ) {
          this.rememberError(error);
          await this.publishStatus();
        }
        throw error;
      }
    });
  }

  async createEnrollmentGrant(
    input: unknown
  ): Promise<Awaited<ReturnType<OperatorControlClient["createEnrollmentGrant"]>>> {
    assertNoSmuggledOperatorSecrets(input, "createEnrollmentGrant");
    const parsed = operatorCreateEnrollmentGrantInputSchema.parse(input);
    return this.enqueue(() =>
      this.withProfile(parsed, (client, value) => client.createEnrollmentGrant(value.request))
    );
  }

  async copyHostBootstrapHandoff(
    input: unknown,
    copyText: (content: string) => void
  ): Promise<ReturnType<typeof operatorHostBootstrapHandoffViewSchema.parse>> {
    assertNoSmuggledOperatorSecrets(input, "copyHostBootstrapHandoff");
    const parsed = operatorCopyHostBootstrapHandoffInputSchema.parse(input);
    return this.enqueue(() =>
      this.withProfile(parsed, async (client, value, connectionProfile) => {
        const grant = await client.createEnrollmentGrant(value.request);
        copyText(buildHostBootstrapHandoff(connectionProfile, value, grant));
        return operatorHostBootstrapHandoffViewSchema.parse({
          state: "ready",
          ...(grant.workspaceId ? { workspaceId: grant.workspaceId } : {}),
          expiresAt: grant.expiresAt,
          credentialExpiresAt: grant.credentialExpiresAt,
          credentialPolicy: grant.credentialPolicy,
          copiedAt: new Date().toISOString(),
          commandPreview: "planweave agent-host enroll <handoff>"
        });
      })
    );
  }

  async copyMemberSetupCode(
    input: unknown,
    copyText: (content: string) => void
  ): Promise<ReturnType<typeof operatorMemberSetupCodeHandoffViewSchema.parse>> {
    assertNoSmuggledOperatorSecrets(input, "copyMemberSetupCode");
    const parsed = operatorCopyMemberSetupCodeInputSchema.parse(input);
    return this.enqueue(() =>
      this.withProfile(parsed, async (client, _value, connectionProfile) => {
        const response = await client.issueMemberDeviceSetupCode();
        copyText(
          serializeCollaborationSetupHandoffV1({
            serverBaseUrl: connectionProfile.serverBaseUrl,
            setupCode: response.setupCode,
            allowInsecureTransport: connectionProfile.allowInsecureTransport
          })
        );
        return operatorMemberSetupCodeHandoffViewSchema.parse({
          state: "ready",
          workspaceId: response.grant.workspaceId,
          expiresAt: response.grant.expiresAt,
          copiedAt: nowIso(this.clock)
        });
      })
    );
  }

  /**
   * Main-only: issue a one-time device setup code for a Server this Desktop already administers.
   * The setup code never crosses the renderer boundary.
   */
  async issueDeviceSetupHandoffForOrigin(serverBaseUrl: string): Promise<{
    serverBaseUrl: string;
    allowInsecureTransport: boolean;
    setupCode: string;
    displayName: string;
  }> {
    return this.enqueue(async () => {
      this.assertOpen();
      const origin = new URL(serverBaseUrl).origin;
      const targetBaseUrl = `${origin}/`;
      const exact = await this.operatorProfilesForOrigin(origin);
      const rejectedExact = new Set<string>();
      for (const match of exact) {
        try {
          return await this.withProfile(
            { profileId: match.profileId },
            async (client, _value, profile) => {
              const response = await client.issueMemberDeviceSetupCode();
              return {
                serverBaseUrl: targetBaseUrl,
                allowInsecureTransport: profile.allowInsecureTransport,
                setupCode: response.setupCode,
                displayName: profile.displayName
              };
            }
          );
        } catch (error) {
          if (!isRejectedByTargetServer(error)) throw error;
          rejectedExact.add(match.profileId);
        }
      }
      if (new URL(targetBaseUrl).protocol !== "https:") {
        throw new OperatorControlError({
          kind: "unauthorized",
          code: "operator_credential_missing"
        });
      }
      const candidates = (await this.profiles.list())
        .filter((profile) => profile.profileId.startsWith("deployment-"))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      for (const profile of candidates) {
        if (rejectedExact.has(profile.profileId)) continue;
        if (!(await this.vault.getOperatorToken(profile.profileId))) continue;
        try {
          const handoff = await this.issueDeviceSetupHandoffAtOrigin({
            profileId: profile.profileId,
            displayName: profile.displayName,
            serverBaseUrl: targetBaseUrl
          });
          await this.retargetOperatorProfileOrigin(profile.profileId, targetBaseUrl);
          this.lastErrorCode = null;
          this.lastErrorMessage = null;
          return handoff;
        } catch (error) {
          if (isRejectedByTargetServer(error)) {
            this.rememberError(error);
            continue;
          }
          this.rememberError(error);
          throw error;
        }
      }
      if (rejectedExact.size > 0) {
        const local = await this.profiles.get(LOCAL_OPERATOR_PROFILE_ID);
        if (local && (await this.vault.getOperatorToken(local.profileId))) {
          try {
            const handoff = await this.issueDeviceSetupHandoffAtOrigin({
              profileId: local.profileId,
              displayName: local.displayName,
              serverBaseUrl: targetBaseUrl
            });
            this.lastErrorCode = null;
            this.lastErrorMessage = null;
            return handoff;
          } catch (error) {
            if (!isRejectedByTargetServer(error)) {
              this.rememberError(error);
              throw error;
            }
            this.rememberError(error);
          }
        }
      }
      const missing = new OperatorControlError({
        kind: "unauthorized",
        code: "operator_credential_missing"
      });
      this.rememberError(missing);
      throw missing;
    });
  }

  private async operatorProfilesForOrigin(
    origin: string
  ): Promise<Array<{ profileId: string; updatedAt: string; deployment: boolean }>> {
    const matches: Array<{ profileId: string; updatedAt: string; deployment: boolean }> = [];
    for (const profile of await this.profiles.list()) {
      try {
        if (new URL(profile.serverBaseUrl).origin !== origin) continue;
      } catch {
        continue;
      }
      if (!(await this.vault.getOperatorToken(profile.profileId))) continue;
      matches.push({
        profileId: profile.profileId,
        updatedAt: profile.updatedAt,
        deployment: profile.profileId.startsWith("deployment-")
      });
    }
    matches.sort((left, right) => {
      if (left.deployment !== right.deployment) return left.deployment ? -1 : 1;
      return right.updatedAt.localeCompare(left.updatedAt);
    });
    return matches;
  }

  private async issueDeviceSetupHandoffAtOrigin(input: {
    profileId: string;
    displayName: string;
    serverBaseUrl: string;
  }): Promise<{
    serverBaseUrl: string;
    allowInsecureTransport: boolean;
    setupCode: string;
    displayName: string;
  }> {
    const client = this.createClient({
      profile: operatorControlProfileSchema.parse({
        profileId: input.profileId,
        displayName: input.displayName,
        serverBaseUrl: input.serverBaseUrl,
        allowInsecureTransport: false
      }),
      credential: { getOperatorToken: () => this.vault.getOperatorToken(input.profileId) },
      request: this.request
    });
    try {
      const response = await client.issueMemberDeviceSetupCode();
      return {
        serverBaseUrl: input.serverBaseUrl,
        allowInsecureTransport: false,
        setupCode: response.setupCode,
        displayName: input.displayName
      };
    } finally {
      client.dispose();
    }
  }

  private async retargetOperatorProfileOrigin(
    profileId: string,
    serverBaseUrl: string
  ): Promise<void> {
    const profile = await this.profiles.get(profileId);
    if (!profile) return;
    if (new URL(profile.serverBaseUrl).origin === new URL(serverBaseUrl).origin) return;
    await this.profiles.upsert(
      operatorControlProfileSchema.parse({
        profileId: profile.profileId,
        displayName: profile.displayName,
        serverBaseUrl,
        allowInsecureTransport: profile.allowInsecureTransport,
        ...(profile.operatorId ? { operatorId: profile.operatorId } : {}),
        ...(profile.endpoint
          ? {
              endpoint: {
                ...profile.endpoint,
                serverOrigin: serverBaseUrl,
                allowedClientOrigins: [
                  ...new Set([serverBaseUrl, ...profile.endpoint.allowedClientOrigins])
                ]
              }
            }
          : {})
      })
    );
  }

  async revokeHost(
    input: unknown
  ): Promise<Awaited<ReturnType<OperatorControlClient["revokeHost"]>>> {
    assertNoSmuggledOperatorSecrets(input, "revokeHost");
    const parsed = operatorRevokeHostInputSchema.parse(input);
    return this.enqueue(() =>
      this.withProfile(parsed, (client, value) => client.revokeHost(value.hostId))
    );
  }

  async renewHostCredential(
    input: unknown
  ): Promise<Awaited<ReturnType<OperatorControlClient["requestHostCredentialRenewal"]>>> {
    assertNoSmuggledOperatorSecrets(input, "renewHostCredential");
    const parsed = operatorRenewHostCredentialInputSchema.parse(input);
    return this.enqueue(() =>
      this.withProfile(parsed, (client, value) => client.requestHostCredentialRenewal(value.hostId))
    );
  }

  async getLocalAgentHostStatus(input: unknown) {
    assertNoSmuggledOperatorSecrets(input, "getLocalAgentHostStatus");
    const parsed = operatorGetLocalAgentHostStatusInputSchema.parse(input);
    return this.enqueue(async () => {
      this.assertOpen();
      if (parsed.profileId && !(await this.profiles.get(parsed.profileId))) {
        throw new OperatorControlError({ kind: "validation", code: "operator_profile_not_found" });
      }
      return this.localAgentHost.status(parsed.profileId);
    });
  }

  async registerLocalAgentHost(input: unknown) {
    assertNoSmuggledOperatorSecrets(input, "registerLocalAgentHost");
    const parsed = operatorRegisterLocalAgentHostInputSchema.parse(input);
    return this.enqueue(() =>
      this.withProfile(parsed, async (client, value, connectionProfile) => {
        if (!(await this.localAgentHost.status(value.profileId)).supported) {
          throw new Error("local_agent_host_unavailable");
        }
        if (connectionProfile.endpoint?.tlsTrust === "configured_ca") {
          throw new Error("local_agent_host_custom_ca_unsupported");
        }
        const grant = await client.createEnrollmentGrant(value.request);
        const handoff = buildHostBootstrapHandoffPayload(connectionProfile, grant);
        try {
          return await this.localAgentHost.register(
            value.profileId,
            handoff,
            value.exposedProfileIds
          );
        } catch (error) {
          throw localAgentHostErrorFromUnknown(error);
        }
      })
    );
  }

  async repairLocalAgentHost(input: unknown) {
    assertNoSmuggledOperatorSecrets(input, "repairLocalAgentHost");
    const parsed = operatorRepairLocalAgentHostInputSchema.parse(input);
    return this.enqueue(async () => {
      try {
        this.assertOpen();
        return await this.localAgentHost.repair(parsed.profileId, parsed.exposedProfileIds);
      } catch (error) {
        const publicError = localAgentHostErrorFromUnknown(error);
        this.rememberError(publicError);
        throw publicError;
      }
    });
  }

  async enrollLocalAgentHost(input: unknown) {
    assertNoSmuggledOperatorSecrets(input, "enrollLocalAgentHost");
    const parsed = operatorEnrollLocalAgentHostInputSchema.parse(input);
    return this.enqueue(async () => {
      try {
        this.assertOpen();
        const enrollmentHandoff = parseAgentHostHandoffInput(parsed.handoff);
        if (!(await this.localAgentHost.status()).supported) {
          throw new Error("local_agent_host_unavailable");
        }
        if (enrollmentHandoff.handoff.endpoint.tlsTrust === "configured_ca") {
          throw new Error("local_agent_host_custom_ca_unsupported");
        }
        const result = await this.localAgentHost.register(
          undefined,
          enrollmentHandoff.encodedHandoff,
          parsed.exposedProfileIds
        );
        this.lastErrorCode = null;
        this.lastErrorMessage = null;
        return result;
      } catch (error) {
        const publicError = localAgentHostErrorFromUnknown(error);
        this.rememberError(publicError);
        throw publicError;
      }
    });
  }

  async dispatchOwnerFleetRemoteOperation(input: unknown) {
    assertNoSmuggledOperatorSecrets(input, "dispatchOwnerFleetRemoteOperation", {
      allowedRootFields: ["command"]
    });
    const parsed = operatorDispatchOwnerFleetRemoteOperationInputSchema.parse(input);
    return this.enqueue(() =>
      this.withProfile(parsed, (client, value) => client.dispatchRemoteOperation(value.command))
    );
  }

  async observeOwnerFleetRemoteOperation(input: unknown) {
    assertNoSmuggledOperatorSecrets(input, "observeOwnerFleetRemoteOperation");
    const parsed = operatorObserveOwnerFleetRemoteOperationInputSchema.parse(input);
    return this.enqueue(() =>
      this.withProfile(parsed, (client, value) => client.observeRemoteOperation(value.operationId))
    );
  }

  async replayOwnerFleetRemoteOperationEvents(input: unknown) {
    assertNoSmuggledOperatorSecrets(input, "replayOwnerFleetRemoteOperationEvents");
    const parsed = operatorReplayOwnerFleetRemoteOperationEventsInputSchema.parse(input);
    return this.enqueue(() =>
      this.withProfile(parsed, (client, value) =>
        client.replayRemoteOperationEvents(value.operationId, value.query.afterCursor)
      )
    );
  }

  async executeOwnerFleetRemoteOperationAction(input: unknown) {
    assertNoSmuggledOperatorSecrets(input, "executeOwnerFleetRemoteOperationAction");
    const parsed = operatorExecuteOwnerFleetRemoteOperationActionInputSchema.parse(input);
    return this.enqueue(() =>
      this.withProfile(parsed, (client, value) =>
        client.executeRemoteOperationAction(value.operationId, value.action)
      )
    );
  }

  private async withProfile<T, P extends { profileId: string }>(
    parsed: P,
    action: (
      client: OperatorControlClient,
      parsed: P,
      connectionProfile: OperatorControlProfile
    ) => Promise<T>
  ): Promise<T> {
    this.assertOpen();
    const profile = await this.profiles.get(parsed.profileId);
    if (!profile)
      throw new OperatorControlError({ kind: "validation", code: "operator_profile_not_found" });
    const token = await this.vault.getOperatorToken(parsed.profileId);
    if (!token)
      throw new OperatorControlError({ kind: "unauthorized", code: "operator_credential_missing" });
    const effective = await resolveEffectiveOperatorServerBaseUrl({
      profile: {
        profileId: profile.profileId,
        serverBaseUrl: profile.serverBaseUrl,
        allowInsecureTransport: profile.allowInsecureTransport
      },
      backend: this.resolveLocalOperatorBackend()
    });
    const client = this.createClient({
      profile: operatorControlProfileSchema.parse({
        profileId: profile.profileId,
        displayName: profile.displayName,
        serverBaseUrl: effective.serverBaseUrl,
        allowInsecureTransport: effective.allowInsecureTransport,
        ...(profile.endpoint &&
        new URL(profile.endpoint.serverOrigin).origin === new URL(effective.serverBaseUrl).origin
          ? { endpoint: profile.endpoint }
          : {}),
        ...(profile.operatorId ? { operatorId: profile.operatorId } : {})
      }),
      credential: { getOperatorToken: () => this.vault.getOperatorToken(parsed.profileId) },
      request: this.request
    });
    try {
      const result = await action(client, parsed, profile);
      this.lastErrorCode = null;
      this.lastErrorMessage = null;
      return result;
    } catch (error) {
      this.rememberError(error);
      throw error;
    } finally {
      client.dispose();
    }
  }

  async shutdown(): Promise<void> {
    await this.enqueue(async () => {
      this.vault.clearSessionMemory();
      this.disposed = true;
    });
  }
}
