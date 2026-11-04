import {
  acpConversationActionSchema,
  storedAcpConversationEventSchema
} from "@planweave-ai/agent-host-protocol";
import { acpConversationDigest } from "./acpConversationReplay.js";
import { AcpConversationRetentionCandidates } from "./acpConversationRetentionCandidates.js";
import { expireAcpConversationTurns } from "./acpConversationExpiry.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const FULL_PER_OPERATION = 20;
const BATCH_SIZE = 25;

export class AcpConversationRetention {
  private readonly candidates: AcpConversationRetentionCandidates;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date()
  ) {
    this.candidates = new AcpConversationRetentionCandidates(
      database,
      BATCH_SIZE,
      FULL_PER_OPERATION
    );
  }

  compactBatch() {
    const now = this.clock();
    const timestamp = now.toISOString();
    const expired = inWriteTransaction(this.database, () =>
      expireAcpConversationTurns(this.database, timestamp, { limit: BATCH_SIZE })
    );
    const cutoff = new Date(now.getTime() - MAX_AGE_MS).toISOString();
    const rows = this.candidates.read(cutoff);
    const result = inWriteTransaction(this.database, () => {
      let compacted = 0;
      for (const row of rows) {
        if (!this.candidates.eligible(row.turn_id, cutoff)) continue;
        this.compact(row.turn_id, timestamp);
        compacted++;
      }
      return { selected: rows.length, compacted, skipped: rows.length - compacted, expired };
    });
    this.candidates.advance(rows);
    return result;
  }

  private compact(turnId: string, timestamp: string) {
    const turn = this.database
      .prepare("SELECT * FROM acp_conversation_turns WHERE turn_id=?")
      .get(turnId)!;
    const request = acpConversationActionSchema.parse(JSON.parse(String(turn.request_json)));
    if (
      request.kind !== "prompt" ||
      request.turnId !== turnId ||
      request.executionAttemptId !== turn.execution_attempt_id ||
      request.sessionId !== turn.session_id
    )
      throw new Error("acp_conversation_retention_request_identity_mismatch");
    const events = this.database
      .prepare("SELECT * FROM acp_conversation_events WHERE turn_id=? ORDER BY sequence")
      .all(turnId);
    if (events.length !== Number(turn.last_sequence))
      throw new Error("acp_conversation_retention_event_sequence_incomplete");
    let lastCursor = 0;
    const digests = events.map((row, index) => {
      const event = storedAcpConversationEventSchema.parse(JSON.parse(String(row.event_json)));
      if (
        event.sequence !== index + 1 ||
        event.sequence !== row.sequence ||
        event.turnId !== turnId ||
        event.operationId !== turn.operation_id ||
        event.executionAttemptId !== turn.execution_attempt_id ||
        event.sessionId !== turn.session_id
      )
        throw new Error("acp_conversation_retention_event_identity_mismatch");
      lastCursor = Math.max(lastCursor, Number(row.cursor));
      return { sequence: event.sequence, digest: acpConversationDigest(event) };
    });
    this.database
      .prepare(`INSERT INTO acp_conversation_replay_receipts
      (turn_id,request_digest,final_sequence,last_cursor) VALUES(?,?,?,?)`)
      .run(turnId, acpConversationDigest(request), turn.last_sequence, lastCursor);
    for (const event of digests)
      this.database
        .prepare(`INSERT INTO acp_conversation_event_digests
      (turn_id,sequence,event_digest) VALUES(?,?,?)`)
        .run(turnId, event.sequence, event.digest);
    const actions = this.database
      .prepare("SELECT * FROM acp_conversation_actions WHERE turn_id=?")
      .all(turnId);
    for (const row of actions) {
      const action = acpConversationActionSchema.parse(JSON.parse(String(row.request_json)));
      if (
        (action.kind !== "respond" && action.kind !== "cancel") ||
        action.turnId !== turnId ||
        action.executionAttemptId !== turn.execution_attempt_id ||
        action.sessionId !== turn.session_id
      )
        throw new Error("acp_conversation_retention_action_identity_mismatch");
      this.database
        .prepare(`INSERT INTO acp_conversation_action_digests
        (action_key,turn_id,request_digest) VALUES(?,?,?)`)
        .run(row.action_key, turnId, acpConversationDigest(action));
    }
    this.database.prepare("DELETE FROM acp_conversation_events WHERE turn_id=?").run(turnId);
    this.database.prepare("DELETE FROM acp_conversation_actions WHERE turn_id=?").run(turnId);
    this.database
      .prepare(
        "UPDATE acp_conversation_turns SET request_json='null',compacted_at=? WHERE turn_id=?"
      )
      .run(timestamp, turnId);
  }
}
