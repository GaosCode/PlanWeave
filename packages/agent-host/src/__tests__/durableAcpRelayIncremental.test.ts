import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  exampleExecuteDelivery,
  executionEnvelopeSchema,
  hashExecutionEnvelope,
  mailboxDeliverySchema
} from "@planweave-ai/agent-host-protocol";
import { AgentHostState, openAgentHostState } from "../state/agentHostState.js";
import { openAgentHostDatabase, type SqliteDatabase } from "../state/sqliteDatabase.js";
import { openAgentHostRemoteExecutionOutbox } from "../state/remoteExecutionOutbox.js";
import type { AgentHostRemoteExecutionIdentity } from "../execution/remoteAcpPorts.js";
import { acpCapabilitySnapshotTestValue } from "./support/acpCapabilitySnapshotTestValues.js";

const directories: string[] = [];
const states: AgentHostState[] = [];
afterEach(async () => {
  for (const state of states.splice(0)) state.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

type QueryRead = { sql: string; values: unknown[]; rows: number };
function observeDatabase(database: SqliteDatabase) {
  const reads: QueryRead[] = [];
  let remoteRows = 0;
  let wireRows = 0;
  let countTotal = 0;
  const observed: SqliteDatabase = {
    exec: (sql) => database.exec(sql),
    close: () => database.close(),
    prepare(sql) {
      const statement = database.prepare(sql);
      const observe = (rows: Array<Record<string, unknown>>, values: unknown[]) => {
        reads.push({ sql, values, rows: rows.length });
        if (sql.includes("agent_host_remote_execution_outbox")) {
          remoteRows += rows.filter((row) => typeof row.record_json === "string").length;
        }
        if (sql.includes("agent_host_outbox")) {
          wireRows += rows.filter((row) => typeof row.event_json === "string").length;
        }
        for (const row of rows) if (typeof row.count === "number") countTotal += row.count;
      };
      return {
        run: (...values) => statement.run(...values),
        get(...values) {
          const result = statement.get(...values);
          observe(result ? [result] : [], values);
          return result;
        },
        all(...values) {
          const result = statement.all(...values);
          observe(result, values);
          return result;
        }
      };
    }
  };
  return { observed, reads, metrics: () => ({ remoteRows, wireRows, countTotal }) };
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-relay-incremental-"));
  directories.push(directory);
  const path = join(directory, "state.sqlite");
  const database = await openAgentHostDatabase(path, 5_000);
  const observer = observeDatabase(database);
  const state = new AgentHostState(observer.observed);
  state.setRemoteRunnerEventProtocolVersion(2);
  states.push(state);
  if (
    exampleExecuteDelivery.type !== "mailbox.message" ||
    exampleExecuteDelivery.command.type !== "execute_block"
  ) {
    throw new Error("execute_block_fixture_required");
  }
  const delivery = mailboxDeliverySchema.parse({
    ...exampleExecuteDelivery,
    command: { ...exampleExecuteDelivery.command, leaseExpiresAt: "2030-01-01T00:00:00.000Z" }
  });
  if (delivery.command.type !== "execute_block") throw new Error("execute_block_required");
  state.receive(delivery);
  state.startExecution(delivery.sequence);
  const identity = {
    dispatchId: delivery.command.dispatchId,
    leaseId: delivery.command.leaseId,
    executionAttemptId: delivery.command.executionAttemptId
  };
  return {
    path,
    database,
    observer,
    state,
    identity,
    delivery: { ...delivery, command: delivery.command }
  };
}

function appendLifecycle(
  state: AgentHostState,
  identity: AgentHostRemoteExecutionIdentity,
  sequence: number
) {
  state.append({
    kind: "engine_event",
    identity,
    event: { sequence, timestamp: "2026-09-27T00:00:00.000Z", kind: "lifecycle", state: "running" }
  });
}
function appendCapability(
  state: AgentHostState,
  identity: AgentHostRemoteExecutionIdentity,
  sequence = 10
) {
  state.append({
    kind: "engine_event",
    identity,
    event: {
      sequence,
      timestamp: "2026-09-27T00:00:00.000Z",
      kind: "capability_snapshot",
      snapshot: acpCapabilitySnapshotTestValue()
    }
  });
}
function appendSession(
  state: AgentHostState,
  identity: AgentHostRemoteExecutionIdentity,
  sequence = 20
) {
  state.append({
    kind: "engine_event",
    identity,
    event: {
      sequence,
      timestamp: "2026-09-27T00:00:00.000Z",
      kind: "session_started",
      sessionId: "session-incremental",
      loaded: false
    }
  });
}
function runnerEvents(state: AgentHostState) {
  return state
    .pendingEvents()
    .filter((event) => event.type === "acp.events" && "eventProtocolVersion" in event);
}
function closeState(state: AgentHostState) {
  states.splice(states.indexOf(state), 1);
  state.close();
}

describe("incremental durable ACP relay", () => {
  it.each([
    256, 512, 1024
  ])("bounds actual SQLite returned/decoded rows for %i engine events", async (size) => {
    const { state, identity, observer, database, delivery } = await setup();
    appendCapability(state, identity);
    appendSession(state, identity);
    for (let index = 0; index < size - 2; index += 1)
      appendLifecycle(state, identity, 30 + index * 7);
    const metrics = observer.metrics();
    const remoteQueries = observer.reads.filter(
      (query) =>
        query.sql.includes("SELECT") &&
        query.sql.includes("record_json") &&
        query.sql.includes("agent_host_remote_execution_outbox")
    );
    const countQueries = observer.reads.filter(
      (query) =>
        query.sql.includes("SELECT COUNT(*)") &&
        (query.sql.includes("agent_host_remote_execution_outbox") ||
          query.sql.includes("FROM agent_host_outbox"))
    );
    const plans = [
      ...new Map([...remoteQueries, ...countQueries].map((query) => [query.sql, query])).values()
    ].map((query) => ({
      sql: query.sql.replace(/\s+/g, " ").trim(),
      plan: database
        .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .all(...query.values)
        .map((row) => String(row.detail))
    }));
    console.info(JSON.stringify({ size, ...metrics, queryPlans: plans }));
    expect(metrics.remoteRows).toBeLessThanOrEqual(size + 2);
    expect(metrics.wireRows).toBeLessThanOrEqual(size);
    const rangeQueries = remoteQueries.filter(
      (query) => query.rows > 1 || query.sql.includes("sequence>")
    );
    expect(rangeQueries.length).toBeGreaterThan(0);
    expect(
      rangeQueries.every((query) => query.sql.includes("LIMIT") && query.sql.includes("sequence>"))
    ).toBe(true);
    expect(plans.every((entry) => entry.plan.some((detail) => detail.includes("INDEX")))).toBe(
      true
    );
    const events = runnerEvents(state);
    expect(events).toHaveLength(size);
    expect(events.map((event) => [event.afterCursor, event.cursor])).toEqual(
      Array.from({ length: size }, (_, index) => [index, index + 1])
    );
    expect(events.map((event) => event.events[0]?.sourceSequence)).toEqual([
      10,
      20,
      ...Array.from({ length: size - 2 }, (_, index) => 30 + index * 7)
    ]);
    expect(state.executionEvidence(delivery.sequence)?.eventCursor).toBe(size);
  });

  it("drains multiple pre-session batches with mixed records and interleaved identities", async () => {
    const { state, identity, delivery } = await setup();
    const envelope = executionEnvelopeSchema.parse({
      ...delivery.command.envelope,
      execution: { dispatchId: "dispatch-interleaved", attemptId: "attempt-interleaved" }
    });
    const other = mailboxDeliverySchema.parse({
      ...delivery,
      sequence: 2,
      previousSequence: 1,
      messageId: "mailbox-interleaved",
      command: {
        ...delivery.command,
        dispatchId: envelope.execution.dispatchId,
        executionAttemptId: envelope.execution.attemptId,
        leaseId: "lease-interleaved",
        envelope,
        envelopeDigest: hashExecutionEnvelope(envelope)
      }
    });
    if (other.command.type !== "execute_block") throw new Error("execute_block_required");
    state.receive(other);
    state.startExecution(other.sequence);
    const otherIdentity = {
      dispatchId: other.command.dispatchId,
      leaseId: other.command.leaseId,
      executionAttemptId: other.command.executionAttemptId
    };
    appendCapability(state, identity);
    appendCapability(state, otherIdentity);
    appendSession(state, otherIdentity);
    for (let index = 0; index < 300; index += 1) {
      appendLifecycle(state, identity, 100 + index * 5);
      if (index % 100 === 0) appendLifecycle(state, otherIdentity, 30 + index);
    }
    expect(runnerEvents(state).filter((event) => event.dispatchId === identity.dispatchId)).toEqual(
      []
    );
    appendSession(state, identity, 3000);
    state.append({
      kind: "permission_request",
      identity,
      deadline: "2030-01-01T00:00:00.000Z",
      request: {
        sessionId: "session-incremental",
        requestId: "permission-mixed",
        toolCallId: "tool-mixed",
        summary: "test",
        options: [{ optionId: "deny", label: "Deny", kind: "reject_once" }]
      }
    });
    appendLifecycle(state, identity, 4000);
    state.append({
      kind: "elicitation_request",
      identity,
      deadline: "2030-01-01T00:00:00.000Z",
      request: {
        sessionId: "session-incremental",
        requestId: "elicitation-mixed",
        message: "test",
        requestedSchema: {}
      }
    });
    appendLifecycle(state, identity, 5000);
    const events = runnerEvents(state);
    const first = events.filter((event) => event.dispatchId === identity.dispatchId);
    const second = events.filter((event) => event.dispatchId === otherIdentity.dispatchId);
    expect(first.map((event) => event.events[0]?.sourceSequence)).toEqual([
      10,
      ...Array.from({ length: 300 }, (_, index) => 100 + index * 5),
      3000,
      4000,
      5000
    ]);
    expect(first.map((event) => event.cursor)).toEqual(
      Array.from({ length: 304 }, (_, index) => index + 1)
    );
    expect(second.map((event) => event.events[0]?.sourceSequence)).toEqual([10, 20, 30, 130, 230]);
    expect(state.executionEvidence(1)?.actionCursor).toBe(2);
  });

  it.each([
    "cursor",
    "queue"
  ])("rolls back checkpoint and queue on %s failure and recovers on reopen", async (stage) => {
    const { state, identity, database, path } = await setup();
    appendCapability(state, identity);
    appendSession(state, identity);
    const pending = state.pendingEvents();
    const mutation =
      stage === "cursor"
        ? "UPDATE OF event_cursor ON agent_host_executions"
        : "INSERT ON agent_host_outbox";
    database.exec(
      `CREATE TRIGGER fail_relay BEFORE ${mutation} BEGIN SELECT RAISE(ABORT,'injected_relay_failure'); END`
    );
    expect(() => appendLifecycle(state, identity, 700)).toThrow("injected_relay_failure");
    expect(state.executionEvidence(1)?.eventCursor).toBe(2);
    expect(state.records(identity)).toHaveLength(2);
    expect(state.pendingEvents()).toEqual(pending);
    database.exec("DROP TRIGGER fail_relay");
    closeState(state);
    const reopened = await openAgentHostState(path);
    states.push(reopened);
    expect(reopened.pendingEvents()).toEqual(pending);
    appendLifecycle(reopened, identity, 700);
    expect(runnerEvents(reopened).map((event) => event.cursor)).toEqual([1, 2, 3]);
  });

  it("recovers the existing durable checkpoint across ACK and repeated restarts without schema changes", async () => {
    const { state, identity, path, database } = await setup();
    appendCapability(state, identity);
    appendSession(state, identity);
    appendLifecycle(state, identity, 900);
    const pending = state.pendingEvents();
    expect(database.prepare("SELECT version FROM agent_host_state_schema").get()?.version).toBe(13);
    closeState(state);
    const reopened = await openAgentHostState(path);
    states.push(reopened);
    expect(reopened.pendingEvents()).toEqual(pending);
    for (const event of pending) reopened.acknowledgeEvent(event.messageId);
    appendLifecycle(reopened, identity, 900);
    expect(reopened.pendingEvents()).toEqual([]);
    appendLifecycle(reopened, identity, 1000);
    const next = runnerEvents(reopened);
    expect(next.map((event) => [event.afterCursor, event.cursor])).toEqual([[3, 4]]);
    closeState(reopened);
    const again = await openAgentHostState(path);
    states.push(again);
    expect(runnerEvents(again)).toEqual(next);
    appendLifecycle(again, identity, 1200);
    expect(runnerEvents(again).map((event) => event.cursor)).toEqual([4, 5]);
  });

  it("rejects a durable cursor whose source record is missing instead of skipping history", async () => {
    const { state, identity, database } = await setup();
    appendCapability(state, identity);
    appendSession(state, identity);
    database.prepare("DELETE FROM agent_host_remote_execution_outbox WHERE record_id='20'").run();
    expect(() => appendLifecycle(state, identity, 900)).toThrow(
      "remote_execution_relay_checkpoint_missing"
    );
    expect(state.executionEvidence(1)?.eventCursor).toBe(2);
    expect(state.records(identity)).toHaveLength(1);
  });

  it("preserves the default 4096-record boundary and byte limit", async () => {
    const { identity, path } = await setup();
    const outbox = await openAgentHostRemoteExecutionOutbox(path);
    try {
      for (let sequence = 1; sequence <= 4096; sequence += 1) {
        outbox.append({
          kind: "engine_event",
          identity,
          event: {
            sequence,
            timestamp: "2026-09-27T00:00:00.000Z",
            kind: "lifecycle",
            state: "running"
          }
        });
      }
      expect(() =>
        outbox.append({
          kind: "engine_event",
          identity,
          event: {
            sequence: 4097,
            timestamp: "2026-09-27T00:00:00.000Z",
            kind: "lifecycle",
            state: "running"
          }
        })
      ).toThrow("remote_execution_record_retention_limit_exceeded");
      expect(outbox.records(identity)).toHaveLength(4096);
      expect(() =>
        outbox.append({
          kind: "elicitation_request",
          identity,
          deadline: "2030-01-01T00:00:00.000Z",
          request: {
            sessionId: "session-incremental",
            requestId: "oversized",
            message: "x".repeat(1_048_576),
            requestedSchema: {}
          }
        })
      ).toThrow("remote_execution_record_too_large");
    } finally {
      outbox.close();
    }
  });
});
