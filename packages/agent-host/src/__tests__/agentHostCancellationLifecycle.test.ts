import {
  agentHostProtocolVersion,
  exampleExecuteDelivery,
  serverEventSchema
} from "@planweave-ai/agent-host-protocol";
import { describe, expect, it, vi } from "vitest";
import { leaseHarness } from "./support/agentHostLeaseExpiryHarness.js";

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

describe("Host executor cleanup lifecycle", () => {
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
  it("persists a late terminal after bounded protection stopped the transport", async () => {
    const harness = await leaseHarness({ abortSettles: false });
    try {
      const run = await harness.startExecution(60_000);
      harness.send(cancelDelivery());
      await vi.waitFor(() => expect(run.abortCount).toBe(1));
      expect(run.context.cancellationStartedAt).toEqual(expect.any(Number));
      harness.clock.advanceBy(101);
      expect(harness.client.status()).toMatchObject({
        state: "reconciliation-required",
        reason: "execution_cleanup_timeout"
      });
      run.context.cleanupObserver?.(null);
      run.result.reject(new Error("eventual cancellation cleanup"));
      await vi.waitFor(() => expect(harness.state.executionEvidence(1)?.status).toBe("cancelled"));
      expect(harness.state.pendingEvents()).toContainEqual(
        expect.objectContaining({
          type: "dispatch.failed",
          failure: expect.objectContaining({ code: "execution_cancelled" })
        })
      );
      expect(harness.execute).toHaveBeenCalledTimes(1);
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
