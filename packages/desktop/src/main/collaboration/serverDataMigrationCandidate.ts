import { createHash } from "node:crypto";
import {
  collaborationServerOriginSchema,
  isLoopbackHostname,
  workspaceConnectionProfileSchema,
  type WorkspaceConnectionProfile,
  type WorkspacePickerPage
} from "@planweave-ai/collaboration-protocol/connection";
import type {
  CollaborationCredentialVault,
  StoredCredentialMetadata
} from "./collaborationCredentialVault.js";
import { CollaborationWorkspaceClient } from "./CollaborationWorkspaceClient.js";
import {
  collaborationEndpointForServerOrigin,
  isLocalCollaborationProfileId
} from "./collaborationProfileEndpoint.js";
import { CollaborationClientError } from "./collaborationErrors.js";
import {
  exportedIdentityCredentialProfileId,
  type ExportedServerDataIdentityStore
} from "./exportedServerDataIdentity.js";
import { findAuthorizedWorkspace } from "./workspacePickerReader.js";
import { isRejectedWorkspaceCredential } from "./workspaceCredentialLifecycle.js";
import type { StoredWorkspaceConnectionProfile } from "./workspaceConnectionProfileStore.js";

type ReadVault = Pick<
  CollaborationCredentialVault,
  "getDeviceToken" | "getIdentityToken" | "getMetadata" | "verifyPersistedCredential"
>;
type Candidate = { credentialProfileId: string; workspaceId: string; fromSnapshot: boolean };
export type VerifiedServerMigrationIdentity = {
  profile: WorkspaceConnectionProfile;
  authoritative: WorkspacePickerPage["items"][number];
  sourceCredentialProfileId: string;
  deviceToken: string;
  identityToken: string | null;
  metadata: StoredCredentialMetadata | null;
};

/** Validation owns no profile-writing or active-selection capability. */
export async function findServerMigrationIdentity(input: {
  serverBaseUrl: string;
  profiles: StoredWorkspaceConnectionProfile[];
  identityStore: Pick<ExportedServerDataIdentityStore, "read">;
  vault: ReadVault;
  request?: typeof fetch;
}): Promise<VerifiedServerMigrationIdentity | null> {
  const serverBaseUrl = collaborationServerOriginSchema.parse(input.serverBaseUrl);
  const origin = new URL(serverBaseUrl);
  const originProfiles = input.profiles
    .filter(
      (profile) =>
        !isLocalCollaborationProfileId(profile.profileId) &&
        new URL(profile.serverBaseUrl).origin === origin.origin
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const allowInsecureTransport =
    origin.protocol === "http:" &&
    (originProfiles[0]?.allowInsecureTransport ?? isLoopbackHostname(origin.hostname));
  collaborationEndpointForServerOrigin(serverBaseUrl, allowInsecureTransport);
  const localProfiles = input.profiles
    .filter((profile) => isLocalCollaborationProfileId(profile.profileId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  async function* candidates(): AsyncGenerator<Candidate> {
    for (const profile of [...originProfiles, ...localProfiles]) {
      yield {
        credentialProfileId: profile.profileId,
        workspaceId: profile.workspaceId,
        fromSnapshot: false
      };
    }
    const snapshot = await input.identityStore.read();
    if (snapshot)
      yield {
        credentialProfileId: exportedIdentityCredentialProfileId(snapshot),
        workspaceId: snapshot.workspaceId,
        fromSnapshot: true
      };
  }
  const request = input.request ?? fetch;
  for await (const candidate of candidates()) {
    const deviceToken = await input.vault.getDeviceToken(candidate.credentialProfileId);
    if (!deviceToken) {
      if (candidate.fromSnapshot)
        throw new CollaborationClientError({
          kind: "auth",
          code: "server_migration_credential_not_persisted",
          message: "The migration snapshot has no available credential.",
          retryable: false
        });
      continue;
    }
    const identityToken =
      (await input.vault.getIdentityToken(candidate.credentialProfileId)) ?? null;
    const existing =
      originProfiles.find((profile) => profile.profileId === candidate.credentialProfileId) ??
      originProfiles[0];
    const profileId =
      existing?.profileId ??
      `profile-${createHash("sha256").update(`${origin.origin}\0${candidate.workspaceId}`).digest("hex").slice(0, 24)}`;
    if (
      profileId !== candidate.credentialProfileId &&
      !(await input.vault.verifyPersistedCredential(candidate.credentialProfileId, {
        deviceToken,
        identityToken
      }))
    ) {
      throw new CollaborationClientError({
        kind: "auth",
        code: "server_migration_credential_not_persisted",
        message: "The migration identity is not available in persistent credential storage.",
        retryable: false
      });
    }
    const profile = workspaceConnectionProfileSchema.parse({
      schemaVersion: "workspace-identity/v1",
      profileId,
      displayName: "Server",
      serverBaseUrl,
      workspaceId: candidate.workspaceId,
      allowInsecureTransport
    });
    const client = new CollaborationWorkspaceClient({
      profile,
      credential: { getDeviceToken: () => deviceToken },
      request: (url, init) => request(url, { ...init, redirect: "error" })
    });
    let authoritative: WorkspacePickerPage["items"][number] | null;
    try {
      authoritative = await findAuthorizedWorkspace(candidate.workspaceId, (cursor) =>
        client.listWorkspaces({ cursor, limit: 100 })
      );
    } catch (error) {
      if (isRejectedWorkspaceCredential(error)) continue;
      throw error;
    } finally {
      client.dispose();
    }
    if (!authoritative) continue;
    return {
      profile: { ...profile, displayName: authoritative.displayName },
      authoritative,
      sourceCredentialProfileId: candidate.credentialProfileId,
      deviceToken,
      identityToken,
      metadata: await input.vault.getMetadata(candidate.credentialProfileId)
    };
  }
  return null;
}
