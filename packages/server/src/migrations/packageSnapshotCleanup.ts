import type { Migration } from "./types.js";

export const packageSnapshotCleanupMigration: Migration = {
  version: 73,
  sql: `
ALTER TABLE package_snapshots ADD COLUMN backing_cleanup_completed_at TEXT
  CHECK(backing_cleanup_completed_at IS NULL OR
    (state='revoked' AND restore_marker<>'restore_pending'));
CREATE INDEX idx_package_snapshots_pending_cleanup
  ON package_snapshots(canvas_registry_id,state,backing_cleanup_completed_at)
  WHERE state='revoked' AND backing_cleanup_completed_at IS NULL
    AND restore_marker<>'restore_pending';
CREATE TABLE package_snapshot_cleanup_cursors (
  scope TEXT PRIMARY KEY,
  last_rowid INTEGER NOT NULL CHECK(last_rowid >= 0)
);
`
};
