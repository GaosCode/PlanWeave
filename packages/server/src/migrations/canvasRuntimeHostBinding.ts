import type { Migration } from "./types.js";

/** Persists only logical Canvas-to-Host bindings; Host filesystem locations remain private. */
export const canvasRuntimeHostBindingMigration: Migration = {
  version: 51,
  sql: `
    CREATE TABLE canvas_runtime_host_bindings (
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      host_id TEXT NOT NULL REFERENCES agent_hosts(id),
      readiness_status TEXT NOT NULL CHECK(readiness_status IN ('ready','missing','invalid')),
      first_observed_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,project_id,host_id)
    );
    CREATE INDEX idx_canvas_runtime_host_bindings_host
      ON canvas_runtime_host_bindings(host_id,workspace_id,project_id);
  `
};
