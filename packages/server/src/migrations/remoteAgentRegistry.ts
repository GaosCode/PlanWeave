import { hostReadinessObservationSchema } from "@planweave-ai/agent-host-protocol";
import { endpointIdFor } from "../agentEndpointCatalog.js";
import type { SqliteDatabase } from "../sqlite.js";
import type { Migration } from "./types.js";

/**
 * Remote Agent identity and Workspace Grant registry (Phase 1A).
 *
 * Repair-required agents may lack an owner; dispatch will refuse them (Phase 2).
 * Do not silently fill owner with server-admin.
 */
export const remoteAgentRegistrySql = `
    CREATE TABLE IF NOT EXISTS remote_agents (
      endpoint_id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL REFERENCES agent_hosts(id),
      profile_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      owner_human_principal_id TEXT
        REFERENCES human_principals(human_principal_id),
      display_name TEXT NOT NULL,
      access_mode TEXT NOT NULL CHECK(access_mode IN ('unrestricted', 'workspace_restricted')),
      policy_revision INTEGER NOT NULL CHECK(policy_revision >= 1),
      ownership_repair_required INTEGER NOT NULL CHECK(ownership_repair_required IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT,
      UNIQUE(host_id, profile_id, agent_id),
      -- Repair-required agents may lack an owner; dispatch will refuse them (Phase 2).
      -- Do not silently fill owner with server-admin.
      CHECK(
        (ownership_repair_required = 1)
        OR (ownership_repair_required = 0 AND owner_human_principal_id IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS remote_agent_workspace_grants (
      endpoint_id TEXT NOT NULL REFERENCES remote_agents(endpoint_id),
      workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
      grant_revision INTEGER NOT NULL CHECK(grant_revision >= 1),
      granted_by_human_principal_id TEXT NOT NULL
        REFERENCES human_principals(human_principal_id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT,
      PRIMARY KEY(endpoint_id, workspace_id)
    );

    CREATE INDEX IF NOT EXISTS idx_remote_agent_workspace_grants_workspace_active
      ON remote_agent_workspace_grants(workspace_id, endpoint_id)
      WHERE revoked_at IS NULL;
`;

function parseHostReadiness(
  raw: string | null
): ReturnType<typeof hostReadinessObservationSchema.parse> | undefined {
  if (raw === null || raw === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = hostReadinessObservationSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** Conservative identity backfill: never assigns owner or workspace grants. */
export function backfillRemoteAgentsFromHostReadiness(database: SqliteDatabase): void {
  const now = new Date().toISOString();
  const insert = database.prepare(`
    INSERT INTO remote_agents(
      endpoint_id, host_id, profile_id, agent_id,
      owner_human_principal_id, display_name, access_mode, policy_revision,
      ownership_repair_required, created_at, updated_at, revoked_at
    )
    SELECT ?, ?, ?, ?, NULL, ?, 'workspace_restricted', 1, 1, ?, ?, NULL
    WHERE NOT EXISTS (SELECT 1 FROM remote_agents WHERE endpoint_id=?)
      AND NOT EXISTS (
        SELECT 1 FROM remote_agents
        WHERE host_id=? AND profile_id=? AND agent_id=?
      )
  `);
  const hosts = database
    .prepare("SELECT id, readiness_json FROM agent_hosts WHERE superseded_at IS NULL")
    .all() as Array<{ id: string; readiness_json: string | null }>;
  for (const host of hosts) {
    const readiness = parseHostReadiness(host.readiness_json);
    if (!readiness) continue;
    const seen = new Set<string>();
    for (const profile of readiness.acpProfiles) {
      const key = `${profile.profileId}\0${profile.agentId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const endpointId = endpointIdFor({
        hostId: host.id,
        profileId: profile.profileId,
        agentId: profile.agentId
      });
      insert.run(
        endpointId,
        host.id,
        profile.profileId,
        profile.agentId,
        profile.displayName,
        now,
        now,
        endpointId,
        host.id,
        profile.profileId,
        profile.agentId
      );
    }
  }
}

export const remoteAgentRegistryMigration: Migration = {
  version: 57,
  sql: remoteAgentRegistrySql,
  after: backfillRemoteAgentsFromHostReadiness
};
