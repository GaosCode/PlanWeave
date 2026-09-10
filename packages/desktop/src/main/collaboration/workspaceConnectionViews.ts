import {
  activeWorkspaceConnectionViewSchema,
  workspacePickerPageSchema,
  workspaceConnectionProfileSchema,
  type ActiveWorkspaceConnectionView,
  type WorkspacePickerPage,
  type WorkspaceConnectionProfile
} from "@planweave-ai/collaboration-protocol/connection";
import type { StoredWorkspaceConnectionProfile } from "./workspaceConnectionProfileStore.js";
import { isLocalCollaborationProfileId } from "./collaborationProfileEndpoint.js";
import {
  EXPORTED_SERVER_DATA_PROFILE_ID,
  isExportedServerDataProfileId,
  type ExportedServerDataIdentity
} from "./exportedServerDataIdentity.js";

export function localOnlyView(): ActiveWorkspaceConnectionView {
  return activeWorkspaceConnectionViewSchema.parse({
    schemaVersion: "workspace-setup/v1",
    status: "local_only",
    profile: null,
    workspaceId: null,
    workspaceDisplayName: null,
    connectedAt: null,
    error: null
  });
}

export function emptyWorkspacePickerPage(): WorkspacePickerPage {
  return workspacePickerPageSchema.parse({
    schemaVersion: "workspace-setup/v1",
    items: [],
    nextCursor: null
  });
}

export function toPublicProfile(
  stored: StoredWorkspaceConnectionProfile
): WorkspaceConnectionProfile {
  return {
    schemaVersion: stored.schemaVersion,
    profileId: stored.profileId,
    displayName: stored.displayName,
    serverBaseUrl: stored.serverBaseUrl,
    workspaceId: stored.workspaceId,
    allowInsecureTransport: stored.allowInsecureTransport
  };
}

export function isRetargetableWorkspaceProfileId(profileId: string): boolean {
  return isLocalCollaborationProfileId(profileId) || isExportedServerDataProfileId(profileId);
}

export function exportedIdentityAsStoredProfile(
  identity: ExportedServerDataIdentity
): StoredWorkspaceConnectionProfile {
  return {
    ...workspaceConnectionProfileSchema.parse({
      schemaVersion: "workspace-identity/v1",
      profileId: EXPORTED_SERVER_DATA_PROFILE_ID,
      displayName: identity.workspaceDisplayName,
      serverBaseUrl: "http://127.0.0.1/",
      workspaceId: identity.workspaceId,
      allowInsecureTransport: true
    }),
    workspaceDisplayName: identity.workspaceDisplayName,
    membershipRole: identity.membershipRole,
    membershipActive: true,
    updatedAt: identity.updatedAt
  };
}
