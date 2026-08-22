import type { Migration } from "./types.js";

/** Monotonic Server Runtime revision plus reset operation receipts. */
export const canvasRuntimeRevisionMigration: Migration = {
  version: 56,
  sql: `
    ALTER TABLE canvas_runtime_status_snapshots
      ADD COLUMN runtime_revision INTEGER NOT NULL DEFAULT 1;

    CREATE TABLE canvas_runtime_reset_operations (
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      intent_digest TEXT NOT NULL CHECK(length(intent_digest)=64),
      status TEXT NOT NULL CHECK(status IN ('applying','unknown','completed')),
      request_json TEXT NOT NULL,
      host_result_json TEXT,
      runtime_revision INTEGER CHECK(runtime_revision IS NULL OR runtime_revision >= 1),
      outcome_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, project_id, canvas_id, operation_id)
    );

    CREATE UNIQUE INDEX idx_canvas_runtime_reset_one_applying
      ON canvas_runtime_reset_operations(workspace_id, project_id, canvas_id)
      WHERE status IN ('applying','unknown');
  `
};
