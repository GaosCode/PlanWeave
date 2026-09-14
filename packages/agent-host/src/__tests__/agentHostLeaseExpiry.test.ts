import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHostExecutionError } from "../execution/agentHostExecutor.js";
import { acpCapabilitySnapshotTestValue } from "./support/acpCapabilitySnapshotTestValues.js";
import {
  completedResult,
  leaseDelivery,
  leaseHarness,
  renewal,
  resumeDelivery,
  type LeaseHarness
} from "./support/agentHostLeaseExpiryHarness.js";

const harnesses: LeaseHarness[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const harness of harnesses.splice(0)) await harness.close();
});

async function setup(options: Parameters<typeof leaseHarness>[0] = {}) {
  const harness = await leaseHarness(options);
  harnesses.push(harness);
  return harness;
}

function expectLeaseLost(harness: LeaseHarness) {
  expect(harness.state.executionEvidence(1)).toMatchObject({
    status: "interrupted",
    recoveryIntent: { kind: "lease_lost", actionRequired: true }
  });
  const terminal = harness.state
    .pendingEvents()
    .filter((event) =>
      ["dispatch.interrupted", "dispatch.failed", "dispatch.completed"].includes(event.type)
    );
  expect(terminal).toHaveLength(1);
  expect(terminal[0]).toMatchObject({ type: "dispatch.interrupted", reason: "lease_lost" });
}

describe("Agent Host connection-independent lease expiry", () => {
  it.each([
    1012, 4001
  ])("aborts and records one lease loss after socket close %s without reconnecting", async (closeCode) => {
    const harness = await setup();
    const run = await harness.startExecution();
    await harness.disconnect(closeCode);

    harness.clock.advanceBy(1_000);
    await vi.waitFor(() => expect(run.context.signal.aborted).toBe(true));
    await vi.waitFor(() => expectLeaseLost(harness));
    harness.clock.advanceBy(1_000);
    expect(run.abortCount).toBe(1);
    expectLeaseLost(harness);
    expect(harness.execute).toHaveBeenCalledOnce();
    if (closeCode === 4001) {
      await vi.waitFor(() => expect(harness.clock.pendingTimerCount()).toBe(0));
    }
  });

  it("uses a persisted renewal even when a cleared deadline callback arrives late", async () => {
    const harness = await setup();
    const run = await harness.startExecution();
    const oldCallbacks = harness.clock.callbacks();
    const renewLease = vi.spyOn(harness.state, "renewLease");
    harness.send(renewal(3_000));
    await vi.waitFor(() => expect(renewLease).toHaveReturnedWith(true));
    harness.clock.jumpBy(1_000);
    for (const callback of oldCallbacks) callback();

    expect(run.context.signal.aborted).toBe(false);
    expect(harness.state.executionEvidence(1)?.status).toBe("running");
    harness.clock.advanceBy(1_999);
    expect(run.context.signal.aborted).toBe(false);
    harness.clock.advanceBy(1);
    await vi.waitFor(() => expectLeaseLost(harness));
    expect(run.abortCount).toBe(1);
  });

  it.each([
    { leaseId: "wrong-lease" },
    { executionAttemptId: "wrong-attempt" }
  ])("rejects renewal for a different execution identity: %j", async (identity) => {
    const harness = await setup();
    const run = await harness.startExecution();
    const renewLease = vi.spyOn(harness.state, "renewLease");
    harness.send(renewal(5_000, identity));
    await vi.waitFor(() => expect(renewLease).toHaveReturnedWith(false));
    harness.clock.advanceBy(1_000);
    await vi.waitFor(() => expectLeaseLost(harness));
    expect(run.context.signal.aborted).toBe(true);
  });

  it("does not revive an expired lease when renewal arrives before a delayed timer", async () => {
    const harness = await setup();
    const run = await harness.startExecution();
    harness.clock.jumpBy(1_001);
    harness.send(renewal(5_000));

    await vi.waitFor(() => expectLeaseLost(harness));
    expect(run.context.signal.aborted).toBe(true);
    expect(harness.state.activeLeases()).toEqual([]);
  });

  it("fails an accepted command that expired while waiting to start without calling the executor", async () => {
    const harness = await setup();
    const receive = harness.state.receive.bind(harness.state);
    vi.spyOn(harness.state, "receive").mockImplementation((event) => {
      const result = receive(event);
      harness.clock.jumpBy(1_001);
      return result;
    });
    harness.send(leaseDelivery());

    await vi.waitFor(() => expect(harness.state.executionEvidence(1)?.status).toBe("failed"));
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.state.pendingEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "dispatch.failed",
          failure: expect.objectContaining({ code: "execution_lease_expired" })
        })
      ])
    );
  });

  it.each([
    "success",
    "error"
  ] as const)("fences an old %s and waits for cleanup before resuming the same sequence", async (outcome) => {
    const harness = await setup({ abortSettles: false });
    const oldRun = await harness.startExecution();
    harness.state.recordSessionEvidence(1, {
      sessionId: "lease-session-1",
      capabilitySnapshot: acpCapabilitySnapshotTestValue(),
      recoveryId: "lease-recovery-1"
    });
    harness.clock.advanceBy(1_000);
    expectLeaseLost(harness);
    harness.send(resumeDelivery());
    await vi.waitFor(() =>
      expect(harness.state.executionEvidence(1)?.leaseId).toBe("lease-resumed-2")
    );
    expect(harness.execute).toHaveBeenCalledOnce();
    expect(harness.state.executionEvidence(1)?.status).toBe("preparing");

    if (outcome === "success") oldRun.result.resolve(completedResult);
    else oldRun.result.reject(new Error("old execution failed after losing its lease"));
    await vi.waitFor(() => expect(harness.execute).toHaveBeenCalledTimes(2));
    const newRun = harness.runs[1]!;
    expect(newRun.context.sessionStart).toEqual({ kind: "load", sessionId: "lease-session-1" });
    expect(harness.state.executionEvidence(1)).toMatchObject({
      leaseId: "lease-resumed-2",
      status: "running"
    });
    expect(
      harness.state
        .pendingEvents()
        .filter((event) => event.type === "dispatch.completed" || event.type === "dispatch.failed")
    ).toEqual([]);

    harness.clock.advanceBy(4_000);
    expect(newRun.context.signal.aborted).toBe(true);
    expect(newRun.abortCount).toBe(1);
    expect(harness.state.executionEvidence(1)).toMatchObject({
      leaseId: "lease-resumed-2",
      status: "interrupted",
      recoveryIntent: { kind: "lease_lost" }
    });
    newRun.result.resolve(completedResult);
  });

  it("rechecks persisted deadlines using the reconnect welcome clock offset before pumping", async () => {
    const harness = await setup({ reconnectDelayMs: 100 });
    const run = await harness.startExecution();
    harness.setServerOffset(2_000);
    await harness.disconnect();
    harness.clock.advanceBy(100);

    await vi.waitFor(() => expect(harness.client.status().state).toBe("connected"));
    await vi.waitFor(() => expectLeaseLost(harness));
    expect(run.context.signal.aborted).toBe(true);
    expect(harness.execute).toHaveBeenCalledOnce();
  });

  it("clears all timers on repeated stop and ignores callbacks already queued before stop", async () => {
    const harness = await setup();
    const run = await harness.startExecution();
    const callbacks = harness.clock.callbacks();
    await harness.client.stop();
    await harness.client.stop();
    expect(harness.clock.pendingTimerCount()).toBe(0);
    for (const callback of callbacks) callback();
    harness.clock.advanceBy(60_000);
    expect(harness.clock.pendingTimerCount()).toBe(0);
    expect(harness.client.status()).toEqual({ state: "stopped" });
    expect(run.abortCount).toBe(1);
    expect(harness.execute).toHaveBeenCalledOnce();
  });

  it("aborts despite expiry persistence failure and exposes reconciliation before any further launch", async () => {
    const harness = await setup({ abortSettles: false });
    const run = await harness.startExecution();
    harness.database.exec(`
      CREATE TRIGGER fail_lease_expiry BEFORE UPDATE ON agent_host_executions
      WHEN NEW.status = 'interrupted'
      BEGIN SELECT RAISE(ABORT, 'lease_expiry_storage_failure'); END
    `);
    harness.clock.advanceBy(1_000);

    await vi.waitFor(() => expect(harness.client.status().state).toBe("reconciliation-required"));
    expect(run.context.signal.aborted).toBe(true);
    expect(harness.state.executionEvidence(1)?.status).toBe("running");
    expect(
      harness.state.pendingEvents().filter((event) => event.type === "dispatch.completed")
    ).toEqual([]);
    harness.client.start();
    harness.clock.advanceBy(5_000);
    expect(harness.execute).toHaveBeenCalledOnce();
    expect(harness.client.status().state).toBe("reconciliation-required");
    harness.database.exec("DROP TRIGGER fail_lease_expiry");
    run.result.resolve(completedResult);
  });

  it("exposes bounded cleanup failure when the expired executor ignores abort", async () => {
    const harness = await setup({ abortSettles: false });
    const run = await harness.startExecution();
    harness.clock.advanceBy(1_000);
    expect(run.context.signal.aborted).toBe(true);
    harness.clock.advanceBy(100);

    await vi.waitFor(() => expect(harness.client.status().state).toBe("reconciliation-required"));
    expect(harness.client.status()).toMatchObject({
      reason: expect.stringMatching(/cleanup|shutdown/)
    });
    expectLeaseLost(harness);
    run.result.resolve(completedResult);
    await harness.client.stop();
    expect(harness.client.status().state).toBe("reconciliation-required");
  });

  it("preserves lease loss and refuses stop when the aborted executor reports cleanup failure", async () => {
    const harness = await setup({
      abortSettles: false,
      expectStopFailure: "agent_host_execution_cleanup_failed"
    });
    const run = await harness.startExecution();
    harness.state.recordSessionEvidence(1, {
      sessionId: "lease-session-1",
      capabilitySnapshot: acpCapabilitySnapshotTestValue(),
      recoveryId: "lease-recovery-1"
    });
    harness.clock.advanceBy(1_000);
    expect(run.context.signal.aborted).toBe(true);
    expectLeaseLost(harness);
    harness.send(resumeDelivery());
    run.result.reject(
      new AgentHostExecutionError({
        code: "acp_cleanup_failed",
        message: "The ACP process did not release its session resources.",
        retryable: false
      })
    );

    await vi.waitFor(() =>
      expect(harness.client.status()).toEqual({
        state: "reconciliation-required",
        reason: "execution_cleanup_failed"
      })
    );
    await expect(harness.client.stop()).rejects.toThrow("agent_host_execution_cleanup_failed");
    harness.client.start();
    harness.clock.advanceBy(5_000);

    expect(harness.execute).toHaveBeenCalledOnce();
    expectLeaseLost(harness);
    expect(harness.state.executionEvidence(1)).toMatchObject({ acpSessionId: "lease-session-1" });
    expect(harness.client.status()).toEqual({
      state: "reconciliation-required",
      reason: "execution_cleanup_failed"
    });
  });

  it.each([
    "success",
    "error"
  ] as const)("checks wall-clock expiry synchronously before settling a late %s with timers suspended", async (outcome) => {
    const harness = await setup({ abortSettles: false });
    const run = await harness.startExecution();
    harness.clock.jumpBy(1_001);
    expect(run.context.signal.aborted).toBe(false);
    if (outcome === "success") run.result.resolve(completedResult);
    else run.result.reject(new Error("late execution error"));

    await vi.waitFor(() => expectLeaseLost(harness));
    expect(run.context.signal.aborted).toBe(true);
  });
});
