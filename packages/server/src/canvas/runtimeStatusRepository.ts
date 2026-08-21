import {
  canvasRuntimeStatusProjectionSchema,
  type CanvasRuntimeStatusProjection
} from "@planweave-ai/collaboration-protocol/canvas/status";
import {
  canvasScopeRefSchema,
  type CanvasScopeRef
} from "@planweave-ai/collaboration-protocol/core/primitives";
import type { SqliteDatabase } from "../sqlite.js";

type RuntimeStatusOrigin = "import" | "execution";

function sameScope(left: CanvasScopeRef, right: CanvasScopeRef): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.canvasId === right.canvasId
  );
}

/** Durable Server authority for the shared Runtime status projection. */
export class CanvasRuntimeStatusRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date()
  ) {}

  read(rawScope: CanvasScopeRef): CanvasRuntimeStatusProjection | null {
    const scope = canvasScopeRefSchema.parse(rawScope);
    const row = this.database
      .prepare(
        `SELECT package_fingerprint,status_json
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
    return status;
  }

  initialize(rawStatus: CanvasRuntimeStatusProjection): CanvasRuntimeStatusProjection {
    const status = canvasRuntimeStatusProjectionSchema.parse(rawStatus);
    const existing = this.read(status.scope);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(status)) {
        throw new Error("canvas_runtime_status_already_initialized");
      }
      return existing;
    }
    this.write(status, "import", false);
    return this.read(status.scope)!;
  }

  replaceFromExecution(rawStatus: CanvasRuntimeStatusProjection): CanvasRuntimeStatusProjection {
    const status = canvasRuntimeStatusProjectionSchema.parse(rawStatus);
    this.write(status, "execution", true);
    return this.read(status.scope)!;
  }

  private write(
    status: CanvasRuntimeStatusProjection,
    origin: RuntimeStatusOrigin,
    replace: boolean
  ): void {
    const values = [
      status.scope.workspaceId,
      status.scope.projectId,
      status.scope.canvasId,
      status.packageFingerprint,
      JSON.stringify(status),
      origin,
      this.clock().toISOString()
    ] as const;
    if (!replace) {
      this.database
        .prepare(
          `INSERT INTO canvas_runtime_status_snapshots(
             workspace_id,project_id,canvas_id,package_fingerprint,status_json,origin,updated_at
           ) VALUES(?,?,?,?,?,?,?)`
        )
        .run(...values);
      return;
    }
    this.database
      .prepare(
        `INSERT INTO canvas_runtime_status_snapshots(
           workspace_id,project_id,canvas_id,package_fingerprint,status_json,origin,updated_at
         ) VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(workspace_id,project_id,canvas_id) DO UPDATE SET
           package_fingerprint=excluded.package_fingerprint,
           status_json=excluded.status_json,
           origin=excluded.origin,
           updated_at=excluded.updated_at`
      )
      .run(...values);
  }
}
