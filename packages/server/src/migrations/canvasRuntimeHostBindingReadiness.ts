import type { Migration } from "./types.js";

export const canvasRuntimeHostBindingReadinessMigration: Migration = {
  version: 66,
  sql: `
    DROP INDEX IF EXISTS idx_canvas_runtime_host_binding_selected_route;
    CREATE TABLE canvas_runtime_host_bindings_v66_new (
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      host_id TEXT NOT NULL REFERENCES agent_hosts(id),
      readiness_status TEXT NOT NULL CHECK(readiness_status IN ('ready','missing','invalid')),
      first_observed_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,project_id,host_id)
    );
    INSERT INTO canvas_runtime_host_bindings_v66_new(
      workspace_id,project_id,host_id,readiness_status,first_observed_at,last_observed_at
    )
    SELECT workspace_id,project_id,host_id,readiness_status,first_observed_at,last_observed_at
    FROM canvas_runtime_host_bindings;
    DROP TABLE canvas_runtime_host_bindings;
    ALTER TABLE canvas_runtime_host_bindings_v66_new RENAME TO canvas_runtime_host_bindings;
    CREATE INDEX idx_canvas_runtime_host_bindings_host
      ON canvas_runtime_host_bindings(host_id,workspace_id,project_id);
  `
};
