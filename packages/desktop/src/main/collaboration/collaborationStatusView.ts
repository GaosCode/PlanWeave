import {
  COLLABORATION_SESSION_ONLY_WARNING,
  type CollaborationProfileView,
  type CollaborationSessionPhase,
  type CollaborationStatus
} from "../../shared/collaboration.js";
import type { CollaborationClient } from "./CollaborationClient.js";
import type { CollaborationObserverStatus } from "./CollaborationClient.js";
import type { CollaborationCredentialVault } from "./collaborationCredentialVault.js";
import type {
  CollaborationProfileStore,
  StoredCollaborationProfileRecord
} from "./collaborationProfileStore.js";
import type { CollaborationWorkspaceConnection } from "./collaborationWorkspaceConnection.js";

export type CollaborationStatusSession = {
  phase: CollaborationSessionPhase;
  detail: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  clientProfileId: string | null;
  observerStatus: CollaborationObserverStatus;
  client: CollaborationClient | null;
};

export type BuildCollaborationStatusOptions = {
  profiles: CollaborationProfileStore;
  vault: CollaborationCredentialVault;
  workspaceConnection: CollaborationWorkspaceConnection;
  session: CollaborationStatusSession;
  clock?: { now(): Date };
};

function observerDetail(status: CollaborationObserverStatus): string {
  if (status.state === "connecting") {
    return `observer:connecting:attempt=${status.attempt}`;
  }
  if (status.state === "reconnecting") {
    return `observer:reconnecting:attempt=${status.attempt}:delay_ms=${status.delayMs}`;
  }
  if (status.state === "catching_up") {
    return `observer:catching_up:resume_cursor=${status.resumeCursor}`;
  }
  return `observer:${status.state}`;
}

function toPublicProfile(
  profile: StoredCollaborationProfileRecord,
  credential: {
    hasDeviceCredential: boolean;
    deviceCredentialPersistence: CollaborationProfileView["deviceCredentialPersistence"];
    deviceCredentialId: string | null;
    humanPrincipalId: string | null;
  }
): CollaborationProfileView {
  const base = {
    profileId: profile.profileId,
    displayName: profile.displayName,
    serverBaseUrl: profile.serverBaseUrl,
    projectId: profile.projectId,
    allowInsecureTransport: profile.allowInsecureTransport,
    hasDeviceCredential: credential.hasDeviceCredential,
    deviceCredentialPersistence: credential.deviceCredentialPersistence,
    deviceCredentialId: credential.deviceCredentialId,
    humanPrincipalId: credential.humanPrincipalId,
    updatedAt: profile.updatedAt
  };
  switch (profile.connectionState) {
    case "ready":
      return { ...base, endpoint: profile.endpoint, connectionState: "ready" };
    case "reconnect_required":
      return { ...base, endpoint: null, connectionState: "reconnect_required" };
  }
}

/** Builds the redacted renderer status from credential/profile read models. */
export async function buildCollaborationStatus(
  options: BuildCollaborationStatusOptions
): Promise<CollaborationStatus> {
  const documentProfiles = await options.profiles.list();
  const activeProfileId = await options.profiles.getActiveProfileId();
  const profiles: CollaborationProfileView[] = [];
  for (const profile of documentProfiles) {
    const persistence = await options.vault.persistenceFor(profile.profileId);
    const metadata = await options.vault.getMetadata(profile.profileId);
    profiles.push(
      toPublicProfile(profile, {
        hasDeviceCredential: persistence !== "missing",
        deviceCredentialPersistence: persistence,
        deviceCredentialId: metadata?.deviceCredentialId ?? null,
        humanPrincipalId: metadata?.humanPrincipalId ?? null
      })
    );
  }

  const hasSessionOnly = await options.vault.hasAnySessionOnlyCredential();
  const nonPersistenceWarning =
    options.vault.storageAvailability() === "unavailable"
      ? profiles.some((profile) => profile.hasDeviceCredential) || hasSessionOnly
        ? COLLABORATION_SESSION_ONLY_WARNING
        : null
      : profiles.some((profile) => profile.deviceCredentialPersistence === "session-only")
        ? COLLABORATION_SESSION_ONLY_WARNING
        : null;
  const detail =
    options.session.observerStatus.state !== "stopped" && options.session.client
      ? observerDetail(options.session.observerStatus)
      : options.session.detail;

  return {
    profiles,
    activeProfileId,
    credentialStorage: options.vault.storageAvailability(),
    nonPersistenceWarning,
    session: {
      phase: options.session.phase,
      activeProfileId: options.session.clientProfileId ?? activeProfileId,
      detail,
      lastErrorCode: options.session.lastErrorCode,
      lastErrorMessage: options.session.lastErrorMessage
    },
    workspaceConnection: await options.workspaceConnection.buildView(),
    workspacePicker: options.workspaceConnection.buildCachedPickerPage(),
    identityRepair: options.workspaceConnection.identityRepairView(),
    updatedAt: (options.clock?.now() ?? new Date()).toISOString()
  };
}
