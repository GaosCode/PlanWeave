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
  /** When false, skip Server recover and return a vault lookup only. */
  recover?: boolean;
};

type HumanIdentityMatch = OperatorHumanIdentityCredential & {
  profileId: string;
  updatedAt: string;
};

function toCredential(match: HumanIdentityMatch): OperatorHumanIdentityCredential {
  return {
    humanPrincipalId: match.humanPrincipalId,
    identityToken: match.identityToken
  };
}

/**
 * Resolve a Human credential by Server origin.
 * When several Humans have credentials on that origin, use the currently
 * signed-in collaboration profile instead of failing closed.
 */
export async function resolveOperatorHumanIdentityCredential(
  input: OperatorHumanIdentityCredentialInput & {
    profiles: Pick<CollaborationProfileStore, "list" | "getActiveProfileId">;
    vault: Pick<CollaborationCredentialVault, "getMetadata" | "getIdentityToken">;
  }
): Promise<OperatorHumanIdentityCredential | null> {
  const origin = new URL(input.serverBaseUrl).origin;
  const expected = input.humanPrincipalId
    ? humanPrincipalIdSchema.parse(input.humanPrincipalId)
    : null;
  const matches: HumanIdentityMatch[] = [];
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
    matches.push({
      profileId: profile.profileId,
      humanPrincipalId,
      identityToken,
      updatedAt: profile.updatedAt
    });
  }
  matches.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (expected) {
    const exact = matches[0];
    return exact ? toCredential(exact) : null;
  }
  const activeProfileId = await input.profiles.getActiveProfileId();
  const activeMatch = activeProfileId
    ? matches.find((match) => match.profileId === activeProfileId)
    : undefined;
  if (activeMatch) return toCredential(activeMatch);
  if (new Set(matches.map((match) => match.humanPrincipalId)).size !== 1) return null;
  const only = matches[0];
  return only ? toCredential(only) : null;
}

type RecoveredHumanIdentity = {
  humanPrincipalId: string;
  identityToken: string;
  identityCredentialId: string;
  identityExpiresAt: string;
};

export async function recoverActiveOperatorHumanIdentity(input: {
  serverBaseUrl: string;
  profiles: Pick<CollaborationProfileStore, "list" | "getActiveProfileId">;
  vault: Pick<CollaborationCredentialVault, "getDeviceToken" | "setDeviceToken">;
  recover: (deviceToken: string) => Promise<RecoveredHumanIdentity>;
}): Promise<OperatorHumanIdentityCredential | null> {
  const origin = new URL(input.serverBaseUrl).origin;
  const activeProfileId = await input.profiles.getActiveProfileId();
  const candidates: Array<{ profileId: string; deviceToken: string; updatedAt: string }> = [];
  for (const profile of await input.profiles.list()) {
    if (profile.connectionState !== "ready") continue;
    try {
      if (new URL(profile.serverBaseUrl).origin !== origin) continue;
    } catch {
      continue;
    }
    const deviceToken = await input.vault.getDeviceToken(profile.profileId);
    if (!deviceToken) continue;
    candidates.push({
      profileId: profile.profileId,
      deviceToken,
      updatedAt: profile.updatedAt
    });
  }
  candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const preferred =
    (activeProfileId
      ? candidates.find((candidate) => candidate.profileId === activeProfileId)
      : undefined) ?? candidates[0];
  if (!preferred) return null;
  const recovered = await input.recover(preferred.deviceToken);
  await input.vault.setDeviceToken(preferred.profileId, preferred.deviceToken, {
    humanPrincipalId: recovered.humanPrincipalId,
    identityToken: recovered.identityToken,
    identityCredentialId: recovered.identityCredentialId,
    identityExpiresAt: recovered.identityExpiresAt
  });
  return {
    humanPrincipalId: recovered.humanPrincipalId,
    identityToken: recovered.identityToken
  };
}
