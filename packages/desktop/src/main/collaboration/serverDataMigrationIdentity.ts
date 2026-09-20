import { randomUUID } from "node:crypto";
import type { ServerDataIdentitySnapshotResult } from "../../shared/serverDataMigration.js";
import type { CollaborationCredentialVault } from "./collaborationCredentialVault.js";
import {
  EXPORTED_SERVER_DATA_PROFILE_ID,
  type ExportedServerDataIdentityStore
} from "./exportedServerDataIdentity.js";
import type { StoredWorkspaceConnectionProfile } from "./workspaceConnectionProfileStore.js";

type SnapshotVault = Pick<
  CollaborationCredentialVault,
  | "getDeviceToken"
  | "getIdentityToken"
  | "getMetadata"
  | "persistenceFor"
  | "setDeviceToken"
  | "verifyPersistedCredential"
>;

/** Write a new vault record before publishing its locator; previous snapshots stay recoverable. */
export async function snapshotServerDataIdentity(input: {
  profiles: StoredWorkspaceConnectionProfile[];
  vault: SnapshotVault;
  identityStore: Pick<ExportedServerDataIdentityStore, "read" | "write">;
  now: () => string;
}): Promise<ServerDataIdentitySnapshotResult> {
  try {
    // An unreadable locator must not be silently replaced by a new snapshot.
    await input.identityStore.read();
    let sessionOnly = false;
    for (const profile of input.profiles) {
      const token = await input.vault.getDeviceToken(profile.profileId);
      if (!token) continue;
      if ((await input.vault.persistenceFor(profile.profileId)) !== "persisted") {
        sessionOnly = true;
        continue;
      }
      const metadata = await input.vault.getMetadata(profile.profileId);
      const identityToken = await input.vault.getIdentityToken(profile.profileId);
      if (
        !(await input.vault.verifyPersistedCredential(profile.profileId, {
          deviceToken: token,
          identityToken: identityToken ?? null
        }))
      ) {
        return { status: "unavailable", reason: "snapshot_failed" };
      }
      const credentialProfileId = `${EXPORTED_SERVER_DATA_PROFILE_ID}-${randomUUID()}`;
      const persistence = await input.vault.setDeviceToken(credentialProfileId, token, {
        deviceCredentialId: metadata?.deviceCredentialId ?? null,
        identityCredentialId: metadata?.identityCredentialId ?? null,
        humanPrincipalId: metadata?.humanPrincipalId ?? null,
        identityExpiresAt: metadata?.identityExpiresAt ?? null,
        identityToken: identityToken ?? null
      });
      if (persistence !== "persisted") {
        return { status: "unavailable", reason: "nonpersistent_credentials" };
      }
      if (
        !(await input.vault.verifyPersistedCredential(credentialProfileId, {
          deviceToken: token,
          identityToken: identityToken ?? null
        }))
      ) {
        return { status: "unavailable", reason: "snapshot_failed" };
      }
      await input.identityStore.write({
        schemaVersion: "exported-server-data-identity/v2",
        credentialProfileId,
        workspaceId: profile.workspaceId,
        workspaceDisplayName: profile.workspaceDisplayName,
        membershipRole: profile.membershipRole,
        updatedAt: input.now()
      });
      return { status: "saved" };
    }
    return {
      status: "unavailable",
      reason: sessionOnly ? "nonpersistent_credentials" : "missing_identity"
    };
  } catch {
    // A failed write may leave an unreferenced vault record; never remove the prior identity.
    return { status: "unavailable", reason: "snapshot_failed" };
  }
}
