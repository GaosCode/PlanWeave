import { describe, expect, it, vi } from "vitest";
import {
  agentHostProtocolVersion,
  CANVAS_RUNTIME_CAPABILITY,
  hostEventSchema
} from "@planweave-ai/agent-host-protocol";
import { RemoteAcpConversationService } from "../execution/remoteAcpConversationService.js";
import type { RemoteAcpExecutor } from "../execution/remoteAcpExecutor.js";
import { encodeHistoricalAgentHostEvent } from "../protocol.js";
import { CanvasRuntimeService } from "../runtime/canvasRuntimeService.js";
import { openAgentHostState } from "../state/agentHostState.js";
import { openAgentHostDatabase } from "../state/sqliteDatabase.js";
import { createProtocolUpgradeFixture, upgradePrompt } from "./support/protocolUpgradeFixture.js";
import {
  artifactTransfer,
  cancel,
  contentTransfer,
  delivery,
  graphFingerprint,
  request,
  resolverWith,
  scope,
  sourceRevision,
  unusedWorkspace
} from "./support/canvasRuntimeServiceFixture.js";

describe("persisted Host protocol upgrades", () => {
  it("reconciles a processed historical permission after restoring its archived ACK", async () => {
    const f = await createProtocolUpgradeFixture();
    const commandJson = JSON.stringify({
      type: "interaction.permission_response",
      dispatchId: "old-dispatch",
      leaseId: "old-lease",
      executionAttemptId: "old-attempt",
      actionId: "old-action",
      acpSessionId: "old-session",
      decision: "allow_once"
    });
    f.initial.receive({
      type: "mailbox.permission_history",
      protocolVersion: agentHostProtocolVersion,
      sequence: 1,
      previousSequence: 0,
      messageId: "old-permission-mailbox",
      commandJson
    });
    f.initial.applyCancellation(1);
    await f.archiveDatabase();
    const state = await f.reopen();
    expect(state.pendingCancellations()).toEqual([]);
    expect(state.mailboxAcknowledgementRecoverySequence()).toBe(1);
    state.synchronizeMailboxAcknowledgement(1);
    expect(state.pendingCancellations()).toMatchObject([
      {
        sequence: 1,
        command: {
          type: "cancel_execution",
          dispatchId: "old-dispatch",
          leaseId: "old-lease",
          executionAttemptId: "old-attempt"
        }
      }
    ]);
    expect(state.applyCancellation(1)).toEqual({ shouldAbort: false });
    state.synchronizeMailboxAcknowledgement(1);
    expect(state.pendingCancellations()).toEqual([]);
    const db = await openAgentHostDatabase(f.path, 5_000);
    try {
      expect(
        db.prepare("SELECT command_json FROM agent_host_inbox WHERE sequence=1").get()?.command_json
      ).toBe(commandJson);
    } finally {
      db.close();
    }
  });

  it.each([
    1, 2
  ])("restores only confirmed mailbox receipts after upgrading wire v%i", async (wireVersion) => {
    const f = await createProtocolUpgradeFixture();
    const first = f.initial.receive(delivery(1, cancel("first", "none")));
    const second = f.initial.receive({
      ...delivery(3, cancel("second", "none")),
      previousSequence: 1
    });
    const unrelated = f.initial.queueHeartbeat([]);
    await f.archiveDatabase(11, wireVersion);
    const state = await f.reopen();
    const reader = await openAgentHostDatabase(f.path, 5_000);
    try {
      const original = reader
        .prepare("SELECT message_id,event_json FROM agent_host_outbox ORDER BY sequence")
        .all();
      const heartbeat = state.queueHeartbeat([]);
      expect(state.lastReceivedSequence()).toBe(3);
      expect(state.mailboxAcknowledgementRecoverySequence()).toBe(wireVersion === 1 ? 3 : 0);
      state.synchronizeMailboxAcknowledgement(1);
      state.synchronizeMailboxAcknowledgement(1);
      expect(state.lastAcknowledgedSequence()).toBe(1);
      expect(
        reader
          .prepare("SELECT acknowledged_at FROM agent_host_outbox WHERE message_id=?")
          .get(first.acknowledgement.messageId)?.acknowledged_at
      ).toEqual(expect.any(String));
      expect(
        reader
          .prepare("SELECT acknowledged_at FROM agent_host_outbox WHERE message_id=?")
          .get(second.acknowledgement.messageId)?.acknowledged_at
      ).toBeNull();
      expect(
        reader
          .prepare("SELECT acknowledged_at FROM agent_host_outbox WHERE message_id=?")
          .get(unrelated.messageId)?.acknowledged_at
      ).toBeNull();
      for (const invalid of [0, 2, 4]) {
        expect(() => state.synchronizeMailboxAcknowledgement(invalid)).toThrow(
          "mailbox_cursor_reconciliation_required"
        );
        expect(state.lastAcknowledgedSequence()).toBe(1);
      }
      state.synchronizeMailboxAcknowledgement(3);
      expect(state.pendingEvents().filter((event) => event.type === "mailbox.ack")).toEqual([]);
      expect(state.pendingEvents()).toContainEqual(heartbeat);
      for (const row of original)
        expect(
          reader
            .prepare("SELECT event_json FROM agent_host_outbox WHERE message_id=?")
            .get(row.message_id)?.event_json
        ).toBe(row.event_json);
    } finally {
      reader.close();
    }
    f.closeState(state);
    const reopened = await f.reopen();
    expect(reopened.lastAcknowledgedSequence()).toBe(3);
    expect(reopened.lastReceivedSequence()).toBe(3);
    expect(
      reopened.receive({ ...delivery(5, cancel("new", "none")), previousSequence: 3 }).stored
    ).toBe(true);
  });

  it("recovers a current v2 turn from the previous database schema", async () => {
    const f = await createProtocolUpgradeFixture();
    const command = upgradePrompt("current-turn", "current-session");
    f.initial.conversations.accept(command);
    await f.archiveDatabase(11, agentHostProtocolVersion);
    const state = await f.reopen();
    const converse = vi.fn<RemoteAcpExecutor["converse"]>(async () => ({
      terminal: { state: "succeeded", stopReason: "end_turn" },
      cleanup: { attempted: true, completed: true }
    }));
    const service = new RemoteAcpConversationService(state.conversations, { converse });
    service.recover();
    const db = await openAgentHostDatabase(f.path, 5_000);
    await vi.waitFor(() =>
      expect(db.prepare("SELECT status FROM agent_host_conversation_turns").get()?.status).toBe(
        "completed"
      )
    );
    expect(converse).toHaveBeenCalledOnce();
    expect(
      db.prepare("SELECT protocol_archive_reason FROM agent_host_conversation_turns").get()
        ?.protocol_archive_reason
    ).toBeNull();
    await service.stop();
    db.close();
  });

  it.each([
    [10, "queued"],
    [10, "running"],
    [10, "unsafe-completed"],
    [11, "queued"],
    [11, "running"],
    [11, "unsafe-completed"]
  ] as const)("upgrades schema %i with a v1 %s turn and can execute a new session", async (schemaVersion, status) => {
    const f = await createProtocolUpgradeFixture();
    const command = upgradePrompt();
    f.initial.conversations.accept(command);
    if (status === "running") f.initial.conversations.start(command.turnId);
    if (status === "unsafe-completed") {
      f.initial.conversations.append(command.turnId, {
        kind: "status",
        status: "completed",
        error: null
      });
      f.initial.conversations.markCleanupUnsafe(command.turnId);
    }
    await f.archiveDatabase(schemaVersion);
    const before = await openAgentHostDatabase(f.path, 5_000);
    const original = before
      .prepare("SELECT command_json,command_digest FROM agent_host_conversation_turns")
      .get();
    const events = before
      .prepare(
        "SELECT message_id,event_json,acknowledged_at FROM agent_host_outbox ORDER BY sequence"
      )
      .all();
    before.close();
    const state = await f.reopen();
    const converse = vi.fn<RemoteAcpExecutor["converse"]>(async () => ({
      terminal: { state: "succeeded" as const, stopReason: "end_turn" },
      cleanup: { attempted: true, completed: true }
    }));
    const service = new RemoteAcpConversationService(state.conversations, { converse });
    service.recover();
    expect(converse).not.toHaveBeenCalled();
    expect(() => state.conversations.accept(command)).toThrow(
      "stored_command_protocol_incompatible"
    );
    const db = await openAgentHostDatabase(f.path, 5_000);
    expect(db.prepare("SELECT status FROM agent_host_conversation_turns").get()?.status).toBe(
      status === "unsafe-completed" ? "completed" : "failed"
    );
    expect(
      db.prepare("SELECT command_json,command_digest FROM agent_host_conversation_turns").get()
    ).toEqual(original);
    expect(
      db.prepare("SELECT protocol_archive_reason FROM agent_host_conversation_turns").get()
        ?.protocol_archive_reason
    ).toBe("stored_command_protocol_incompatible");
    expect(
      db
        .prepare(
          "SELECT message_id,event_json,acknowledged_at FROM agent_host_outbox ORDER BY sequence"
        )
        .all()
    ).toEqual(events);
    expect(state.pendingEvents()).toEqual([]);
    if (status !== "queued") expect(service.isSessionActive(command.sessionId)).toBe(true);
    const current = upgradePrompt("current-turn", "new-session");
    state.receive({
      type: "mailbox.message",
      protocolVersion: agentHostProtocolVersion,
      messageId: "current-message",
      previousSequence: 0,
      sequence: 1,
      command: current
    });
    service.handle(current);
    await vi.waitFor(() =>
      expect(
        db
          .prepare("SELECT status FROM agent_host_conversation_turns WHERE turn_id=?")
          .get(current.turnId)?.status
      ).toBe("completed")
    );
    await service.stop();
    expect(converse).toHaveBeenCalledOnce();
    expect(converse.mock.calls[0]?.[0]).toEqual(current);
    for (const event of state.pendingEvents())
      expect(() => encodeHistoricalAgentHostEvent(event, 1024 * 1024)).not.toThrow();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it.each([
    "pending",
    "running"
  ] as const)("archives a v1 %s reset without resolving or executing it", async (status) => {
    const f = await createProtocolUpgradeFixture();
    const evidence = { operationId: "legacy-reset-operation", sourceRevision, graphFingerprint };
    const reset = request("legacy-reset", {
      operation: "reset",
      runtimeLeaseId: "legacy-lease",
      evidence,
      input: { ...evidence, reason: "Requested reset" }
    });
    f.initial.receive(delivery(1, reset));
    if (status === "running") f.initial.canvasRuntime.begin(reset.requestId);
    await f.archiveDatabase();
    const state = await f.reopen();
    const workspace = unusedWorkspace();
    const resolve = vi.fn(async () => ({ scope, project: workspace, canvas: workspace }));
    const runtime = new CanvasRuntimeService({
      receipts: state.canvasRuntime,
      resolver: resolverWith(resolve),
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer,
      contentTransfer
    });
    await runtime.recover();
    await runtime.recover();
    expect(resolve).not.toHaveBeenCalled();
    expect(state.canvasRuntime.incomplete()).toEqual([]);
    expect(() => state.canvasRuntime.accept(reset, 1)).toThrow(
      "stored_command_protocol_incompatible"
    );
    expect(state.canvasRuntime.resetStatus(scope, evidence.operationId)).toMatchObject({
      kind: "failed",
      error: {
        code: "stored_command_protocol_incompatible",
        retryable: false,
        reconcileRequired: true
      }
    });
    expect(
      state.canvasRuntime.resetOperation(scope, evidence.operationId)?.command.protocolVersion
    ).toBe(1);
    const current = cancel("current-cancel", "not-running");
    state.receive(delivery(2, current));
    await runtime.handle(current);
    expect(resolve).toHaveBeenCalledOnce();
    expect(state.pendingEvents()).toContainEqual(
      expect.objectContaining({
        type: "canvas_runtime.response",
        protocolVersion: agentHostProtocolVersion,
        requestId: current.requestId,
        response: {
          outcome: "success",
          operation: "cancel",
          result: { targetRequestId: "not-running", cancelled: false }
        }
      })
    );
    await runtime.stop();
    const db = await openAgentHostDatabase(f.path, 5_000);
    expect(
      db
        .prepare(
          "SELECT status,response_json,protocol_archive_reason FROM canvas_runtime_rpc_receipts WHERE request_id=?"
        )
        .get(reset.requestId)
    ).toEqual({
      status: "reconcile_required",
      response_json: null,
      protocol_archive_reason: "stored_command_protocol_incompatible"
    });
    expect(
      JSON.parse(
        String(
          db
            .prepare("SELECT command_json FROM canvas_runtime_rpc_receipts WHERE request_id=?")
            .get(reset.requestId)?.command_json
        )
      ).protocolVersion
    ).toBe(1);
    db.close();
  });

  it("reads an old terminal reset response without changing its outcome", async () => {
    const f = await createProtocolUpgradeFixture();
    const evidence = { operationId: "legacy-completed-reset", sourceRevision, graphFingerprint };
    const reset = request("legacy-reset", {
      operation: "reset",
      runtimeLeaseId: "legacy-lease",
      evidence,
      input: { ...evidence, reason: "Requested reset" }
    });
    f.initial.receive(delivery(1, reset));
    f.initial.canvasRuntime.complete(reset.requestId, {
      type: "canvas_runtime.response",
      protocolVersion: agentHostProtocolVersion,
      requestId: reset.requestId,
      response: {
        outcome: "error",
        operation: "reset",
        error: { code: "original-reset-error", message: "Reset failed", retryable: false }
      }
    });
    await f.archiveDatabase();
    const state = await f.reopen();
    expect(state.canvasRuntime.resetStatus(scope, evidence.operationId)).toEqual({
      kind: "failed",
      error: { code: "original-reset-error", retryable: false }
    });
    expect(
      state.canvasRuntime.resetOperation(scope, evidence.operationId)?.command.protocolVersion
    ).toBe(1);
  });

  it("retains archived outbox bytes across reopen and permits a new heartbeat with the same event key", async () => {
    const f = await createProtocolUpgradeFixture();
    const original = f.initial.queueHeartbeat([]);
    await f.archiveDatabase();
    const db = await openAgentHostDatabase(f.path, 5_000);
    const stored = db
      .prepare("SELECT event_json,acknowledged_at FROM agent_host_outbox WHERE message_id=?")
      .get(original.messageId);
    db.close();
    const state = await f.reopen();
    expect(state.pendingEventCount()).toBe(0);
    const current = state.queueHeartbeat([]);
    expect(hostEventSchema.parse(current).protocolVersion).toBe(agentHostProtocolVersion);
    expect(state.pendingEvents()).toEqual([current]);
    f.closeState(state);
    const reopened = await f.reopen();
    expect(reopened.pendingEvents()).toEqual([current]);
    const after = await openAgentHostDatabase(f.path, 5_000);
    expect(
      after
        .prepare("SELECT event_json,acknowledged_at FROM agent_host_outbox WHERE message_id=?")
        .get(original.messageId)
    ).toEqual(stored);
    expect(
      after
        .prepare("SELECT protocol_archive_reason FROM agent_host_outbox WHERE message_id=?")
        .get(original.messageId)?.protocol_archive_reason
    ).toBe("stored_event_protocol_incompatible");
    after.close();
  });

  it("reads an archived permission decision without accepting it as a new command", async () => {
    const f = await createProtocolUpgradeFixture();
    const command = upgradePrompt();
    f.initial.conversations.accept(command);
    f.initial.conversations.accept({
      type: "acp_conversation.respond",
      protocolVersion: agentHostProtocolVersion,
      operationId: command.operationId,
      turnId: command.turnId,
      sessionId: command.sessionId,
      executionAttemptId: command.executionAttemptId,
      requestId: "old-permission",
      decision: { kind: "permission", optionId: "allow" }
    });
    await f.archiveDatabase();
    const state = await f.reopen();
    expect(state.conversations.response(command.turnId, "old-permission")).toMatchObject({
      protocolVersion: 1,
      decision: { kind: "permission", optionId: "allow" }
    });
    expect(() => state.conversations.command(command.turnId)).toThrow(/protocol/);
  });

  it("rolls back upgrade metadata and archival together when an old command is malformed", async () => {
    const f = await createProtocolUpgradeFixture();
    f.initial.conversations.accept(upgradePrompt());
    f.initial.queueHeartbeat([]);
    await f.archiveDatabase();
    const before = await openAgentHostDatabase(f.path, 5_000);
    before
      .prepare(
        "UPDATE agent_host_conversation_turns SET command_json=json_set(command_json,'$.unexpected',true)"
      )
      .run();
    const original = before.prepare("SELECT * FROM agent_host_outbox").all();
    before.close();
    await expect(openAgentHostState(f.path)).rejects.toThrow();
    const after = await openAgentHostDatabase(f.path, 5_000);
    expect(after.prepare("SELECT version FROM agent_host_state_schema").get()?.version).toBe(11);
    expect(after.prepare("SELECT * FROM agent_host_outbox").all()).toEqual(original);
    expect(
      after
        .prepare("PRAGMA table_info(agent_host_outbox)")
        .all()
        .some((row) => row.name === "protocol_archive_reason")
    ).toBe(false);
    after.close();
  });

  it("finishes an older schema with partially added archive metadata but rejects an incomplete current schema", async () => {
    const f = await createProtocolUpgradeFixture();
    f.initial.conversations.accept(upgradePrompt());
    await f.archiveDatabase();
    const partial = await openAgentHostDatabase(f.path, 5_000);
    partial.exec("ALTER TABLE agent_host_outbox ADD COLUMN protocol_archive_reason TEXT");
    partial.close();
    const state = await f.reopen();
    expect(state.conversations.queued()).toEqual([]);
    f.closeState(state);
    const current = await openAgentHostDatabase(f.path, 5_000);
    expect(current.prepare("SELECT version FROM agent_host_state_schema").get()?.version).toBe(12);
    current.exec("ALTER TABLE canvas_runtime_rpc_receipts DROP COLUMN protocol_archive_reason");
    current.close();
    await expect(openAgentHostState(f.path)).rejects.toThrow(/schema/);
  });
});
