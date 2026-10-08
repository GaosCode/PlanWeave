import { PACKAGE_SNAPSHOT_MAX_RETAINED } from "@planweave-ai/collaboration-protocol/core/limits";
import { cleanupPackageSnapshotBackingBatch } from "./packageSnapshotBackingCleanup.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

function reconcileRetentionWindow(
  database: SqliteDatabase,
  canvasRegistryId: string,
  at: string
): void {
  // Logical retention is complete before any bounded filesystem work begins.
  inWriteTransaction(database, () => {
    const boundary = database
      .prepare(
        "SELECT rowid FROM package_snapshots WHERE canvas_registry_id=? AND state='available' ORDER BY rowid DESC LIMIT 1 OFFSET ?"
      )
      .get(canvasRegistryId, PACKAGE_SNAPSHOT_MAX_RETAINED - 1);
    if (boundary)
      database
        .prepare(
          `UPDATE package_snapshots SET state='revoked',revoked_at=?,updated_at=?,retention_order=NULL
       WHERE canvas_registry_id=? AND state='available' AND rowid<? AND restore_marker<>'restore_pending'`
        )
        .run(at, at, canvasRegistryId, boundary.rowid);
    database
      .prepare(
        "UPDATE package_snapshots SET retention_order=NULL WHERE canvas_registry_id=? AND state='available'"
      )
      .run(canvasRegistryId);
    const retained = database
      .prepare(
        "SELECT snapshot_id FROM package_snapshots WHERE canvas_registry_id=? AND state='available' ORDER BY rowid DESC LIMIT ?"
      )
      .all(canvasRegistryId, PACKAGE_SNAPSHOT_MAX_RETAINED);
    retained.forEach((row, index) => {
      database
        .prepare(
          "UPDATE package_snapshots SET retention_order=?,updated_at=? WHERE snapshot_id=? AND canvas_registry_id=? AND state='available'"
        )
        .run(retained.length - index, at, row.snapshot_id, canvasRegistryId);
    });
  });
}

export async function enforcePackageSnapshotRetention(
  database: SqliteDatabase,
  dataDirectory: string,
  canvasRegistryId: string,
  at: string
): Promise<void> {
  reconcileRetentionWindow(database, canvasRegistryId, at);
  await cleanupPackageSnapshotBackingBatch(database, dataDirectory, at, canvasRegistryId);
}

/** Reconcile publication interrupted before retention, then resume one global cleanup budget. */
export async function recoverPackageSnapshotRetention(
  database: SqliteDatabase,
  dataDirectory: string,
  at: string
): Promise<void> {
  const canvases = database
    .prepare("SELECT DISTINCT canvas_registry_id FROM package_snapshots WHERE state='available'")
    .all();
  for (const canvas of canvases)
    reconcileRetentionWindow(database, String(canvas.canvas_registry_id), at);
  await cleanupPackageSnapshotBackingBatch(database, dataDirectory, at);
}
