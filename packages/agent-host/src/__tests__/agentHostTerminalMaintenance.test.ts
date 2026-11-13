import {
  agentHostProtocolVersion,
  hostEventSchema,
  serverEventSchema
} from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableAcpInteractionRelay } from "../execution/durableAcpRelay.js";
import { AgentHostState, openAgentHostState } from "../state/agentHostState.js";
import { DEFAULT_AGENT_HOST_TERMINAL_COMPACTION_POLICY } from "../state/agentHostTerminalCompaction.js";
import { openAgentHostDatabase } from "../state/sqliteDatabase.js";
import { AgentHostClient } from "../transport/agentHostClient.js";
import { acpCapabilitySnapshotTestValue } from "./support/acpCapabilitySnapshotTestValues.js";
import { emptyHostReadiness } from "./support/agentHostOutboxFailureHarness.js";
import { HostTransportSocketHarness } from "./support/hostTransportSocketHarness.js";
import { remoteRunnerEventV2Request } from "./support/remoteRunnerEventCapabilityTestValues.js";
import {
  acknowledgeByType,
  cancelDelivery,
  cleanup,
  commandFor,
  count,
  delivery,
  permissionDelivery,
  result,
  seedReceiptHistory,
  setup,
  states
} from "./support/agentHostTerminalCompactionFixture.js";

const dayMs = 24 * 60 * 60 * 1_000;

afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Agent Host terminal maintenance", () => {
  it("acknowledges an exact terminal permission replay over the Host socket", async () => {
    const { state } = await setup();
    const original = delivery(1);
    state.receive(original);
    state.startExecution(1);
    state.recordSessionEvidence(1, {
      sessionId: "acp-compaction",
      capabilitySnapshot: acpCapabilitySnapshotTestValue(false)
    });
    state.recordInteractionAction(1, {
      leaseId: original.command.leaseId,
      sessionId: "acp-compaction",
      actionId: "permission-compaction",
      kind: "permission",
      deadline: "2030-01-01T00:00:00.000Z",
      requestDigest: `sha256:${"a".repeat(64)}`,
      afterCursor: 0,
      cursor: 1
    });
    const permission = permissionDelivery(2);
    const first = state.receive(permission).acknowledgement;
    state.completeExecution(1, original.command, result);
    for (const event of state.pendingEvents()) state.acknowledgeEvent(event.messageId);
    await vi.waitFor(() => expect(state.executionEvidence(1)).toBeUndefined());

    const server = await HostTransportSocketHarness.open();
    const seen: string[] = [];
    server.webSocketServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        const input = JSON.parse(data.toString());
        if (input.type === "host.hello") {
          socket.send(
            JSON.stringify(
              serverEventSchema.parse({
                type: "host.welcome",
                protocolVersion: agentHostProtocolVersion,
                exactPermissionOptionsVersion: 1,
                lastAcknowledgedSequence: permission.sequence,
                serverTime: new Date().toISOString(),
                heartbeatIntervalMs: 60_000,
                leaseDurationMs: 60_000
              })
            )
          );
          socket.send(JSON.stringify(permission));
          return;
        }
        const event = hostEventSchema.parse(input);
        socket.send(
          JSON.stringify({
            type: "host.event_ack",
            protocolVersion: agentHostProtocolVersion,
            messageId: event.messageId
          })
        );
        if (event.type === "mailbox.ack" && event.sequence === permission.sequence) {
          seen.push(event.messageId);
        }
      });
    });
    const execute = vi.fn();
    const client = new AgentHostClient({
      readiness: emptyHostReadiness,
      serverUrl: server.serverUrl,
      hostId: "host-terminal-permission-replay",
      token: "host-token",
      capabilities: ["test"],
      capacity: 1,
      state,
      executor: { execute },
      interactionRelay: new DurableAcpInteractionRelay(state),
      request: remoteRunnerEventV2Request,
      allowInsecureTransport: true
    });
    try {
      client.start();
      await vi.waitFor(() => {
        expect(seen).toEqual([expect.any(String)]);
        expect(state.pendingEventCount()).toBe(0);
      });
      expect(seen[0]).not.toBe(first.messageId);
      expect(client.status().state).toBe("connected");
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await client.stop();
      await server.close();
    }
  });

  it("restarts a partially retired attempt without losing exact mailbox replay", async () => {
    vi.useFakeTimers();
    const { state, path } = await setup();
    const original = delivery(1);
    const first = state.receive(original);
    state.acknowledgeEvent(first.acknowledgement.messageId);
    state.startExecution(1);
    acknowledgeByType(state, "dispatch.accepted");
    const last = 150;
    for (let sequence = 2; sequence <= last; sequence += 1) {
      const received = state.receive(cancelDelivery(sequence));
      state.acknowledgeEvent(received.acknowledgement.messageId);
      expect(state.applyCancellation(sequence)).toEqual({ shouldAbort: true });
    }
    state.recordSessionEvidence(1, {
      sessionId: "acp-compaction",
      capabilitySnapshot: acpCapabilitySnapshotTestValue(false)
    });
    state.recordInteractionAction(1, {
      leaseId: original.command.leaseId,
      sessionId: "acp-compaction",
      actionId: "permission-compaction",
      kind: "permission",
      deadline: "2030-01-01T00:00:00.000Z",
      requestDigest: `sha256:${"a".repeat(64)}`,
      afterCursor: 0,
      cursor: 1
    });
    const permission = permissionDelivery(last + 1);
    const permissionAck = state.receive(permission).acknowledgement;
    state.acknowledgeEvent(permissionAck.messageId);
    state.failExecution(1, commandFor(1), {
      code: "execution_cancelled",
      message: "Execution cancelled.",
      retryable: false
    });
    acknowledgeByType(state, "dispatch.failed");
    vi.advanceTimersToNextTimer();
    const database = await openAgentHostDatabase(path, 5_000);
    try {
      expect(count(database, "agent_host_inbox")).toBeGreaterThan(1);
      expect(count(database, "agent_host_compacted_mailbox_receipts")).toBeGreaterThan(0);
      expect(count(database, "agent_host_terminal_execution_receipts")).toBe(0);
      const replay = state.receive(cancelDelivery(last));
      expect(replay.stored).toBe(false);
      const permissionReplay = state.receive(permission);
      expect(permissionReplay).toMatchObject({ stored: false, terminalReplay: true });
      const before = count(database, "agent_host_inbox");
      const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      database.exec(`
        CREATE TRIGGER fail_retirement_page BEFORE DELETE ON agent_host_inbox
        BEGIN SELECT RAISE(ABORT,'retirement page rejected'); END;
      `);
      vi.advanceTimersToNextTimer();
      expect(warning).toHaveBeenCalledWith("retirement page rejected", {
        code: "agent_host_terminal_maintenance_failed"
      });
      expect(count(database, "agent_host_inbox")).toBe(before);
      expect(count(database, "agent_host_compacted_mailbox_receipts")).toBe(last + 1 - before);
      expect(state.executionEvidence(1)?.terminalAcknowledgedAt).toEqual(expect.any(String));
      database.exec("DROP TRIGGER fail_retirement_page");
      state.close();
      states.pop();
      const reopened = await openAgentHostState(path);
      states.push(reopened);
      expect(reopened.lastAcknowledgedSequence()).toBe(last + 1);
      expect(reopened.receive(cancelDelivery(last))).toEqual(replay);
      expect(reopened.receive(permission)).toEqual(permissionReplay);
      expect(() => reopened.receive(cancelDelivery(last + 2))).toThrow("mailbox_message_conflict");
      expect(reopened.acknowledgeEvent(replay.acknowledgement.messageId)).toBe(true);
      expect(reopened.acknowledgeEvent(permissionReplay.acknowledgement.messageId)).toBe(true);
      for (let batch = 0; batch < 10 && reopened.executionEvidence(1); batch += 1) {
        vi.advanceTimersToNextTimer();
      }
      expect(reopened.executionEvidence(1)).toBeUndefined();
      expect(count(database, "agent_host_inbox")).toBe(0);
      expect(count(database, "agent_host_terminal_execution_receipts")).toBe(1);
      expect(count(database, "agent_host_compacted_mailbox_receipts")).toBe(last + 1);
      expect(reopened.receive(original).stored).toBe(false);
    } finally {
      database.close();
    }
  });

  it("prunes expired terminal receipt dependents in bounded transactions across reopen", async () => {
    vi.useFakeTimers();
    const { state, path } = await setup();
    const database = await openAgentHostDatabase(path, 5_000);
    try {
      const dependentCount = 500;
      const old = new Date(Date.now() - 100 * dayMs).toISOString();
      seedReceiptHistory(database, old, 1, dependentCount);
      database.exec(`
        UPDATE agent_host_compacted_mailbox_receipts SET execution_attempt_id='attempt-1';
        WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<500)
        INSERT INTO agent_host_execution_cancellation_history
        SELECT 1,'historical-dispatch','lease-'||n,'attempt-1','{}' FROM rows;
      `);
      state.close();
      states.pop();
      const reopened = await openAgentHostState(path);
      states.push(reopened);
      const remaining = () =>
        count(database, "agent_host_compacted_mailbox_receipts") +
        count(database, "agent_host_execution_cancellation_history");
      const budget = DEFAULT_AGENT_HOST_TERMINAL_COMPACTION_POLICY.mailboxReceiptPruneBatchSize;
      expect(remaining()).toBe(2 * dependentCount - budget);
      expect(count(database, "agent_host_terminal_execution_receipts")).toBe(1);
      reopened.close();
      states.pop();
      const resumed = await openAgentHostState(path);
      states.push(resumed);
      expect(remaining()).toBe(2 * dependentCount - 2 * budget);
      expect(count(database, "agent_host_terminal_execution_receipts")).toBe(1);
      vi.advanceTimersToNextTimer();
      expect(remaining()).toBe(2 * dependentCount - 3 * budget);
      vi.advanceTimersToNextTimer();
      expect(remaining()).toBe(0);
      expect(count(database, "agent_host_terminal_execution_receipts")).toBe(0);
      expect(resumed.lastAcknowledgedSequence()).toBe(dependentCount);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("durably acknowledges ordinary outbox events without reading a full retained receipt history", async () => {
    const { path } = await setup();
    const database = await openAgentHostDatabase(path, 5_000);
    const statements: string[] = [];
    const state = new AgentHostState({
      exec: (sql) => database.exec(sql),
      close: () => database.close(),
      prepare(sql) {
        statements.push(sql);
        return database.prepare(sql);
      }
    });
    states.push(state);
    seedReceiptHistory(database, new Date().toISOString());
    const event = state.queueHeartbeat([]);
    statements.length = 0;
    expect(state.acknowledgeEvent(event.messageId)).toBe(true);
    expect(state.pendingEventCount()).toBe(0);
    expect(
      database
        .prepare("SELECT acknowledged_at FROM agent_host_outbox WHERE message_id=?")
        .get(event.messageId)?.acknowledged_at
    ).toEqual(expect.any(String));
    expect(
      statements.filter((sql) =>
        /agent_host_(terminal_execution_receipts|compacted_mailbox_receipts)/.test(sql)
      )
    ).toEqual([]);
  });

  it("uses bounded index ranges to prune an oversized receipt history before minting more", async () => {
    vi.useFakeTimers();
    const { state, path } = await setup();
    state.close();
    states.pop();
    const database = await openAgentHostDatabase(path, 5_000);
    const { maxReceipts, maxMailboxReceipts, receiptPruneBatchSize, mailboxReceiptPruneBatchSize } =
      DEFAULT_AGENT_HOST_TERMINAL_COMPACTION_POLICY;
    database.exec(`
      DROP INDEX idx_agent_host_terminal_event_message;
      DROP INDEX idx_agent_host_terminal_maintenance;
      DROP INDEX idx_agent_host_inbox_attempt;
      DROP INDEX idx_agent_host_outbox_attempt;
    `);
    seedReceiptHistory(
      database,
      new Date().toISOString(),
      maxReceipts + 130,
      maxMailboxReceipts + 600
    );
    const plans: string[] = [];
    const reopened = new AgentHostState({
      exec: (sql) => database.exec(sql),
      close: () => database.close(),
      prepare(sql) {
        const statement = database.prepare(sql);
        return {
          get: (...values) => statement.get(...values),
          run: (...values) => statement.run(...values),
          all: (...values) => {
            if (
              /idx_agent_host_(terminal_receipts_age|compacted_mailbox_receipts_age)/.test(sql) ||
              sql.includes("idx_agent_host_terminal_maintenance")
            ) {
              for (const row of database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values)) {
                plans.push(String(row.detail));
              }
            }
            return statement.all(...values);
          }
        };
      }
    });
    states.push(reopened);
    expect(database.prepare("SELECT version FROM agent_host_state_schema").get()?.version).toBe(14);
    expect(count(database, "agent_host_terminal_execution_receipts")).toBe(
      maxReceipts + 130 - receiptPruneBatchSize
    );
    expect(count(database, "agent_host_compacted_mailbox_receipts")).toBe(
      maxMailboxReceipts + 600 - mailboxReceiptPruneBatchSize
    );
    const sequence = maxMailboxReceipts + 601;
    const received = reopened.receive(delivery(sequence));
    reopened.acknowledgeEvent(received.acknowledgement.messageId);
    reopened.startExecution(sequence);
    acknowledgeByType(reopened, "dispatch.accepted");
    reopened.completeExecution(sequence, commandFor(sequence), result);
    acknowledgeByType(reopened, "dispatch.completed");
    expect(reopened.executionEvidence(sequence)?.terminalAcknowledgedAt).toEqual(
      expect.any(String)
    );
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersToNextTimer();
    expect(reopened.executionEvidence(sequence)?.status).toBe("completed");
    vi.advanceTimersToNextTimer();
    expect(reopened.executionEvidence(sequence)).toBeUndefined();
    expect(count(database, "agent_host_terminal_execution_receipts")).toBe(maxReceipts + 1);
    expect(count(database, "agent_host_compacted_mailbox_receipts")).toBe(maxMailboxReceipts);
    vi.advanceTimersToNextTimer();
    expect(count(database, "agent_host_terminal_execution_receipts")).toBe(maxReceipts);
    expect(count(database, "agent_host_compacted_mailbox_receipts")).toBe(maxMailboxReceipts);
    expect(plans).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/SEARCH .*idx_agent_host_terminal_receipts_age .*compacted_at</),
        expect.stringMatching(
          /SEARCH .*idx_agent_host_compacted_mailbox_receipts_age .*compacted_at</
        ),
        expect.stringMatching(
          /SEARCH .*idx_agent_host_terminal_receipts_age .*compacted_at=\? AND inbox_sequence</
        ),
        expect.stringMatching(
          /SEARCH .*idx_agent_host_compacted_mailbox_receipts_age .*compacted_at=\? AND (sequence|rowid)</
        ),
        expect.stringMatching(/SEARCH .*idx_agent_host_terminal_maintenance/)
      ])
    );
  });

  it("accepts exact replay through deferred compaction and rejects a fresh sequence for that attempt", async () => {
    vi.useFakeTimers();
    const { state, path } = await setup();
    const message = delivery(1);
    const first = state.receive(message).acknowledgement;
    state.acknowledgeEvent(first.messageId);
    state.startExecution(1);
    acknowledgeByType(state, "dispatch.accepted");
    state.completeExecution(1, commandFor(1), result);
    acknowledgeByType(state, "dispatch.completed");
    expect(state.executionEvidence(1)?.terminalAcknowledgedAt).toEqual(expect.any(String));
    expect(() => state.receive(delivery(2, 1))).toThrow("mailbox_message_conflict");
    expect(() => state.receive(cancelDelivery(2))).toThrow("mailbox_message_conflict");
    expect(() => state.receive(permissionDelivery(2))).toThrow("mailbox_message_conflict");
    expect(state.lastReceivedSequence()).toBe(1);

    const replay = state.receive(message);
    expect(replay.stored).toBe(false);
    expect(replay.acknowledgement.messageId).not.toBe(first.messageId);
    expect(state.receive(message)).toEqual(replay);
    expect(state.pendingEvents()).toEqual([replay.acknowledgement]);
    vi.advanceTimersByTime(1);
    expect(state.executionEvidence(1)).toBeUndefined();
    expect(state.pendingEvents()).toEqual([replay.acknowledgement]);
    state.close();
    states.pop();

    const reopened = await openAgentHostState(path);
    states.push(reopened);
    expect(reopened.receive(message)).toEqual(replay);
    expect(reopened.acknowledgeEvent(replay.acknowledgement.messageId)).toBe(true);
    const repeated = reopened.receive(message);
    expect(repeated.stored).toBe(false);
    expect(repeated.acknowledgement.messageId).not.toBe(replay.acknowledgement.messageId);
    expect(reopened.pendingEvents()).toEqual([repeated.acknowledgement]);
    expect(reopened.pendingExecutions(1)).toEqual([]);
    expect(reopened.lastAcknowledgedSequence()).toBe(1);

    reopened.receive(delivery(2));
    reopened.synchronizeMailboxAcknowledgement(2);
    expect(reopened.pendingEventCount()).toBe(0);
    const afterReconciliation = reopened.receive(message);
    expect(afterReconciliation.acknowledgement.messageId).not.toBe(
      repeated.acknowledgement.messageId
    );
    expect(reopened.pendingEvents()).toEqual([afterReconciliation.acknowledgement]);
    expect(reopened.acknowledgeEvent(afterReconciliation.acknowledgement.messageId)).toBe(true);

    const nextReplay = reopened.receive(message);
    reopened.receive(delivery(3));
    reopened.synchronizeMailboxAcknowledgement(3);
    vi.advanceTimersToNextTimer();
    const database = await openAgentHostDatabase(path, 5_000);
    try {
      expect(
        database
          .prepare("SELECT message_id FROM agent_host_outbox WHERE message_id=?")
          .get(nextReplay.acknowledgement.messageId)
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("advances past a full page of protected attempts sharing one terminal ACK timestamp", async () => {
    vi.useFakeTimers();
    const { state, path } = await setup();
    const blocked = DEFAULT_AGENT_HOST_TERMINAL_COMPACTION_POLICY.compactionBatchSize;
    const ready = blocked + 1;
    const later = ready + 1;
    for (let sequence = 1; sequence <= later; sequence += 1) {
      if (sequence === later) vi.setSystemTime(Date.now() + 1);
      const received = state.receive(delivery(sequence));
      state.acknowledgeEvent(received.acknowledgement.messageId);
      state.startExecution(sequence);
      if (sequence > blocked) {
        const accepted = state
          .pendingEvents()
          .find(
            (event) =>
              event.type === "dispatch.accepted" &&
              event.dispatchId === commandFor(sequence).dispatchId
          );
        if (!accepted) throw new Error("missing_test_accepted_event");
        state.acknowledgeEvent(accepted.messageId);
      }
      state.completeExecution(sequence, commandFor(sequence), result);
      acknowledgeByType(state, "dispatch.completed");
    }
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersToNextTimer();
    expect(state.executionEvidence(ready)?.status).toBe("completed");
    expect(state.executionEvidence(later)?.status).toBe("completed");
    vi.advanceTimersToNextTimer();
    expect(state.executionEvidence(ready)).toBeUndefined();
    expect(state.executionEvidence(later)?.status).toBe("completed");
    vi.advanceTimersToNextTimer();
    expect(state.executionEvidence(later)).toBeUndefined();
    expect(state.executionEvidence(1)?.status).toBe("completed");
    expect(state.executionEvidence(blocked)?.status).toBe("completed");
    expect(state.pendingEventCount()).toBe(blocked);
    const database = await openAgentHostDatabase(path, 5_000);
    try {
      expect(count(database, "agent_host_terminal_execution_receipts")).toBe(2);
    } finally {
      database.close();
    }
  });

  it("reclaims an expiring receipt while idle and cancels queued maintenance on state close", async () => {
    vi.useFakeTimers();
    const { state, path } = await setup();
    const database = await openAgentHostDatabase(path, 5_000);
    try {
      const ageDays = DEFAULT_AGENT_HOST_TERMINAL_COMPACTION_POLICY.maxReceiptAgeDays;
      seedReceiptHistory(database, new Date(Date.now() - ageDays * dayMs + 1).toISOString(), 1, 1);
      state.close();
      states.pop();
      const reopened = await openAgentHostState(path);
      states.push(reopened);
      expect(count(database, "agent_host_compacted_mailbox_receipts")).toBe(1);
      vi.advanceTimersByTime(1);
      expect(count(database, "agent_host_compacted_mailbox_receipts")).toBe(1);
      vi.advanceTimersByTime(1);
      expect(count(database, "agent_host_compacted_mailbox_receipts")).toBe(0);
      expect(reopened.lastAcknowledgedSequence()).toBe(1);

      const received = reopened.receive(delivery(2));
      reopened.acknowledgeEvent(received.acknowledgement.messageId);
      reopened.startExecution(2);
      acknowledgeByType(reopened, "dispatch.accepted");
      reopened.completeExecution(2, commandFor(2), result);
      acknowledgeByType(reopened, "dispatch.completed");
      expect(reopened.executionEvidence(2)?.terminalAcknowledgedAt).toEqual(expect.any(String));
      reopened.close();
      states.pop();
      vi.advanceTimersByTime(dayMs);
      expect(count(database, "agent_host_executions")).toBe(1);

      const recovered = await openAgentHostState(path);
      states.push(recovered);
      expect(recovered.executionEvidence(2)).toBeUndefined();
      expect(recovered.receive(delivery(2)).stored).toBe(false);
      expect(recovered.lastAcknowledgedSequence()).toBe(2);
    } finally {
      database.close();
    }
  });

  it("reports a failed maintenance batch, preserves committed ACKs and retries after a yield", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const { state, path } = await setup();
    const database = await openAgentHostDatabase(path, 5_000);
    try {
      const received = state.receive(delivery(1));
      state.acknowledgeEvent(received.acknowledgement.messageId);
      state.startExecution(1);
      acknowledgeByType(state, "dispatch.accepted");
      state.completeExecution(1, commandFor(1), result);
      database.exec(`
        CREATE TRIGGER reject_terminal_compaction BEFORE INSERT ON agent_host_terminal_execution_receipts
        BEGIN SELECT RAISE(ABORT,'maintenance test write failure'); END;
      `);
      acknowledgeByType(state, "dispatch.completed");
      expect(state.pendingEventCount()).toBe(0);
      vi.advanceTimersByTime(1);
      expect(warning).toHaveBeenCalledWith("maintenance test write failure", {
        code: "agent_host_terminal_maintenance_failed"
      });
      expect(state.executionEvidence(1)?.terminalAcknowledgedAt).toEqual(expect.any(String));
      expect(state.lastAcknowledgedSequence()).toBe(1);
      expect(count(database, "agent_host_terminal_execution_receipts")).toBe(0);
      const heartbeat = state.queueHeartbeat([]);
      expect(state.acknowledgeEvent(heartbeat.messageId)).toBe(true);
      database.exec("DROP TRIGGER reject_terminal_compaction");
      vi.advanceTimersToNextTimer();
      expect(state.executionEvidence(1)).toBeUndefined();
      expect(count(database, "agent_host_terminal_execution_receipts")).toBe(1);
    } finally {
      database.close();
    }
  });
});
