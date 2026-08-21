import type { Migration } from "./types.js";

export const canvasRuntimeStatusMigration: Migration = {
  version: 53,
  sql: `
    CREATE TABLE canvas_runtime_status_snapshots (
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      package_fingerprint TEXT NOT NULL,
      status_json TEXT NOT NULL,
      origin TEXT NOT NULL CHECK(origin IN ('import','execution')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,project_id,canvas_id)
    );

    CREATE INDEX idx_canvas_runtime_status_snapshots_updated
      ON canvas_runtime_status_snapshots(updated_at);
  `
};
