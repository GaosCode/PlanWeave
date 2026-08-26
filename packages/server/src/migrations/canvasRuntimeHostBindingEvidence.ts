import { columnExists } from "./schemaIntrospection.js";
import type { Migration } from "./types.js";
import type { SqliteDatabase } from "../sqlite.js";

function ensureCanvasRuntimeHostBindingEvidence(database: SqliteDatabase): void {
  if (!columnExists(database, "canvas_runtime_host_bindings", "operation_id")) {
    database.exec("ALTER TABLE canvas_runtime_host_bindings ADD COLUMN operation_id TEXT");
  }
  if (!columnExists(database, "canvas_runtime_host_bindings", "execution_attempt_id")) {
    database.exec("ALTER TABLE canvas_runtime_host_bindings ADD COLUMN execution_attempt_id TEXT");
  }
  if (!columnExists(database, "canvas_runtime_host_bindings", "host_generation")) {
    database.exec("ALTER TABLE canvas_runtime_host_bindings ADD COLUMN host_generation TEXT");
  }
  if (!columnExists(database, "canvas_runtime_host_bindings", "content_revision")) {
    database.exec("ALTER TABLE canvas_runtime_host_bindings ADD COLUMN content_revision INTEGER");
  }
  if (!columnExists(database, "canvas_runtime_host_bindings", "graph_fingerprint")) {
    database.exec("ALTER TABLE canvas_runtime_host_bindings ADD COLUMN graph_fingerprint TEXT");
  }
}

/** Operation-scoped evidence on the existing Canvas Runtime binding table. PK unchanged. */
export const canvasRuntimeHostBindingEvidenceMigration: Migration = {
  version: 62,
  sql: "SELECT 1;",
  before: ensureCanvasRuntimeHostBindingEvidence
};
