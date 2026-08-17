import type {
  HumanDeviceView,
  HumanInvitationView,
  HumanMembershipView
} from "@planweave-ai/collaboration-protocol/identity/workspace";
import type {
  CollaborationBoundaryErrorView,
  CollaborationHostProjection,
  CollaborationSyncPhase
} from "../../shared/collaborationReadModels.js";
import type {
  CollaborationCredentialPersistence,
  CollaborationSessionPhase,
  CollaborationStatus
} from "../../shared/collaboration.js";

/** Presence status derived only from authoritative host facts (no invented last-seen/version). */
export type HostPresenceStatus = "online" | "offline" | "degraded";

export type MemberRoleAction = "promote" | "demote" | "remove";

export type MemberActionAvailability = {
  action: MemberRoleAction;
  allowed: boolean;
  reason:
    | "ok"
    | "not_owner"
    | "last_owner"
    | "self_only_owner"
    | "already_owner"
    | "already_member";
};

export type PeopleMemberRow = {
  membershipId: string;
  humanPrincipalId: string;
  displayName: string;
  role: HumanMembershipView["role"];
  isCurrentUser: boolean;
  initials: string;
  actions: MemberActionAvailability[];
};

export type PeopleHostRow = {
  hostId: string;
  displayName: string;
  status: HostPresenceStatus;
  capacityRemaining?: number;
  capabilities: string[];
  revoked: boolean;
  authorizedForProject: boolean;
  exists: boolean;
  /** Authoritative projections do not currently expose host version or last-seen. */
  versionSummary: null;
  lastSeenSummary: null;
};

export type PeopleInvitationRow = {
  invitationId: string;
  role: HumanInvitationView["role"];
  createdAt: string;
  expiresAt: string;
  open: boolean;
  revokedAt?: string;
  consumedAt?: string;
};

export type PeopleDeviceRow = {
  deviceCredentialId: string;
  humanPrincipalId: string;
  label: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  lastSeenAt?: string;
  isRevoked: boolean;
};

export type PeoplePanelMode =
  | "disconnected"
  | "connecting"
  | "ready"
  | "loading"
  | "offline"
  | "forbidden"
  | "auth_expired"
  | "error"
  | "empty";

export type PeoplePresenceSummary = {
  memberCount: number;
  hostCount: number;
  onlineHostCount: number;
  avatarMembers: Array<{ humanPrincipalId: string; displayName: string; initials: string }>;
  sessionPhase: CollaborationSessionPhase;
  syncPhase: CollaborationSyncPhase;
  currentUserIsOwner: boolean;
  credentialPersistence: CollaborationCredentialPersistence | null;
  nonPersistenceWarning: string | null;
};

export function memberInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  return `${parts[0]!.slice(0, 1)}${parts[1]!.slice(0, 1)}`.toUpperCase();
}

export function countOwners(members: readonly HumanMembershipView[]): number {
  return members.filter((member) => member.role === "owner").length;
}

export function deriveHostPresenceStatus(host: CollaborationHostProjection): HostPresenceStatus {
  if (!host.exists || host.revoked || !host.authorizedForProject) {
    return "degraded";
  }
  return host.online ? "online" : "offline";
}

export function isInvitationOpen(
  invitation: HumanInvitationView,
  nowMs: number = Date.now()
): boolean {
  if (invitation.revokedAt || invitation.consumedAt) return false;
  const expires = Date.parse(invitation.expiresAt);
  if (Number.isFinite(expires) && expires <= nowMs) return false;
  return true;
}

export function evaluateMemberAction(input: {
  action: MemberRoleAction;
  member: HumanMembershipView;
  members: readonly HumanMembershipView[];
  currentUserIsOwner: boolean;
  currentHumanPrincipalId: string | null;
}): MemberActionAvailability {
  const { action, member, members, currentUserIsOwner, currentHumanPrincipalId } = input;
  if (!currentUserIsOwner) {
    return { action, allowed: false, reason: "not_owner" };
  }

  if (action === "promote") {
    if (member.role === "owner") {
      return { action, allowed: false, reason: "already_owner" };
    }
    return { action, allowed: true, reason: "ok" };
  }

  if (action === "demote") {
    if (member.role !== "owner") {
      return { action, allowed: false, reason: "already_member" };
    }
    if (countOwners(members) <= 1) {
      return { action, allowed: false, reason: "last_owner" };
    }
    return { action, allowed: true, reason: "ok" };
  }

  // remove
  if (member.role === "owner" && countOwners(members) <= 1) {
    return { action, allowed: false, reason: "last_owner" };
  }
  if (
    member.role === "owner" &&
    currentHumanPrincipalId === member.humanPrincipalId &&
    countOwners(members) <= 1
  ) {
    return { action, allowed: false, reason: "self_only_owner" };
  }
  return { action, allowed: true, reason: "ok" };
}

export function buildPeopleMemberRows(input: {
  members: readonly HumanMembershipView[];
  currentHumanPrincipalId: string | null;
  currentUserIsOwner: boolean;
}): PeopleMemberRow[] {
  return input.members.map((member) => {
    const actions: MemberActionAvailability[] = (["promote", "demote", "remove"] as const).map(
      (action) =>
        evaluateMemberAction({
          action,
          member,
          members: input.members,
          currentUserIsOwner: input.currentUserIsOwner,
          currentHumanPrincipalId: input.currentHumanPrincipalId
        })
    );
    return {
      membershipId: member.membershipId,
      humanPrincipalId: member.humanPrincipalId,
      displayName: member.displayName,
      role: member.role,
      isCurrentUser: input.currentHumanPrincipalId === member.humanPrincipalId,
      initials: memberInitials(member.displayName),
      actions
    };
  });
}

export function buildPeopleHostRows(
  hosts: readonly CollaborationHostProjection[]
): PeopleHostRow[] {
  return hosts.map((host) => ({
    hostId: host.hostId,
    displayName: host.displayName?.trim() || host.hostId,
    status: deriveHostPresenceStatus(host),
    capacityRemaining: host.capacityRemaining,
    capabilities: host.capabilities,
    revoked: host.revoked,
    authorizedForProject: host.authorizedForProject,
    exists: host.exists,
    versionSummary: null,
    lastSeenSummary: null
  }));
}

export function buildPeopleInvitationRows(
  invitations: readonly HumanInvitationView[],
  nowMs: number = Date.now()
): PeopleInvitationRow[] {
  return invitations.map((invitation) => ({
    invitationId: invitation.invitationId,
    role: invitation.role,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    open: isInvitationOpen(invitation, nowMs),
    revokedAt: invitation.revokedAt,
    consumedAt: invitation.consumedAt
  }));
}

export function buildPeopleDeviceRows(devices: readonly HumanDeviceView[]): PeopleDeviceRow[] {
  return devices.map((device) => ({
    deviceCredentialId: device.deviceCredentialId,
    humanPrincipalId: device.humanPrincipalId,
    label: device.label?.trim() || device.deviceCredentialId,
    createdAt: device.createdAt,
    expiresAt: device.expiresAt,
    revokedAt: device.revokedAt,
    lastSeenAt: device.lastUsedAt,
    isRevoked: Boolean(device.revokedAt)
  }));
}

export function resolveCurrentMembership(input: {
  members: readonly HumanMembershipView[];
  status: CollaborationStatus | null;
}): HumanMembershipView | null {
  const principalId =
    input.status?.profiles.find((profile) => profile.profileId === input.status?.activeProfileId)
      ?.humanPrincipalId ?? null;
  if (!principalId) return null;
  return input.members.find((member) => member.humanPrincipalId === principalId) ?? null;
}

export function buildPeoplePresenceSummary(input: {
  members: readonly HumanMembershipView[];
  hosts: readonly CollaborationHostProjection[];
  status: CollaborationStatus | null;
  syncPhase: CollaborationSyncPhase;
}): PeoplePresenceSummary {
  const activeProfile =
    input.status?.profiles.find((profile) => profile.profileId === input.status?.activeProfileId) ??
    null;
  const currentMembership = resolveCurrentMembership({
    members: input.members,
    status: input.status
  });
  const avatarMembers = input.members.slice(0, 5).map((member) => ({
    humanPrincipalId: member.humanPrincipalId,
    displayName: member.displayName,
    initials: memberInitials(member.displayName)
  }));
  return {
    memberCount: input.members.length,
    hostCount: input.hosts.length,
    onlineHostCount: input.hosts.filter((host) => deriveHostPresenceStatus(host) === "online")
      .length,
    avatarMembers,
    sessionPhase: input.status?.session.phase ?? "idle",
    syncPhase: input.syncPhase,
    currentUserIsOwner: currentMembership?.role === "owner",
    credentialPersistence: activeProfile?.deviceCredentialPersistence ?? null,
    nonPersistenceWarning: input.status?.nonPersistenceWarning ?? null
  };
}

export function resolvePeoplePanelMode(input: {
  status: CollaborationStatus | null;
  syncPhase: CollaborationSyncPhase;
  memberCount: number;
  detailsLoading?: boolean;
  detailsFailed?: boolean;
}): PeoplePanelMode {
  const sessionPhase = input.status?.session.phase ?? "idle";
  if (sessionPhase === "connecting") return "connecting";
  if (sessionPhase === "error") {
    if (input.syncPhase === "auth_expired") return "auth_expired";
    if (input.syncPhase === "forbidden") return "forbidden";
    return "error";
  }
  if (sessionPhase !== "connected" && sessionPhase !== "ready") {
    return "disconnected";
  }
  if (input.syncPhase === "loading") return "loading";
  if (input.syncPhase === "auth_expired") return "auth_expired";
  if (input.syncPhase === "forbidden") return "forbidden";
  if (input.syncPhase === "disconnected" || input.syncPhase === "reconnecting") return "offline";
  if (input.syncPhase === "error" || input.syncPhase === "degraded") return "error";
  if (input.memberCount === 0) {
    if (input.detailsLoading) return "loading";
    if (input.detailsFailed) return "error";
    return "empty";
  }
  return "ready";
}

/**
 * Map typed collaboration boundary errors for UI.
 * Never include raw payloads that might contain tokens/digests.
 */
export function formatCollaborationBoundaryError(
  error: CollaborationBoundaryErrorView | null | undefined
): string | null {
  if (!error) return null;
  const code = error.code?.trim();
  const message = error.message?.trim();
  if (code && message && message !== code) {
    return `${code}: ${message}`;
  }
  return message || code || "collaboration_error";
}

export function stripElectronRemoteInvokeMessage(message: string): string {
  const match = message.match(
    /^Error invoking remote method '[^']+':\s*(?:[\w.]+Error:\s*)*(.+)$/s
  );
  const inner = match?.[1]?.trim();
  return inner && inner.length > 0 ? inner : message;
}

export function formatUnknownCollaborationError(error: unknown): string {
  if (error instanceof Error) {
    const message = stripElectronRemoteInvokeMessage(error.message);
    const code =
      "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : null;
    const safeMessage =
      message && !/pw_hdev_|pw_inv_|tokenSha256|token_sha256|Authorization|Bearer\s+/i.test(message)
        ? message
        : null;
    if (code && safeMessage && safeMessage !== code) {
      return `${code}: ${safeMessage}`;
    }
    return safeMessage || code || "collaboration_error";
  }
  if (!error || typeof error !== "object") {
    return "collaboration_error";
  }
  const record = error as {
    code?: unknown;
    message?: unknown;
  };
  const code = typeof record.code === "string" ? record.code : null;
  const message =
    typeof record.message === "string" ? stripElectronRemoteInvokeMessage(record.message) : null;
  // Drop anything that looks like a token/digest fragment.
  const safeMessage =
    message && !/pw_hdev_|pw_inv_|tokenSha256|token_sha256|Authorization|Bearer\s+/i.test(message)
      ? message
      : null;
  if (code && safeMessage && safeMessage !== code) {
    return `${code}: ${safeMessage}`;
  }
  return safeMessage || code || "collaboration_error";
}
