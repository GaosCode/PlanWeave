import { rm } from "node:fs/promises";
import { backingPath } from "./packageSnapshotBacking.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

const BACKING_CLEANUP_BUDGET = 256;
type CleanupRow = { rowid: number; snapshot_id: string; canvas_registry_id: string };

/** Only the physical deletion boundary may produce this retryable failure. */
export class PackageSnapshotBackingDeletionError extends Error {
  constructor(
    readonly snapshotId: string,
    readonly canvasRegistryId: string,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : "snapshot_backing_deletion_failed", { cause });
    this.name = "PackageSnapshotBackingDeletionError";
  }
}

export class PackageSnapshotBackingCleanupBatchError extends AggregateError {
  readonly physicalFailures: PackageSnapshotBackingDeletionError[];
  readonly hasNonPhysicalFailures: boolean;

  constructor(failures: unknown[]) {
    super(failures, "snapshot_retention_cleanup_failed");
    this.name = "PackageSnapshotBackingCleanupBatchError";
    this.physicalFailures = failures.filter(
      (failure): failure is PackageSnapshotBackingDeletionError =>
        failure instanceof PackageSnapshotBackingDeletionError
    );
    this.hasNonPhysicalFailures = this.physicalFailures.length !== failures.length;
  }
}

/** Revoked snapshots cannot be pinned by restore; only this terminal state owns deletion. */
export async function cleanupPackageSnapshotBacking(
  database: SqliteDatabase,
  dataDirectory: string,
  canvasRegistryId: string,
  snapshotId: string,
  at: string
): Promise<void> {
  const pending = database
    .prepare(`SELECT snapshot_id FROM package_snapshots
      WHERE snapshot_id=? AND canvas_registry_id=? AND state='revoked'
        AND restore_marker<>'restore_pending' AND backing_cleanup_completed_at IS NULL`)
    .get(snapshotId, canvasRegistryId);
  if (!pending) return;
  const path = backingPath(dataDirectory, snapshotId);
  try {
    await rm(path, { recursive: true, force: true });
  } catch (cause) {
    throw new PackageSnapshotBackingDeletionError(snapshotId, canvasRegistryId, cause);
  }
  database
    .prepare(`UPDATE package_snapshots SET backing_cleanup_completed_at=?
      WHERE snapshot_id=? AND canvas_registry_id=? AND state='revoked'
        AND restore_marker<>'restore_pending' AND backing_cleanup_completed_at IS NULL`)
    .run(at, snapshotId, canvasRegistryId);
}

/** A durable cursor advances even on filesystem failure, then wraps to retry older pending rows. */
export async function cleanupPackageSnapshotBackingBatch(
  database: SqliteDatabase,
  dataDirectory: string,
  at: string,
  canvasRegistryId?: string
): Promise<void> {
  const rows = inWriteTransaction(database, () => {
    const scope = canvasRegistryId === undefined ? "startup" : `canvas:${canvasRegistryId}`;
    const cursor = Number(
      database
        .prepare("SELECT last_rowid FROM package_snapshot_cleanup_cursors WHERE scope=?")
        .get(scope)?.last_rowid ?? 0
    );
    const canvasFilter = canvasRegistryId === undefined ? "" : "AND canvas_registry_id=?";
    const scopeArgs = canvasRegistryId === undefined ? [] : [canvasRegistryId];
    const select = (range: string, limit: number) =>
      database
        .prepare(
          `SELECT rowid,snapshot_id,canvas_registry_id FROM package_snapshots
       WHERE state='revoked' AND backing_cleanup_completed_at IS NULL
         AND restore_marker<>'restore_pending' ${canvasFilter} AND rowid${range}?
       ORDER BY rowid LIMIT ?`
        )
        .all(...scopeArgs, cursor, limit) as CleanupRow[];
    const forward = select(">", BACKING_CLEANUP_BUDGET);
    const remaining = BACKING_CLEANUP_BUDGET - forward.length;
    const batch = remaining > 0 ? [...forward, ...select("<=", remaining)] : forward;
    if (batch.length > 0)
      database
        .prepare(
          `INSERT INTO package_snapshot_cleanup_cursors(scope,last_rowid) VALUES(?,?)
       ON CONFLICT(scope) DO UPDATE SET last_rowid=excluded.last_rowid`
        )
        .run(scope, batch[batch.length - 1]!.rowid);
    return batch;
  });
  const failures: unknown[] = [];
  for (const row of rows) {
    try {
      await cleanupPackageSnapshotBacking(
        database,
        dataDirectory,
        row.canvas_registry_id,
        row.snapshot_id,
        at
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new PackageSnapshotBackingCleanupBatchError(failures);
}
