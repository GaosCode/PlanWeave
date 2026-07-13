import type { SqliteDatabase } from "../sqlite.js";

const proposalsMigrations = [
  {
    version: 4,
    sql: `
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  current_revision_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_proposals_project_id ON proposals(project_id);
CREATE TABLE proposal_revisions (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  revision_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  citations_json TEXT NOT NULL DEFAULT '[]',
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE(proposal_id, revision_number)
);
CREATE INDEX idx_proposal_revisions_proposal_id ON proposal_revisions(proposal_id);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  revision_id TEXT NOT NULL REFERENCES proposal_revisions(id),
  approver_user_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(revision_id, approver_user_id)
);
CREATE INDEX idx_approvals_revision_id ON approvals(revision_id);
CREATE INDEX idx_approvals_proposal_id ON approvals(proposal_id);
`
  }
] as const;

function applyMigrationsToDatabase(database: SqliteDatabase, migrations: readonly { version: number; sql: string }[]): void {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(database.prepare("SELECT version FROM schema_migrations").all().map((row) => Number(row.version)));
  for (const migration of migrations) {
    if (!applied.has(migration.version)) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(migration.sql);
        database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, new Date().toISOString());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  }
}

export function applyProposalsMigrations(database: SqliteDatabase): void {
  applyMigrationsToDatabase(database, proposalsMigrations);
}

export { proposalsMigrations };
