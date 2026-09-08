import { afterEach, expect, it, vi } from "vitest";
import {
  transportCapture,
  nextPresenceTrace,
  startCaptureLoopProbe
} from "../main/collaboration/collaborationCaptureRecorder.js";

afterEach(() => {
  transportCapture.stop();
  transportCapture.bind(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("correlates messages per capture and resets stream identity on a repeated capture ID", () => {
  expect(nextPresenceTrace()).toBeUndefined();
  transportCapture.bind("scope");
  transportCapture.start("test", "scope");
  const first = nextPresenceTrace();
  const second = nextPresenceTrace();
  expect(first?.sequence).toBe(0);
  expect(second?.sequence).toBe(1);
  expect(second?.streamId).toBe(first?.streamId);
  transportCapture.stop();
  transportCapture.start("test", "scope");
  expect(nextPresenceTrace()?.streamId).not.toBe(first?.streamId);
});

it("records scheduling lateness and stops sampling after scope teardown", () => {
  vi.useFakeTimers();
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  transportCapture.bind("scope");
  transportCapture.start("test", "scope");
  startCaptureLoopProbe();
  clock.mockReturnValue(175);
  vi.advanceTimersByTime(100);
  expect(transportCapture.snapshot()?.samples).toEqual([
    expect.objectContaining({ stage: "main_event_loop_delay", durationMs: 75 })
  ]);
  transportCapture.bind(null);
  vi.advanceTimersByTime(500);
  expect(transportCapture.snapshot()?.samples).toHaveLength(1);
});
