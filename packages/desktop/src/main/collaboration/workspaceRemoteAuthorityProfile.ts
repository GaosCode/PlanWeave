import type { StoredCollaborationProfile } from "./collaborationProfileStore.js";
import type { StoredWorkspaceConnectionProfile } from "./workspaceConnectionProfileStore.js";

export type WorkspaceRemoteAuthorityProfile = {
  profileId: string;
  serverBaseUrl: string;
  workspaceId: string;
  projectId: string;
};

export async function resolveWorkspaceRemoteAuthorityProfile(input: {
  profileId: string;
  getCollaborationProfile(profileId: string): Promise<StoredCollaborationProfile | null>;
  getWorkspaceProfile(profileId: string): Promise<StoredWorkspaceConnectionProfile | null>;
}): Promise<WorkspaceRemoteAuthorityProfile | null> {
  const [profile, workspaceProfile] = await Promise.all([
    input.getCollaborationProfile(input.profileId),
    input.getWorkspaceProfile(input.profileId)
  ]);
  if (!profile || !workspaceProfile || !workspaceProfile.membershipActive) return null;
  if (
    profile.profileId !== workspaceProfile.profileId ||
    new URL(profile.serverBaseUrl).origin !== new URL(workspaceProfile.serverBaseUrl).origin
  ) {
    throw new Error("workspace_remote_authority_profile_identity_mismatch");
  }
  return {
    profileId: profile.profileId,
    serverBaseUrl: profile.serverBaseUrl,
    workspaceId: workspaceProfile.workspaceId,
    projectId: profile.projectId
  };
}
