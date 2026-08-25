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
  identityExpiresAt?: string | null;
  updatedAt: string;
};

export type IdentityRepairPrincipal = {
  humanPrincipalId: string | null;
  profileIds: string[];
  hasIdentityToken: boolean;
  hasDeviceToken: boolean;
  identityExpiresAt: string | null;
};

export type DiagnosedOriginIdentity =
  | { kind: "none" }
  | {
      kind: "identity";
      token: string;
      humanPrincipalId: string;
      profileId: string;
      expiresAt: string | null;
    }
  | { kind: "device_recovery"; token: string; humanPrincipalId: string; profileId: string }
  | { kind: "repair_required"; principals: IdentityRepairPrincipal[] };

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

function identityUsable(candidate: OriginCredentialCandidate, now: Date): boolean {
  if (candidate.identityToken === undefined) return false;
  if (candidate.identityExpiresAt === undefined || candidate.identityExpiresAt === null) {
    return true;
  }
  const expiresAt = Date.parse(candidate.identityExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

function repairPrincipals(
  matching: readonly OriginCredentialCandidate[]
): IdentityRepairPrincipal[] {
  const groups = new Map<string, OriginCredentialCandidate[]>();
  for (const candidate of matching) {
    const key = candidate.humanPrincipalId ?? `unproven:${candidate.profileId}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const newest = [...group].sort(compareUpdatedAt)[0];
    return {
      humanPrincipalId: newest.humanPrincipalId,
      profileIds: group.map((candidate) => candidate.profileId).sort(),
      hasIdentityToken: group.some((candidate) => candidate.identityToken !== undefined),
      hasDeviceToken: group.some((candidate) => candidate.deviceToken !== undefined),
      identityExpiresAt: newest.identityExpiresAt ?? null
    };
  });
}

/**
 * Diagnose Server-global identity for one origin.
 * Multiple proven principals or unproven device tokens require an explicit repair.
 */
export function diagnoseOriginIdentity(
  candidates: readonly OriginCredentialCandidate[],
  serverBaseUrl: string,
  now: Date = new Date()
): DiagnosedOriginIdentity {
  const origin = originOf(serverBaseUrl);
  if (!origin) return { kind: "none" };
  const matching = candidates.filter(
    (candidate) =>
      candidate.origin === origin &&
      (candidate.identityToken !== undefined || candidate.deviceToken !== undefined)
  );
  if (matching.length === 0) return { kind: "none" };
  const unproven = matching.filter((candidate) => candidate.humanPrincipalId === null);
  const provenIds = [
    ...new Set(
      matching
        .map((candidate) => candidate.humanPrincipalId)
        .filter((id): id is string => id !== null)
    )
  ];
  if (unproven.length > 0 || provenIds.length > 1) {
    return { kind: "repair_required", principals: repairPrincipals(matching) };
  }
  if (provenIds.length === 0) return { kind: "none" };
  const humanPrincipalId = provenIds[0];
  const forPrincipal = matching
    .filter((candidate) => candidate.humanPrincipalId === humanPrincipalId)
    .sort(compareUpdatedAt);
  const identity = forPrincipal.find((candidate) => identityUsable(candidate, now));
  if (identity?.identityToken) {
    return {
      kind: "identity",
      token: identity.identityToken,
      humanPrincipalId,
      profileId: identity.profileId,
      expiresAt: identity.identityExpiresAt ?? null
    };
  }
  const device = forPrincipal.find((candidate) => candidate.deviceToken !== undefined);
  if (device?.deviceToken) {
    return {
      kind: "device_recovery",
      token: device.deviceToken,
      humanPrincipalId,
      profileId: device.profileId
    };
  }
  return { kind: "none" };
}

/** @deprecated Prefer diagnoseOriginIdentity; throws when repair is required. */
export function selectExistingIdentityProof(
  candidates: readonly OriginCredentialCandidate[],
  serverBaseUrl: string,
  now: Date = new Date()
):
  | { kind: "identity"; token: string; humanPrincipalId: string }
  | { kind: "device_recovery"; token: string; humanPrincipalId: string }
  | undefined {
  const diagnosed = diagnoseOriginIdentity(candidates, serverBaseUrl, now);
  if (diagnosed.kind === "none") return undefined;
  if (diagnosed.kind === "repair_required") {
    throw new IdentitySelectionError("identity_repair_required");
  }
  return {
    kind: diagnosed.kind,
    token: diagnosed.token,
    humanPrincipalId: diagnosed.humanPrincipalId
  };
}
