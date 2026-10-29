import type { Migration } from "./types.js";

export const acpConversationEventCursorMigration: Migration = {
  version: 76,
  sql: `
    CREATE INDEX acp_conversation_event_cursor
      ON acp_conversation_events(turn_id,cursor);
  `
};
