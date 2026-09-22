import { OperatorProfileSynchronization } from "./operatorProfileSynchronization.js";
import {
  OperatorLocalHostOperations,
  localAgentHostErrorFromUnknown
} from "./operatorLocalHostOperations.js";
import { OperatorAuthorizationMaintenance } from "./operatorAuthorizationMaintenance.js";
import {
  OperatorProfileOperations,
  type OperatorProfileOperation
} from "./operatorProfileOperations.js";
import { OperatorManagementService } from "./operatorManagementService.js";
import {
  operatorManagementInputSchema,
  operatorManagementRevokeInputSchema,
  operatorManagementRecoverInputSchema
} from "../../shared/operatorManagement.js";
import { serializeCollaborationSetupHandoffV1 } from "@planweave-ai/collaboration-protocol/handoff/setup";
import { operatorTokenSchema } from "@planweave-ai/agent-host-protocol";
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
  operatorObserveOwnerFleetRemoteOperationInputSchema,
  operatorReplayOwnerFleetRemoteOperationEventsInputSchema,
  operatorListRemoteAgentsInputSchema,
  operatorSetRemoteAgentAccessModeInputSchema,
  operatorGrantRemoteAgentWorkspaceInputSchema,
  operatorRevokeRemoteAgentGrantInputSchema,
  operatorRevokeRemoteAgentInputSchema,
  operatorRepairRemoteAgentOwnershipInputSchema,
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

export type OperatorHumanIdentityCredential = {
  humanPrincipalId: string;
  identityToken: string;
};

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
  resolveHumanIdentityCredential?: (input: {
    serverBaseUrl: string;
    humanPrincipalId?: string;
    recover?: boolean;
  }) => Promise<OperatorHumanIdentityCredential | null>;
};

function nowIso(clock?: { now(): Date }): string {
  return (clock?.now() ?? new Date()).toISOString();
}

function toPublicProfile(
  profile: OperatorControlProfile & { updatedAt: string },
  hostedByThisDesktop: boolean,
  credential: {
    hasOperatorCredential: boolean;
    operatorCredentialPersistence: OperatorCredentialPersistence;
    operatorId: string | null;
    humanPrincipalId: string | null;
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
    humanPrincipalId: credential.humanPrincipalId,
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
  private readonly resolveHumanIdentityCredential?: OperatorControlServiceOptions["resolveHumanIdentityCredential"];
  private readonly localHostOperation = Symbol("local-agent-host");
  private readonly operations = new OperatorProfileOperations();
  private readonly synchronization: OperatorProfileSynchronization;
  private readonly profileMutations = new Map<string, symbol>();
  private readonly localHostMutations = new OperatorLocalHostOperations(this.operations);
  private readonly management: OperatorManagementService;
  private readonly maintenance: OperatorAuthorizationMaintenance;
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
    this.synchronization = new OperatorProfileSynchronization(this.profiles, this.vault);
    this.createClient =
      options.createClient ?? ((clientOptions) => new OperatorControlClient(clientOptions));
    this.request = options.request;
    this.clock = options.clock;
    this.onStatusChange = options.onStatusChange;
    this.localAgentHost = options.localAgentHost ?? unavailableLocalAgentHostProvisioner();
    this.localOperatorBackend = options.localOperatorBackend;
    this.resolveHumanIdentityCredential = options.resolveHumanIdentityCredential;
    this.management = new OperatorManagementService({
      profiles: this.profiles,
      vault: this.vault,
      operations: this.operations,
      client: (profileId) => this.createProfileClient(profileId)
    });
    this.maintenance = new OperatorAuthorizationMaintenance({
      profiles: async () => (await this.profiles.list()).map((profile) => profile.profileId),
      check: async (profileId) => {
        if (!this.disposed && (await this.vault.getOperatorToken(profileId)))
          await this.management.check(profileId);
      },
      onError: (error) => this.rememberError(error)
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

  private changeProfile<T>(
    profileId: string,
    action: (operation: OperatorProfileOperation) => Promise<T>,
    unchanged?: () => Promise<boolean>
  ): Promise<T> {
    this.assertOpen();
    if (unchanged) {
      const mutation = this.profileMutations.get(profileId);
      return this.enqueue(async () => {
        this.assertOpen();
        if (this.profileMutations.get(profileId) !== mutation)
          throw new OperatorControlError({
            kind: "offline",
            code: "operator_operation_invalidated"
          });
        const current = this.operations.capture(profileId);
        try {
          const same = await unchanged();
          current.assertCurrent();
          if (!same) {
            current.release();
            this.management.forget(profileId);
            // The new generation queue must follow this action, not a cancellable race.
            return await this.operations.occupy(profileId, async (operation) => {
              const result = await action(operation);
              operation.assertCurrent();
              return result;
            });
          }
          // Local persistence must drain the action, not its cancellable caller promise.
          const result = await action(current);
          current.assertCurrent();
          return result;
        } finally {
          current.release();
        }
      });
    }
    this.invalidateProfile(profileId);
    return this.operations.run(profileId, (operation) =>
      this.enqueue(async () => {
        operation.assertCurrent();
        return action(operation);
      })
    );
  }

  private invalidateProfile(profileId: string): void {
    this.profileMutations.set(profileId, Symbol());
    this.management.forget(profileId);
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
      const humanIdentity = await this.resolveHumanIdentityCredential?.({
        serverBaseUrl: profile.serverBaseUrl,
        recover: false
      });
      views.push(
        toPublicProfile(profile, isLocalOwnedOperatorProfile(profile, localBackendSnapshot), {
          hasOperatorCredential: persistence !== "missing",
          operatorCredentialPersistence: persistence,
          operatorId: metadata?.operatorId ?? null,
          humanPrincipalId: humanIdentity?.humanPrincipalId ?? null
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

  startAuthorizationMaintenance(): void {
    this.maintenance.start();
  }

  getManagementAuthorization(input: unknown) {
    const { profileId } = operatorManagementInputSchema.parse(input);

    this.assertOpen();
    return this.management.check(profileId);
  }

  revokeManagementDevice(input: unknown) {
    const { profileId, deviceId } = operatorManagementRevokeInputSchema.parse(input);

    this.assertOpen();
    return this.management.revoke(profileId, deviceId);
  }

  reauthorizeManagement(input: unknown) {
    const { profileId } = operatorManagementInputSchema.parse(input);

    this.assertOpen();
    return this.management.reauthorize(profileId).then(async (result) => {
      this.lastErrorCode = null;
      this.lastErrorMessage = null;
      await this.publishStatus();
      return result;
    });
  }

  recoverManagement(input: unknown) {
    const parsed = operatorManagementRecoverInputSchema.safeParse(input);
    if (!parsed.success)
      throw new OperatorControlError({ kind: "validation", code: "operator_recovery_invalid" });

    this.assertOpen();
    return this.management
      .reauthorize(parsed.data.profileId, parsed.data.recoveryCode)
      .then(async (result) => {
        this.lastErrorCode = null;
        this.lastErrorMessage = null;
        await this.publishStatus();
        return result;
      });
  }

  async getStatus(): Promise<OperatorControlStatus> {
    this.assertOpen();
    await this.queue;
    return this.buildStatus();
  }

  async upsertProfile(input: unknown): Promise<OperatorControlStatus> {
    assertNoSmuggledOperatorSecrets(input, "upsertOperatorProfile");
    const profile = operatorControlProfileInputSchema.parse(input);
    return this.changeProfile(profile.profileId, async (operation) => {
      this.assertOpen();

      const existing = await this.profiles.get(profile.profileId);
      operation.assertCurrent();
      await this.profiles.upsert(
        {
          ...profile,
          ...(existing?.endpoint ? { endpoint: existing.endpoint } : {})
        },
        operation.assertCurrent
      );
      return this.publishStatus();
    });
  }

  /** Main-only provisioning for Desktop-generated self-host deployments. */
  async ensureDeploymentProfile(input: {
    profile: OperatorControlProfile;
    operatorId: string;
  }): Promise<string> {
    const profile = operatorControlProfileSchema.parse(input.profile);
    return this.changeProfile(
      profile.profileId,
      (operation) => this.synchronization.ensureDeployment(profile, input.operatorId, operation),
      async () =>
        (await this.synchronization.matches(profile)) &&
        !!(await this.vault.getOperatorToken(profile.profileId))
    );
  }

  /** Main-only registration for an already-running Desktop-owned server and its existing token. */
  async ensureMainOwnedServerProfile(input: {
    profile: OperatorControlProfile;
    operatorId: string;
    operatorToken: string;
  }): Promise<void> {
    const profile = operatorControlProfileSchema.parse(input.profile);
    return this.changeProfile(
      profile.profileId,
      async (operation) => {
        await this.synchronization.ensureMainOwned(
          profile,
          input.operatorId,
          input.operatorToken,
          operation
        );
        operation.assertCurrent();
        if (this.lastErrorCode === "operator_local_server_not_ready") {
          this.lastErrorCode = null;
          this.lastErrorMessage = null;
        }
        await this.publishStatus();
      },
      async () =>
        (await this.synchronization.matches(profile)) &&
        !!(await this.vault.getOperatorToken(profile.profileId)) &&
        (await this.vault.getMetadata(profile.profileId))?.operatorId === input.operatorId.trim()
    );
  }

  async removeProfile(input: unknown): Promise<OperatorControlStatus> {
    assertNoSmuggledOperatorSecrets(input, "removeOperatorProfile");
    const { profileId } = operatorProfileIdInputSchema.parse(input);
    return this.changeProfile(profileId, async (operation) => {
      this.assertOpen();

      await this.vault.clear(profileId, operation.assertCurrent);
      await this.profiles.remove(profileId, operation.assertCurrent);
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
    const validation = operatorCredentialMaterialInputSchema.safeParse(input);
    if (!validation.success)
      throw new OperatorControlError({ kind: "validation", code: "operator_import_invalid" });
    const parsed = validation.data;
    this.invalidateProfile(parsed.profileId);
    return this.operations.run(parsed.profileId, async (operation) => {
      await this.queue;
      operation.assertCurrent();
      const profile = await this.profiles.get(parsed.profileId);
      if (!profile) {
        throw new OperatorControlError({ kind: "validation", code: "operator_profile_not_found" });
      }
      if (parsed.verifyBeforeSave) {
        const effective = await resolveEffectiveOperatorServerBaseUrl({
          profile,
          backend: this.resolveLocalOperatorBackend()
        });
        const client = this.createClient({
          profile: operatorControlProfileSchema.parse({
            profileId: profile.profileId,
            displayName: profile.displayName,
            operatorId: profile.operatorId,
            ...effective,
            endpoint:
              profile.endpoint &&
              new URL(profile.endpoint.serverOrigin).origin ===
                new URL(effective.serverBaseUrl).origin
                ? profile.endpoint
                : undefined
          }),
          credential: { getOperatorToken: async () => parsed.operatorToken },
          request: this.request
        });
        operation.track(client);
        try {
          await client.listHosts({ limit: 1 });
        } finally {
          client.dispose();
        }
      }
      await this.enqueue(async () => {
        operation.assertCurrent();
        await this.vault.setManagementDevice(parsed.profileId, undefined, operation.assertCurrent);
        await this.vault.setOperatorToken(
          parsed.profileId,
          parsed.operatorToken,
          parsed.operatorId,
          operation.assertCurrent
        );
      });
      operation.assertCurrent();
      this.lastErrorCode = null;
      this.lastErrorMessage = null;
      return this.publishStatus();
    });
  }

  async clearCredential(input: unknown): Promise<OperatorControlStatus> {
    assertNoSmuggledOperatorSecrets(input, "clearOperatorCredential");
    const { profileId } = operatorProfileIdInputSchema.parse(input);
    return this.changeProfile(profileId, async (operation) => {
      this.assertOpen();

      await this.vault.clear(profileId, operation.assertCurrent);
      return this.publishStatus();
    });
  }

  async listHosts(
    input: unknown
  ): Promise<Awaited<ReturnType<OperatorControlClient["listHosts"]>>> {
    assertNoSmuggledOperatorSecrets(input, "listHosts");
    const parsed = operatorListHostsInputSchema.parse(input);
    return this.withProfile(parsed, (client, value) => client.listHosts(value.query ?? {}));
  }

  async listAgentEndpoints(
    input: unknown
  ): Promise<Awaited<ReturnType<OperatorControlClient["listAgentEndpoints"]>>> {
    assertNoSmuggledOperatorSecrets(input, "listAgentEndpoints");
    const parsed = operatorListAgentEndpointsInputSchema.parse(input);

    try {
      return await this.withProfile(parsed, (client, value) =>
        client.listAgentEndpoints({
          humanPrincipalId: value.humanPrincipalId,
          projectId: value.projectId,
          canvasId: value.canvasId,
          ...(value.workspaceId === undefined ? {} : { workspaceId: value.workspaceId })
        })
      );
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
  }

  async createEnrollmentGrant(
    input: unknown
  ): Promise<Awaited<ReturnType<OperatorControlClient["createEnrollmentGrant"]>>> {
    assertNoSmuggledOperatorSecrets(input, "createEnrollmentGrant");
    const parsed = operatorCreateEnrollmentGrantInputSchema.parse(input);
    return this.withProfile(parsed, (client, value) => client.createEnrollmentGrant(value.request));
  }

  async copyHostBootstrapHandoff(
    input: unknown,
    copyText: (content: string) => void
  ): Promise<ReturnType<typeof operatorHostBootstrapHandoffViewSchema.parse>> {
    assertNoSmuggledOperatorSecrets(input, "copyHostBootstrapHandoff");
    const parsed = operatorCopyHostBootstrapHandoffInputSchema.parse(input);
    return this.withProfile(parsed, async (client, value, connectionProfile, operation) => {
      const grant = await client.createEnrollmentGrant(value.request);
      operation.assertCurrent();
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
    });
  }

  async copyMemberSetupCode(
    input: unknown,
    copyText: (content: string) => void
  ): Promise<ReturnType<typeof operatorMemberSetupCodeHandoffViewSchema.parse>> {
    assertNoSmuggledOperatorSecrets(input, "copyMemberSetupCode");
    const parsed = operatorCopyMemberSetupCodeInputSchema.parse(input);
    return this.withProfile(parsed, async (client, _value, connectionProfile, operation) => {
      if (
        new URL(connectionProfile.serverBaseUrl).origin !== new URL(parsed.serverBaseUrl).origin
      ) {
        throw new OperatorControlError({
          kind: "validation",
          code: "operator_workspace_origin_mismatch"
        });
      }
      const response = await client.issueMemberDeviceSetupCode(parsed.workspaceId);
      if (response.grant.workspaceId !== parsed.workspaceId) {
        throw new OperatorControlError({
          kind: "protocol",
          code: "operator_setup_workspace_mismatch"
        });
      }
      operation.assertCurrent();
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

  async revokeHost(
    input: unknown
  ): Promise<Awaited<ReturnType<OperatorControlClient["revokeHost"]>>> {
    assertNoSmuggledOperatorSecrets(input, "revokeHost");
    const parsed = operatorRevokeHostInputSchema.parse(input);
    return this.withProfile(parsed, (client, value) => client.revokeHost(value.hostId));
  }

  async renewHostCredential(
    input: unknown
  ): Promise<Awaited<ReturnType<OperatorControlClient["requestHostCredentialRenewal"]>>> {
    assertNoSmuggledOperatorSecrets(input, "renewHostCredential");
    const parsed = operatorRenewHostCredentialInputSchema.parse(input);
    return this.withProfile(parsed, (client, value) =>
      client.requestHostCredentialRenewal(value.hostId)
    );
  }

  async getLocalAgentHostStatus(input: unknown) {
    assertNoSmuggledOperatorSecrets(input, "getLocalAgentHostStatus");
    const parsed = operatorGetLocalAgentHostStatusInputSchema.parse(input);

    this.assertOpen();
    if (parsed.profileId && !(await this.profiles.get(parsed.profileId))) {
      throw new OperatorControlError({ kind: "validation", code: "operator_profile_not_found" });
    }
    return this.localAgentHost.status(parsed.profileId);
  }

  async registerLocalAgentHost(input: unknown) {
    assertNoSmuggledOperatorSecrets(input, "registerLocalAgentHost");
    const parsed = operatorRegisterLocalAgentHostInputSchema.parse(input);
    return this.withProfile(parsed, async (client, value, connectionProfile, operation) => {
      if (!(await this.localAgentHost.status(value.profileId)).supported) {
        throw new Error("local_agent_host_unavailable");
      }
      if (connectionProfile.endpoint?.tlsTrust === "configured_ca") {
        throw new Error("local_agent_host_custom_ca_unsupported");
      }
      const grant = await client.createEnrollmentGrant(value.request);
      operation.assertCurrent();
      const handoff = buildHostBootstrapHandoffPayload(connectionProfile, grant);
      try {
        return await this.localHostMutations.run(operation, () =>
          this.localAgentHost.register(value.profileId, handoff, value.exposedProfileIds)
        );
      } catch (error) {
        throw localAgentHostErrorFromUnknown(error);
      }
    });
  }

  async repairLocalAgentHost(input: unknown) {
    assertNoSmuggledOperatorSecrets(input, "repairLocalAgentHost");
    const parsed = operatorRepairLocalAgentHostInputSchema.parse(input);

    this.assertOpen();
    return this.operations.run(parsed.profileId ?? this.localHostOperation, async (operation) => {
      try {
        this.assertOpen();
        return await this.localHostMutations.run(operation, () =>
          this.localAgentHost.repair(parsed.profileId, parsed.exposedProfileIds)
        );
      } catch (error) {
        const publicError = localAgentHostErrorFromUnknown(error);
        if (operation.isCurrent()) this.rememberError(publicError);
        throw publicError;
      }
    });
  }

  async enrollLocalAgentHost(input: unknown) {
    assertNoSmuggledOperatorSecrets(input, "enrollLocalAgentHost");
    const parsed = operatorEnrollLocalAgentHostInputSchema.parse(input);

    this.assertOpen();
    return this.operations.run(this.localHostOperation, async (operation) => {
      try {
        this.assertOpen();
        const enrollmentHandoff = parseAgentHostHandoffInput(parsed.handoff);
        if (!(await this.localAgentHost.status()).supported) {
          throw new Error("local_agent_host_unavailable");
        }
        if (enrollmentHandoff.handoff.endpoint.tlsTrust === "configured_ca") {
          throw new Error("local_agent_host_custom_ca_unsupported");
        }
        const result = await this.localHostMutations.run(operation, () =>
          this.localAgentHost.register(
            undefined,
            enrollmentHandoff.encodedHandoff,
            parsed.exposedProfileIds
          )
        );
        operation.assertCurrent();
        this.lastErrorCode = null;
        this.lastErrorMessage = null;
        return result;
      } catch (error) {
        const publicError = localAgentHostErrorFromUnknown(error);
        if (operation.isCurrent()) this.rememberError(publicError);
        throw publicError;
      }
    });
  }

  async observeOwnerFleetRemoteOperation(input: unknown) {
    assertNoSmuggledOperatorSecrets(input, "observeOwnerFleetRemoteOperation");
    const parsed = operatorObserveOwnerFleetRemoteOperationInputSchema.parse(input);
    return this.withProfile(parsed, async (client, value) =>
      client.observeRemoteOperation(
        value.operationId,
        await this.requireProfileHumanPrincipalId(client)
      )
    );
  }

  async replayOwnerFleetRemoteOperationEvents(input: unknown) {
    assertNoSmuggledOperatorSecrets(input, "replayOwnerFleetRemoteOperationEvents");
    const parsed = operatorReplayOwnerFleetRemoteOperationEventsInputSchema.parse(input);
    return this.withProfile(parsed, async (client, value) =>
      client.replayRemoteOperationEvents(
        value.operationId,
        value.query.afterCursor,
        await this.requireProfileHumanPrincipalId(client)
      )
    );
  }

  async listRemoteAgents(input: unknown) {
    assertNoSmuggledOperatorSecrets(input, "listRemoteAgents");
    const parsed = operatorListRemoteAgentsInputSchema.parse(input);
    return this.withProfile(parsed, (client, value) =>
      client.listRemoteAgents({ humanPrincipalId: value.humanPrincipalId })
    );
  }

  async setRemoteAgentAccessMode(input: unknown) {
    assertNoSmuggledOperatorSecrets(input, "setRemoteAgentAccessMode");
    const parsed = operatorSetRemoteAgentAccessModeInputSchema.parse(input);
    return this.withProfile(parsed, (client, value) =>
      client.setRemoteAgentAccessMode({
        humanPrincipalId: value.humanPrincipalId,
        endpointId: value.endpointId,
        accessMode: value.accessMode,
        ...(value.allowOwnerCanvas === undefined
          ? {}
          : { allowOwnerCanvas: value.allowOwnerCanvas }),
        ...(value.expectedPolicyRevision === undefined
          ? {}
          : { expectedPolicyRevision: value.expectedPolicyRevision })
      })
    );
  }

  async grantRemoteAgentWorkspace(input: unknown) {
    assertNoSmuggledOperatorSecrets(input, "grantRemoteAgentWorkspace");
    const parsed = operatorGrantRemoteAgentWorkspaceInputSchema.parse(input);
    return this.withProfile(parsed, (client, value) =>
      client.grantRemoteAgentWorkspace({
        humanPrincipalId: value.humanPrincipalId,
        endpointId: value.endpointId,
        workspaceId: value.workspaceId,
        ...(value.expectedGrantRevision === undefined
          ? {}
          : { expectedGrantRevision: value.expectedGrantRevision })
      })
    );
  }

  async revokeRemoteAgentGrant(input: unknown) {
    assertNoSmuggledOperatorSecrets(input, "revokeRemoteAgentGrant");
    const parsed = operatorRevokeRemoteAgentGrantInputSchema.parse(input);
    return this.withProfile(parsed, (client, value) =>
      client.revokeRemoteAgentGrant({
        humanPrincipalId: value.humanPrincipalId,
        endpointId: value.endpointId,
        workspaceId: value.workspaceId
      })
    );
  }

  async revokeRemoteAgent(input: unknown) {
    assertNoSmuggledOperatorSecrets(input, "revokeRemoteAgent");
    const parsed = operatorRevokeRemoteAgentInputSchema.parse(input);
    return this.withProfile(parsed, (client, value) =>
      client.revokeRemoteAgent({
        humanPrincipalId: value.humanPrincipalId,
        endpointId: value.endpointId
      })
    );
  }

  async repairRemoteAgentOwnership(input: unknown) {
    assertNoSmuggledOperatorSecrets(input, "repairRemoteAgentOwnership");
    const parsed = operatorRepairRemoteAgentOwnershipInputSchema.parse(input);
    return this.withProfile(parsed, (client, value) =>
      client.repairRemoteAgentOwnership({
        endpointId: value.endpointId,
        ownerHumanPrincipalId: value.ownerHumanPrincipalId
      })
    );
  }

  /** Main-process execution seam; credentials never leave the profile-scoped client callback. */
  async withExecutionProfile<T>(
    profileId: string,
    action: (client: OperatorControlClient) => Promise<T>
  ): Promise<T> {
    const parsed = operatorProfileIdInputSchema.parse({ profileId });
    return this.withProfile(parsed, (client) => action(client));
  }

  private async withProfile<T, P extends { profileId: string }>(
    parsed: P,
    action: (
      client: OperatorControlClient,
      parsed: P,
      connectionProfile: OperatorControlProfile,
      operation: OperatorProfileOperation
    ) => Promise<T>
  ): Promise<T> {
    this.assertOpen();
    return this.operations.run(parsed.profileId, async (operation) => {
      await this.queue;
      operation.assertCurrent();
      const profile = await this.profiles.get(parsed.profileId);
      if (!profile)
        throw new OperatorControlError({ kind: "validation", code: "operator_profile_not_found" });
      const token = await this.vault.getOperatorToken(parsed.profileId);
      if (!token)
        throw new OperatorControlError({
          kind: "unauthorized",
          code: "operator_credential_missing"
        });
      await this.management.ensureAccess(parsed.profileId, operation);
      operation.assertCurrent();
      const { client } = await this.createProfileClient(parsed.profileId);
      operation.track(client);
      try {
        const result = await action(client, parsed, profile, operation);
        operation.assertCurrent();
        this.lastErrorCode = null;
        this.lastErrorMessage = null;
        return result;
      } catch (error) {
        if (operation.isCurrent()) this.rememberError(error);
        throw error;
      } finally {
        client.dispose();
      }
    });
  }

  private async createProfileClient(profileId: string) {
    await this.queue;
    this.assertOpen();
    const profile = await this.profiles.get(profileId);
    if (!profile)
      throw new OperatorControlError({ kind: "validation", code: "operator_profile_not_found" });
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
      credential: {
        getOperatorToken: () => this.vault.getOperatorToken(profileId),
        getHumanIdentityToken: async (humanPrincipalId) =>
          (
            await this.resolveHumanIdentityCredential?.({
              serverBaseUrl: effective.serverBaseUrl,
              humanPrincipalId
            })
          )?.identityToken
      },
      request: this.request
    });
    return { client, profile };
  }

  private async requireProfileHumanPrincipalId(client: OperatorControlClient): Promise<string> {
    const identity = await this.resolveHumanIdentityCredential?.({
      serverBaseUrl: client.connectionProfile.serverBaseUrl
    });
    if (!identity) {
      throw new OperatorControlError({
        kind: "unauthorized",
        code: "operator_human_identity_credential_missing"
      });
    }
    return identity.humanPrincipalId;
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    this.maintenance.stop();
    this.operations.shutdown();
    await this.queue;
    await this.vault.clearSessionMemory();
  }
}
