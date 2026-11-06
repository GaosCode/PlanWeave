import { describe, expect, it } from "vitest";
import {
  agentHostProtocolVersion,
  exampleExecuteDelivery
} from "@planweave-ai/agent-host-protocol";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";
import { openAgentHostDatabase } from "../state/sqliteDatabase.js";
import { delivery, request } from "./support/canvasRuntimeServiceFixture.js";
import { createProtocolUpgradeFixture } from "./support/protocolUpgradeFixture.js";

async function archivedInboxFixture(origin: "schema11" | "current" = "current") {
  const fixture = await createProtocolUpgradeFixture();
  const received = fixture.initial.receive(delivery(1, request("archived-request")));
  fixture.initial.acknowledgeEvent(received.acknowledgement.messageId);
  await fixture.archiveDatabase();
  if (origin === "current") {
    const upgraded = await fixture.reopen();
    fixture.closeState(upgraded);
  }
  return fixture;
}

function completeAvailability(state: AgentHostState, requestId: string) {
  return state.canvasRuntime.complete(requestId, {
    type: "canvas_runtime.response",
    protocolVersion: agentHostProtocolVersion,
    requestId,
    response: {
      outcome: "error",
      operation: "availability",
      error: { code: "unavailable", message: "Workspace unavailable", retryable: false }
    }
  });
}

describe("archived Canvas inbox eligibility", () => {
  it.each([
    "schema11",
    "current"
  ] as const)("preserves one-command admission, completion and replay across restart from %s", async (origin) => {
    const fixture = await archivedInboxFixture(origin);
    const db = await openAgentHostDatabase(fixture.path, 5_000);
    const originalInbox = db.prepare("SELECT * FROM agent_host_inbox WHERE sequence=1").get();
    const originalReceipt = db
      .prepare(
        "SELECT command_json,command_digest FROM canvas_runtime_rpc_receipts WHERE inbox_sequence=1"
      )
      .get();
    expect(db.prepare("SELECT version FROM agent_host_state_schema").get()?.version).toBe(
      origin === "schema11" ? 11 : 13
    );
    let state = await openAgentHostState(fixture.path, 5_000, { maxPendingCommands: 1 });
    try {
      const inbox = db.prepare("SELECT * FROM agent_host_inbox WHERE sequence=1").get();
      const receipt = db
        .prepare("SELECT * FROM canvas_runtime_rpc_receipts WHERE inbox_sequence=1")
        .get();
      expect(inbox).toMatchObject({ processed_at: null, acknowledged_at: expect.any(String) });
      expect(receipt).toMatchObject({
        protocol_archive_reason: "stored_command_protocol_incompatible",
        response_json: null
      });
      expect(state.canvasRuntime.incomplete()).toEqual([]);
      expect(state.pendingCancellations()).toEqual([]);
      expect(state.lastAcknowledgedSequence()).toBe(1);
      expect(state.lastReceivedSequence()).toBe(1);
      const current = delivery(2, request("current-request"));
      const next = delivery(3, request("next-request"));
      const accepted = state.receive(current);
      expect(accepted.stored).toBe(true);
      expect(state.receive(current)).toEqual({
        stored: false,
        acknowledgement: accepted.acknowledgement
      });
      expect(() => state.receive(next)).toThrow("agent_host_pending_command_capacity_exceeded");
      expect(state.canvasRuntime.incomplete()).toMatchObject([
        { command: { requestId: "current-request" }, status: "pending" }
      ]);
      expect(state.lastReceivedSequence()).toBe(2);
      expect(state.lastAcknowledgedSequence()).toBe(1);
      state.close();
      state = await openAgentHostState(fixture.path, 5_000, { maxPendingCommands: 1 });
      expect(state.canvasRuntime.incomplete()).toMatchObject([
        { command: { requestId: "current-request" }, status: "pending" }
      ]);
      expect(state.pendingCancellations()).toEqual([]);
      expect(state.receive(current)).toEqual({
        stored: false,
        acknowledgement: accepted.acknowledgement
      });
      expect(() => state.receive(next)).toThrow("agent_host_pending_command_capacity_exceeded");
      expect(state.lastReceivedSequence()).toBe(2);
      expect(state.lastAcknowledgedSequence()).toBe(1);
      const response = completeAvailability(state, current.command.requestId);
      expect(state.pendingEvents()).toContainEqual(response);
      expect(state.acknowledgeEvent(accepted.acknowledgement.messageId)).toBe(true);
      expect(state.lastAcknowledgedSequence()).toBe(2);
      expect(state.receive(next).stored).toBe(true);
      expect(state.canvasRuntime.incomplete()).toMatchObject([
        { command: { requestId: "next-request" }, status: "pending" }
      ]);
      expect(state.lastReceivedSequence()).toBe(3);
      expect(state.lastAcknowledgedSequence()).toBe(2);
      expect(db.prepare("SELECT * FROM agent_host_inbox WHERE sequence=1").get()).toEqual(inbox);
      expect(inbox).toEqual(originalInbox);
      expect(
        db
          .prepare(
            "SELECT command_json,command_digest FROM canvas_runtime_rpc_receipts WHERE inbox_sequence=1"
          )
          .get()
      ).toEqual(originalReceipt);
      expect(
        db.prepare("SELECT * FROM canvas_runtime_rpc_receipts WHERE inbox_sequence=1").get()
      ).toEqual(receipt);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      state.close();
      db.close();
    }
  });

  it("counts mixed live work once and preserves ordered ordinary and historical cancellations beside an archive", async () => {
    const fixture = await archivedInboxFixture();
    const state = await openAgentHostState(fixture.path, 5_000, { maxPendingCommands: 3 });
    const execution = {
      ...exampleExecuteDelivery,
      sequence: 2,
      previousSequence: 1,
      messageId: "mailbox-2",
      command: {
        ...exampleExecuteDelivery.command,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z"
      }
    };
    const identity = execution.command;
    const ordinaryCancel = {
      type: "mailbox.message" as const,
      protocolVersion: agentHostProtocolVersion,
      sequence: 4,
      previousSequence: 3,
      messageId: "mailbox-4",
      command: {
        type: "cancel_execution" as const,
        protocolVersion: agentHostProtocolVersion,
        dispatchId: "already-finished-dispatch",
        leaseId: identity.leaseId,
        executionAttemptId: identity.executionAttemptId,
        reason: "Task reassigned"
      }
    };
    const commandJson = JSON.stringify({
      type: "interaction.permission_response",
      dispatchId: identity.dispatchId,
      leaseId: identity.leaseId,
      executionAttemptId: identity.executionAttemptId,
      actionId: "historical-action",
      acpSessionId: "historical-session",
      decision: "allow_once"
    });
    const permission = {
      type: "mailbox.permission_history" as const,
      protocolVersion: agentHostProtocolVersion,
      sequence: 5,
      previousSequence: 4,
      messageId: "mailbox-5",
      commandJson
    };
    try {
      const executionAck = state.receive(execution).acknowledgement;
      expect(state.startExecution(2)?.status).toBe("running");
      expect(state.receive(delivery(3, request("mixed-current"))).stored).toBe(true);
      const cancelAck = state.receive(ordinaryCancel).acknowledgement;
      expect(state.receive(execution)).toEqual({ stored: false, acknowledgement: executionAck });
      expect(state.receive(ordinaryCancel)).toEqual({ stored: false, acknowledgement: cancelAck });
      expect(() => state.receive(permission)).toThrow(
        "agent_host_pending_command_capacity_exceeded"
      );
      expect(state.lastReceivedSequence()).toBe(4);
      completeAvailability(state, "mixed-current");
      const permissionAck = state.receive(permission).acknowledgement;
      expect(state.receive(permission)).toEqual({ stored: false, acknowledgement: permissionAck });
      expect(state.pendingCancellations()).toMatchObject([
        { sequence: 4, command: { type: "cancel_execution", reason: "Task reassigned" } },
        { sequence: 5, command: { type: "cancel_execution", dispatchId: identity.dispatchId } }
      ]);
      const next = delivery(6, request("after-cancel"));
      expect(() => state.receive(next)).toThrow("agent_host_pending_command_capacity_exceeded");
      expect(state.applyCancellation(4)).toEqual({ shouldAbort: false });
      expect(state.applyCancellation(4)).toEqual({ shouldAbort: false });
      expect(state.pendingCancellations()).toMatchObject([{ sequence: 5 }]);
      expect(state.receive(next).stored).toBe(true);
      const after = delivery(7, request("after-permission"));
      expect(() => state.receive(after)).toThrow("agent_host_pending_command_capacity_exceeded");
      expect(state.applyCancellation(5)).toEqual({ shouldAbort: true });
      expect(state.pendingCancellations()).toEqual([]);
      expect(state.receive(after).stored).toBe(true);
      expect(() => state.receive(delivery(8, request("still-running")))).toThrow(
        "agent_host_pending_command_capacity_exceeded"
      );
      expect(
        state.failExecution(2, identity, {
          code: "execution_cancelled",
          message: "Execution cancelled",
          retryable: false
        })
      ).toBe("applied");
      expect(state.receive(delivery(8, request("after-execution"))).stored).toBe(true);
      expect(state.executionEvidence(2)?.cancellationIntent).toMatchObject({ commandSequence: 5 });
      expect(state.lastReceivedSequence()).toBe(8);
      expect(state.lastAcknowledgedSequence()).toBe(1);
    } finally {
      state.close();
    }
  });

  it("does not decode quarantined inbox payloads during cancellation scanning", async () => {
    const fixture = await archivedInboxFixture();
    const state = await fixture.reopen();
    const db = await openAgentHostDatabase(fixture.path, 5_000);
    try {
      const archivedPayload = JSON.stringify({
        type: "canvas_runtime.request",
        protocolVersion: 0
      });
      db.prepare("UPDATE agent_host_inbox SET command_json=? WHERE sequence=1").run(
        archivedPayload
      );
      expect(state.pendingCancellations()).toEqual([]);
      expect(
        db.prepare("SELECT command_json FROM agent_host_inbox WHERE sequence=1").get()
      ).toEqual({
        command_json: archivedPayload
      });
    } finally {
      db.close();
    }
  });
});
