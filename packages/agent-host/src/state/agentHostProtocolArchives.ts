import {
  historicalHostEventSchema,
  storedAcpConversationPromptCommandSchema
} from "@planweave-ai/agent-host-protocol";
import { storedCanvasRuntimeCommandIdentitySchema } from "./storedCanvasRuntimeCommandIdentity.js";
import type { SqliteDatabase } from "./sqliteDatabase.js";

export function migrateAgentHostProtocolArchives(database: SqliteDatabase): void {
  for (const table of [
    "agent_host_outbox",
    "agent_host_conversation_turns",
    "canvas_runtime_rpc_receipts"
  ]) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((column) => column.name === "protocol_archive_reason")) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN protocol_archive_reason TEXT`);
    }
  }

  for (const row of database
    .prepare(`SELECT sequence,event_key,event_json FROM agent_host_outbox
    WHERE acknowledged_at IS NULL AND protocol_archive_reason IS NULL
      AND json_extract(event_json,'$.protocolVersion')=1`)
    .all()) {
    historicalHostEventSchema.parse(JSON.parse(String(row.event_json)));
    database
      .prepare(`UPDATE agent_host_outbox SET protocol_archive_reason=?,event_key=?
      WHERE sequence=?`)
      .run(
        "stored_event_protocol_incompatible",
        `protocol-archive:v1:${row.sequence}:${row.event_key}`,
        row.sequence
      );
  }

  for (const row of database
    .prepare(`SELECT turn_id,command_json FROM agent_host_conversation_turns
    WHERE protocol_archive_reason IS NULL AND json_extract(command_json,'$.protocolVersion')=1`)
    .all()) {
    const command = storedAcpConversationPromptCommandSchema.parse(
      JSON.parse(String(row.command_json))
    );
    if (command.turnId !== row.turn_id) throw new Error("acp_conversation_identity_mismatch");
    database
      .prepare(`UPDATE agent_host_conversation_turns
      SET protocol_archive_reason=?,
        cleanup_safe=CASE WHEN status='running' THEN 0 ELSE cleanup_safe END,
        status=CASE WHEN status IN ('queued','running') THEN 'failed' ELSE status END
      WHERE turn_id=?`)
      .run("stored_command_protocol_incompatible", row.turn_id);
  }

  for (const row of database
    .prepare(`SELECT request_id,command_json FROM canvas_runtime_rpc_receipts
    WHERE protocol_archive_reason IS NULL`)
    .all()) {
    const command = storedCanvasRuntimeCommandIdentitySchema.parse(
      JSON.parse(String(row.command_json))
    );
    if (command.requestId !== row.request_id)
      throw new Error("canvas_runtime_request_identity_conflict");
    if (command.protocolVersion !== 1) continue;
    database
      .prepare(`UPDATE canvas_runtime_rpc_receipts SET protocol_archive_reason=?,
      status=CASE WHEN response_json IS NULL THEN 'reconcile_required' ELSE status END
      WHERE request_id=?`)
      .run("stored_command_protocol_incompatible", row.request_id);
  }
}
