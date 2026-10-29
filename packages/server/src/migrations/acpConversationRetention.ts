import type { Migration } from "./types.js";

export const acpConversationRetentionMigration: Migration = {
  version: 77,
  sql: `
    ALTER TABLE acp_conversation_turns ADD COLUMN terminal_at TEXT;
    ALTER TABLE acp_conversation_turns ADD COLUMN compacted_at TEXT;
    CREATE INDEX acp_conversation_active_expiry
      ON acp_conversation_turns(expires_at)
      WHERE status IN ('queued','running');
    CREATE INDEX acp_conversation_retention_candidates
      ON acp_conversation_turns(terminal_at,turn_id)
      WHERE compacted_at IS NULL AND terminal_at IS NOT NULL
        AND status IN ('completed','failed','cancelled');
    CREATE INDEX acp_conversation_retention_operation
      ON acp_conversation_turns(operation_id,terminal_at DESC,turn_id DESC)
      WHERE compacted_at IS NULL AND terminal_at IS NOT NULL;
    CREATE TABLE acp_conversation_replay_receipts (
      turn_id TEXT PRIMARY KEY REFERENCES acp_conversation_turns(turn_id),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
      final_sequence INTEGER NOT NULL CHECK(final_sequence>=0),
      last_cursor INTEGER NOT NULL CHECK(last_cursor>=0)
    );
    CREATE TABLE acp_conversation_action_digests (
      action_key TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES acp_conversation_replay_receipts(turn_id),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64)
    );
    CREATE INDEX acp_conversation_action_digest_turn
      ON acp_conversation_action_digests(turn_id);
    CREATE TABLE acp_conversation_event_digests (
      turn_id TEXT NOT NULL REFERENCES acp_conversation_replay_receipts(turn_id),
      sequence INTEGER NOT NULL CHECK(sequence>0),
      event_digest TEXT NOT NULL CHECK(length(event_digest)=64),
      PRIMARY KEY(turn_id,sequence)
    );
  `,
  after(database) {
    database
      .prepare(`UPDATE acp_conversation_turns SET terminal_at=?
      WHERE status IN ('completed','failed','cancelled') AND terminal_at IS NULL`)
      .run(new Date().toISOString());
  }
};
