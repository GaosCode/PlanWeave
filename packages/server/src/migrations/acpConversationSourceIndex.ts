import type { Migration } from "./types.js";

export const acpConversationSourceIndexMigration: Migration = {
  version: 79,
  before(database) {
    const invalid = database
      .prepare(`SELECT sequence,message_id FROM mailbox_messages
        WHERE NOT json_valid(command_json) ORDER BY sequence LIMIT 1`)
      .get();
    if (invalid) {
      throw new Error(
        `mailbox_command_json_invalid:sequence=${invalid.sequence}:message_id=${invalid.message_id}`
      );
    }
  },
  sql: `CREATE INDEX idx_mailbox_host_execution_attempt_sequence
    ON mailbox_messages(host_id,json_extract(command_json,'$.executionAttemptId'),sequence)
    WHERE json_extract(command_json,'$.type')='execute_block';`
};
