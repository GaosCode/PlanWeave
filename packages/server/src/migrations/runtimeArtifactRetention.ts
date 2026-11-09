import type { Migration } from "./types.js";

export const runtimeArtifactRetentionMigration: Migration = {
  version: 80,
  sql: `
    CREATE INDEX idx_canvas_runtime_leases_retention
      ON canvas_runtime_leases(
        MAX(expires_at, CASE WHEN status='active' THEN expires_at ELSE updated_at END),
        runtime_lease_id
      );
    CREATE INDEX idx_canvas_runtime_artifact_grants_retention
      ON canvas_runtime_artifact_grants(runtime_lease_id,grant_id);
  `
};
