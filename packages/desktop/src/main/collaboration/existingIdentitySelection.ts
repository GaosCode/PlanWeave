export class IdentitySelectionError extends Error {
  constructor(readonly code: "identity_repair_required") {
    super(code);
    this.name = "IdentitySelectionError";
  }
}

export type OriginCredentialCandidate = {
  profileId: string;
  origin: string;
  humanPrincipalId: string | null;
  deviceToken?: string;
  identityToken?: string;
  updatedAt: string;
};

export type ExistingIdentityProof =
  | { kind: "identity"; token: string; humanPrincipalId: string }
  | { kind: "device_recovery"; token: string; humanPrincipalId: string };

function originOf(serverBaseUrl: string): string | undefined {
  try {
    return new URL(serverBaseUrl).origin;
  } catch {
    return undefined;
  }
}

function compareUpdatedAt(
  left: OriginCredentialCandidate,
  right: OriginCredentialCandidate
): number {
  if (left.updatedAt === right.updatedAt) return left.profileId.localeCompare(right.profileId);
  return right.updatedAt.localeCompare(left.updatedAt);
}

/**
 * Choose a Server-global identity proof for one origin.
 * Multiple proven principals fail closed. Never returns the first matching
 * workspace token when another principal or unproven credential exists.
 */
export function selectExistingIdentityProof(
  candidates: readonly OriginCredentialCandidate[],
  serverBaseUrl: string
): ExistingIdentityProof | undefined {
  const origin = originOf(serverBaseUrl);
  if (!origin) return undefined;
  const matching = candidates.filter((candidate) => candidate.origin === origin);
  const proven = matching.filter(
    (candidate) =>
      candidate.humanPrincipalId !== null &&
      (candidate.identityToken !== undefined || candidate.deviceToken !== undefined)
  );
  const unproven = matching.filter(
    (candidate) =>
      candidate.humanPrincipalId === null &&
      (candidate.identityToken !== undefined || candidate.deviceToken !== undefined)
  );
  if (unproven.length > 0) {
    throw new IdentitySelectionError("identity_repair_required");
  }
  const principalIds = [
    ...new Set(proven.map((candidate) => candidate.humanPrincipalId as string))
  ];
  if (principalIds.length > 1) {
    throw new IdentitySelectionError("identity_repair_required");
  }
  if (principalIds.length === 0) return undefined;
  const humanPrincipalId = principalIds[0];
  const forPrincipal = proven
    .filter((candidate) => candidate.humanPrincipalId === humanPrincipalId)
    .sort(compareUpdatedAt);
  const identity = forPrincipal.find((candidate) => candidate.identityToken !== undefined);
  if (identity?.identityToken) {
    return { kind: "identity", token: identity.identityToken, humanPrincipalId };
  }
  const device = forPrincipal.find((candidate) => candidate.deviceToken !== undefined);
  if (device?.deviceToken) {
    return { kind: "device_recovery", token: device.deviceToken, humanPrincipalId };
  }
  return undefined;
}
