import type { AgentHost } from "../hostRecord.js";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import { readHostRemoteAgentDefaults } from "./hostDefaults.js";
import { RemoteAgentRepository } from "./repository.js";

export function syncRemoteAgentsFromHost(input: {
  database: SqliteDatabase;
  host: AgentHost;
  clock: () => Date;
}): void {
  const observation = input.host.readinessObservation;
  if (!observation) return;
  const now = input.clock().toISOString();
  inWriteTransaction(input.database, () => {
    const defaults = readHostRemoteAgentDefaults(input.database, input.host.id);
    const repository = new RemoteAgentRepository(input.database, input.clock);
    const seen = new Set<string>();
    for (const profile of observation.acpProfiles) {
      const key = `${profile.profileId}\0${profile.agentId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const agent = repository.registerOrRestoreFromProfile({
        hostId: input.host.id,
        profileId: profile.profileId,
        agentId: profile.agentId,
        displayName: profile.displayName,
        now,
        ...(defaults === undefined
          ? {}
          : {
              ownerHumanPrincipalId: defaults.ownerHumanPrincipalId,
              accessMode: defaults.accessMode
            })
      });
      if (
        defaults === undefined ||
        !defaults.createWorkspaceGrant ||
        defaults.grantWorkspaceId === null ||
        agent.ownershipRepairRequired ||
        agent.ownerHumanPrincipalId === null
      ) {
        continue;
      }
      const alreadyGranted = repository
        .listGrants(agent.endpointId)
        .some((grant) => grant.workspaceId === defaults.grantWorkspaceId);
      if (alreadyGranted) continue;
      repository.grantWorkspace({
        endpointId: agent.endpointId,
        workspaceId: defaults.grantWorkspaceId,
        grantedByHumanPrincipalId: agent.ownerHumanPrincipalId
      });
    }
  });
}
