import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentHostProtocolGoldenFixtures,
  exampleExecuteDelivery
} from "@planweave-ai/agent-host-protocol";
import { canvasRuntimeContentTargetSchema } from "@planweave-ai/collaboration-protocol/content/version";
import { AgentHostEventOutbox } from "../state/agentHostEventOutbox.js";
import { openAgentHostDatabase, openReadonlyAgentHostDatabase } from "../state/sqliteDatabase.js";
import {
  acpConversationPromptCommandSchema,
  exampleExecutionEnvelopeInput
} from "@planweave-ai/agent-host-protocol";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";

const directories: string[] = [];
const states: AgentHostState[] = [];
const canvasRuntimeContentTarget = canvasRuntimeContentTargetSchema.parse({
  revision: 1,
  content: {
    versionId: `version-${"c".repeat(64)}`,
    canonicalDigest: "c".repeat(64),
    verification: "complete"
  },
  graphFingerprint: `pkg-${"a".repeat(64)}`
});

afterEach(async () => {
  for (const state of states.splice(0)) state.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup(): Promise<{ directory: string; state: AgentHostState }> {
  const directory = await mkdtemp(join(tmpdir(), "planweave-agent-host-state-"));
  directories.push(directory);
  const state = await openAgentHostState(join(directory, "host.sqlite"));
  states.push(state);
  return { directory, state };
}

function executeMessage(sequence = 1) {
  return {
    ...exampleExecuteDelivery,
    sequence,
    previousSequence: sequence - 1,
    messageId: `mailbox-${sequence}`,
    command: {
      ...exampleExecuteDelivery.command,
      leaseId: "lease-1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    }
  };
}

function cancelMessage(sequence = 2) {
  return {
    type: "mailbox.message" as const,
    protocolVersion: 1 as const,
    sequence,
    previousSequence: sequence - 1,
    messageId: `mailbox-${sequence}`,
    command: {
      type: "cancel_execution" as const,
      protocolVersion: 1 as const,
      dispatchId: exampleExecuteDelivery.command.dispatchId,
      leaseId: "lease-1",
      executionAttemptId: exampleExecuteDelivery.command.executionAttemptId,
      reason: "The task was reassigned."
    }
  };
}

function unsupportedMessage(sequence: number, command: Record<string, unknown>) {
  return {
    type: "mailbox.message" as const,
    protocolVersion: 1 as const,
    sequence,
    previousSequence: sequence - 1,
    messageId: `mailbox-${sequence}`,
    command
  };
}

function canvasRuntimeMessage(sequence = 1) {
  return {
    type: "mailbox.message" as const,
    protocolVersion: 1 as const,
    sequence,
    previousSequence: sequence - 1,
    messageId: `canvas-mailbox-${sequence}`,
    command: {
      type: "canvas_runtime.request" as const,
      protocolVersion: 1 as const,
      requestId: "runtime-request-1",
      scope: { workspaceId: "workspace-1", projectId: "project-1", canvasId: "default" },
      deadline: "2030-01-01T00:00:00.000Z",
      operation: { operation: "availability" as const, contentTarget: canvasRuntimeContentTarget }
    }
  };
}

describe("durable Agent Host state", () => {
  it("notifies only after durable commit and discards rolled-back conversation events", async () => {
    const { directory, state } = await setup();
    const command = acpConversationPromptCommandSchema.parse({
      type: "acp_conversation.prompt",
      protocolVersion: 1,
      operationId: "notify-op",
      turnId: "notify-turn",
      executionAttemptId: exampleExecutionEnvelopeInput.execution.attemptId,
      sessionId: "notify-session",
      text: "Continue",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceEnvelope: { ...exampleExecutionEnvelopeInput, requiredCapabilities: [] }
    });
    state.conversations.accept(command);
    const reader = openReadonlyAgentHostDatabase(join(directory, "host.sqlite"), 5_000);
    const writer = await openAgentHostDatabase(join(directory, "host.sqlite"), 5_000);
    const snapshots: Array<{ sequence: number; count: number }> = [];
    const unsubscribe = state.subscribeOutboxReady(() => {
      snapshots.push({
        sequence: Number(
          reader
            .prepare("SELECT last_sequence FROM agent_host_conversation_turns WHERE turn_id=?")
            .get(command.turnId)?.last_sequence
        ),
        count: Number(
          reader.prepare("SELECT COUNT(*) AS count FROM agent_host_outbox").get()?.count
        )
      });
    });
    try {
      state.conversations.start(command.turnId);
      expect(snapshots).toEqual([{ sequence: 1, count: 1 }]);
      writer.exec(`CREATE TRIGGER fail_conversation_write BEFORE UPDATE ON agent_host_conversation_turns
        BEGIN SELECT RAISE(ABORT, 'forced_conversation_rollback'); END`);
      expect(() =>
        state.conversations.append(command.turnId, {
          kind: "status",
          status: "running",
          error: null
        })
      ).toThrow("forced_conversation_rollback");
      expect(snapshots).toEqual([{ sequence: 1, count: 1 }]);
      expect(state.pendingEvents()).toHaveLength(1);
      writer.exec("DROP TRIGGER fail_conversation_write");
      state.conversations.append(command.turnId, {
        kind: "status",
        status: "completed",
        error: null
      });
      expect(snapshots).toEqual([
        { sequence: 1, count: 1 },
        { sequence: 2, count: 2 }
      ]);
    } finally {
      unsubscribe();
      reader.close();
      writer.close();
    }
  });

  it("notifies standalone outbox writes after SQLite autocommit", async () => {
    const { directory } = await setup();
    const database = await openAgentHostDatabase(join(directory, "host.sqlite"), 5_000);
    const reader = openReadonlyAgentHostDatabase(join(directory, "host.sqlite"), 5_000);
    const outbox = new AgentHostEventOutbox(database, 10);
    const committedCounts: number[] = [];
    const unsubscribe = outbox.subscribeReady(() => {
      committedCounts.push(
        Number(reader.prepare("SELECT COUNT(*) AS count FROM agent_host_outbox").get()?.count)
      );
    });
    try {
      const event = outbox.queue("standalone-heartbeat", {
        type: "host.heartbeat",
        protocolVersion: 1,
        messageId: "standalone-message",
        activeLeases: []
      });
      expect(committedCounts).toEqual([1]);
      expect(outbox.queue("standalone-heartbeat", event)).toEqual(event);
      expect(committedCounts).toEqual([1]);
    } finally {
      unsubscribe();
      outbox.close();
      reader.close();
      database.close();
    }
  });

  it("isolates a failing listener, diagnoses it, and suppresses duplicate enqueue hints", async () => {
    const { state } = await setup();
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const observed = vi.fn();
    const detach = state.subscribeOutboxReady(() => {
      throw new Error("broken_outbox_listener");
    });
    const unsubscribe = state.subscribeOutboxReady(observed);
    try {
      const first = state.queueHeartbeat([]);
      expect(state.pendingEvents()).toEqual([first]);
      expect(warning).toHaveBeenCalledWith("broken_outbox_listener", {
        code: "agent_host_outbox_listener_failed"
      });
      expect(observed).toHaveBeenCalledTimes(1);
      expect(state.queueHeartbeat([])).toEqual(first);
      expect(observed).toHaveBeenCalledTimes(1);
      detach();
      unsubscribe();
      state.acknowledgeEvent(first.messageId);
      state.queueHeartbeat([]);
      expect(observed).toHaveBeenCalledTimes(1);
    } finally {
      detach();
      unsubscribe();
      warning.mockRestore();
    }
  });

  it("persists Canvas Runtime receipts independently and replays terminal responses after restart", async () => {
    const { directory, state } = await setup();
    const message = canvasRuntimeMessage();
    state.receive(message);
    expect(state.canvasRuntime.begin("runtime-request-1")).toBe(true);
    const response = {
      type: "canvas_runtime.response" as const,
      protocolVersion: 1 as const,
      requestId: "runtime-request-1",
      response: {
        outcome: "success" as const,
        operation: "availability" as const,
        result: { kind: "unavailable" as const, reason: "runtime_not_attached" as const }
      }
    };
    const event = state.canvasRuntime.complete("runtime-request-1", response);
    expect(event).toMatchObject({
      type: "canvas_runtime.response",
      requestId: "runtime-request-1"
    });
    expect(state.canvasRuntime.accept(message.command, message.sequence)).toEqual({
      kind: "replay",
      response
    });
    expect(() =>
      state.canvasRuntime.accept(
        { ...message.command, deadline: "2031-01-01T00:00:00.000Z" },
        message.sequence
      )
    ).toThrow("canvas_runtime_request_identity_conflict");

    state.close();
    states.pop();
    const reopened = await openAgentHostState(join(directory, "host.sqlite"));
    states.push(reopened);
    expect(reopened.canvasRuntime.accept(message.command, message.sequence)).toEqual({
      kind: "replay",
      response
    });
    expect(reopened.pendingEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "canvas_runtime.response",
          requestId: "runtime-request-1",
          messageId: event.messageId
        })
      ])
    );
  });
  it("persists a mailbox command before advancing its acknowledged cursor", async () => {
    const { directory, state } = await setup();
    const received = state.receive(executeMessage());
    expect(received.stored).toBe(true);
    expect(state.pendingExecutions(1)).toHaveLength(1);
    expect(state.recoverableExecutionCount()).toBe(1);
    expect(state.lastAcknowledgedSequence()).toBe(0);
    expect(state.pendingEvents()).toContainEqual(received.acknowledgement);

    state.close();
    states.pop();
    const reopened = await openAgentHostState(join(directory, "host.sqlite"));
    states.push(reopened);
    expect(reopened.pendingExecutions(1)).toHaveLength(1);
    expect(reopened.lastAcknowledgedSequence()).toBe(0);

    reopened.acknowledgeEvent(received.acknowledgement.messageId);
    expect(reopened.lastAcknowledgedSequence()).toBe(1);
  });

  it("deduplicates replayed messages and rejects conflicting sequence reuse", async () => {
    const { state } = await setup();
    const message = executeMessage();
    const first = state.receive(message);
    const replay = state.receive(message);
    expect(replay).toEqual({ stored: false, acknowledgement: first.acknowledgement });

    expect(() => state.receive({ ...message, messageId: "mailbox-conflict" })).toThrowError(
      "mailbox_message_conflict"
    );
  });

  it("bounds pending durable commands while still accepting an identical replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-agent-host-state-bounded-"));
    directories.push(directory);
    const state = await openAgentHostState(join(directory, "host.sqlite"), 5_000, {
      maxPendingCommands: 1
    });
    states.push(state);
    const message = executeMessage(1);
    const first = state.receive(message);

    expect(state.receive(message)).toEqual({
      stored: false,
      acknowledgement: first.acknowledgement
    });
    expect(() => state.receive(executeMessage(2))).toThrow(
      "agent_host_pending_command_capacity_exceeded"
    );
    expect(state.pendingExecutions(2)).toHaveLength(1);
  });

  it("rejects a mailbox delivery whose per-host predecessor is not durable", async () => {
    const { state } = await setup();
    expect(() => state.receive({ ...executeMessage(2), previousSequence: 1 })).toThrow(
      "mailbox_message_out_of_order"
    );
    expect(state.pendingExecutions(1)).toEqual([]);
    expect(state.pendingEvents()).toEqual([]);
  });

  it("bounds durable outbound events without committing a partial state transition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-agent-host-state-outbox-"));
    directories.push(directory);
    const state = await openAgentHostState(join(directory, "host.sqlite"), 5_000, {
      maxPendingEvents: 1
    });
    states.push(state);
    const received = state.receive(executeMessage());

    expect(state.pendingEventCount()).toBe(1);
    expect(() => state.startExecution(1)).toThrow("agent_host_pending_event_capacity_exceeded");
    expect(state.pendingExecutions(1)[0]?.status).toBe("accepted");

    state.acknowledgeEvent(received.acknowledgement.messageId);
    expect(state.pendingEventCount()).toBe(0);
    expect(state.startExecution(1)?.status).toBe("running");
  });

  it("keeps at most one durable heartbeat pending until the server acknowledges it", async () => {
    const { state } = await setup();
    const first = state.queueHeartbeat([]);
    const replay = state.queueHeartbeat([]);

    expect(replay).toEqual(first);
    expect(state.pendingEvents()).toEqual([first]);

    state.acknowledgeEvent(first.messageId);
    const next = state.queueHeartbeat([]);
    expect(next.messageId).not.toBe(first.messageId);
    expect(state.pendingEvents()).toEqual([next]);
  });

  it("rejects a stale envelope digest before persistence or acknowledgement", async () => {
    const { state } = await setup();
    const message = executeMessage();
    expect(() =>
      state.receive({
        ...message,
        command: {
          ...message.command,
          envelopeDigest: `envelope:sha256:${"0".repeat(64)}`
        }
      })
    ).toThrow("envelopeDigest must match");
    expect(state.pendingExecutions(1)).toEqual([]);
    expect(state.pendingEvents()).toEqual([]);
  });

  it("rejects unknown resume identity and unfenced interaction commands without durable ACK", async () => {
    const { state } = await setup();
    const identity = {
      dispatchId: exampleExecuteDelivery.command.dispatchId,
      leaseId: "lease-1",
      executionAttemptId: exampleExecuteDelivery.command.executionAttemptId,
      acpSessionId: "acp-session-1",
      actionId: "action-1"
    };
    expect(() =>
      state.receive(unsupportedMessage(1, agentHostProtocolGoldenFixtures.resumeDelivery.command))
    ).toThrow("execution_resume_identity_not_found");
    const commands = [
      { type: "interaction.permission_response", ...identity, decision: "deny" },
      { type: "interaction.elicitation_response", ...identity, outcome: "cancelled" },
      { type: "interaction.authentication_action", ...identity, action: "cancel" }
    ];
    for (const command of commands) {
      expect(() => state.receive(unsupportedMessage(1, command))).toThrow(
        "execution_action_identity_stale"
      );
    }
    expect(state.pendingExecutions(1)).toEqual([]);
    expect(state.pendingCancellations()).toEqual([]);
    expect(state.pendingEvents()).toEqual([]);
    expect(state.lastAcknowledgedSequence()).toBe(0);
  });

  it("atomically persists execution lifecycle events and recovers interrupted work", async () => {
    const { directory, state } = await setup();
    state.receive(executeMessage());
    const execution = state.startExecution(1);
    expect(execution?.status).toBe("running");
    expect(state.pendingEvents()).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "dispatch.accepted" })])
    );

    state.close();
    states.pop();
    const reopened = await openAgentHostState(join(directory, "host.sqlite"));
    states.push(reopened);
    expect(reopened.recoverInterruptedExecutions()).toBe(1);
    expect(reopened.startExecution(1)).toBeUndefined();

    expect(reopened.pendingExecutions(1)).toEqual([]);
    expect(reopened.activeLeases()).toEqual([]);
    expect(reopened.pendingEvents()).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "dispatch.interrupted" })])
    );
    expect(reopened.startExecution(1)).toBeUndefined();
  });

  it("persists cancellation intent and reports ambiguous work as interrupted after a crash", async () => {
    const { directory, state } = await setup();
    state.receive(executeMessage());
    state.startExecution(1);
    state.receive(cancelMessage());
    expect(state.pendingCancellations()).toHaveLength(1);
    expect(state.applyCancellation(2)).toEqual({ shouldAbort: true });

    state.close();
    states.pop();
    const reopened = await openAgentHostState(join(directory, "host.sqlite"));
    states.push(reopened);
    expect(reopened.recoverInterruptedExecutions()).toBe(1);
    expect(reopened.pendingExecutions(1)).toEqual([]);
    expect(reopened.executionEvidence(1)?.cancellationIntent).toEqual(
      expect.objectContaining({ commandSequence: 2 })
    );
    expect(reopened.pendingEvents()).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "dispatch.interrupted" })])
    );
  });

  it("does not apply cancellation from a stale execution attempt", async () => {
    const { state } = await setup();
    state.receive(executeMessage());
    state.startExecution(1);
    const stale = cancelMessage();
    state.receive({
      ...stale,
      command: { ...stale.command, executionAttemptId: "stale-attempt" }
    });

    expect(state.applyCancellation(2)).toEqual({ shouldAbort: false });
    expect(state.activeLeases()).toEqual([
      expect.objectContaining({
        executionAttemptId: exampleExecuteDelivery.command.executionAttemptId
      })
    ]);
  });

  it("tracks lease renewals and abandons expired local execution", async () => {
    const { state } = await setup();
    state.receive(executeMessage());
    const renewedUntil = new Date(Date.now() + 120_000).toISOString();
    expect(
      state.renewLease(
        exampleExecuteDelivery.command.dispatchId,
        "lease-1",
        exampleExecuteDelivery.command.executionAttemptId,
        renewedUntil
      )
    ).toBe(true);
    expect(state.pendingExecutions(1)[0]?.command.leaseExpiresAt).toBe(renewedUntil);
    expect(state.abandonExpiredExecutions(new Date(Date.now() + 60_000))).toEqual([]);

    const expired = state.abandonExpiredExecutions(new Date(Date.now() + 180_000));
    expect(expired).toHaveLength(1);
    expect(state.activeLeases()).toEqual([]);
    expect(state.pendingExecutions(1)).toEqual([]);
  });
});
