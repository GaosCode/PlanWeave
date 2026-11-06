import {
  agentHostProtocolVersion,
  exampleExecuteDelivery,
  serverEventSchema
} from "@planweave-ai/agent-host-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  completedResult,
  leaseHarness,
  resumeDelivery,
  type LeaseHarness
} from "./support/agentHostLeaseExpiryHarness.js";
import { acpCapabilitySnapshotTestValue } from "./support/acpCapabilitySnapshotTestValues.js";

function cancelDelivery(
  sequence = 2,
  identity: Partial<{ dispatchId: string; leaseId: string; executionAttemptId: string }> = {}
) {
  return serverEventSchema.parse({
    type: "mailbox.message",
    protocolVersion: agentHostProtocolVersion,
    sequence,
    previousSequence: sequence - 1,
    messageId: `cancel-lifecycle-${sequence}`,
    command: {
      type: "cancel_execution",
      protocolVersion: agentHostProtocolVersion,
      dispatchId: exampleExecuteDelivery.command.dispatchId,
      leaseId: exampleExecuteDelivery.command.leaseId,
      executionAttemptId: exampleExecuteDelivery.command.executionAttemptId,
      reason: "cancel test",
      ...identity
    }
  });
}

function sendCancellation(
  harness: LeaseHarness,
  kind: "mailbox" | "authentication",
  sequence = 2,
  identity = exampleExecuteDelivery.command
) {
  if (kind === "mailbox") {
    harness.send(
      cancelDelivery(sequence, {
        dispatchId: identity.dispatchId,
        leaseId: identity.leaseId,
        executionAttemptId: identity.executionAttemptId
      })
    );
    return { reason: "cancel test", commandSequence: sequence };
  }
  const sessionId = "lease-session-1";
  const actionId = `authentication:cancel-${sequence}`;
  harness.state.recordSessionEvidence(1, {
    sessionId,
    capabilitySnapshot: acpCapabilitySnapshotTestValue(),
    recoveryId: "lease-recovery-1"
  });
  const afterCursor = harness.state.executionEvidence(1)!.actionCursor;
  harness.state.recordInteractionAction(1, {
    leaseId: identity.leaseId,
    sessionId,
    actionId,
    kind: "authentication",
    deadline: new Date(harness.clock.now().getTime() + 60_000).toISOString(),
    requestDigest: `sha256:${"b".repeat(64)}`,
    afterCursor,
    cursor: afterCursor + 1
  });
  harness.send(
    serverEventSchema.parse({
      type: "mailbox.message",
      protocolVersion: agentHostProtocolVersion,
      sequence,
      previousSequence: sequence - 1,
      messageId: `authentication-cancel-lifecycle-${sequence}`,
      command: {
        type: "interaction.authentication_action",
        dispatchId: identity.dispatchId,
        leaseId: identity.leaseId,
        executionAttemptId: identity.executionAttemptId,
        acpSessionId: sessionId,
        actionId,
        action: "cancel"
      }
    })
  );
  return { kind: "authentication_cancelled", actionId };
}

describe("Host executor cleanup lifecycle", () => {
  it.each([
    { kind: "mailbox", cancelAgain: true },
    { kind: "authentication", cancelAgain: true },
    { kind: "mailbox", cancelAgain: false },
    { kind: "authentication", cancelAgain: false }
  ] as const)("settles resumed $kind cancellation cancelAgain=$cancelAgain and replays its terminal without executing again", async ({
    kind,
    cancelAgain
  }) => {
    const harness = await leaseHarness({ abortSettles: false });
    try {
      const oldRun = await harness.startExecution(1_000);
      harness.state.recordSessionEvidence(1, {
        sessionId: "lease-session-1",
        capabilitySnapshot: acpCapabilitySnapshotTestValue(),
        recoveryId: "lease-recovery-1"
      });
      const expiresAt = harness.clock.now().getTime() + 11_000;
      oldRun.context.cleanupObserver?.({
        expiresAt,
        remainingMs: () => Math.max(0, expiresAt - harness.clock.now().getTime())
      });
      sendCancellation(harness, kind);
      await vi.waitFor(() => expect(oldRun.abortCount).toBe(1));
      harness.clock.advanceBy(1_000);
      const resume = serverEventSchema.parse({
        ...resumeDelivery(60_000),
        sequence: 3,
        previousSequence: 2,
        messageId: "resume-after-cancel-again"
      });
      harness.send(resume);
      await vi.waitFor(() =>
        expect(harness.state.executionEvidence(1)?.leaseId).toBe("lease-resumed-2")
      );
      oldRun.result.resolve(completedResult);
      await vi.waitFor(() => expect(harness.execute).toHaveBeenCalledTimes(2));
      const resumed = harness.runs[1]!;
      const identity = harness.execute.mock.calls[1]![0];
      if (cancelAgain) {
        sendCancellation(harness, kind, 4, identity);
        await vi.waitFor(() => expect(resumed.abortCount).toBe(1));
      }
      await harness.disconnect();
      resumed.result.reject(new Error("resumed executor failure"));
      await vi.waitFor(() =>
        expect(harness.state.executionEvidence(1)?.status).toBe(
          cancelAgain ? "cancelled" : "failed"
        )
      );
      const terminal = harness.state
        .pendingEvents()
        .find((event) => event.type === "dispatch.failed" && event.leaseId === identity.leaseId);
      if (!terminal || terminal.type !== "dispatch.failed")
        throw new Error("missing resumed terminal");
      expect(terminal.failure.code).toBe(cancelAgain ? "execution_cancelled" : "executor_failed");
      expect(
        harness.state
          .pendingEvents()
          .filter(
            (event) =>
              (event.type === "dispatch.completed" || event.type === "dispatch.failed") &&
              event.leaseId === exampleExecuteDelivery.command.leaseId
          )
      ).toEqual([]);
      await harness.client.stop();
      harness.client.start();
      await vi.waitFor(() => expect(harness.client.status().state).toBe("connected"));
      harness.clock.advanceBy(0);
      await vi.waitFor(() => expect(harness.events).toContainEqual(terminal));
      harness.send(
        serverEventSchema.parse({
          type: "host.event_ack",
          protocolVersion: agentHostProtocolVersion,
          messageId: terminal.messageId
        })
      );
      await vi.waitFor(() =>
        expect(
          harness.state.pendingEvents().some((event) => event.messageId === terminal.messageId)
        ).toBe(false)
      );
      harness.send(resume);
      await vi.waitFor(() =>
        expect(
          harness.events.filter((event) => event.type === "mailbox.ack" && event.sequence === 3)
            .length
        ).toBeGreaterThan(1)
      );
      expect(harness.state.pendingCancellations()).toEqual([]);
      expect(harness.execute).toHaveBeenCalledTimes(2);
    } finally {
      await harness.close();
    }
  });
  it("keeps serving after the old watchdog while the actual executor deadline remains", async () => {
    const harness = await leaseHarness({ abortSettles: false });
    try {
      const run = await harness.startExecution(60_000);
      run.context.signal.addEventListener(
        "abort",
        () => {
          const expiresAt = harness.clock.now().getTime() + 11_000;
          run.context.cleanupObserver?.({
            expiresAt,
            remainingMs: () => Math.max(0, expiresAt - harness.clock.now().getTime())
          });
        },
        { once: true }
      );
      harness.send(cancelDelivery());
      await vi.waitFor(() => expect(run.abortCount).toBe(1));
      harness.clock.advanceBy(6_000);
      expect(harness.client.status().state).toBe("connected");
      run.context.cleanupObserver?.(null);
      run.result.reject(new Error("cancelled after cleanup"));
      await vi.waitFor(() =>
        expect(harness.events.some((event) => event.type === "dispatch.failed")).toBe(true)
      );
      expect(harness.state.activeLeases()).toEqual([]);
      expect(harness.execute).toHaveBeenCalledTimes(1);
    } finally {
      await harness.close();
    }
  });
  it.each([
    { kind: "mailbox", outcome: "resolve" },
    { kind: "mailbox", outcome: "reject" },
    { kind: "authentication", outcome: "resolve" },
    { kind: "authentication", outcome: "reject" }
  ] as const)("persists a late $kind $outcome terminal after bounded protection stopped the transport", async ({
    kind,
    outcome
  }) => {
    const harness = await leaseHarness({ abortSettles: false });
    try {
      const run = await harness.startExecution(60_000);
      const cancellationIntent = sendCancellation(harness, kind);
      await vi.waitFor(() => expect(run.abortCount).toBe(1));
      expect(run.context.cancellationStartedAt).toEqual(expect.any(Number));
      expect(harness.state.executionEvidence(1)?.cancellationIntent).toEqual(cancellationIntent);
      harness.clock.advanceBy(101);
      expect(harness.client.status()).toMatchObject({
        state: "reconciliation-required",
        reason: "execution_cleanup_timeout"
      });
      run.context.cleanupObserver?.(null);
      if (outcome === "resolve") run.result.resolve(completedResult);
      else run.result.reject(new Error("eventual cancellation cleanup"));
      await vi.waitFor(() =>
        expect(harness.state.executionEvidence(1)?.status).toBe(
          outcome === "resolve" ? "completed" : "cancelled"
        )
      );
      expect(harness.state.pendingEvents()).toContainEqual(
        expect.objectContaining({
          dispatchId: exampleExecuteDelivery.command.dispatchId,
          leaseId: exampleExecuteDelivery.command.leaseId,
          executionAttemptId: exampleExecuteDelivery.command.executionAttemptId,
          ...(outcome === "resolve"
            ? { type: "dispatch.completed", result: completedResult }
            : {
                type: "dispatch.failed",
                failure: expect.objectContaining({ code: "execution_cancelled" })
              })
        })
      );
      const terminal = harness.state
        .pendingEvents()
        .find((event) => event.type === "dispatch.completed" || event.type === "dispatch.failed");
      if (!terminal) throw new Error("missing durable terminal");
      await harness.client.stop();
      harness.client.start();
      await vi.waitFor(() => expect(harness.client.status().state).toBe("connected"));
      harness.clock.advanceBy(0);
      await vi.waitFor(() => expect(harness.events).toContainEqual(terminal));
      harness.send(
        serverEventSchema.parse({
          type: "host.event_ack",
          protocolVersion: agentHostProtocolVersion,
          messageId: terminal.messageId
        })
      );
      await vi.waitFor(() =>
        expect(
          harness.state.pendingEvents().some((event) => event.messageId === terminal.messageId)
        ).toBe(false)
      );
      expect(harness.execute).toHaveBeenCalledTimes(1);
    } finally {
      await harness.close();
    }
  });

  it.each([
    "mailbox",
    "authentication"
  ] as const)("preserves a resumed execution on shutdown when its persisted %s cancellation belongs to the old lease", async (kind) => {
    const harness = await leaseHarness({ abortSettles: false });
    try {
      const oldRun = await harness.startExecution(1_000);
      harness.state.recordSessionEvidence(1, {
        sessionId: "lease-session-1",
        capabilitySnapshot: acpCapabilitySnapshotTestValue(),
        recoveryId: "lease-recovery-1"
      });
      const expiresAt = harness.clock.now().getTime() + 11_000;
      oldRun.context.cleanupObserver?.({
        expiresAt,
        remainingMs: () => Math.max(0, expiresAt - harness.clock.now().getTime())
      });
      const cancellationIntent = sendCancellation(harness, kind);
      await vi.waitFor(() => expect(oldRun.abortCount).toBe(1));
      expect(harness.state.executionEvidence(1)?.cancellationIntent).toEqual(cancellationIntent);
      harness.clock.advanceBy(1_000);
      expect(harness.state.executionEvidence(1)?.status).toBe("interrupted");
      harness.send(
        serverEventSchema.parse({
          ...resumeDelivery(),
          sequence: 3,
          previousSequence: 2,
          messageId: "resume-after-old-cancel"
        })
      );
      await vi.waitFor(() =>
        expect(harness.state.executionEvidence(1)?.leaseId).toBe("lease-resumed-2")
      );
      oldRun.result.resolve(completedResult);
      await vi.waitFor(() => expect(harness.execute).toHaveBeenCalledTimes(2));
      const resumed = harness.runs[1]!;
      expect(harness.state.executionEvidence(1)).toMatchObject({
        status: "running",
        leaseId: "lease-resumed-2",
        cancellationIntent
      });
      resumed.context.signal.addEventListener(
        "abort",
        () => resumed.result.resolve(completedResult),
        { once: true }
      );
      await harness.client.stop();
      expect(harness.client.status()).toEqual({ state: "stopped" });
      expect(harness.state.executionEvidence(1)).toMatchObject({
        status: "running",
        leaseId: "lease-resumed-2",
        cancellationIntent
      });
      expect(harness.state.executionEvidence(1)?.terminalKind).toBeUndefined();
      expect(
        harness.state
          .pendingEvents()
          .filter(
            (event) => event.type === "dispatch.failed" || event.type === "dispatch.completed"
          )
      ).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("replays the persisted cancellation terminal through reconnect and ACK without executing again", async () => {
    const harness = await leaseHarness({ abortSettles: false, reconnectDelayMs: 10 });
    try {
      const run = await harness.startExecution(60_000);
      run.context.signal.addEventListener(
        "abort",
        () => {
          const expiresAt = harness.clock.now().getTime() + 11_000;
          run.context.cleanupObserver?.({
            expiresAt,
            remainingMs: () => Math.max(0, expiresAt - harness.clock.now().getTime())
          });
        },
        { once: true }
      );
      harness.send(cancelDelivery());
      await vi.waitFor(() => expect(run.abortCount).toBe(1));
      await harness.disconnect();
      run.context.cleanupObserver?.(null);
      run.result.reject(new Error("cancelled while disconnected"));
      await vi.waitFor(() => expect(harness.state.executionEvidence(1)?.status).toBe("cancelled"));
      const terminal = harness.state
        .pendingEvents()
        .find((event) => event.type === "dispatch.failed");
      if (!terminal || !("messageId" in terminal)) throw new Error("missing durable terminal");
      harness.clock.advanceBy(10);
      await vi.waitFor(() => expect(harness.client.status().state).toBe("connected"));
      harness.clock.advanceBy(0);
      await vi.waitFor(() => expect(harness.events).toContainEqual(terminal));
      harness.send(
        serverEventSchema.parse({
          type: "host.event_ack",
          protocolVersion: agentHostProtocolVersion,
          messageId: terminal.messageId
        })
      );
      await vi.waitFor(() =>
        expect(
          harness.state
            .pendingEvents()
            .some((event) => "messageId" in event && event.messageId === terminal.messageId)
        ).toBe(false)
      );
      harness.send(cancelDelivery());
      await vi.waitFor(() =>
        expect(
          harness.events.filter((event) => event.type === "mailbox.ack" && event.sequence === 2)
            .length
        ).toBeGreaterThan(1)
      );
      expect(harness.execute).toHaveBeenCalledTimes(1);
    } finally {
      await harness.close();
    }
  });

  it.each([
    { dispatchId: "old-dispatch" },
    { leaseId: "old-lease" },
    { executionAttemptId: "old-attempt" }
  ])("does not cancel the active run for a stale identity %j", async (identity) => {
    const harness = await leaseHarness();
    try {
      const run = await harness.startExecution(60_000);
      harness.send(cancelDelivery(2, identity));
      await vi.waitFor(() =>
        expect(
          harness.events.some((event) => event.type === "mailbox.ack" && event.sequence === 2)
        ).toBe(true)
      );
      expect(run.context.signal.aborted).toBe(false);
      harness.send(cancelDelivery(3));
      await vi.waitFor(() => expect(run.abortCount).toBe(1));
      expect(harness.execute).toHaveBeenCalledTimes(1);
    } finally {
      await harness.close();
    }
  });
});
