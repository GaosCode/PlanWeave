import {
  canvasRuntimeStatusProjectionSchema,
  canvasRuntimeStatusSnapshotSchema,
  type CanvasRuntimeStatusProjection,
  type CanvasRuntimeStatusSnapshot
} from "@planweave-ai/collaboration-protocol/canvas/status";
import {
  canvasScopeRefSchema,
  type CanvasScopeRef
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";

type RuntimeStatusOrigin = "import" | "execution";

type CanvasRuntimeStatusCommittedListener = (snapshot: CanvasRuntimeStatusSnapshot) => void;

function sameScope(left: CanvasScopeRef, right: CanvasScopeRef): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.canvasId === right.canvasId
  );
}

function parseSnapshot(
  status: CanvasRuntimeStatusProjection,
  runtimeRevision: number
): CanvasRuntimeStatusSnapshot {
  return canvasRuntimeStatusSnapshotSchema.parse({ runtimeRevision, status });
}

/** Durable Server authority for the shared Runtime status projection. */
export class CanvasRuntimeStatusRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date(),
    private readonly onCommittedInTransaction?: CanvasRuntimeStatusCommittedListener
  ) {}

  read(rawScope: CanvasScopeRef): CanvasRuntimeStatusSnapshot | null {
    const scope = canvasScopeRefSchema.parse(rawScope);
    const row = this.database
      .prepare(
        `SELECT package_fingerprint,status_json,runtime_revision
           FROM canvas_runtime_status_snapshots
          WHERE workspace_id=? AND project_id=? AND canvas_id=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId);
    if (!row) return null;
    const status = canvasRuntimeStatusProjectionSchema.parse(JSON.parse(String(row.status_json)));
    if (
      !sameScope(status.scope, scope) ||
      status.packageFingerprint !== String(row.package_fingerprint)
    ) {
      throw new Error("canvas_runtime_status_snapshot_corrupt");
    }
    return parseSnapshot(status, Number(row.runtime_revision));
  }

  initialize(rawStatus: CanvasRuntimeStatusProjection): CanvasRuntimeStatusSnapshot {
    const status = canvasRuntimeStatusProjectionSchema.parse(rawStatus);
    return inWriteTransaction(this.database, () => {
      const existing = this.read(status.scope);
      if (existing) {
        if (JSON.stringify(existing.status) !== JSON.stringify(status)) {
          throw new Error("canvas_runtime_status_already_initialized");
        }
        return existing;
      }
      this.write(status, "import", false, 1);
      return this.readCommitted(status.scope);
    });
  }

  replaceFromExecution(rawStatus: CanvasRuntimeStatusProjection): CanvasRuntimeStatusSnapshot {
    const status = canvasRuntimeStatusProjectionSchema.parse(rawStatus);
    return inWriteTransaction(this.database, () => {
      const existing = this.read(status.scope);
      const runtimeRevision = existing ? existing.runtimeRevision + 1 : 1;
      this.write(status, "execution", true, runtimeRevision);
      return this.readCommitted(status.scope);
    });
  }

  private readCommitted(scope: CanvasScopeRef): CanvasRuntimeStatusSnapshot {
    const snapshot = this.read(scope);
    if (!snapshot) throw new Error("canvas_runtime_status_snapshot_missing");
    this.onCommittedInTransaction?.(snapshot);
    return snapshot;
  }

  private write(
    status: CanvasRuntimeStatusProjection,
    origin: RuntimeStatusOrigin,
    replace: boolean,
    runtimeRevision: number
  ): void {
    const values = [
      status.scope.workspaceId,
      status.scope.projectId,
      status.scope.canvasId,
      status.packageFingerprint,
      JSON.stringify(status),
      origin,
      this.clock().toISOString(),
      runtimeRevision
    ] as const;
    if (!replace) {
      this.database
        .prepare(
          `INSERT INTO canvas_runtime_status_snapshots(
             workspace_id,project_id,canvas_id,package_fingerprint,status_json,origin,updated_at,runtime_revision
           ) VALUES(?,?,?,?,?,?,?,?)`
        )
        .run(...values);
      return;
    }
    this.database
      .prepare(
        `INSERT INTO canvas_runtime_status_snapshots(
           workspace_id,project_id,canvas_id,package_fingerprint,status_json,origin,updated_at,runtime_revision
         ) VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(workspace_id,project_id,canvas_id) DO UPDATE SET
           package_fingerprint=excluded.package_fingerprint,
           status_json=excluded.status_json,
           origin=excluded.origin,
           updated_at=excluded.updated_at,
           runtime_revision=excluded.runtime_revision`
      )
      .run(...values);
  }
}
