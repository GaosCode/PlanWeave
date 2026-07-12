export const ROLE_NAMES = ["viewer", "contributor", "maintainer", "owner"] as const;
export type Role = typeof ROLE_NAMES[number];
const ROLE_RANK: Record<Role, number> = { viewer: 1, contributor: 2, maintainer: 3, owner: 4 };
export function roleRank(role: Role): number { return ROLE_RANK[role]; }
export function meetsRole(actual: Role, minimum: Role): boolean { return ROLE_RANK[actual] >= ROLE_RANK[minimum]; }

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLE_NAMES as readonly string[]).includes(value);
}

export type User = { id: string; displayName: string; email: string | null; createdAt: string };
export type Device = { id: string; userId: string; deviceName: string; publicKeyFingerprint: string | null; lastSeenAt: string | null; status: "active" | "revoked"; createdAt: string };
export type Invitation = { id: string; projectId: string; code: string; role: Role; expiresAt: string; redeemedByUserId: string | null; redeemedAt: string | null; createdByUserId: string; createdAt: string };
export type Session = { id: string; userId: string; deviceId: string; issuedAt: string; expiresAt: string; revokedAt: string | null };
export type Membership = { projectId: string; userId: string; role: Role; createdAt: string };
