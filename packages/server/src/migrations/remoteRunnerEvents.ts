import type { Migration } from "./types.js";
import type { SqliteDatabase } from "../sqlite.js";
import { columnExists, tableExists } from "./schemaIntrospection.js";

function ensureRemoteRunnerEventColumns(database: SqliteDatabase): void {
  if (
    !tableExists(database, "remote_acp_event_streams") ||
    !tableExists(database, "remote_acp_events")
  ) {
    throw new Error("remote_runner_event_tables_missing");
  }
  if (!columnExists(database, "remote_acp_event_streams", "event_protocol_version")) {
    database.exec(
      "ALTER TABLE remote_acp_event_streams ADD COLUMN event_protocol_version INTEGER NOT NULL DEFAULT 1 CHECK(event_protocol_version IN (1,2))"
    );
  }
  if (!columnExists(database, "remote_acp_event_streams", "usage_source_sequence")) {
    database.exec("ALTER TABLE remote_acp_event_streams ADD COLUMN usage_source_sequence INTEGER");
  }
  if (!columnExists(database, "remote_acp_event_streams", "usage_snapshot_json")) {
    database.exec("ALTER TABLE remote_acp_event_streams ADD COLUMN usage_snapshot_json TEXT");
  }
  if (!columnExists(database, "remote_acp_events", "event_version")) {
    database.exec(
      "ALTER TABLE remote_acp_events ADD COLUMN event_version INTEGER NOT NULL DEFAULT 1 CHECK(event_version IN (1,2))"
    );
  }
}

export const remoteRunnerEventsMigration: Migration = {
  version: 65,
  sql: "SELECT 1;",
  before: ensureRemoteRunnerEventColumns
};
