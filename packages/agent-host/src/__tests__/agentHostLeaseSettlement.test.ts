import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exampleExecuteDelivery, hashExecutionEnvelope } from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentHostRemoteExecutionIdentity } from "../execution/remoteAcpPorts.js";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";
import { openAgentHostDatabase } from "../state/sqliteDatabase.js";
import { acpCapabilitySnapshotTestValue } from "./support/acpCapabilitySnapshotTestValues.js";

const directories: string[] = [];
const states: AgentHostState[] = [];
const before = new Date("2030-01-01T00:00:00.000Z");
const expiry = "2030-01-01T00:01:00.000Z";
const deadline = new Date(expiry);
const renewedExpiry = "2030-01-01T00:02:00.000Z";
const command = { ...exampleExecuteDelivery.command, leaseExpiresAt: expiry };
const result = {
  summary: "execution completed",
  reportArtifactRef: `artifact:sha256:${"a".repeat(64)}` as const,
  artifactRefs: []
};
const failure = { code: "executor_failed", message: "Execution failed.", retryable: false };

const settlements = [
  {
    name: "completeExecution",
    settle: (state: AgentHostState, identity: AgentHostRemoteExecutionIdentity, now: Date) =>
      state.completeExecution(1, identity, result, now)
  },
  {
    name: "failExecution",
    settle: (state: AgentHostState, identity: AgentHostRemoteExecutionIdentity, now: Date) =>
      state.failExecution(1, identity, failure, now)
  },
  {
    name: "failResumption",
    settle: (state: AgentHostState, identity: AgentHostRemoteExecutionIdentity, now: Date) =>
      state.failResumption(1, identity, now)
  }
];

afterEach(async () => {
  for (const state of states.splice(0)) state.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function setup(limits: Parameters<typeof openAgentHostState>[2] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "planweave-lease-settlement-"));
  directories.push(directory);
  const path = join(directory, "host.sqlite");
  const state = await openAgentHostState(path, 5_000, limits);
  states.push(state);
  state.receive({ ...exampleExecuteDelivery, command });
  return { state, path };
}

function authorizeResume(state: AgentHostState) {
  state.startExecution(1, before);
  state.recordSessionEvidence(1, {
    sessionId: "session-lease-settlement",
    capabilitySnapshot: acpCapabilitySnapshotTestValue(),
    recoveryId: "recovery-lease-settlement"
  });
  state.abandonExpiredExecutions(deadline);
  const resumed = {
    type: "resume_execution" as const,
    protocolVersion: 1 as const,
    dispatchId: command.dispatchId,
    leaseId: "lease-settlement-resumed",
    executionAttemptId: command.executionAttemptId,
    leaseExpiresAt: renewedExpiry,
    priorRecovery: {
      acpSessionId: "session-lease-settlement",
      recoveryId: "recovery-lease-settlement"
    }
  };
  state.receive({
    type: "mailbox.message",
    protocolVersion: 1,
    messageId: "mailbox-settlement-resume",
    sequence: 2,
    previousSequence: 1,
    command: resumed
  });
  return resumed;
}

describe("Agent Host authoritative lease settlement", () => {
  it.each([
    "accepted",
    "preparing",
    "running",
    "interaction_wait"
  ])("queries and expires the persisted deadline for %s", async (status) => {
    const { state, path } = await setup();
    const database = await openAgentHostDatabase(path, 5_000);
    try {
      database
        .prepare("UPDATE agent_host_executions SET status=? WHERE inbox_sequence=1")
        .run(status);
    } finally {
      database.close();
    }
    expect(state.nextLeaseExpiresAt()).toBe(expiry);
    expect(state.abandonExpiredExecutions(deadline)).toHaveLength(1);
    expect(state.executionEvidence(1)?.status).toBe(
      status === "accepted" ? "failed" : "interrupted"
    );
    expect(state.nextLeaseExpiresAt()).toBeUndefined();
    expect(state.abandonExpiredExecutions(deadline)).toEqual([]);
  });

  it("selects the earliest active deadline and removes completed work from scheduling", async () => {
    const { state } = await setup();
    const envelope = {
      ...command.envelope,
      execution: {
        ...command.envelope.execution,
        dispatchId: "dispatch-second",
        attemptId: "attempt-second"
      }
    };
    const second = {
      ...command,
      dispatchId: "dispatch-second",
      executionAttemptId: "attempt-second",
      leaseId: "lease-second",
      leaseExpiresAt: "2030-01-01T00:00:30Z",
      envelope,
      envelopeDigest: hashExecutionEnvelope(envelope)
    };
    state.receive({
      ...exampleExecuteDelivery,
      sequence: 2,
      previousSequence: 1,
      messageId: "mailbox-second",
      command: second
    });
    expect(state.nextLeaseExpiresAt()).toBe(second.leaseExpiresAt);
    state.startExecution(2, before);
    expect(state.completeExecution(2, second, result, before)).toBe("applied");
    expect(state.nextLeaseExpiresAt()).toBe(expiry);
    const events = state.pendingEvents();
    expect(state.completeExecution(2, second, result, before)).toBe("stale");
    expect(state.failExecution(2, second, failure, deadline)).toBe("stale");
    expect(state.pendingEvents()).toEqual(events);
    expect(state.executionEvidence(2)?.status).toBe("completed");
  });

  it("rejects expired or mismatched renewals and uses the committed deadline for settlement", async () => {
    const { state } = await setup();
    state.startExecution(1, before);
    for (const identity of [
      { ...command, dispatchId: "stale-dispatch" },
      { ...command, leaseId: "stale-lease" },
      { ...command, executionAttemptId: "stale-attempt" }
    ]) {
      expect(
        state.renewLease(
          identity.dispatchId,
          identity.leaseId,
          identity.executionAttemptId,
          renewedExpiry,
          before
        )
      ).toBe(false);
    }
    expect(
      state.renewLease(
        command.dispatchId,
        command.leaseId,
        command.executionAttemptId,
        renewedExpiry,
        deadline
      )
    ).toBe(false);
    expect(state.nextLeaseExpiresAt()).toBe(expiry);
    expect(
      state.renewLease(
        command.dispatchId,
        command.leaseId,
        command.executionAttemptId,
        renewedExpiry,
        before
      )
    ).toBe(true);
    expect(state.nextLeaseExpiresAt()).toBe(renewedExpiry);
    expect(state.abandonExpiredExecutions(deadline)).toEqual([]);
    expect(state.completeExecution(1, command, result, deadline)).toBe("applied");
    expect(state.nextLeaseExpiresAt()).toBeUndefined();
  });

  it("does not launch accepted or resumed work after its deadline", async () => {
    const { state: accepted } = await setup();
    expect(accepted.startExecution(1, deadline)).toBeUndefined();
    expect(accepted.executionEvidence(1)?.status).toBe("failed");
    expect(accepted.pendingEvents().filter((event) => event.type === "dispatch.accepted")).toEqual(
      []
    );

    const { state: resumed } = await setup();
    authorizeResume(resumed);
    expect(resumed.startResumption(1, new Date(renewedExpiry))).toBeUndefined();
    expect(resumed.executionEvidence(1)).toMatchObject({
      status: "interrupted",
      recoveryIntent: { kind: "lease_lost" }
    });
    expect(
      resumed
        .pendingEvents()
        .filter(
          (event) =>
            event.type === "dispatch.accepted" && event.leaseId === "lease-settlement-resumed"
        )
    ).toEqual([]);
  });

  it.each(settlements)("$name fences all identity fields before touching state", async ({
    settle
  }) => {
    const { state } = await setup();
    state.startExecution(1, before);
    const evidence = state.executionEvidence(1);
    const events = state.pendingEvents();
    for (const identity of [
      { ...command, dispatchId: "stale-dispatch" },
      { ...command, leaseId: "stale-lease" },
      { ...command, executionAttemptId: "stale-attempt" }
    ])
      expect(settle(state, identity, deadline)).toBe("stale");
    expect(state.executionEvidence(1)).toEqual(evidence);
    expect(state.pendingEvents()).toEqual(events);
    expect(state.completeExecution(999, command, result, before)).toBe("stale");
  });

  it.each(
    settlements
  )("$name preserves lease loss when its callback arrives at the deadline", async ({ settle }) => {
    const { state } = await setup();
    state.startExecution(1, before);
    expect(settle(state, command, deadline)).toBe("lease_lost");
    const evidence = state.executionEvidence(1);
    expect(evidence).toMatchObject({
      status: "interrupted",
      recoveryIntent: { kind: "lease_lost", actionRequired: true }
    });
    expect(settle(state, command, deadline)).toBe("lease_lost");
    expect(state.executionEvidence(1)).toEqual(evidence);
    expect(
      state.pendingEvents().filter((event) => event.type === "dispatch.interrupted")
    ).toHaveLength(1);
    expect(
      state
        .pendingEvents()
        .filter((event) => event.type === "dispatch.completed" || event.type === "dispatch.failed")
    ).toEqual([]);
  });

  it.each(settlements)("$name cannot settle a new lease on the same sequence", async ({
    settle
  }) => {
    const { state } = await setup();
    const resumed = authorizeResume(state);
    expect(state.startResumption(1, deadline)?.execution.command.leaseId).toBe(resumed.leaseId);
    const evidence = state.executionEvidence(1);
    const events = state.pendingEvents();
    expect(settle(state, command, deadline)).toBe("stale");
    expect(state.executionEvidence(1)).toEqual(evidence);
    expect(state.pendingEvents()).toEqual(events);
    expect(settle(state, resumed, deadline)).toBe("applied");
  });

  it.each([
    before,
    deadline
  ])("rolls back state and terminal evidence when persistence fails at %s", async (now) => {
    const { state } = await setup({ maxPendingEvents: 2 });
    state.startExecution(1, before);
    expect(() => state.completeExecution(1, command, result, now)).toThrow(
      "agent_host_pending_event_capacity_exceeded"
    );
    expect(state.executionEvidence(1)).toMatchObject({ status: "running" });
    expect(state.executionEvidence(1)?.recoveryIntent).toBeUndefined();
    expect(state.pendingEventCount()).toBe(2);
    expect(state.nextLeaseExpiresAt()).toBe(expiry);
  });
});
