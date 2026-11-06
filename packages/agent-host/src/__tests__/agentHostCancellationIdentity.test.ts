import {
  agentHostProtocolVersion,
  exampleExecuteDelivery
} from "@planweave-ai/agent-host-protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";
import { AgentHostTerminalCompactionRepository } from "../state/agentHostTerminalCompaction.js";
import { openAgentHostDatabase } from "../state/sqliteDatabase.js";
import { acpCapabilitySnapshotTestValue } from "./support/acpCapabilitySnapshotTestValues.js";

const directories: string[] = [];
const states: AgentHostState[] = [];
const before = new Date("2030-01-01T00:00:00.000Z");
const expiry = "2030-01-01T00:01:00.000Z";
const deadline = new Date(expiry);
const renewedExpiry = "2030-01-01T00:02:00.000Z";
const command = { ...exampleExecuteDelivery.command, leaseExpiresAt: expiry };
const failure = { code: "executor_failed", message: "Execution failed.", retryable: false };

afterEach(async () => {
  for (const state of states.splice(0)) state.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-cancellation-identity-"));
  directories.push(directory);
  const path = join(directory, "host.sqlite");
  const state = await openAgentHostState(path);
  states.push(state);
  state.receive({ ...exampleExecuteDelivery, command });
  return { state, path };
}

async function resumeCancelled(kind: "mailbox" | "authentication") {
  const fixture = await setup();
  const { state } = fixture;
  state.startExecution(1, before);
  state.recordSessionEvidence(1, {
    sessionId: "session-lease-settlement",
    capabilitySnapshot: acpCapabilitySnapshotTestValue(),
    recoveryId: "recovery-lease-settlement"
  });
  const identity = command;
  const cancellation =
    kind === "mailbox"
      ? {
          type: "cancel_execution" as const,
          protocolVersion: agentHostProtocolVersion,
          dispatchId: identity.dispatchId,
          leaseId: identity.leaseId,
          executionAttemptId: identity.executionAttemptId,
          reason: "old cancellation"
        }
      : {
          type: "interaction.authentication_action" as const,
          dispatchId: identity.dispatchId,
          leaseId: identity.leaseId,
          executionAttemptId: identity.executionAttemptId,
          acpSessionId: "session-lease-settlement",
          actionId: "authentication-old",
          action: "cancel" as const
        };
  if (kind === "authentication")
    state.recordInteractionAction(1, {
      leaseId: identity.leaseId,
      sessionId: "session-lease-settlement",
      actionId: "authentication-old",
      kind: "authentication",
      deadline: renewedExpiry,
      requestDigest: `sha256:${"b".repeat(64)}`,
      afterCursor: 0,
      cursor: 1
    });
  state.receive(
    {
      type: "mailbox.message",
      protocolVersion: agentHostProtocolVersion,
      messageId: "old-cancellation",
      sequence: 2,
      previousSequence: 1,
      command: cancellation
    },
    before
  );
  if (kind === "mailbox") expect(state.applyCancellation(2)).toEqual({ shouldAbort: true });
  expect(state.executionCancellationMatches(1, identity)).toBe(true);
  const oldIntent = state.executionEvidence(1)?.cancellationIntent;
  state.abandonExpiredExecutions(deadline);
  const resumed = {
    ...identity,
    type: "resume_execution" as const,
    leaseId: "lease-cancellation-resumed",
    leaseExpiresAt: renewedExpiry,
    priorRecovery: {
      acpSessionId: "session-lease-settlement",
      recoveryId: "recovery-lease-settlement"
    }
  };
  state.receive({
    type: "mailbox.message",
    protocolVersion: agentHostProtocolVersion,
    messageId: "resume-after-cancellation",
    sequence: 3,
    previousSequence: 2,
    command: {
      type: resumed.type,
      protocolVersion: agentHostProtocolVersion,
      dispatchId: resumed.dispatchId,
      leaseId: resumed.leaseId,
      executionAttemptId: resumed.executionAttemptId,
      leaseExpiresAt: resumed.leaseExpiresAt,
      priorRecovery: resumed.priorRecovery
    }
  });
  state.close();
  states.splice(states.indexOf(state), 1);
  const legacy = await openAgentHostDatabase(fixture.path, 5_000);
  legacy.exec(
    "DROP TABLE agent_host_execution_cancellation_history; UPDATE agent_host_state_schema SET version=12"
  );
  legacy.close();
  const reopened = await openAgentHostState(fixture.path);
  states.push(reopened);
  expect(reopened.startResumption(1, deadline)?.execution.command.leaseId).toBe(resumed.leaseId);
  expect(reopened.executionCancellationMatches(1, resumed)).toBe(false);
  return { ...fixture, state: reopened, resumed, cancellation, oldIntent };
}

async function verifyAuditRetention(
  state: AgentHostState,
  path: string,
  expected: Array<{ leaseId: string; intent: unknown }>
) {
  for (const event of state.pendingEvents()) state.acknowledgeEvent(event.messageId);
  expect(state.executionEvidence(1)).toBeUndefined();
  expect(state.pendingExecutions(1)).toEqual([]);
  expect(state.receive({ ...exampleExecuteDelivery, command }).stored).toBe(false);
  state.close();
  states.splice(states.indexOf(state), 1);
  const reopened = await openAgentHostState(path);
  states.push(reopened);
  const inspected = await openAgentHostDatabase(path, 5_000);
  try {
    expect(
      inspected.prepare("SELECT COUNT(*) AS count FROM agent_host_execution_actions").get()?.count
    ).toBe(0);
    const audit = inspected
      .prepare(
        "SELECT lease_id,intent_json FROM agent_host_execution_cancellation_history ORDER BY lease_id"
      )
      .all();
    expect(audit).toEqual(
      expected
        .map(({ leaseId, intent }) => ({ lease_id: leaseId, intent_json: JSON.stringify(intent) }))
        .sort((a, b) => a.lease_id.localeCompare(b.lease_id))
    );
    expect(
      inspected.prepare("SELECT terminal_kind FROM agent_host_terminal_execution_receipts").all()
    ).toHaveLength(1);
    inspected
      .prepare("UPDATE agent_host_terminal_execution_receipts SET compacted_at=?")
      .run("2000-01-01T00:00:00.000Z");
    expect(
      new AgentHostTerminalCompactionRepository(inspected).compact().prunedReceipts
    ).toBeGreaterThan(0);
    expect(
      inspected
        .prepare("SELECT COUNT(*) AS count FROM agent_host_execution_cancellation_history")
        .get()?.count
    ).toBe(0);
  } finally {
    inspected.close();
  }
}

describe("Agent Host cancellation identity and audit", () => {
  it.each([
    "mailbox",
    "authentication"
  ] as const)("keeps a real resumed failure failed after old %s cancellation and reopen", async (kind) => {
    const { state, resumed, oldIntent, path } = await resumeCancelled(kind);
    expect(state.failExecution(1, command, failure, deadline)).toBe("stale");
    expect(state.failExecution(1, resumed, failure, deadline)).toBe("applied");
    expect(state.executionEvidence(1)).toMatchObject({
      status: "failed",
      terminalKind: "failed",
      cancellationIntent: oldIntent
    });
    expect(state.pendingEvents()).toContainEqual(
      expect.objectContaining({ type: "dispatch.failed", leaseId: resumed.leaseId, failure })
    );
    await verifyAuditRetention(state, path, [{ leaseId: command.leaseId, intent: oldIntent }]);
  });

  it("keeps old evidence and the pending cancellation when archiving fails, then retries atomically", async () => {
    const { state, path, resumed, oldIntent } = await resumeCancelled("mailbox");
    state.receive({
      type: "mailbox.message",
      protocolVersion: agentHostProtocolVersion,
      sequence: 4,
      previousSequence: 3,
      messageId: "archive-write-failure",
      command: {
        type: "cancel_execution",
        protocolVersion: agentHostProtocolVersion,
        dispatchId: resumed.dispatchId,
        leaseId: resumed.leaseId,
        executionAttemptId: resumed.executionAttemptId,
        reason: "new cancellation"
      }
    });
    const inspected = await openAgentHostDatabase(path, 5_000);
    try {
      inspected.exec(
        "CREATE TRIGGER fail_cancellation_archive BEFORE INSERT ON agent_host_execution_cancellation_history BEGIN SELECT RAISE(ABORT,'audit_unavailable'); END"
      );
      expect(() => state.applyCancellation(4)).toThrow("audit_unavailable");
      expect(state.executionEvidence(1)?.cancellationIntent).toEqual(oldIntent);
      expect(state.pendingCancellations().map((item) => item.sequence)).toEqual([4]);
      expect(state.executionCancellationMatches(1, resumed)).toBe(false);
      expect(
        inspected
          .prepare("SELECT COUNT(*) AS count FROM agent_host_execution_cancellation_history")
          .get()?.count
      ).toBe(0);
      inspected.exec("DROP TRIGGER fail_cancellation_archive");
      expect(state.applyCancellation(4)).toEqual({ shouldAbort: true });
      expect(state.pendingCancellations()).toEqual([]);
      expect(state.executionCancellationMatches(1, resumed)).toBe(true);
      expect(
        inspected
          .prepare("SELECT COUNT(*) AS count FROM agent_host_execution_cancellation_history")
          .get()?.count
      ).toBe(1);
    } finally {
      inspected.close();
    }
  });

  it.each([
    "mailbox",
    "authentication"
  ] as const)("cancels a resumed lease after %s cancellation, preserves both identities and retries idempotently", async (kind) => {
    const { state, resumed, path, oldIntent } = await resumeCancelled(kind);
    const identity = resumed;
    if (kind === "authentication") {
      expect(() =>
        state.receive(
          {
            type: "mailbox.message",
            protocolVersion: agentHostProtocolVersion,
            messageId: "old-action-new-lease",
            sequence: 4,
            previousSequence: 3,
            command: {
              type: "interaction.authentication_action",
              dispatchId: identity.dispatchId,
              leaseId: identity.leaseId,
              executionAttemptId: identity.executionAttemptId,
              acpSessionId: "session-lease-settlement",
              actionId: "authentication-old",
              action: "cancel"
            }
          },
          deadline
        )
      ).toThrow("execution_action_stale_lease");
      state.recordInteractionAction(1, {
        leaseId: identity.leaseId,
        sessionId: "session-lease-settlement",
        actionId: "authentication-new",
        kind: "authentication",
        deadline: renewedExpiry,
        requestDigest: `sha256:${"c".repeat(64)}`,
        afterCursor: 1,
        cursor: 2
      });
    }
    const cancellation =
      kind === "mailbox"
        ? {
            type: "cancel_execution" as const,
            protocolVersion: agentHostProtocolVersion,
            dispatchId: identity.dispatchId,
            leaseId: identity.leaseId,
            executionAttemptId: identity.executionAttemptId,
            reason: "new cancellation"
          }
        : {
            type: "interaction.authentication_action" as const,
            dispatchId: identity.dispatchId,
            leaseId: identity.leaseId,
            executionAttemptId: identity.executionAttemptId,
            acpSessionId: "session-lease-settlement",
            actionId: "authentication-new",
            action: "cancel" as const
          };
    for (const sequence of [4, 5]) {
      const delivery = {
        type: "mailbox.message" as const,
        protocolVersion: agentHostProtocolVersion,
        sequence,
        previousSequence: sequence - 1,
        messageId: `new-cancellation-${sequence}`,
        command: cancellation
      };
      state.receive(delivery, deadline);
      if (kind === "mailbox")
        expect(state.applyCancellation(sequence)).toEqual({ shouldAbort: true });
      expect(state.receive(delivery, deadline).stored).toBe(false);
      expect(state.executionCancellationMatches(1, identity)).toBe(true);
    }
    expect(state.pendingCancellations()).toEqual([]);
    for (const [index, stale] of [
      command,
      { ...identity, dispatchId: "wrong-dispatch" },
      { ...identity, executionAttemptId: "wrong-attempt" }
    ].entries()) {
      const sequence = 6 + index;
      state.receive({
        type: "mailbox.message",
        protocolVersion: agentHostProtocolVersion,
        sequence,
        previousSequence: sequence - 1,
        messageId: `late-cancel-${sequence}`,
        command: {
          type: "cancel_execution",
          protocolVersion: agentHostProtocolVersion,
          dispatchId: stale.dispatchId,
          leaseId: stale.leaseId,
          executionAttemptId: stale.executionAttemptId,
          reason: "late"
        }
      });
      expect(state.applyCancellation(sequence)).toEqual({ shouldAbort: false });
      expect(state.executionCancellationMatches(1, stale)).toBe(false);
    }
    const inspected = await openAgentHostDatabase(path, 5_000);
    try {
      const audit = inspected
        .prepare(
          "SELECT dispatch_id,lease_id,execution_attempt_id,intent_json FROM agent_host_execution_cancellation_history"
        )
        .all();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        dispatch_id: command.dispatchId,
        lease_id: command.leaseId,
        execution_attempt_id: command.executionAttemptId,
        intent_json: JSON.stringify(oldIntent)
      });
    } finally {
      inspected.close();
    }
    expect(state.failExecution(1, command, failure, deadline)).toBe("stale");
    expect(state.failExecution(1, identity, failure, deadline)).toBe("applied");
    expect(state.executionEvidence(1)).toMatchObject({
      status: "cancelled",
      terminalKind: "cancelled"
    });
    await verifyAuditRetention(state, path, [
      { leaseId: command.leaseId, intent: oldIntent },
      { leaseId: identity.leaseId, intent: state.executionEvidence(1)?.cancellationIntent }
    ]);
  });

  it.each([
    {
      intent: { reason: "missing", commandSequence: 99 },
      error: "execution_cancellation_command_not_found"
    },
    {
      intent: { reason: "not cancellation", commandSequence: 1 },
      error: "execution_cancellation_command_invalid"
    },
    {
      intent: { kind: "authentication_cancelled", actionId: "missing" },
      error: "execution_cancellation_action_not_found"
    }
  ])("fails closed without terminal evidence for corrupt cancellation $error", async ({
    intent,
    error
  }) => {
    const { state, path } = await setup();
    state.startExecution(1, before);
    const inspected = await openAgentHostDatabase(path, 5_000);
    inspected
      .prepare("UPDATE agent_host_executions SET cancellation_intent_json=?")
      .run(JSON.stringify(intent));
    inspected.close();
    expect(() => state.failExecution(1, command, failure, before)).toThrow(error);
    expect(state.executionEvidence(1)?.status).toBe("running");
    expect(state.pendingEvents().filter((event) => event.type === "dispatch.failed")).toEqual([]);
  });

  it("rejects a current schema with missing cancellation audit storage without recreating it", async () => {
    const { state, path } = await setup();
    state.close();
    states.pop();
    const inspected = await openAgentHostDatabase(path, 5_000);
    inspected.exec("DROP TABLE agent_host_execution_cancellation_history");
    inspected.close();
    await expect(openAgentHostState(path)).rejects.toThrow("agent_host_state_schema_incomplete");
  });
});
