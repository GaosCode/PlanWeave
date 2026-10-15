import type { DispatchRecord } from "./dispatches.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

type DispatchTerminalIdentity = Pick<
  DispatchRecord,
  "id" | "workspaceId" | "projectId" | "blockRef" | "hostId" | "leaseId" | "executionAttemptId"
>;

export type DispatchTerminalTransition = {
  dispatchId: string;
  type: "remote_run_succeeded" | "remote_run_failed";
  occurredAt: string;
};

/** The terminal dispatch event and its human projection share the same commit. */
export function finishDispatchTerminal(
  database: SqliteDatabase,
  input: {
    dispatch: DispatchTerminalIdentity;
    status: "completed" | "failed" | "cancelled";
    onTransitionInTransaction?: (transition: DispatchTerminalTransition) => void;
  }
): void {
  inWriteTransaction(database, () => {
    const expected = input.dispatch;
    const row = database.prepare("SELECT * FROM dispatches WHERE id=?").get(expected.id);
    if (!row) throw new Error("remote_dispatch_not_found");
    if (
      row.workspace_id !== expected.workspaceId ||
      row.project_id !== expected.projectId ||
      row.block_ref !== expected.blockRef ||
      row.host_id !== expected.hostId ||
      row.lease_id !== expected.leaseId ||
      row.execution_attempt_id !== expected.executionAttemptId
    )
      throw new Error("remote_dispatch_terminal_identity_mismatch");
    if (row.status === input.status) return;
    if (row.status !== "awaiting_writeback")
      throw new Error("remote_dispatch_not_awaiting_writeback");
    const occurredAt = new Date().toISOString();
    const updated = database
      .prepare(
        "UPDATE dispatches SET status=?,finished_at=? WHERE id=? AND status='awaiting_writeback' AND lease_id=?"
      )
      .run(input.status, occurredAt, expected.id, expected.leaseId);
    if (updated.changes !== 1) throw new Error("remote_dispatch_terminal_conflict");
    database
      .prepare(
        "INSERT INTO dispatch_events(dispatch_id,type,payload_json,occurred_at) VALUES (?,?,?,?)"
      )
      .run(expected.id, `dispatch.${input.status}`, "{}", occurredAt);
    if (input.status !== "cancelled")
      input.onTransitionInTransaction?.({
        dispatchId: expected.id,
        type: input.status === "completed" ? "remote_run_succeeded" : "remote_run_failed",
        occurredAt
      });
  });
}
