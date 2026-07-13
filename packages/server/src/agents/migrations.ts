/**
 * A6 agent-coordinator schema migrations.
 *
 * Uses its own `agents_schema_migrations` tracker so the agent module
 * can be versioned independently. Called from `lifecycle.ts` alongside
 * the other per-module migrations.
 *
 * Tables introduced by v1:
 *  - agent_runs        — lifecycle of a coordinator agent invocation
 *  - agent_checkpoints  — incremental snapshots for cancel/restart recovery
 *  - agent_artifacts    — structured consensus artifacts with citation validation
 */

import type { SqliteDatabase } from "../sqlite.js"

const agentMigration1 = `
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  status TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancelled_at TEXT
);
CREATE INDEX idx_agent_runs_room ON agent_runs(room_id, status);
CREATE INDEX idx_agent_runs_project ON agent_runs(project_id);

CREATE TABLE agent_checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  sequence INTEGER NOT NULL,
  consumed_cursor TEXT,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE(run_id, sequence)
);
CREATE INDEX idx_agent_checkpoints_run ON agent_checkpoints(run_id, sequence);

CREATE TABLE agent_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  checkpoint_id TEXT NOT NULL REFERENCES agent_checkpoints(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  citations_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_agent_artifacts_run ON agent_artifacts(run_id);
CREATE INDEX idx_agent_artifacts_checkpoint ON agent_artifacts(checkpoint_id);
`

const agentMigration2 = `
ALTER TABLE agent_checkpoints ADD COLUMN message_cursor TEXT;
ALTER TABLE agent_checkpoints ADD COLUMN attachment_cursor TEXT;
UPDATE agent_checkpoints
SET message_cursor = CASE WHEN consumed_cursor LIKE 'message:%' THEN substr(consumed_cursor, 9) ELSE NULL END,
    attachment_cursor = CASE WHEN consumed_cursor LIKE 'attachment:%' THEN substr(consumed_cursor, 12) ELSE NULL END;
`

export const agentMigrations = [
  { version: 1, sql: agentMigration1 },
  { version: 2, sql: agentMigration2 }
] as const

export function applyAgentsMigrations(database: SqliteDatabase): void {
  database.exec("CREATE TABLE IF NOT EXISTS agents_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
  const applied = new Set(
    (database.prepare("SELECT version FROM agents_schema_migrations").all() as Array<Record<string, unknown>>).map((row) => Number(row.version))
  )
  for (const migration of agentMigrations) {
    if (applied.has(migration.version)) continue
    database.exec("BEGIN IMMEDIATE")
    try {
      database.exec(migration.sql)
      database.prepare("INSERT INTO agents_schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, new Date().toISOString())
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  }
}

export function agentsSchemaVersion(database: SqliteDatabase): number {
  try {
    const row = database.prepare("SELECT MAX(version) AS version FROM agents_schema_migrations").get() as { version: number | null } | undefined
    return Number(row?.version ?? 0)
  } catch {
    return 0
  }
}
