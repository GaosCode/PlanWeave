import { z } from "zod";
import type { SqliteDatabase } from "./sqlite.js";

const terminal = "state IN ('completed','failed','cancelled')";
const index = "idx_remote_operation_retention_scope_terminal";
const scopeSchema = z.object({
  workspace_id: z.string(),
  project_id: z.string(),
  canvas_id: z.string()
});
const keySchema = z.object({ id: z.string(), terminal_at: z.string() });
type Scope = z.infer<typeof scopeSchema>;
type Key = z.infer<typeof keySchema>;

function isBeforeBoundary(key: Key, boundary: Key | undefined): boolean {
  return (
    !boundary ||
    key.terminal_at < boundary.terminal_at ||
    (key.terminal_at === boundary.terminal_at && key.id < boundary.id)
  );
}

// A pass visits one scope and one raw page. Receipts and unsafe children do not
// affect page boundaries, so neither can turn LIMIT into an unbounded search.
export class RemoteOperationRetentionCandidates {
  private lastScope: Scope | undefined;
  private readonly cursors = new Map<string, Key>();

  constructor(
    private readonly database: SqliteDatabase,
    private readonly fullPerScope: number,
    private readonly pageSize: number
  ) {}

  read(cutoff: string) {
    const scopeSql = `SELECT workspace_id,project_id,canvas_id FROM remote_operations INDEXED BY ${index}
      WHERE ${terminal}`;
    // Seek each scope level separately. A vector range on the three-column
    // prefix can still walk every operation sharing the current scope.
    let row: Record<string, unknown> | undefined;
    if (this.lastScope) {
      const [workspace, project, canvas] = this.scopeValues(this.lastScope);
      row = this.database
        .prepare(`${scopeSql}
        AND workspace_id=? AND project_id=? AND canvas_id>?
        ORDER BY canvas_id LIMIT 1`)
        .get(workspace, project, canvas);
      row ??= this.database
        .prepare(`${scopeSql}
        AND workspace_id=? AND project_id>?
        ORDER BY project_id,canvas_id LIMIT 1`)
        .get(workspace, project);
      row ??= this.database
        .prepare(`${scopeSql}
        AND workspace_id>?
        ORDER BY workspace_id,project_id,canvas_id LIMIT 1`)
        .get(workspace);
    }
    row ??= this.database
      .prepare(`${scopeSql}
      ORDER BY workspace_id,project_id,canvas_id LIMIT 1`)
      .get();
    if (!row) return undefined;
    const scope = scopeSchema.parse(row);
    const scopeId = JSON.stringify(this.scopeValues(scope));
    const cursor = this.cursors.get(scopeId);
    const boundary = this.boundary(scope);
    const conditions = [
      `${terminal}`,
      "workspace_id=? AND project_id=? AND canvas_id=?",
      "terminal_at<?"
    ];
    const values: (string | number)[] = [...this.scopeValues(scope), cutoff];
    if (!boundary && this.fullPerScope > 0) {
      return { scope, scopeId, rows: [] as Key[], ids: [] as string[] };
    }
    if (cursor) {
      conditions.push("(terminal_at,id)>(?,?)");
      values.push(cursor.terminal_at, cursor.id);
    }
    const rows = this.database
      .prepare(`SELECT id,terminal_at FROM remote_operations INDEXED BY ${index}
      WHERE ${conditions.join(" AND ")} ORDER BY terminal_at,id LIMIT ?`)
      .all(...values, this.pageSize)
      .map((row) => keySchema.parse(row));
    return {
      scope,
      scopeId,
      rows,
      ids: rows
        .filter((row) => isBeforeBoundary(row, boundary) && this.eligible(row.id))
        .map((row) => row.id)
    };
  }

  advance(page: NonNullable<ReturnType<RemoteOperationRetentionCandidates["read"]>>) {
    this.lastScope = page.scope;
    if (page.rows.length < this.pageSize) this.cursors.delete(page.scopeId);
    else this.cursors.set(page.scopeId, page.rows.at(-1)!);
  }

  revalidate(
    page: NonNullable<ReturnType<RemoteOperationRetentionCandidates["read"]>>,
    cutoff: string
  ): Set<string> {
    const boundary = this.boundary(page.scope);
    if (!boundary && this.fullPerScope > 0) return new Set();
    return new Set(
      page.ids.filter((id) => {
        const row = this.database
          .prepare(`SELECT id,terminal_at FROM remote_operations
        WHERE id=? AND ${terminal} AND workspace_id=? AND project_id=? AND canvas_id=? AND terminal_at<?`)
          .get(id, ...this.scopeValues(page.scope), cutoff);
        if (!row) return false;
        const key = keySchema.parse(row);
        return isBeforeBoundary(key, boundary) && this.eligible(id);
      })
    );
  }

  private boundary(scope: Scope): Key | undefined {
    if (this.fullPerScope === 0) return undefined;
    const rows = this.database
      .prepare(`SELECT id,terminal_at FROM remote_operations INDEXED BY ${index}
      WHERE ${terminal} AND workspace_id=? AND project_id=? AND canvas_id=?
      ORDER BY terminal_at DESC,id DESC LIMIT ?`)
      .all(...this.scopeValues(scope), this.fullPerScope);
    return rows.length === this.fullPerScope ? keySchema.parse(rows.at(-1)) : undefined;
  }

  private scopeValues(scope: Scope): [string, string, string] {
    return [scope.workspace_id, scope.project_id, scope.canvas_id];
  }

  private eligible(operationId: string): boolean {
    return Boolean(
      this.database
        .prepare(`           SELECT operation.id
           FROM remote_operations operation
           JOIN remote_execution_attempts current_attempt
             ON current_attempt.execution_attempt_id=operation.execution_attempt_id
            AND current_attempt.operation_id=operation.id
            AND current_attempt.dispatch_id=operation.dispatch_id
            AND current_attempt.workspace_id=operation.workspace_id
            AND current_attempt.project_id=operation.project_id
            AND current_attempt.canvas_id=operation.canvas_id
            AND current_attempt.block_ref=operation.block_ref
           JOIN dispatches current_dispatch
             ON current_dispatch.id=operation.dispatch_id
            AND current_dispatch.execution_attempt_id=operation.execution_attempt_id
            AND current_dispatch.workspace_id=operation.workspace_id
            AND current_dispatch.project_id=operation.project_id
            AND current_dispatch.block_ref=operation.block_ref
           LEFT JOIN remote_operation_retention_receipts receipt ON receipt.operation_id=operation.id
           WHERE operation.id=? AND receipt.operation_id IS NULL
             AND current_attempt.status IN ('superseded','completed','failed','cancelled')
             AND current_attempt.terminal_at IS NOT NULL
             AND current_dispatch.status IN ('completed','failed','cancelled')
             AND NOT EXISTS (
               SELECT 1 FROM remote_execution_attempts attempt
               WHERE attempt.operation_id=operation.id
                 AND (attempt.status NOT IN ('superseded','completed','failed','cancelled')
                   OR attempt.terminal_at IS NULL
                   OR attempt.workspace_id<>operation.workspace_id
                   OR attempt.project_id<>operation.project_id
                   OR attempt.canvas_id<>operation.canvas_id
                   OR attempt.block_ref<>operation.block_ref)
             )
             AND NOT EXISTS (
               SELECT 1 FROM remote_execution_attempts attempt
               LEFT JOIN dispatches dispatch
                 ON dispatch.id=attempt.dispatch_id
                AND dispatch.execution_attempt_id=attempt.execution_attempt_id
                AND dispatch.workspace_id=attempt.workspace_id
                AND dispatch.project_id=attempt.project_id
                AND dispatch.block_ref=attempt.block_ref
               WHERE attempt.operation_id=operation.id
                 AND (dispatch.id IS NULL OR dispatch.status NOT IN ('completed','failed','cancelled'))
             )
             AND NOT EXISTS (
               SELECT 1 FROM host_capacity_reservations reservation
               JOIN remote_execution_attempts attempt
                 ON attempt.execution_attempt_id=reservation.execution_attempt_id
               WHERE attempt.operation_id=operation.id AND reservation.status='active'
             )
             AND NOT EXISTS (
               SELECT 1 FROM remote_execution_actions action
               WHERE action.operation_id=operation.id AND action.state NOT IN ('settled','rejected')
             )
             AND NOT EXISTS (
               SELECT 1 FROM remote_interactions interaction
               WHERE interaction.operation_id=operation.id AND interaction.status='pending'
             )
`)
        .get(operationId)
    );
  }
}
