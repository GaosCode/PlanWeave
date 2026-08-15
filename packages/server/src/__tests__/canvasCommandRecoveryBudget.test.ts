import { describe, expect, it } from "vitest";
import type { CanvasCommandIntent } from "@planweave-ai/collaboration-protocol/canvas/commands";
import { digestCanvasIntent } from "../canvas/index.js";
import { inWriteTransaction } from "../sqlite.js";
import { canvasCommandServiceFixture as fixture } from "./support/canvasCommandServiceFixture.js";

describe("canvas command recovery budget", () => {
  it("repairs a markerless pending scope without clearing its recovery evidence", async () => {
    const { service, database } = await fixture();
    const intent: CanvasCommandIntent = {
      kind: "update_task_prompt",
      taskId: "T-001",
      promptMarkdown: "# markerless"
    };
    database
      .prepare(
        `INSERT INTO canvas_command_pending_scopes(
           workspace_id,project_id,canvas_id,operation_id,expected_revision,intent_json,
           intent_digest,actor_kind,actor_id,actor_display_name,reserved_at,status
         ) VALUES ('w','p','default','markerless-pending',0,?,?,'human','owner','Owner',
                   '2026-01-02T00:00:00.000Z','needs_recovery')`
      )
      .run(JSON.stringify(intent), digestCanvasIntent(intent));

    await expect(service.recoverInterrupted(100)).resolves.toEqual({
      cleared: 0,
      recovered: 0,
      deferred: 1
    });
    expect(
      database.prepare("SELECT operation_id FROM canvas_command_pending_scopes").get()
    ).toEqual({ operation_id: "markerless-pending" });
    expect(
      database
        .prepare(
          `SELECT status,failure_code FROM canvas_command_operation_retention_scopes
            WHERE workspace_id='w' AND project_id='p' AND canvas_id='default'`
        )
        .get()
    ).toEqual({
      status: "repair_required",
      failure_code: "canvas_operation_retention_marker_missing"
    });
  });

  it("limits pending recovery to 100 scopes and resumes in stable scope order", async () => {
    const { service, database } = await fixture();
    const intent: CanvasCommandIntent = {
      kind: "update_task_prompt",
      taskId: "T-001",
      promptMarkdown: "# interrupted"
    };
    const intentJson = JSON.stringify(intent);
    const intentDigest = digestCanvasIntent(intent);
    const insertScope = database.prepare(
      `INSERT INTO canvas_command_operation_retention_scopes(
         workspace_id,project_id,canvas_id,high_water_sequence,retained_from_sequence,
         status,failure_code,updated_at
       ) VALUES ('w','p',?,0,1,'ready',NULL,'2026-01-02T00:00:00.000Z')`
    );
    const insertPending = database.prepare(
      `INSERT INTO canvas_command_pending_scopes(
         workspace_id,project_id,canvas_id,operation_id,expected_revision,intent_json,
         intent_digest,actor_kind,actor_id,actor_display_name,reserved_at,status
       ) VALUES ('w','p',?,?,0,?,?,'human','owner','Owner',
                 '2026-01-02T00:00:00.000Z','needs_recovery')`
    );
    inWriteTransaction(database, () => {
      for (let index = 0; index < 101; index += 1) {
        const canvasId = `recovery-${String(index).padStart(3, "0")}`;
        insertScope.run(canvasId);
        insertPending.run(canvasId, `op-recovery-${index}`, intentJson, intentDigest);
      }
    });

    await expect(service.recoverInterrupted(100)).resolves.toEqual({
      cleared: 100,
      recovered: 0,
      deferred: 0
    });
    expect(database.prepare("SELECT canvas_id FROM canvas_command_pending_scopes").all()).toEqual([
      { canvas_id: "recovery-100" }
    ]);
    await expect(service.recoverInterrupted(100)).resolves.toEqual({
      cleared: 1,
      recovered: 0,
      deferred: 0
    });
  });
});
