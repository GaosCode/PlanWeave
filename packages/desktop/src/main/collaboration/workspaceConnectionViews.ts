import {
  activeWorkspaceConnectionViewSchema,
  workspacePickerPageSchema,
  type ActiveWorkspaceConnectionView,
  type WorkspacePickerPage,
  type WorkspaceConnectionProfile
} from "@planweave-ai/collaboration-protocol/connection";
import type { StoredWorkspaceConnectionProfile } from "./workspaceConnectionProfileStore.js";
import { isLocalCollaborationProfileId } from "./collaborationProfileEndpoint.js";
import { isExportedServerDataProfileId } from "./exportedServerDataIdentity.js";

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
