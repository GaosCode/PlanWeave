import type { CollaborationCredentialVault } from "./collaborationCredentialVault.js";
import { CollaborationClientError } from "./collaborationErrors.js";
import type { VerifiedServerMigrationIdentity } from "./serverDataMigrationCandidate.js";
import type {
  WorkspaceConnectionProfileStore,
  StoredWorkspaceConnectionProfile
} from "./workspaceConnectionProfileStore.js";

type MigrationStore = Pick<
  WorkspaceConnectionProfileStore,
  "read" | "write" | "upsert" | "setLastConnection" | "setActiveProfileId"
>;
type MigrationVault = Pick<
  CollaborationCredentialVault,
  | "getDeviceToken"
  | "getIdentityToken"
  | "getMetadata"
  | "persistenceFor"
  | "setDeviceToken"
  | "verifyPersistedCredential"
  | "clear"
>;

/** Commit profile and credentials before active selection; compensate only this operation's writes. */
export async function persistServerMigrationIdentity(input: {
  verified: VerifiedServerMigrationIdentity;
  store: MigrationStore;
  vault: MigrationVault;
}): Promise<StoredWorkspaceConnectionProfile> {
  const { verified, store, vault } = input;
  const previousDocument = structuredClone(await store.read());
  const profileId = verified.profile.profileId;
  const copyCredential = profileId !== verified.sourceCredentialProfileId;
  const previousPersistence = copyCredential ? await vault.persistenceFor(profileId) : "missing";
  const previousToken = copyCredential ? await vault.getDeviceToken(profileId) : undefined;
  const previousIdentity = copyCredential ? await vault.getIdentityToken(profileId) : undefined;
  const previousMetadata = copyCredential ? await vault.getMetadata(profileId) : null;
  let credentialAttempted = false;
  try {
    const stored = await store.upsert({
      profile: verified.profile,
      workspaceDisplayName: verified.authoritative.displayName,
      membershipRole: verified.authoritative.role,
      membershipActive: true
    });
    if (copyCredential) {
      credentialAttempted = true;
      const persistence = await vault.setDeviceToken(profileId, verified.deviceToken, {
        deviceCredentialId: verified.metadata?.deviceCredentialId ?? null,
        humanPrincipalId: verified.metadata?.humanPrincipalId ?? null,
        identityCredentialId: verified.metadata?.identityCredentialId ?? null,
        identityExpiresAt: verified.metadata?.identityExpiresAt ?? null,
        identityToken: verified.identityToken
      });
      if (
        persistence !== "persisted" ||
        !(await vault.verifyPersistedCredential(profileId, verified))
      ) {
        throw new Error("Migration credential persistence failed.");
      }
    }
    await store.setLastConnection({ kind: "remote", profileId });
    await store.setActiveProfileId(profileId);
    return stored;
  } catch {
    let rollbackFailed = false;
    try {
      await store.write(previousDocument);
    } catch {
      rollbackFailed = true;
    }
    if (credentialAttempted) {
      try {
        if (previousToken) {
          const persistence = await vault.setDeviceToken(profileId, previousToken, {
            deviceCredentialId: previousMetadata?.deviceCredentialId ?? null,
            humanPrincipalId: previousMetadata?.humanPrincipalId ?? null,
            identityCredentialId: previousMetadata?.identityCredentialId ?? null,
            identityExpiresAt: previousMetadata?.identityExpiresAt ?? null,
            identityToken: previousIdentity ?? null
          });
          if (
            previousPersistence === "persisted" &&
            (persistence !== "persisted" ||
              !(await vault.verifyPersistedCredential(profileId, {
                deviceToken: previousToken,
                identityToken: previousIdentity ?? null
              })))
          ) {
            rollbackFailed = true;
          }
        } else await vault.clear(profileId);
      } catch {
        rollbackFailed = true;
      }
    }
    throw new CollaborationClientError({
      kind: "protocol",
      code: rollbackFailed
        ? "server_migration_rollback_failed"
        : "server_migration_persistence_failed",
      message: rollbackFailed
        ? "Could not save the migrated connection or fully restore its previous settings. Keep the original identity and inspect connection settings before retrying."
        : "Could not save the migrated connection. The previous connection was restored; the original identity is retained.",
      retryable: !rollbackFailed
    });
  }
}
