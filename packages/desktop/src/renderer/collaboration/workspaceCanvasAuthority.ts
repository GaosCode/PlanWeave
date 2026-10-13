import type { CollaborationStatus } from "../../shared/collaboration";

/** Shared identity for renderer operations bound to a Home and collaboration connection. */
export function workspaceCanvasAuthorityKey(
  planweaveHome: string,
  status: CollaborationStatus | null
): string {
  const profile = status?.profiles.find((profile) => profile.profileId === status.activeProfileId);
  const connection = status?.workspaceConnection;
  return JSON.stringify([
    planweaveHome,
    status?.activeProfileId,
    status?.session.phase,
    profile?.serverBaseUrl,
    profile?.projectId,
    profile?.credentialRevision,
    profile?.deviceCredentialId,
    profile?.humanPrincipalId,
    connection?.status,
    connection?.profile?.profileId,
    connection?.workspaceId,
    connection?.connectedAt,
    connection?.credentialRevision
  ]);
}
