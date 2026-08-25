import type { CollaborationStatus } from "../../shared/collaboration";

export function resolveDesktopHumanPrincipalId(input: {
  collaborationStatus: CollaborationStatus | null;
  membershipHumanPrincipalId?: string | null;
}): string | null {
  const activeProfileId = input.collaborationStatus?.activeProfileId ?? null;
  const fromProfile =
    input.collaborationStatus?.profiles.find((profile) => profile.profileId === activeProfileId)
      ?.humanPrincipalId ?? null;
  const trimmedProfile = fromProfile?.trim() || null;
  if (trimmedProfile) return trimmedProfile;
  const trimmedMembership = input.membershipHumanPrincipalId?.trim() || null;
  return trimmedMembership;
}
