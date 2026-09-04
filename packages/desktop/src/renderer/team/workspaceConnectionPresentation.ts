import type { ActiveWorkspaceConnectionView } from "@planweave-ai/collaboration-protocol/connection";
import type { CollaborationProfileView } from "../../shared/collaboration";
import type { createTranslator } from "../i18n";
import { collaborationConnectionErrorMessage } from "../collaboration/formatCollaborationError";

export function resolveWorkspaceIdentityProfile(
  profiles: readonly CollaborationProfileView[],
  connection: ActiveWorkspaceConnectionView | null | undefined
): CollaborationProfileView | null {
  const profileId = connection?.profile?.profileId;
  if (!profileId) return null;
  return profiles.find((profile) => profile.profileId === profileId) ?? null;
}

export function isWorkspaceDeviceCredentialMissing(
  connection: ActiveWorkspaceConnectionView | null | undefined,
  workspaceIdentityProfile: CollaborationProfileView | null
): boolean {
  return (
    connection?.profile !== null &&
    connection?.profile !== undefined &&
    workspaceIdentityProfile?.hasDeviceCredential === false
  );
}

export function workspaceIdentityStatusLabel(
  connection: ActiveWorkspaceConnectionView | null | undefined,
  t: ReturnType<typeof createTranslator>,
  credentialMissing = false
): string {
  if (!connection) return t("peopleWorkspaceIdentityMissingHint");
  if (
    credentialMissing &&
    (connection.status === "connected" || connection.status === "disconnected")
  ) {
    return t("peopleWorkspaceIdentityAwaitingAuthorization");
  }
  switch (connection.status) {
    case "local_only":
      return t("peopleWorkspaceIdentityMissingHint");
    case "connecting":
      return t("peopleWorkspaceIdentityVerifying");
    case "connected":
      return t("peopleWorkspaceIdentityVerified");
    case "reconnecting":
      return t("peopleWorkspaceIdentityReverifying");
    case "error":
      return t("peopleWorkspaceIdentityError");
    case "disconnected":
      return t("peopleWorkspaceIdentityPending");
    default:
      return connection.status;
  }
}

export function workspaceDisplayName(
  displayName: string | null | undefined,
  t: ReturnType<typeof createTranslator>
): string {
  if (!displayName || displayName === "Configured workspace") {
    return t("peopleWorkspaceDefaultName");
  }
  return displayName;
}

/** Localized Workspace error, omitted when the credential-missing banner already explains it. */
export function visibleWorkspaceConnectionError(
  connection: ActiveWorkspaceConnectionView | null | undefined,
  credentialMissing: boolean,
  t: ReturnType<typeof createTranslator>
): string | null {
  if (connection?.status !== "error" || !connection.error) return null;
  const message = collaborationConnectionErrorMessage(t, connection.error);
  if (credentialMissing && message === t("peopleMissingCredential")) return null;
  return message;
}
