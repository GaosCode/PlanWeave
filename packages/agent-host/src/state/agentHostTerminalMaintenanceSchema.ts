import type { SqliteDatabase } from "./sqliteDatabase.js";

const validJsonField = (column: "command_json" | "event_json", field: string): string =>
  `CASE WHEN json_valid(${column}) THEN json_extract(${column},'$.${field}') END`;

export const inboxDispatchIdSql = validJsonField("command_json", "dispatchId");
export const inboxAttemptIdSql = validJsonField("command_json", "executionAttemptId");
export const outboxDispatchIdSql = validJsonField("event_json", "dispatchId");
export const outboxAttemptIdSql = validJsonField("event_json", "executionAttemptId");
export const outboxMailboxSequenceSql = validJsonField("event_json", "sequence");
export const MAILBOX_REPLAY_ACK_KEY_PREFIX = "mailbox.replay_ack:";
export const acknowledgedReplayAckSql = `acknowledged_at IS NOT NULL AND event_key GLOB '${MAILBOX_REPLAY_ACK_KEY_PREFIX}*'`;
export const outboxOriginalMailboxAckSql = `${validJsonField("event_json", "type")}='mailbox.ack' AND event_key NOT GLOB '${MAILBOX_REPLAY_ACK_KEY_PREFIX}*'`;
const pendingOriginalMailboxAckSql = `o.acknowledged_at IS NULL AND ${outboxOriginalMailboxAckSql}`;
export const acknowledgedTerminalExecutionSql =
  "status IN ('completed','failed','cancelled') AND terminal_acknowledged_at IS NOT NULL";

export function initializeTerminalMaintenanceIndexes(
  database: SqliteDatabase,
  backfill: boolean
): void {
  initializePendingMailboxAcks(database, backfill);
  initializeMailboxReceiptCount(database, backfill);
}

function initializeMailboxReceiptCount(database: SqliteDatabase, backfill: boolean): void {
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS agent_host_count_mailbox_receipt_insert
      AFTER INSERT ON agent_host_compacted_mailbox_receipts BEGIN
        UPDATE agent_host_receipt_counts SET mailbox_count=mailbox_count+1 WHERE singleton=1;
      END;
    CREATE TRIGGER IF NOT EXISTS agent_host_count_mailbox_receipt_delete
      AFTER DELETE ON agent_host_compacted_mailbox_receipts BEGIN
        UPDATE agent_host_receipt_counts SET mailbox_count=mailbox_count-1 WHERE singleton=1;
      END;
  `);
  if (backfill) {
    database.exec(`
      INSERT INTO agent_host_receipt_counts(singleton,mailbox_count)
      SELECT 1,(SELECT COUNT(*) FROM agent_host_compacted_mailbox_receipts)
      ON CONFLICT(singleton) DO UPDATE SET mailbox_count=excluded.mailbox_count;
    `);
  }
  if (!database.prepare("SELECT 1 FROM agent_host_receipt_counts WHERE singleton=1").get()) {
    throw new Error("agent_host_state_schema_incomplete");
  }
}

function initializePendingMailboxAcks(database: SqliteDatabase, backfill: boolean): void {
  const columns = "outbox_sequence,mailbox_sequence,dispatch_id,execution_attempt_id";
  const select = `SELECT o.sequence,${outboxMailboxSequenceSql},${inboxDispatchIdSql},${inboxAttemptIdSql}
                  FROM agent_host_outbox o
                  LEFT JOIN agent_host_inbox i ON i.sequence=${outboxMailboxSequenceSql}
                  WHERE ${pendingOriginalMailboxAckSql}
                    AND typeof(${outboxMailboxSequenceSql})='integer'`;
  const indexOne = `INSERT INTO agent_host_pending_mailbox_acks(${columns})
                    ${select} AND o.sequence=NEW.sequence;`;
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS agent_host_index_pending_mailbox_ack_insert
      AFTER INSERT ON agent_host_outbox BEGIN
        ${indexOne}
      END;
    CREATE TRIGGER IF NOT EXISTS agent_host_index_pending_mailbox_ack_update
      AFTER UPDATE OF acknowledged_at,event_json,event_key ON agent_host_outbox BEGIN
        DELETE FROM agent_host_pending_mailbox_acks WHERE outbox_sequence=OLD.sequence;
        ${indexOne}
      END;
    CREATE TRIGGER IF NOT EXISTS agent_host_index_pending_mailbox_ack_delete
      AFTER DELETE ON agent_host_outbox BEGIN
        DELETE FROM agent_host_pending_mailbox_acks WHERE outbox_sequence=OLD.sequence;
      END;
  `);
  if (backfill) {
    database.exec(`
      DELETE FROM agent_host_pending_mailbox_acks;
      INSERT INTO agent_host_pending_mailbox_acks(${columns}) ${select};
    `);
  }
}
