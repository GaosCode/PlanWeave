import type { SqliteDatabase } from "./sqlite.js";

export function expireAcpConversationTurns(
  database: SqliteDatabase,
  now: string,
  scope: { hostId: string; sessionId: string } | { limit: number }
): number {
  const scoped = "hostId" in scope;
  return database
    .prepare(`UPDATE acp_conversation_turns
    SET status='failed',error='acp_conversation_deadline_exceeded',terminal_at=COALESCE(terminal_at,?)
    WHERE turn_id IN (SELECT turn_id FROM acp_conversation_turns
      WHERE status IN ('queued','running') AND expires_at<=?
      ${scoped ? "AND host_id=? AND session_id=?" : "ORDER BY expires_at LIMIT ?"})`)
    .run(now, now, ...(scoped ? [scope.hostId, scope.sessionId] : [scope.limit])).changes;
}
