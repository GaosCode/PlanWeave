import type { SqliteDatabase } from "../sqlite.js";
import { columnExists, tableExists } from "./schemaIntrospection.js";
import type { Migration } from "./types.js";

function addColumn(
  database: SqliteDatabase,
  table: string,
  column: string,
  definition: string
): void {
  if (!tableExists(database, table) || columnExists(database, table, column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function addEnrollmentGrantRemoteAgentColumns(database: SqliteDatabase): void {
  addColumn(
    database,
    "agent_host_enrollment_grants",
    "owner_human_principal_id",
    "TEXT REFERENCES human_principals(human_principal_id)"
  );
  addColumn(
    database,
    "agent_host_enrollment_grants",
    "access_mode",
    "TEXT CHECK(access_mode IN ('unrestricted','workspace_restricted') OR access_mode IS NULL)"
  );
  addColumn(
    database,
    "agent_host_enrollment_grants",
    "create_workspace_grant",
    "INTEGER NOT NULL DEFAULT 0 CHECK(create_workspace_grant IN (0,1))"
  );
}

/**
 * Enrollment-declared Remote Agent owner/access defaults (Phase 1B).
 *
 * `unrestricted` requires a verified owner; repair-required + unrestricted is forbidden.
 * Do not infer owner from operatorId, server-admin, or workspace bindings.
 */
export const remoteAgentEnrollmentDefaultsSql = `
    CREATE TABLE IF NOT EXISTS agent_host_remote_agent_defaults (
      host_id TEXT PRIMARY KEY REFERENCES agent_hosts(id),
      owner_human_principal_id TEXT REFERENCES human_principals(human_principal_id),
      access_mode TEXT CHECK(access_mode IN ('unrestricted','workspace_restricted') OR access_mode IS NULL),
      create_workspace_grant INTEGER NOT NULL CHECK(create_workspace_grant IN (0,1)),
      grant_workspace_id TEXT REFERENCES workspaces(workspace_id),
      updated_at TEXT NOT NULL,
      CHECK (
        (owner_human_principal_id IS NULL AND access_mode IS NULL
          AND create_workspace_grant = 0 AND grant_workspace_id IS NULL)
        OR (owner_human_principal_id IS NOT NULL AND access_mode IS NOT NULL)
      ),
      CHECK (create_workspace_grant = 0 OR grant_workspace_id IS NOT NULL)
    );

    CREATE TABLE remote_agents_v58 (
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
      CHECK(
        (ownership_repair_required = 1)
        OR (ownership_repair_required = 0 AND owner_human_principal_id IS NOT NULL)
      ),
      CHECK (
        access_mode <> 'unrestricted'
        OR (owner_human_principal_id IS NOT NULL AND ownership_repair_required = 0)
      )
    );

    INSERT INTO remote_agents_v58(
      endpoint_id, host_id, profile_id, agent_id, owner_human_principal_id,
      display_name, access_mode, policy_revision, ownership_repair_required,
      created_at, updated_at, revoked_at
    )
    SELECT endpoint_id, host_id, profile_id, agent_id, owner_human_principal_id,
      display_name, access_mode, policy_revision, ownership_repair_required,
      created_at, updated_at, revoked_at
    FROM remote_agents;

    DROP TABLE remote_agents;
    ALTER TABLE remote_agents_v58 RENAME TO remote_agents;
`;

export const remoteAgentEnrollmentDefaultsMigration: Migration = {
  version: 58,
  sql: remoteAgentEnrollmentDefaultsSql,
  disableForeignKeys: true,
  before: addEnrollmentGrantRemoteAgentColumns
};
