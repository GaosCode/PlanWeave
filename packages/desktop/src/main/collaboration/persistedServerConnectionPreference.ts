import { isLocalCollaborationProfileId } from "./collaborationProfileEndpoint.js";
import type { LastServerConnection } from "./workspaceConnectionProfileStore.js";

/** Repair window for a local profile that overwrote activeProfileId right after a remote connect. */
export const LOCAL_SERVER_AUTHORITY_STEAL_WINDOW_MS = 10_000;

export function inferPersistedRemoteProfileId(input: {
  lastConnection?: LastServerConnection;
  activeProfileId: string | null;
  profiles: Array<{ profileId: string; updatedAt: string }>;
}): string | null {
  if (input.lastConnection?.kind === "remote") {
    const lastRemoteId = input.lastConnection.profileId;
    const exists = input.profiles.some((profile) => profile.profileId === lastRemoteId);
    return exists ? lastRemoteId : null;
  }
  if (input.lastConnection?.kind === "local") return null;
  if (input.activeProfileId && !isLocalCollaborationProfileId(input.activeProfileId)) {
    const exists = input.profiles.some((profile) => profile.profileId === input.activeProfileId);
    return exists ? input.activeProfileId : null;
  }
  if (!input.activeProfileId || !isLocalCollaborationProfileId(input.activeProfileId)) {
    return null;
  }
  const active = input.profiles.find((profile) => profile.profileId === input.activeProfileId);
  const stolen = input.profiles
    .filter((profile) => !isLocalCollaborationProfileId(profile.profileId))
    .filter((remote) => active !== undefined && remote.updatedAt <= active.updatedAt)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!stolen || !active) return null;
  const delta = Date.parse(active.updatedAt) - Date.parse(stolen.updatedAt);
  if (!Number.isFinite(delta) || delta < 0 || delta >= LOCAL_SERVER_AUTHORITY_STEAL_WINDOW_MS) {
    return null;
  }
  return stolen.profileId;
}
