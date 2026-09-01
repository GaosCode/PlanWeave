import { humanPrincipalIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { CollaborationCredentialVault } from "./collaborationCredentialVault.js";
import type { CollaborationProfileStore } from "./collaborationProfileStore.js";

export type OperatorHumanIdentityCredential = {
  humanPrincipalId: string;
  identityToken: string;
};

export type OperatorHumanIdentityCredentialInput = {
  serverBaseUrl: string;
  humanPrincipalId?: string;
};

/** Resolve a Human credential by Server origin without consulting the active Workspace. */
export async function resolveOperatorHumanIdentityCredential(
  input: OperatorHumanIdentityCredentialInput & {
    profiles: Pick<CollaborationProfileStore, "list">;
    vault: Pick<CollaborationCredentialVault, "getMetadata" | "getIdentityToken">;
  }
): Promise<OperatorHumanIdentityCredential | null> {
  const origin = new URL(input.serverBaseUrl).origin;
  const expected = input.humanPrincipalId
    ? humanPrincipalIdSchema.parse(input.humanPrincipalId)
    : null;
  const matches: Array<OperatorHumanIdentityCredential & { updatedAt: string }> = [];
  for (const profile of await input.profiles.list()) {
    if (profile.connectionState !== "ready") continue;
    try {
      if (new URL(profile.serverBaseUrl).origin !== origin) continue;
    } catch {
      continue;
    }
    const [metadata, identityToken] = await Promise.all([
      input.vault.getMetadata(profile.profileId),
      input.vault.getIdentityToken(profile.profileId)
    ]);
    if (!metadata?.humanPrincipalId || !identityToken) continue;
    const humanPrincipalId = humanPrincipalIdSchema.parse(metadata.humanPrincipalId);
    if (expected && humanPrincipalId !== expected) continue;
    matches.push({ humanPrincipalId, identityToken, updatedAt: profile.updatedAt });
  }
  matches.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (expected) {
    const exact = matches[0];
    return exact
      ? { humanPrincipalId: exact.humanPrincipalId, identityToken: exact.identityToken }
      : null;
  }
  if (new Set(matches.map((match) => match.humanPrincipalId)).size !== 1) return null;
  const only = matches[0];
  return only
    ? { humanPrincipalId: only.humanPrincipalId, identityToken: only.identityToken }
    : null;
}
