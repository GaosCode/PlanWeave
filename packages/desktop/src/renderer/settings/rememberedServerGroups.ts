import type { RememberedServerConnectionView } from "../../shared/collaboration";

/** Server rows group saved credentials by origin without merging or deleting identities. */
export function rememberedServerGroups(
  profiles: RememberedServerConnectionView[],
  activeProfileId: string | null
) {
  const groups = new Map<string, RememberedServerConnectionView[]>();
  for (const profile of profiles) {
    const origin = new URL(profile.serverBaseUrl).origin;
    const group = groups.get(origin) ?? [];
    group.push(profile);
    groups.set(origin, group);
  }
  return [...groups].map(([origin, connections]) => ({
    origin,
    connections,
    primary: connections.find((profile) => profile.profileId === activeProfileId) ?? connections[0]!
  }));
}
