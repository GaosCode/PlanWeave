import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  agentHostProtocolVersion,
  canonicalizeJson,
  canvasRuntimeRequestCommandSchema
} from "@planweave-ai/agent-host-protocol";
import { openAgentHostDatabase } from "../state/sqliteDatabase.js";
import { openAgentHostState } from "../state/agentHostState.js";
import { createProtocolUpgradeFixture } from "./support/protocolUpgradeFixture.js";
import { delivery, request } from "./support/canvasRuntimeServiceFixture.js";

const historicalOperations = [
  { operation: "availability" },
  { operation: "acquire" },
  {
    operation: "acquire",
    expectedEvidence: {
      sourceRevision: "snapshot:historical",
      graphFingerprint: `pkg-${"a".repeat(64)}`
    }
  },
  { operation: "resolve_work_items", input: {} }
] as const;

describe("original v1 Canvas Runtime receipts", () => {
  it.each(
    historicalOperations.flatMap((operation) =>
      [false, true].flatMap((completed) =>
        [false, true].map((missingDigest) => ({ operation, completed, missingDigest }))
      )
    )
  )("preserves $operation.operation completed=$completed missingDigest=$missingDigest across upgrade and reopen", async ({
    operation,
    completed,
    missingDigest
  }) => {
    const f = await createProtocolUpgradeFixture();
    await f.archiveDatabase();
    const command = {
      type: "canvas_runtime.request",
      protocolVersion: 1,
      requestId: "historical-request",
      scope: { workspaceId: "workspace", projectId: "project", canvasId: "canvas" },
      deadline: "2099-01-01T00:00:00.000Z",
      operation
    };
    const commandJson = JSON.stringify(command, null, 2);
    expect(canvasRuntimeRequestCommandSchema.safeParse(command).success).toBe(false);
    expect(
      canvasRuntimeRequestCommandSchema.safeParse({
        ...command,
        protocolVersion: agentHostProtocolVersion
      }).success
    ).toBe(false);
    const hash = (encoded: string) =>
      `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
    const inboxDigest = hash(JSON.stringify(command));
    const receiptDigest = hash(canonicalizeJson(command));
    const responseJson = completed
      ? JSON.stringify({
          type: "canvas_runtime.response",
          protocolVersion: 1,
          requestId: command.requestId,
          messageId: "original-response",
          response: {
            outcome: "error",
            operation: operation.operation,
            error: { code: "original-error", message: "Original failure", retryable: false }
          }
        })
      : null;
    const ackJson = JSON.stringify({
      type: "mailbox.ack",
      protocolVersion: 1,
      messageId: "original-ack",
      sequence: 1
    });
    const db = await openAgentHostDatabase(f.path, 5_000);
    try {
      db.prepare(
        `INSERT INTO agent_host_inbox(
          sequence,previous_sequence,message_id,command_json,command_digest,received_at,processed_at
        ) VALUES(1,0,'original-delivery',?,?,?,?)`
      ).run(
        commandJson,
        missingDigest ? null : inboxDigest,
        command.deadline,
        completed ? command.deadline : null
      );
      db.prepare(
        `INSERT INTO canvas_runtime_rpc_receipts(
          request_id,inbox_sequence,command_digest,command_json,workspace_id,project_id,canvas_id,
          operation,status,response_json,received_at,updated_at
        ) VALUES(?,1,?,?,'workspace','project','canvas',?,?,?,?,?)`
      ).run(
        command.requestId,
        receiptDigest,
        commandJson,
        operation.operation,
        completed ? "terminal" : "running",
        responseJson,
        command.deadline,
        command.deadline
      );
      db.prepare(
        `INSERT INTO agent_host_outbox(message_id,event_key,event_json,created_at)
        VALUES('original-ack','mailbox.ack:1',?,?)`
      ).run(ackJson, command.deadline);
      db.prepare("UPDATE agent_host_mailbox_checkpoint SET received_high_water_sequence=1").run();
      const originalInbox = db.prepare("SELECT * FROM agent_host_inbox").get();
      const originalOutbox = db
        .prepare("SELECT sequence,message_id,event_json,acknowledged_at FROM agent_host_outbox")
        .all();
      const originalReceipt = db.prepare("SELECT * FROM canvas_runtime_rpc_receipts").get();
      for (let attempt = 0; attempt < 2; attempt++) {
        const state = await f.reopen();
        expect(state.canvasRuntime.incomplete()).toEqual([]);
        expect(state.pendingCancellations()).toEqual([]);
        expect(state.pendingEvents()).toEqual([]);
        expect(state.lastReceivedSequence()).toBe(1);
        expect(state.lastAcknowledgedSequence()).toBe(0);
        expect(state.mailboxAcknowledgementRecoverySequence()).toBe(1);
        expect(db.prepare("SELECT * FROM agent_host_inbox").get()).toEqual({
          ...originalInbox,
          command_digest: inboxDigest
        });
        expect(
          db
            .prepare("SELECT sequence,message_id,event_json,acknowledged_at FROM agent_host_outbox")
            .all()
        ).toEqual(originalOutbox);
        expect(db.prepare("SELECT * FROM canvas_runtime_rpc_receipts").get()).toEqual({
          ...originalReceipt,
          status: completed ? "terminal" : "reconcile_required",
          protocol_archive_reason: "stored_command_protocol_incompatible"
        });
        expect(() =>
          state.canvasRuntime.accept(
            canvasRuntimeRequestCommandSchema.parse({
              ...command,
              protocolVersion: agentHostProtocolVersion,
              operation: { ...operation, contentTarget: {} }
            }),
            1
          )
        ).toThrow("stored_command_protocol_incompatible");
        f.closeState(state);
      }
    } finally {
      db.close();
    }
  });

  it.each([
    { field: "$.protocolVersion", value: 99 },
    { field: "$.protocolVersion", value: agentHostProtocolVersion },
    { field: "$.requestId", value: "conflicting-request" },
    { field: "$.unexpected", value: true },
    { field: "$.operation.operation", value: "unknown-operation" },
    { field: "malformed JSON", value: null }
  ])("rolls back the entire upgrade for invalid stored $field", async ({ field, value }) => {
    const f = await createProtocolUpgradeFixture();
    f.initial.receive(delivery(1, request("valid-historical-request")));
    f.initial.receive(delivery(2, request("invalid-historical-request")));
    await f.archiveDatabase();
    const db = await openAgentHostDatabase(f.path, 5_000);
    try {
      db.prepare(`UPDATE canvas_runtime_rpc_receipts SET command_json=
        json_remove(command_json,'$.operation.contentTarget')`).run();
      db.prepare(`UPDATE agent_host_inbox SET command_digest=NULL,command_json=
        json_remove(command_json,'$.operation.contentTarget') WHERE sequence=1`).run();
      if (field === "malformed JSON") {
        db.prepare(
          `UPDATE canvas_runtime_rpc_receipts SET command_json='{' WHERE inbox_sequence=2`
        ).run();
      } else {
        db.prepare(`UPDATE canvas_runtime_rpc_receipts SET command_json=
          json_set(command_json,?,?) WHERE inbox_sequence=2`).run(field, value);
      }
      const originalReceipt = db.prepare("SELECT * FROM canvas_runtime_rpc_receipts").all();
      const originalOutbox = db.prepare("SELECT * FROM agent_host_outbox").all();
      const originalInbox = db.prepare("SELECT * FROM agent_host_inbox").all();
      await expect(openAgentHostState(f.path)).rejects.toThrow();
      expect(db.prepare("SELECT version FROM agent_host_state_schema").get()?.version).toBe(11);
      expect(db.prepare("SELECT * FROM canvas_runtime_rpc_receipts").all()).toEqual(
        originalReceipt
      );
      expect(db.prepare("SELECT * FROM agent_host_outbox").all()).toEqual(originalOutbox);
      expect(db.prepare("SELECT * FROM agent_host_inbox").all()).toEqual(originalInbox);
      expect(
        db
          .prepare("PRAGMA table_info(canvas_runtime_rpc_receipts)")
          .all()
          .some((column) => column.name === "protocol_archive_reason")
      ).toBe(false);
    } finally {
      db.close();
    }
  });
});
