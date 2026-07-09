import type { PlanGraphProjectionVersion } from "../ports.js";
import { stringColumn } from "./columns.js";
import type { SqliteDatabase } from "./connection.js";

export function projectionVersion(row: Record<string, unknown>): PlanGraphProjectionVersion {
  return {
    projectionName: stringColumn(row, "projection_name"),
    graphVersion: stringColumn(row, "graph_version"),
    projectionVersion: stringColumn(row, "projection_version"),
    cacheKey: stringColumn(row, "cache_key"),
    updatedAt: stringColumn(row, "updated_at")
  };
}

export function readProjectionVersion(
  db: SqliteDatabase,
  graphKey: string,
  projectionName: string,
  cacheKey: string
): PlanGraphProjectionVersion | null {
  const row = db
    .prepare(
      "SELECT * FROM projection_versions WHERE project_root = ? AND projection_name = ? AND cache_key = ?"
    )
    .get(graphKey, projectionName, cacheKey);
  return row ? projectionVersion(row) : null;
}

export function writeProjectionVersion(
  db: SqliteDatabase,
  graphKey: string,
  projection: PlanGraphProjectionVersion
): void {
  db.prepare(
    `INSERT OR REPLACE INTO projection_versions
     (project_root, projection_name, graph_version, projection_version, cache_key, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    graphKey,
    projection.projectionName,
    projection.graphVersion,
    projection.projectionVersion,
    projection.cacheKey,
    projection.updatedAt
  );
}

export function clearProjectionVersions(db: SqliteDatabase, graphKey: string): void {
  db.prepare("DELETE FROM projection_versions WHERE project_root = ?").run(graphKey);
}
