import { describe, expect, it, vi } from "vitest";
import {
  ExecutionLeaseDeadline,
  EXECUTION_LEASE_RECHECK_MS
} from "../transport/executionLeaseDeadline.js";
import { FakeHostTransportClock } from "./support/hostTransportTestClock.js";

describe("execution lease deadline", () => {
  it("keeps one timer, rejects a cleared callback, and stops idempotently", () => {
    const clock = new FakeHostTransportClock();
    const onDue = vi.fn();
    const schedule = vi.spyOn(clock, "setTimeout");
    const deadline = new ExecutionLeaseDeadline(clock, onDue);
    deadline.reschedule(clock.now().getTime() + 50);
    const oldCallback = schedule.mock.calls[0]![0];
    deadline.reschedule(clock.now().getTime() + 100);
    expect(clock.pendingTimerCount()).toBe(1);
    oldCallback();
    expect(onDue).not.toHaveBeenCalled();
    clock.advanceBy(100);
    expect(onDue).toHaveBeenCalledTimes(1);
    expect(clock.pendingTimerCount()).toBe(0);
    deadline.reschedule(clock.now().getTime() + 100);
    const stoppedCallback = schedule.mock.calls.at(-1)![0];
    deadline.stop();
    deadline.stop();
    stoppedCallback();
    expect(clock.pendingTimerCount()).toBe(0);
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it("bounds distant checks and clears the timer when no authoritative lease remains", () => {
    const clock = new FakeHostTransportClock();
    const deadline = new ExecutionLeaseDeadline(clock, vi.fn());
    deadline.reschedule(clock.now().getTime() + 60_000);
    expect(clock.nextDelay()).toBe(EXECUTION_LEASE_RECHECK_MS);
    deadline.reschedule(undefined);
    expect(clock.pendingTimerCount()).toBe(0);
    deadline.reschedule(clock.now().getTime() - 10);
    expect(clock.nextDelay()).toBe(0);
    deadline.stop();
  });
});
