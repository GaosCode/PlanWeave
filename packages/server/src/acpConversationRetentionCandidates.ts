import { z } from "zod";
import type { SqliteDatabase } from "./sqlite.js";

const keySchema = z.object({ turn_id: z.string(), terminal_at: z.string() });
type Key = z.infer<typeof keySchema>;
const terminal = "status IN ('completed','failed','cancelled')";
const complete = `compacted_at IS NULL AND terminal_at IS NOT NULL AND ${terminal}`;

export class AcpConversationRetentionCandidates {
  private cursor: Key | undefined;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly batchSize: number,
    private readonly fullPerOperation: number
  ) {}

  read(cutoff: string): Key[] {
    return this.database
      .prepare(`SELECT turn_id,terminal_at FROM acp_conversation_turns
      INDEXED BY acp_conversation_retention_candidates
      WHERE ${complete} AND terminal_at<?
      ${this.cursor ? "AND (terminal_at,turn_id)>(?,?)" : ""}
      ORDER BY terminal_at,turn_id LIMIT ?`)
      .all(
        cutoff,
        ...(this.cursor ? [this.cursor.terminal_at, this.cursor.turn_id] : []),
        this.batchSize
      )
      .map((row) => keySchema.parse(row));
  }

  advance(rows: Key[]) {
    this.cursor = rows.length === this.batchSize ? rows.at(-1) : undefined;
  }

  eligible(turnId: string, cutoff: string) {
    const turn = this.database
      .prepare(`SELECT turn_id,terminal_at,operation_id,host_id,session_id
      FROM acp_conversation_turns WHERE turn_id=? AND ${complete} AND terminal_at<?`)
      .get(turnId, cutoff);
    if (!turn) return false;
    const boundary = this.database
      .prepare(`SELECT turn_id,terminal_at FROM acp_conversation_turns
      INDEXED BY acp_conversation_retention_operation
      WHERE operation_id=? AND ${complete}
      ORDER BY terminal_at DESC,turn_id DESC LIMIT 1 OFFSET ?`)
      .get(turn.operation_id, this.fullPerOperation - 1);
    if (!boundary) return false;
    const key = keySchema.parse(turn);
    const protectedKey = keySchema.parse(boundary);
    if (
      key.terminal_at > protectedKey.terminal_at ||
      (key.terminal_at === protectedKey.terminal_at && key.turn_id >= protectedKey.turn_id)
    )
      return false;
    if (
      this.database
        .prepare(`SELECT turn_id FROM acp_conversation_turns
      WHERE host_id=? AND session_id=? AND status IN ('queued','running') LIMIT 1`)
        .get(turn.host_id, turn.session_id)
    )
      return false;
    if (
      this.database
        .prepare(`SELECT id FROM remote_operations
      WHERE id=? AND state NOT IN ('completed','failed','cancelled')`)
        .get(turn.operation_id)
    )
      return false;
    return !this.database
      .prepare(`SELECT source_operation_id FROM acp_task_restorations restoration
      WHERE host_id=? AND session_id=? AND (restored_operation_id IS NULL OR EXISTS (
        SELECT 1 FROM remote_operations operation WHERE operation.id=restoration.restored_operation_id
          AND operation.state NOT IN ('completed','failed','cancelled'))) LIMIT 1`)
      .get(turn.host_id, turn.session_id);
  }
}
