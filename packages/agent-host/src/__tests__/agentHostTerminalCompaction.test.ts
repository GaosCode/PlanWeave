import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exampleExecuteDelivery,
  executeBlockCommandSchema,
  hashExecutionEnvelope
} from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";
import { AgentHostTerminalCompactionRepository } from "../state/agentHostTerminalCompaction.js";
import { openAgentHostDatabase } from "../state/sqliteDatabase.js";

const directories: string[] = [];
const states: AgentHostState[] = [];

afterEach(async () => {
  for (const state of states.splice(0)) state.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-agent-host-compaction-"));
  directories.push(directory);
  const path = join(directory, "state.sqlite");
  const state = await openAgentHostState(path);
  states.push(state);
  return { path, state };
}

function commandFor(index: number) {
  const dispatchId = `dispatch-compaction-${index}`;
  const executionAttemptId = `attempt-compaction-${index}`;
  const envelope = {
    ...exampleExecuteDelivery.command.envelope,
    execution: {
      ...exampleExecuteDelivery.command.envelope.execution,
      dispatchId,
      attemptId: executionAttemptId
    }
  };
  return executeBlockCommandSchema.parse({
    ...exampleExecuteDelivery.command,
    dispatchId,
    leaseId: `lease-compaction-${index}`,
    executionAttemptId,
    envelope,
    envelopeDigest: hashExecutionEnvelope(envelope)
  });
}

function delivery(sequence: number, index = sequence) {
  return {
    type: "mailbox.message" as const,
    protocolVersion: 1 as const,
    sequence,
    previousSequence: sequence - 1,
    messageId: `mailbox-compaction-${sequence}`,
    command: commandFor(index)
  };
}

const result = {
  summary: "terminal compaction complete",
  reportArtifactRef: `artifact:sha256:${"a".repeat(64)}` as const,
  artifactRefs: []
};

function acknowledgeByType(state: AgentHostState, type: string): void {
  const event = state.pendingEvents().find((candidate) => candidate.type === type);
  if (!event) throw new Error(`missing_test_event:${type}`);
  expect(state.acknowledgeEvent(event.messageId)).toBe(true);
}

function count(database: Awaited<ReturnType<typeof openAgentHostDatabase>>, table: string): number {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
}

describe("Agent Host terminal state compaction", () => {
  it("retains terminal executions until the terminal event is acknowledged", async () => {
    const { path, state } = await setup();
    const received = state.receive(delivery(1));
    state.acknowledgeEvent(received.acknowledgement.messageId);
    state.startExecution(1);
    acknowledgeByType(state, "dispatch.accepted");
    state.completeExecution(1, result);

    state.close();
    states.pop();
    const database = await openAgentHostDatabase(path, 5_000);
    expect(count(database, "agent_host_executions")).toBe(1);
    expect(count(database, "agent_host_terminal_execution_receipts")).toBe(0);
    database.close();
  });

  it("retains acknowledged terminal work with a pending event or interaction settlement", async () => {
    const pendingEvent = await setup();
    const received = pendingEvent.state.receive(delivery(1));
    pendingEvent.state.acknowledgeEvent(received.acknowledgement.messageId);
    pendingEvent.state.startExecution(1);
    pendingEvent.state.completeExecution(1, result);
    acknowledgeByType(pendingEvent.state, "dispatch.completed");
    expect(pendingEvent.state.executionEvidence(1)?.status).toBe("completed");

    const pendingAction = await setup();
    const actionReceived = pendingAction.state.receive(delivery(1));
    pendingAction.state.acknowledgeEvent(actionReceived.acknowledgement.messageId);
    pendingAction.state.startExecution(1);
    acknowledgeByType(pendingAction.state, "dispatch.accepted");
    pendingAction.state.recordSessionEvidence(1, {
      sessionId: "acp-compaction",
      capabilities: { loadSession: false }
    });
    pendingAction.state.recordInteractionAction(1, {
      leaseId: commandFor(1).leaseId,
      sessionId: "acp-compaction",
      actionId: "pending-action",
      kind: "permission",
      deadline: "2030-01-01T00:00:00.000Z",
      requestDigest: `sha256:${"b".repeat(64)}`,
      afterCursor: 0,
      cursor: 1
    });
    pendingAction.state.completeExecution(1, result);
    acknowledgeByType(pendingAction.state, "dispatch.completed");
    expect(pendingAction.state.executionEvidence(1)?.status).toBe("completed");
  });

  it("atomically replaces eligible heavy state with a compact replay receipt", async () => {
    const { path, state } = await setup();
    const message = delivery(1);
    const received = state.receive(message);
    state.acknowledgeEvent(received.acknowledgement.messageId);
    state.startExecution(1);
    acknowledgeByType(state, "dispatch.accepted");
    state.recordArtifactTransfer(1, message.command.leaseId, {
      operationId: "report-upload",
      direction: "report",
      artifactRef: `artifact:sha256:${"c".repeat(64)}`,
      sha256: "c".repeat(64),
      sizeBytes: 12,
      mediaType: "text/markdown"
    });
    state.append({
      kind: "engine_event",
      identity: {
        dispatchId: message.command.dispatchId,
        leaseId: message.command.leaseId,
        executionAttemptId: message.command.executionAttemptId
      },
      event: {
        kind: "lifecycle",
        state: "running",
        sequence: 1,
        timestamp: "2026-08-16T00:00:00.000Z"
      }
    });
    state.completeExecution(1, result);
    acknowledgeByType(state, "dispatch.completed");
    expect(state.executionEvidence(1)).toBeUndefined();
    expect(state.lastAcknowledgedSequence()).toBe(1);

    state.close();
    states.pop();
    const database = await openAgentHostDatabase(path, 5_000);
    for (const table of [
      "agent_host_inbox",
      "agent_host_outbox",
      "agent_host_executions",
      "agent_host_execution_transitions",
      "agent_host_execution_actions",
      "agent_host_execution_artifacts",
      "agent_host_remote_execution_outbox"
    ]) {
      expect(count(database, table), table).toBe(0);
    }
    expect(count(database, "agent_host_terminal_execution_receipts")).toBe(1);
    database.close();
  });

  it("deduplicates retained replay, rejects conflict, and rejects replay beyond the receipt horizon", async () => {
    const { path, state } = await setup();
    const message = delivery(1);
    const received = state.receive(message);
    state.acknowledgeEvent(received.acknowledgement.messageId);
    state.startExecution(1);
    acknowledgeByType(state, "dispatch.accepted");
    state.completeExecution(1, result);
    acknowledgeByType(state, "dispatch.completed");
    state.close();
    states.pop();

    const reopened = await openAgentHostState(path);
    states.push(reopened);
    expect(reopened.receive(message).stored).toBe(false);
    expect(() =>
      reopened.receive({
        ...message,
        command: { ...message.command, leaseExpiresAt: "2031-01-01T00:00:00.000Z" }
      })
    ).toThrow("execution_identity_conflict");
    reopened.close();
    states.pop();

    const database = await openAgentHostDatabase(path, 5_000);
    database
      .prepare("UPDATE agent_host_terminal_execution_receipts SET compacted_at=?")
      .run("2000-01-01T00:00:00.000Z");
    database.close();
    const beyondHorizon = await openAgentHostState(path);
    states.push(beyondHorizon);
    expect(() => beyondHorizon.receive(message)).toThrow(
      "mailbox_message_retention_horizon_exceeded"
    );
    expect(beyondHorizon.pendingExecutions(1)).toEqual([]);
  });

  it("preserves active and interrupted executions across maintenance", async () => {
    const { path, state } = await setup();
    state.receive(delivery(1));
    state.startExecution(1);
    state.close();
    states.pop();

    const reopened = await openAgentHostState(path);
    states.push(reopened);
    expect(reopened.executionEvidence(1)?.status).toBe("running");
    expect(reopened.recoverInterruptedExecutions()).toBe(1);
    reopened.close();
    states.pop();
    const maintained = await openAgentHostState(path);
    states.push(maintained);
    expect(maintained.executionEvidence(1)?.status).toBe("interrupted");
  });

  it("bounds compaction and receipt pruning by batch, count, and age", async () => {
    const { path, state } = await setup();
    for (const sequence of [1, 2]) {
      state.receive(delivery(sequence));
      state.startExecution(sequence);
      state.completeExecution(sequence, result);
    }
    state.close();
    states.pop();
    const database = await openAgentHostDatabase(path, 5_000);
    database.exec(`
      UPDATE agent_host_inbox SET acknowledged_at='2026-08-16T00:00:00.000Z';
      UPDATE agent_host_outbox SET acknowledged_at='2026-08-16T00:00:00.000Z';
      UPDATE agent_host_executions SET terminal_acknowledged_at='2026-08-16T00:00:00.000Z';
    `);
    const compaction = new AgentHostTerminalCompactionRepository(database, {
      compactionBatchSize: 1,
      maxReceipts: 1,
      maxReceiptAgeDays: 1,
      receiptPruneBatchSize: 1
    });
    expect(compaction.compact(new Date("2026-08-16T01:00:00.000Z")).compacted).toBe(1);
    expect(count(database, "agent_host_executions")).toBe(1);
    expect(compaction.compact(new Date("2026-08-16T01:00:00.000Z"))).toEqual({
      compacted: 1,
      prunedReceipts: 1
    });
    expect(count(database, "agent_host_executions")).toBe(0);
    expect(count(database, "agent_host_terminal_execution_receipts")).toBe(1);
    database
      .prepare("UPDATE agent_host_terminal_execution_receipts SET compacted_at=?")
      .run("2026-08-14T00:00:00.000Z");
    expect(compaction.compact(new Date("2026-08-16T01:00:00.000Z")).prunedReceipts).toBe(1);
    expect(count(database, "agent_host_terminal_execution_receipts")).toBe(0);
    database.close();
  });

  it("migrates a v3 checkpoint atomically and reopens the compacted state", async () => {
    const { path, state } = await setup();
    state.close();
    states.pop();
    const v3 = await openAgentHostDatabase(path, 5_000);
    v3.exec(`
      DROP TABLE agent_host_terminal_execution_receipts;
      DROP TABLE agent_host_mailbox_checkpoint;
      UPDATE agent_host_state_schema SET version=3;
    `);
    v3.close();

    const migrated = await openAgentHostState(path);
    states.push(migrated);
    const received = migrated.receive(delivery(1));
    migrated.acknowledgeEvent(received.acknowledgement.messageId);
    migrated.startExecution(1);
    acknowledgeByType(migrated, "dispatch.accepted");
    migrated.completeExecution(1, result);
    acknowledgeByType(migrated, "dispatch.completed");
    migrated.close();
    states.pop();

    const reopened = await openAgentHostState(path);
    states.push(reopened);
    expect(reopened.lastAcknowledgedSequence()).toBe(1);
    expect(reopened.receive(delivery(1)).stored).toBe(false);
    const inspected = await openAgentHostDatabase(path, 5_000);
    expect(inspected.prepare("SELECT version FROM agent_host_state_schema").get()).toMatchObject({
      version: 4
    });
    inspected.close();
  });

  it("fails closed on partial v4 schema and corrupt terminal evidence without deleting state", async () => {
    const partial = await setup();
    partial.state.close();
    states.pop();
    const partialDatabase = await openAgentHostDatabase(partial.path, 5_000);
    partialDatabase.exec("DROP TABLE agent_host_terminal_execution_receipts");
    partialDatabase.close();
    await expect(openAgentHostState(partial.path)).rejects.toThrow(
      "agent_host_state_schema_incomplete"
    );

    const corrupt = await setup();
    corrupt.state.receive(delivery(1));
    corrupt.state.startExecution(1);
    corrupt.state.completeExecution(1, result);
    corrupt.state.close();
    states.pop();
    const corruptDatabase = await openAgentHostDatabase(corrupt.path, 5_000);
    corruptDatabase.exec(`
      UPDATE agent_host_inbox SET acknowledged_at='2026-08-16T00:00:00.000Z';
      UPDATE agent_host_outbox SET acknowledged_at='2026-08-16T00:00:00.000Z';
      UPDATE agent_host_executions SET terminal_acknowledged_at='2026-08-16T00:00:00.000Z';
      DELETE FROM agent_host_outbox WHERE json_extract(event_json,'$.type')='dispatch.completed';
    `);
    const compaction = new AgentHostTerminalCompactionRepository(corruptDatabase);
    expect(() => compaction.compact()).toThrow(
      "agent_host_terminal_compaction_terminal_event_missing"
    );
    expect(count(corruptDatabase, "agent_host_executions")).toBe(1);
    expect(count(corruptDatabase, "agent_host_terminal_execution_receipts")).toBe(0);
    corruptDatabase.close();
  });
});
