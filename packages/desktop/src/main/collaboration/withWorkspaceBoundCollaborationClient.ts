import type { CollaborationConnectionProfile } from "@planweave-ai/collaboration-protocol/connection";
import type { WorkspaceCanvasLocator } from "../../shared/canvasLocator.js";
import type { CollaborationClient } from "./CollaborationClient.js";
import { CollaborationClientError, collaborationErrorFromUnknown } from "./collaborationErrors.js";
import { workspaceRemoteAuthorityKeyFromProfile } from "./WorkspaceRemoteAuthorityIdentity.js";
import type { WorkspaceRemoteAuthorityProfile } from "./workspaceRemoteAuthorityProfile.js";

export async function withWorkspaceBoundCollaborationClient<T>(input: {
  locator: WorkspaceCanvasLocator;
  resolveAuthorityProfile(profileId: string): Promise<WorkspaceRemoteAuthorityProfile | null>;
  clientForProfile(
    profileId: string,
    requireCredential: boolean
  ): Promise<{ client: CollaborationClient; profile: CollaborationConnectionProfile }>;
  operation(client: CollaborationClient): Promise<T>;
}): Promise<T> {
  try {
    const authorityProfile = await input.resolveAuthorityProfile(input.locator.connectionProfileId);
    if (!authorityProfile) {
      throw new CollaborationClientError({
        kind: "forbidden",
        code: "collaboration_workspace_connection_mismatch",
        message: "The requested Workspace profile is not an active authorized Workspace authority.",
        retryable: false
      });
    }
    if (
      authorityProfile.profileId !== input.locator.connectionProfileId ||
      authorityProfile.workspaceId !== input.locator.workspaceId ||
      authorityProfile.projectId !== input.locator.projectId
    ) {
      throw new CollaborationClientError({
        kind: "forbidden",
        code: "collaboration_workspace_connection_mismatch",
        message: "The requested Workspace locator does not match the profile Workspace authority.",
        retryable: false
      });
    }
    workspaceRemoteAuthorityKeyFromProfile(input.locator, authorityProfile);
    const { client, profile } = await input.clientForProfile(
      input.locator.connectionProfileId,
      true
    );
    if (
      profile.profileId !== authorityProfile.profileId ||
      profile.projectId !== authorityProfile.projectId ||
      new URL(profile.serverBaseUrl).origin !== new URL(authorityProfile.serverBaseUrl).origin
    ) {
      throw new Error("workspace_remote_authority_profile_changed");
    }
    return await input.operation(client);
  } catch (error) {
    throw collaborationErrorFromUnknown(error);
  }
}
