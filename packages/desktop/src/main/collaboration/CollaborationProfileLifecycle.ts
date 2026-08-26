import {
  humanBootstrapRequestSchema,
  humanConsumeInvitationRequestSchema,
  type HumanBootstrapRequest,
  type HumanBootstrapResponse,
  type HumanConsumeInvitationRequest,
  type HumanConsumeInvitationResponse
} from "@planweave-ai/collaboration-protocol/identity/workspace";
import {
  assertNoSmuggledCollaborationSecrets,
  COLLABORATION_SESSION_ONLY_WARNING,
  collaborationBootstrapInputSchema,
  collaborationConsumeInvitationInputSchema,
  collaborationImportDeviceCredentialInputSchema,
  collaborationProfileIdInputSchema,
  collaborationUpsertProfileInputSchema,
  type CollaborationAuthHandoffView,
  type CollaborationSessionPhase,
  type CollaborationStatus
} from "../../shared/collaboration.js";
import type { CollaborationClient } from "./CollaborationClient.js";
import type { CollaborationCredentialVault } from "./collaborationCredentialVault.js";
import {
  CollaborationClientError,
  collaborationConnectionErrorFromUnknown
} from "./collaborationErrors.js";
import { CollaborationIdentityCredentialClient } from "./collaborationIdentityCredentialClient.js";
import type { CollaborationInvitationVault } from "./collaborationInvitationVault.js";
import type { CollaborationProfileStore } from "./collaborationProfileStore.js";

type CollaborationProfileLifecycleDependencies = {
  profiles: CollaborationProfileStore;
  vault: CollaborationCredentialVault;
  invitationVault: CollaborationInvitationVault;
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  assertOpen(): void;
  getClientProfileId(): string | null;
  getSessionPhase(): CollaborationSessionPhase;
  setSession(
    phase: CollaborationSessionPhase,
    detail?: string | null,
    error?: { code: string; message: string } | null
  ): void;
  disposeClient(reason: string): Promise<void>;
  clearRememberedObserverCursor(profileId?: string | null): void;
  publishStatus(): Promise<CollaborationStatus>;
  clientForProfile(profileId: string, requireCredential: boolean): Promise<CollaborationClient>;
  activateWorkspaceAuthority(input: {
    profileId: string;
    workspaceId: string;
    membershipRole: "owner" | "member";
  }): Promise<void>;
};

function stripAuthHandoff(
  response: HumanBootstrapResponse | HumanConsumeInvitationResponse,
  persistence: CollaborationAuthHandoffView["deviceCredentialPersistence"],
  nonPersistenceWarning: string | null
): CollaborationAuthHandoffView {
  const base: CollaborationAuthHandoffView = {
    workspaceId: response.workspaceId,
    principal: response.principal,
    membership: response.membership,
    device: response.device,
    deviceCredentialPersistence: persistence,
    nonPersistenceWarning
  };
  if ("created" in response) base.created = response.created;
  if ("principalCreated" in response) base.principalCreated = response.principalCreated;
  if ("invitation" in response) base.invitation = response.invitation;
  return base;
}

/** Owns profile, credential, and authentication-handoff lifecycle operations. */
export class CollaborationProfileLifecycle {
  constructor(private readonly dependencies: CollaborationProfileLifecycleDependencies) {}

  async upsertProfile(input: unknown): Promise<CollaborationStatus> {
    return this.dependencies.enqueue(async () => {
      this.dependencies.assertOpen();
      assertNoSmuggledCollaborationSecrets(input, "upsertCollaborationProfile");
      const profile = collaborationUpsertProfileInputSchema.parse(input);
      const existing = await this.dependencies.profiles.get(profile.profileId);
      const connectionIdentityChanged =
        !existing ||
        existing.serverBaseUrl !== profile.serverBaseUrl ||
        existing.projectId !== profile.projectId ||
        existing.allowInsecureTransport !== profile.allowInsecureTransport ||
        JSON.stringify(existing.endpoint) !== JSON.stringify(profile.endpoint);
      await this.dependencies.profiles.upsert(profile);
      if (
        this.dependencies.getClientProfileId() === profile.profileId &&
        connectionIdentityChanged
      ) {
        await this.dependencies.disposeClient("profile_updated");
      }
      if (
        existing &&
        (existing.serverBaseUrl !== profile.serverBaseUrl ||
          existing.projectId !== profile.projectId)
      ) {
        this.dependencies.clearRememberedObserverCursor(profile.profileId);
      }
      return this.dependencies.publishStatus();
    });
  }

  async removeProfile(input: unknown): Promise<CollaborationStatus> {
    return this.dependencies.enqueue(async () => {
      this.dependencies.assertOpen();
      assertNoSmuggledCollaborationSecrets(input, "removeCollaborationProfile");
      const { profileId } = collaborationProfileIdInputSchema.parse(input);
      if (this.dependencies.getClientProfileId() === profileId) {
        await this.dependencies.disposeClient("profile_removed");
      } else {
        this.dependencies.clearRememberedObserverCursor(profileId);
      }
      await this.dependencies.vault.clear(profileId);
      await this.dependencies.invitationVault.clearProfile(profileId);
      await this.dependencies.profiles.remove(profileId);
      return this.dependencies.publishStatus();
    });
  }

  async setActiveProfile(input: unknown): Promise<CollaborationStatus> {
    return this.dependencies.enqueue(async () => {
      this.dependencies.assertOpen();
      assertNoSmuggledCollaborationSecrets(input, "setActiveCollaborationProfile");
      const { profileId } = collaborationProfileIdInputSchema.parse(input);
      const profile = await this.dependencies.profiles.get(profileId);
      if (!profile) throw new Error(`Unknown collaboration profile: ${profileId}`);
      const clientProfileId = this.dependencies.getClientProfileId();
      if (clientProfileId && clientProfileId !== profileId) {
        await this.dependencies.disposeClient("project_switch");
      }
      await this.dependencies.profiles.setActiveProfileId(profileId);
      this.dependencies.setSession(
        this.dependencies.getClientProfileId() === profileId
          ? this.dependencies.getSessionPhase()
          : "idle",
        null,
        null
      );
      return this.dependencies.publishStatus();
    });
  }

  async clearActiveProfile(): Promise<CollaborationStatus> {
    return this.dependencies.enqueue(async () => {
      this.dependencies.assertOpen();
      await this.dependencies.disposeClient("active_cleared");
      await this.dependencies.profiles.setActiveProfileId(null);
      this.dependencies.setSession("idle", null, null);
      return this.dependencies.publishStatus();
    });
  }

  async importDeviceCredential(input: unknown): Promise<CollaborationStatus> {
    return this.dependencies.enqueue(async () => {
      this.dependencies.assertOpen();
      if (!input || typeof input !== "object") {
        throw new Error("importDeviceCredential requires an object payload.");
      }
      const record = input as Record<string, unknown>;
      for (const key of [
        "encryptedDeviceToken",
        "authorization",
        "Authorization",
        "credentialPath",
        "credentialsPath",
        "existingDeviceToken",
        "existingIdentityToken",
        "identityToken"
      ] as const) {
        if (key in record && record[key] !== undefined) {
          throw new Error(
            `Collaboration IPC rejected importDeviceCredential: field "${key}" is not allowed.`
          );
        }
      }
      const parsed = collaborationImportDeviceCredentialInputSchema.parse(input);
      const profile = await this.dependencies.profiles.get(parsed.profileId);
      if (!profile) throw new Error(`Unknown collaboration profile: ${parsed.profileId}`);
      await this.dependencies.vault.setDeviceToken(parsed.profileId, parsed.deviceToken, {
        deviceCredentialId: parsed.deviceCredentialId ?? null,
        humanPrincipalId: parsed.humanPrincipalId ?? null
      });
      if (this.dependencies.getClientProfileId() === parsed.profileId) {
        await this.dependencies.disposeClient("credential_imported");
      }
      return this.dependencies.publishStatus();
    });
  }

  async clearDeviceCredential(input: unknown): Promise<CollaborationStatus> {
    return this.dependencies.enqueue(async () => {
      this.dependencies.assertOpen();
      assertNoSmuggledCollaborationSecrets(input, "clearDeviceCredential");
      const { profileId } = collaborationProfileIdInputSchema.parse(input);
      if (this.dependencies.getClientProfileId() === profileId) {
        await this.dependencies.disposeClient("logout");
      } else {
        this.dependencies.clearRememberedObserverCursor(profileId);
      }
      const [profile, identityToken, metadata] = await Promise.all([
        this.dependencies.profiles.get(profileId),
        this.dependencies.vault.getIdentityToken(profileId),
        this.dependencies.vault.getMetadata(profileId)
      ]);
      if (profile && identityToken) {
        try {
          await new CollaborationIdentityCredentialClient({
            origin: {
              serverBaseUrl: profile.serverBaseUrl,
              allowInsecureTransport: profile.allowInsecureTransport
            }
          }).revoke(identityToken, "device_credential_cleared");
        } catch (error) {
          if (!(error instanceof CollaborationClientError)) throw error;
        }
        const copies = await this.dependencies.vault.findProfilesSharingIdentity({
          identityCredentialId: metadata?.identityCredentialId ?? null,
          identityToken,
          excludeProfileId: profileId
        });
        for (const copyProfileId of copies) {
          await this.dependencies.vault.clearIdentityCredential(copyProfileId);
        }
      }
      await this.dependencies.vault.clear(profileId);
      return this.dependencies.publishStatus();
    });
  }

  async bootstrapOwner(input: unknown): Promise<CollaborationAuthHandoffView> {
    return this.dependencies.enqueue(async () => {
      this.dependencies.assertOpen();
      assertNoSmuggledCollaborationSecrets(
        input && typeof input === "object" ? { ...(input as object), request: undefined } : input,
        "bootstrapCollaborationOwner"
      );
      if (input && typeof input === "object" && "request" in input) {
        assertNoSmuggledCollaborationSecrets(
          (input as { request: unknown }).request,
          "bootstrapCollaborationOwner.request"
        );
      }
      const parsed = collaborationBootstrapInputSchema.parse(input);
      const request: HumanBootstrapRequest = humanBootstrapRequestSchema.parse(parsed.request);
      const client = await this.dependencies.clientForProfile(parsed.profileId, false);
      try {
        this.dependencies.setSession("connecting", "bootstrap");
        const response = await client.bootstrapOwner(request);
        let persistence: CollaborationAuthHandoffView["deviceCredentialPersistence"] = "missing";
        if (response.deviceToken) {
          persistence = await this.dependencies.vault.setDeviceToken(
            parsed.profileId,
            response.deviceToken,
            {
              deviceCredentialId: response.device.deviceCredentialId,
              humanPrincipalId: response.principal.humanPrincipalId
            }
          );
        }
        await this.dependencies.profiles.setActiveProfileId(parsed.profileId);
        await this.dependencies.activateWorkspaceAuthority({
          profileId: parsed.profileId,
          workspaceId: response.workspaceId,
          membershipRole: "owner"
        });
        this.dependencies.setSession("ready", "bootstrap_complete", null);
        await this.dependencies.publishStatus();
        return stripAuthHandoff(
          response,
          persistence,
          persistence === "session-only" ? COLLABORATION_SESSION_ONLY_WARNING : null
        );
      } catch (error) {
        const mapped = collaborationConnectionErrorFromUnknown(
          error,
          client.connectionProfile.endpoint.topology
        );
        this.dependencies.setSession("error", "bootstrap_failed", {
          code: mapped.code,
          message: mapped.message
        });
        await this.dependencies.publishStatus();
        throw mapped;
      } finally {
        client.dispose();
      }
    });
  }

  async activeHumanPrincipalId(profileId: string): Promise<string | null> {
    const metadata = await this.dependencies.vault.getMetadata(profileId);
    return metadata?.humanPrincipalId ?? null;
  }

  async migrateLocalProfileCredential(
    sourceProfileId: string,
    targetProfileId: string
  ): Promise<void> {
    return this.dependencies.enqueue(async () => {
      this.dependencies.assertOpen();
      if (sourceProfileId === targetProfileId) return;
      const [sourceProfile, targetProfile, targetToken] = await Promise.all([
        this.dependencies.profiles.get(sourceProfileId),
        this.dependencies.profiles.get(targetProfileId),
        this.dependencies.vault.getDeviceToken(targetProfileId)
      ]);
      if (!sourceProfile || !targetProfile || sourceProfile.projectId !== targetProfile.projectId) {
        return;
      }
      if (targetToken) return;
      const [sourceToken, sourceMetadata] = await Promise.all([
        this.dependencies.vault.getDeviceToken(sourceProfileId),
        this.dependencies.vault.getMetadata(sourceProfileId)
      ]);
      if (!sourceToken) return;
      await this.dependencies.vault.setDeviceToken(
        targetProfileId,
        sourceToken,
        sourceMetadata ?? undefined
      );
    });
  }

  async consumeInvitation(input: unknown): Promise<CollaborationAuthHandoffView> {
    return this.dependencies.enqueue(async () => {
      this.dependencies.assertOpen();
      if (!input || typeof input !== "object") {
        throw new Error("consumeCollaborationInvitation requires an object payload.");
      }
      const outer = input as Record<string, unknown>;
      if ("existingDeviceToken" in outer && outer.existingDeviceToken !== undefined) {
        throw new Error(
          'Collaboration IPC rejected consumeCollaborationInvitation: field "existingDeviceToken" is not allowed across the renderer boundary.'
        );
      }
      if ("existingIdentityToken" in outer && outer.existingIdentityToken !== undefined) {
        throw new Error(
          'Collaboration IPC rejected consumeCollaborationInvitation: field "existingIdentityToken" is not allowed across the renderer boundary.'
        );
      }
      assertNoSmuggledCollaborationSecrets(
        { profileId: outer.profileId },
        "consumeCollaborationInvitation"
      );
      if (outer.request && typeof outer.request === "object") {
        assertNoSmuggledCollaborationSecrets(
          outer.request,
          "consumeCollaborationInvitation.request"
        );
      }
      const parsed = collaborationConsumeInvitationInputSchema.parse(input);
      const existing = await this.dependencies.vault.getDeviceToken(parsed.profileId);
      const request: HumanConsumeInvitationRequest = humanConsumeInvitationRequestSchema.parse({
        ...parsed.request,
        ...(existing ? { existingDeviceToken: existing } : {})
      });
      const client = await this.dependencies.clientForProfile(parsed.profileId, false);
      try {
        this.dependencies.setSession("connecting", "consume_invitation");
        const response = await client.consumeInvitation(request);
        const persistence = await this.dependencies.vault.setDeviceToken(
          parsed.profileId,
          response.deviceToken,
          {
            deviceCredentialId: response.device.deviceCredentialId,
            humanPrincipalId: response.principal.humanPrincipalId
          }
        );
        await this.dependencies.profiles.setActiveProfileId(parsed.profileId);
        await this.dependencies.activateWorkspaceAuthority({
          profileId: parsed.profileId,
          workspaceId: response.workspaceId,
          membershipRole: "member"
        });
        this.dependencies.setSession("ready", "consume_invitation_complete", null);
        await this.dependencies.publishStatus();
        return stripAuthHandoff(
          response,
          persistence,
          persistence === "session-only" ? COLLABORATION_SESSION_ONLY_WARNING : null
        );
      } catch (error) {
        const mapped = collaborationConnectionErrorFromUnknown(
          error,
          client.connectionProfile.endpoint.topology
        );
        this.dependencies.setSession("error", "consume_invitation_failed", {
          code: mapped.code,
          message: mapped.message
        });
        await this.dependencies.publishStatus();
        throw mapped;
      } finally {
        client.dispose();
      }
    });
  }
}
