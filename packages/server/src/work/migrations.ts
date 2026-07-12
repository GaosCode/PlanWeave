/**
 * A2 work-coordination schema migrations.
 *
 * These are A2's v2 schema additions, kept in a separate file so the
 * A1 migration runner stays untouched. The integration step (a follow-up
 * PR after A2/A3/A4) wires this array into `migrations.ts` (option a in
 * the A2 brief) — that PR appends `workMigrations` to the existing
 * `migrations` array. The runner is idempotent (it tracks applied
 * versions in `schema_migrations`), so re-running it picks up v2
 * automatically once the array is merged.
 *
 * Tables introduced by v2:
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

const workMigration2 = `
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

export const workMigrations = [{ version: 2, sql: workMigration2 }] as const;

/**
 * Apply the work migrations to a database that has already had
 * `applyMigrations` run (i.e. schema_migrations exists). Mirrors the
 * pattern in `migrations.ts` — idempotent, BEGIN IMMEDIATE, rollback on
 * failure. The integration PR should call this after `applyMigrations`,
 * OR fold `workMigrations` into the main array.
 */
export function applyWorkMigrations(database: SqliteDatabase): void {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(database.prepare("SELECT version FROM schema_migrations").all().map((row) => Number(row.version)));
  for (const migration of workMigrations) {
    if (applied.has(migration.version)) continue;
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
