import { afterEach, describe, expect, it } from "vitest";
import { CANVAS_COMMAND_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canvasCommandIntentSchema,
  canvasCommandRejectedSchema
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import { CanvasOperationRetention, digestCanvasIntent } from "../canvas/index.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
const intent = canvasCommandIntentSchema.parse({
  kind: "update_task_prompt",
  taskId: "T-001",
  promptMarkdown: "# legacy"
});
const intentDigest = digestCanvasIntent(intent);

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function fixture() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  return {
    database,
    retention: new CanvasOperationRetention(database, () => new Date("2026-08-15T00:00:00.000Z"))
  };
}

function outcome(operationId: string) {
  return canvasCommandRejectedSchema.parse({
    type: "canvas.command.rejected",
    protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
    schemaVersion: "canvas-command/v1",
    projectId: scope.projectId,
    canvasId: scope.canvasId,
    operationId,
    code: "invalid_command",
    detail: "legacy"
  });
}

describe("canvas operation retention reconciliation", () => {
  async function migratedDatabase(): Promise<SqliteDatabase> {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    return database;
  }

  it.each([
    { name: "wrong type", outcomeColumn: "outcome_json BLOB NOT NULL", operationDefault: "" },
    { name: "nullable column", outcomeColumn: "outcome_json TEXT NOT NULL", operationDefault: "" },
    {
      name: "unexpected default",
      outcomeColumn: "outcome_json TEXT NOT NULL",
      operationDefault: " DEFAULT 'op'"
    }
  ])("fails startup closed for receipt $name", async ({
    name,
    outcomeColumn,
    operationDefault
  }) => {
    const database = await migratedDatabase();
    const operationNullability = name === "nullable column" ? "" : " NOT NULL";
    database.exec(`
      DROP TABLE canvas_command_operation_receipts;
      CREATE TABLE canvas_command_operation_receipts (
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        operation_id TEXT${operationNullability}${operationDefault},
        intent_digest TEXT NOT NULL CHECK(length(intent_digest)=64),
        ${outcomeColumn} CHECK(length(CAST(outcome_json AS BLOB)) <= 4096),
        terminal_sequence INTEGER NOT NULL CHECK(terminal_sequence > 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id,project_id,canvas_id,operation_id),
        UNIQUE(workspace_id,project_id,canvas_id,terminal_sequence)
      )
    `);

    expect(() => new CanvasOperationRetention(database)).toThrow(
      "canvas_operation_retention_schema_invalid:canvas_command_operation_receipts:columns"
    );
  });

  it("fails startup closed for a missing scope status check", async () => {
    const database = await migratedDatabase();
    database.exec(`
      DROP TABLE canvas_command_operation_retention_scopes;
      CREATE TABLE canvas_command_operation_retention_scopes (
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        high_water_sequence INTEGER NOT NULL CHECK(high_water_sequence >= 0),
        retained_from_sequence INTEGER NOT NULL CHECK(
          retained_from_sequence >= 1 AND retained_from_sequence <= high_water_sequence + 1
        ),
        status TEXT NOT NULL,
        failure_code TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id,project_id,canvas_id),
        CHECK((status='repair_required') = (failure_code IS NOT NULL))
      )
    `);
    expect(() => new CanvasOperationRetention(database)).toThrow(
      "canvas_operation_retention_schema_invalid:canvas_command_operation_retention_scopes:definition"
    );
  });

  it("fails startup closed for an unexpected unique index shape", async () => {
    const database = await migratedDatabase();
    database.exec(`CREATE UNIQUE INDEX unexpected_receipt_digest_unique
      ON canvas_command_operation_receipts(workspace_id,project_id,canvas_id,intent_digest)`);
    expect(() => new CanvasOperationRetention(database)).toThrow(
      "canvas_operation_retention_schema_invalid:canvas_command_operation_receipts:indexes"
    );
  });

  it("resumes legacy terminals oldest-first and retains only the newest 10,000", async () => {
    const { database, retention } = await fixture();
    const insert = database.prepare(
      `INSERT INTO canvas_command_operations(
         workspace_id,project_id,canvas_id,operation_id,intent_digest,intent_json,outcome_json,
         accepted,revision,journal_entry_id,created_at
       ) VALUES(?,?,?,?,?,?,?,0,NULL,NULL,?)`
    );
    for (let index = 0; index < 10_001; index += 1) {
      const operationId = `legacy-${index}`;
      insert.run(
        scope.workspaceId,
        scope.projectId,
        scope.canvasId,
        operationId,
        intentDigest,
        JSON.stringify(intent),
        JSON.stringify(outcome(operationId)),
        "2026-08-15T00:00:00.000Z"
      );
    }

    expect(retention.reconcileBatch()).toMatchObject({ processed: 100, status: "reconciling" });
    const resumed = new CanvasOperationRetention(
      database,
      () => new Date("2026-08-15T00:00:00.000Z")
    );
    let final = resumed.reconcileBatch();
    while (final.processed > 0 && final.status !== "ready") final = resumed.reconcileBatch();
    expect(final).toMatchObject({ processed: 1, status: "ready" });
    expect(resumed.getReceipt(scope, "legacy-0")).toBeUndefined();
    expect(resumed.getReceipt(scope, "legacy-1")?.terminalSequence).toBe(2);
    expect(resumed.getReceipt(scope, "legacy-10000")?.terminalSequence).toBe(10_001);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM canvas_command_operations").get()?.count
    ).toBe(0);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM canvas_command_operation_receipts").get()
        ?.count
    ).toBe(10_000);
  });

  it.each([
    "missing receipt",
    "retention metadata mismatch"
  ])("rolls the final legacy batch back when resume detects %s", async (fault) => {
    const { database, retention } = await fixture();
    const insert = database.prepare(
      `INSERT INTO canvas_command_operations(
           workspace_id,project_id,canvas_id,operation_id,intent_digest,intent_json,outcome_json,
           accepted,revision,journal_entry_id,created_at
         ) VALUES(?,?,?,?,?,?,?,0,NULL,NULL,?)`
    );
    for (let index = 0; index < 101; index += 1) {
      const operationId = `resume-${index}`;
      insert.run(
        scope.workspaceId,
        scope.projectId,
        scope.canvasId,
        operationId,
        intentDigest,
        JSON.stringify(intent),
        JSON.stringify(outcome(operationId)),
        "2026-08-15T00:00:00.000Z"
      );
    }
    expect(retention.reconcileBatch()).toMatchObject({
      processed: 100,
      status: "reconciling"
    });
    if (fault === "missing receipt") {
      database
        .prepare(
          `DELETE FROM canvas_command_operation_receipts
              WHERE workspace_id=? AND project_id=? AND canvas_id=? AND terminal_sequence=50`
        )
        .run(scope.workspaceId, scope.projectId, scope.canvasId);
    } else {
      database
        .prepare(
          `UPDATE canvas_command_operation_retention_scopes SET retained_from_sequence=2
              WHERE workspace_id=? AND project_id=? AND canvas_id=?`
        )
        .run(scope.workspaceId, scope.projectId, scope.canvasId);
    }

    const resumed = new CanvasOperationRetention(
      database,
      () => new Date("2026-08-15T00:00:00.000Z")
    );
    expect(resumed.reconcileBatch()).toMatchObject({
      processed: 0,
      consumed: 1,
      status: "repair_required"
    });
    expect(
      database
        .prepare(
          `SELECT operation_id FROM canvas_command_operations
              WHERE workspace_id=? AND project_id=? AND canvas_id=?`
        )
        .all(scope.workspaceId, scope.projectId, scope.canvasId)
    ).toEqual([{ operation_id: "resume-100" }]);
    expect(
      database
        .prepare(
          `SELECT status,failure_code,high_water_sequence
               FROM canvas_command_operation_retention_scopes
              WHERE workspace_id=? AND project_id=? AND canvas_id=?`
        )
        .get(scope.workspaceId, scope.projectId, scope.canvasId)
    ).toEqual({
      status: "repair_required",
      failure_code: "canvas_operation_retention_invariant",
      high_water_sequence: 100
    });
  });

  it("marks legacy scopes with multiple pending rows as repair-required", async () => {
    const { database, retention } = await fixture();
    const insert = database.prepare(
      `INSERT INTO canvas_command_pending(
         workspace_id,project_id,canvas_id,operation_id,expected_revision,intent_json,
         intent_digest,actor_kind,actor_id,actor_display_name,reserved_at,status
       ) VALUES(?,?,?,?,0,?,?, 'human','owner',NULL,?,'needs_recovery')`
    );
    for (const operationId of ["pending-1", "pending-2"]) {
      insert.run(
        scope.workspaceId,
        scope.projectId,
        scope.canvasId,
        operationId,
        JSON.stringify(intent),
        intentDigest,
        "2026-08-15T00:00:00.000Z"
      );
    }

    expect(retention.reconcileBatch()).toMatchObject({
      processed: 0,
      status: "repair_required"
    });
    expect(
      database
        .prepare(
          `SELECT status,failure_code FROM canvas_command_operation_retention_scopes
            WHERE workspace_id=? AND project_id=? AND canvas_id=?`
        )
        .get(scope.workspaceId, scope.projectId, scope.canvasId)
    ).toEqual({
      status: "repair_required",
      failure_code: "canvas_operation_multiple_pending"
    });
  });

  it.each([
    ["operation_id", ""],
    ["expected_revision", -1],
    ["intent_json", "{}"],
    ["intent_digest", "f".repeat(64)],
    ["actor_kind", "unknown"],
    ["actor_id", ""],
    ["actor_display_name", " "],
    ["reserved_at", "not-a-timestamp"],
    ["status", "unknown"]
  ])("rolls back and repairs malformed legacy pending field %s", async (column, value) => {
    const { database, retention } = await fixture();
    database
      .prepare(
        `INSERT INTO canvas_command_pending(
           workspace_id,project_id,canvas_id,operation_id,expected_revision,intent_json,
           intent_digest,actor_kind,actor_id,actor_display_name,reserved_at,status
         ) VALUES(?,?,?,'pending',0,?,?,'human','owner','Owner',?,'needs_recovery')`
      )
      .run(
        scope.workspaceId,
        scope.projectId,
        scope.canvasId,
        JSON.stringify(intent),
        intentDigest,
        "2026-08-15T00:00:00.000Z"
      );
    database.exec("PRAGMA ignore_check_constraints=ON");
    database.prepare(`UPDATE canvas_command_pending SET ${column}=?`).run(value);
    database.exec("PRAGMA ignore_check_constraints=OFF");

    expect(retention.reconcileBatch()).toMatchObject({
      processed: 0,
      status: "repair_required"
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM canvas_command_pending").get()?.count
    ).toBe(1);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM canvas_command_pending_scopes").get()?.count
    ).toBe(0);
  });
});
