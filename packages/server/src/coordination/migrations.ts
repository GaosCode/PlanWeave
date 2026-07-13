import type { SqliteDatabase } from "../sqlite.js";

const coordinationMigration1 = `
CREATE TABLE project_coordination (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  phase TEXT NOT NULL DEFAULT 'planning',
  active_baseline_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE consensus_baselines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  requirements_json TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  decisions_json TEXT NOT NULL,
  acceptance_criteria_json TEXT NOT NULL,
  risks_json TEXT NOT NULL,
  open_questions_json TEXT NOT NULL,
  citations_json TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  frozen_at TEXT,
  UNIQUE(project_id, revision)
);
CREATE INDEX idx_consensus_baselines_project ON consensus_baselines(project_id, revision DESC);

CREATE TABLE baseline_approvals (
  baseline_id TEXT NOT NULL REFERENCES consensus_baselines(id),
  user_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(baseline_id, user_id)
);

CREATE TABLE task_preferences (
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, task_id, user_id)
);

CREATE TABLE member_agent_profiles (
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT,
  capabilities_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, user_id, device_id)
);

CREATE TABLE submission_evidence (
  submission_id TEXT PRIMARY KEY REFERENCES work_submissions(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  submitted_by_user_id TEXT NOT NULL,
  local_checks_json TEXT NOT NULL,
  agent_report TEXT,
  bundle_digest TEXT,
  bundle_size INTEGER,
  bundle_status TEXT NOT NULL DEFAULT 'missing',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_submission_evidence_project ON submission_evidence(project_id, created_at);
`;

const coordinationMigration2 = `
CREATE TABLE device_resume_credentials (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  secret_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
`;

export const coordinationMigrations = [{ version: 1, sql: coordinationMigration1 }, { version: 2, sql: coordinationMigration2 }] as const;

export function applyCoordinationMigrations(database: SqliteDatabase): void {
  database.exec("CREATE TABLE IF NOT EXISTS coordination_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set((database.prepare("SELECT version FROM coordination_schema_migrations").all() as Array<Record<string, unknown>>).map((row) => Number(row.version)));
  for (const migration of coordinationMigrations) {
    if (applied.has(migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database.prepare("INSERT INTO coordination_schema_migrations(version, applied_at) VALUES (?,?)").run(migration.version, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

export function coordinationSchemaVersion(database: SqliteDatabase): number {
  try {
    return Number(database.prepare("SELECT MAX(version) AS version FROM coordination_schema_migrations").get()?.version ?? 0);
  } catch {
    return 0;
  }
}
