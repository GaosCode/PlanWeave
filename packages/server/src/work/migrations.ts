/**
 * A2 work-coordination schema migrations.
 *
 * Integration: this file uses its OWN `work_schema_migrations` tracker
 * (rather than the central `schema_migrations` table) so the work
 * module can be versioned independently of A3's identity/planning/
 * proposals/attachments modules. The integration PR calls
 * `applyWorkMigrations` from `lifecycle.ts` after `applyMigrations` and
 * the per-module A3 migrations.
 *
 * Tables introduced by v1:
 *  - work_tasks                — server bindings for PlanWeave task ids
 *  - work_task_dependencies    — frozen dep snapshot for read-time checks
 *  - work_assignments          — claim/lease rows; one active per task via
 *                                UNIQUE partial index
 *  - work_submissions          — submitted head commits per assignment
 *  - work_reviews              — review verdicts attached to submissions
 *
 * Note: this is purely an addition; the v1 schema is unchanged.
 */

import type { SqliteDatabase } from "../sqlite.js";

const workMigration1 = `
CREATE TABLE work_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  parallel INTEGER NOT NULL,
  locks_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, task_id)
);
CREATE INDEX idx_work_tasks_project ON work_tasks(project_id, status);

CREATE TABLE work_task_dependencies (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  PRIMARY KEY(project_id, task_id, depends_on_task_id),
  FOREIGN KEY(task_id) REFERENCES work_tasks(id)
);
CREATE INDEX idx_work_task_dependencies_depends_on ON work_task_dependencies(project_id, depends_on_task_id);

CREATE TABLE work_assignments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  assignee_user_id TEXT NOT NULL,
  assignee_device_id TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  branch_name TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  current_submission_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_work_assignments_project_task ON work_assignments(project_id, task_id, status);
CREATE INDEX idx_work_assignments_lease ON work_assignments(status, lease_expires_at);

/*
 * One active assignment per (project, task). The partial index makes the
 * "exactly one active assignment" rule a hard database invariant; it is
 * the authoritative serialization point for the conditional claim.
 *
 * SQLite supports partial unique indexes; node:sqlite surfaces UNIQUE
 * constraint failures as ERR_SQLITE_ERROR, which we map to a
 * WorkError("state_conflict", { policyConflict: ... }).
 */
CREATE UNIQUE INDEX uq_work_assignments_one_active
  ON work_assignments(project_id, task_id)
  WHERE status = 'active';

CREATE TABLE work_submissions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  assignment_id TEXT NOT NULL REFERENCES work_assignments(id),
  head_commit TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_work_submissions_assignment ON work_submissions(assignment_id, status);

CREATE TABLE work_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  submission_id TEXT NOT NULL REFERENCES work_submissions(id),
  assignment_id TEXT NOT NULL REFERENCES work_assignments(id),
  reviewer_user_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  comments TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_work_reviews_submission ON work_reviews(submission_id);
`;

const workMigration2 = `
ALTER TABLE work_tasks ADD COLUMN ownership_scopes_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE work_tasks ADD COLUMN acceptance_checks_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE work_tasks ADD COLUMN reviewers_json TEXT NOT NULL DEFAULT '[]';
`;

export const workMigrations = [{ version: 1, sql: workMigration1 }, { version: 2, sql: workMigration2 }] as const;

/**
 * Apply the work migrations. Uses the private `work_schema_migrations`
 * tracker so it is independent of the central `schema_migrations` table
 * and of A3's per-module trackers. Idempotent, BEGIN IMMEDIATE, rollback
 * on failure. The integration PR calls this from `lifecycle.ts` after
 * `applyMigrations` and the per-module A3 migrations.
 */
export function applyWorkMigrations(database: SqliteDatabase): void {
  database.exec("CREATE TABLE IF NOT EXISTS work_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(
    (database.prepare("SELECT version FROM work_schema_migrations").all() as Array<Record<string, unknown>>).map((row) => Number(row.version))
  );
  for (const migration of workMigrations) {
    if (applied.has(migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database.prepare("INSERT INTO work_schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

export function workSchemaVersion(database: SqliteDatabase): number {
  try {
    const row = database.prepare("SELECT MAX(version) AS version FROM work_schema_migrations").get() as { version: number | null } | undefined;
    return Number(row?.version ?? 0);
  } catch {
    return 0;
  }
}
