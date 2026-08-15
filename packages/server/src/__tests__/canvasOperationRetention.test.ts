import { afterEach, describe, expect, it, vi } from "vitest";
import { CANVAS_COMMAND_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canvasCommandIntentSchema,
  canvasCommandRejectedSchema
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import {
  CanvasOperationRetention,
  CanvasOperationRetentionCorruptionError,
  CanvasOperationRetentionMaintenance,
  canonicalCanvasOperationOutcome,
  digestCanvasIntent
} from "../canvas/index.js";
import { applyMigrations } from "../migrations.js";
import { inWriteTransaction, openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
const intent = canvasCommandIntentSchema.parse({
  kind: "update_task_prompt",
  taskId: "T-001",
  promptMarkdown: "# prompt"
});
const intentDigest = digestCanvasIntent(intent);

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function fixture() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  const retention = new CanvasOperationRetention(
    database,
    () => new Date("2026-08-15T00:00:00.000Z")
  );
  return { database, retention };
}

function rejected(operationId: string, detail = "invalid") {
  return canvasCommandRejectedSchema.parse({
    type: "canvas.command.rejected",
    protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
    schemaVersion: "canvas-command/v1",
    projectId: scope.projectId,
    canvasId: scope.canvasId,
    operationId,
    code: "invalid_command",
    detail
  });
}

describe("canvas operation receipt retention", () => {
  it("rejects markerless receipt evidence as typed corruption", async () => {
    const { database, retention } = await fixture();
    database
      .prepare(
        `INSERT INTO canvas_command_operation_receipts(
           workspace_id,project_id,canvas_id,operation_id,intent_digest,outcome_json,
           terminal_sequence,created_at
         ) VALUES(?,?,?,?,?,?,1,?)`
      )
      .run(
        scope.workspaceId,
        scope.projectId,
        scope.canvasId,
        "markerless-receipt",
        intentDigest,
        JSON.stringify(rejected("markerless-receipt")),
        "2026-08-15T00:00:00.000Z"
      );

    expect(() => retention.assertScopeWritable(scope)).toThrowError(
      expect.objectContaining({
        failureCode: "canvas_operation_retention_marker_missing"
      })
    );
  });

  it("keeps zero full terminal intents and only the newest 10,000 compact receipts", async () => {
    const { database, retention } = await fixture();
    retention.assertScopeWritable(scope);

    inWriteTransaction(database, () => {
      for (let index = 0; index < 10_001; index += 1) {
        const operationId = `op-${index}`;
        retention.recordTerminalInCallerTransaction({
          scope,
          operationId,
          intentDigest,
          outcome: rejected(operationId),
          createdAt: "2026-08-15T00:00:00.000Z"
        });
      }
    });

    expect(
      database.prepare("SELECT COUNT(*) AS count FROM canvas_command_operations").get()?.count
    ).toBe(0);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM canvas_command_operation_receipts").get()
        ?.count
    ).toBe(10_000);
    expect(retention.getReceipt(scope, "op-0")).toBeUndefined();
    expect(retention.getReceipt(scope, "op-1")?.terminalSequence).toBe(2);
    expect(
      database
        .prepare(
          `SELECT high_water_sequence,retained_from_sequence
             FROM canvas_command_operation_retention_scopes
            WHERE workspace_id='w' AND project_id='p' AND canvas_id='default'`
        )
        .get()
    ).toEqual({ high_water_sequence: 10_001, retained_from_sequence: 2 });

    const otherWorkspaceScope = { ...scope, workspaceId: "other-workspace" };
    retention.assertScopeWritable(otherWorkspaceScope);
    inWriteTransaction(database, () => {
      retention.recordTerminalInCallerTransaction({
        scope: otherWorkspaceScope,
        operationId: "op-1",
        intentDigest,
        outcome: rejected("op-1"),
        createdAt: "2026-08-15T00:00:00.000Z"
      });
    });
    expect(retention.getReceipt(scope, "op-1")?.terminalSequence).toBe(2);
    expect(retention.getReceipt(otherWorkspaceScope, "op-1")?.terminalSequence).toBe(1);
  });

  it("canonicalizes receipt-eligible server outcomes and fails closed on corrupt receipts", async () => {
    const { database, retention } = await fixture();
    const worstCurrentRejected = rejected("op-max", "界".repeat(512));
    const canonical = canonicalCanvasOperationOutcome(worstCurrentRejected);
    expect(Buffer.byteLength(canonical.json, "utf8")).toBeLessThanOrEqual(4_096);

    expect(() =>
      database
        .prepare(
          `INSERT INTO canvas_command_operation_receipts(
             workspace_id,project_id,canvas_id,operation_id,intent_digest,outcome_json,
             terminal_sequence,created_at
           ) VALUES('oversize','p','default','op',?, ?,1,'2026-08-15T00:00:00.000Z')`
        )
        .run(intentDigest, `${JSON.stringify(rejected("op-ddl"))}${" ".repeat(4_097)}`)
    ).toThrow();

    retention.assertScopeWritable(scope);
    database.exec("PRAGMA ignore_check_constraints=ON");
    database
      .prepare(
        `INSERT INTO canvas_command_operation_receipts(
           workspace_id,project_id,canvas_id,operation_id,intent_digest,outcome_json,
           terminal_sequence,created_at
         ) VALUES(?,?,?,?,?,?,1,?)`
      )
      .run(
        scope.workspaceId,
        scope.projectId,
        scope.canvasId,
        "op-corrupt",
        intentDigest,
        `${JSON.stringify(rejected("op-corrupt"))}${" ".repeat(4_097)}`,
        "2026-08-15T00:00:00.000Z"
      );
    database.exec("PRAGMA ignore_check_constraints=OFF");
    database
      .prepare(
        `UPDATE canvas_command_operation_retention_scopes SET high_water_sequence=1
          WHERE workspace_id=? AND project_id=? AND canvas_id=?`
      )
      .run(scope.workspaceId, scope.projectId, scope.canvasId);

    let corruption: CanvasOperationRetentionCorruptionError | undefined;
    try {
      retention.getReceipt(scope, "op-corrupt");
    } catch (error) {
      expect(error).toBeInstanceOf(CanvasOperationRetentionCorruptionError);
      corruption = error as CanvasOperationRetentionCorruptionError;
    }
    expect(corruption?.failureCode).toBe("canvas_operation_receipt_corrupt");
    retention.markRepairRequired(scope, corruption?.failureCode ?? "missing_corruption");
    expect(
      database
        .prepare(
          `SELECT status FROM canvas_command_operation_retention_scopes
            WHERE workspace_id=? AND project_id=? AND canvas_id=?`
        )
        .get(scope.workspaceId, scope.projectId, scope.canvasId)?.status
    ).toBe("repair_required");
  });

  it("stops scheduling and waits for the current bounded maintenance batch on close", async () => {
    const { retention } = await fixture();
    let release!: () => void;
    let entered = false;
    const afterBatch = new Promise<void>((resolve) => {
      release = resolve;
    });
    const maintenance = new CanvasOperationRetentionMaintenance(
      retention,
      async () => {
        entered = true;
        await afterBatch;
      },
      60_000
    );
    const starting = maintenance.start();
    await vi.waitFor(() => expect(entered).toBe(true));
    let closed = false;
    const closing = maintenance.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await Promise.all([starting, closing]);
    expect(closed).toBe(true);
  });

  it("shares one 100-record budget between reconciliation and recovery", async () => {
    const { database, retention } = await fixture();
    const insert = database.prepare(
      `INSERT INTO canvas_command_operations(
         workspace_id,project_id,canvas_id,operation_id,intent_digest,intent_json,outcome_json,
         accepted,revision,journal_entry_id,created_at
       ) VALUES(?,?,?,?,?,?,?,0,NULL,NULL,?)`
    );
    for (let index = 0; index < 73; index += 1) {
      const operationId = `legacy-budget-${index}`;
      insert.run(
        scope.workspaceId,
        scope.projectId,
        scope.canvasId,
        operationId,
        intentDigest,
        JSON.stringify(intent),
        JSON.stringify(rejected(operationId)),
        "2026-08-15T00:00:00.000Z"
      );
    }
    const recoveryBudgets: number[] = [];
    const maintenance = new CanvasOperationRetentionMaintenance(
      retention,
      async (remainingBudget) => recoveryBudgets.push(remainingBudget),
      60_000
    );

    await maintenance.start();
    await maintenance.close();

    expect(recoveryBudgets).toEqual([27]);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM canvas_command_operation_receipts").get()
        ?.count
    ).toBe(73);
  });
});
