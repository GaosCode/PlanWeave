import { afterEach, expect, it, vi } from "vitest";
import { CollaborationCaptureRecorder } from "../shared/CollaborationCaptureRecorder.js";
import { CAPTURE_SAMPLE_LIMIT, captureTraceSchema } from "../shared/collaborationCapture.js";
import { summarizePresenceQueue } from "../shared/collaborationCaptureSummary.js";
import {
  nextPresenceTrace,
  peekPresenceTrace,
  transportCapture
} from "../main/collaboration/collaborationCaptureRecorder.js";

afterEach(() => {
  transportCapture.stop();
  transportCapture.bind(null);
  vi.useRealTimers();
});

it("does not consume a wire sequence while checking a blocked frame budget", () => {
  transportCapture.bind("scope");
  transportCapture.start("queue-test", "scope");
  const candidate = peekPresenceTrace();
  for (let i = 0; i < 100; i += 1) expect(peekPresenceTrace()).toEqual(candidate);
  expect(nextPresenceTrace()).toEqual(candidate);
  expect(nextPresenceTrace()?.sequence).toBe(1);
});

it("separates local replacements, queue wait, and sampled buffered bytes from sends", () => {
  vi.useFakeTimers();
  const recorder = new CollaborationCaptureRecorder(() => 100);
  recorder.bind("scope");
  recorder.start("queue-test", "scope");
  recorder.record("presence_coalesced");
  recorder.record("presence_coalesced");
  recorder.record("presence_buffer", { bufferedBytes: 4096 });
  recorder.record("presence_queue_wait", { durationMs: 75 });
  recorder.record("socket_send", { bufferedBytes: 1024 });
  recorder.record("presence_queue_wait", { durationMs: 0 });
  recorder.record("socket_send", { bufferedBytes: 0 });
  recorder.stop();
  const trace = captureTraceSchema.parse(recorder.snapshot());
  expect(summarizePresenceQueue(trace)).toEqual({
    sentUpdates: 2,
    coalescedUpdates: 2,
    queueWait: { count: 2, p50Ms: 0, p95Ms: 75, maxMs: 75, over100Ms: 0 },
    bufferedBytesHighWater: 4096
  });
});

it("bounds coalescing samples using the existing capture budget", () => {
  vi.useFakeTimers();
  const recorder = new CollaborationCaptureRecorder(() => 0);
  recorder.bind("scope");
  recorder.start("queue-test", "scope");
  for (let i = 0; i <= CAPTURE_SAMPLE_LIMIT; i += 1) recorder.record("presence_coalesced");
  const trace = captureTraceSchema.parse(recorder.snapshot());
  expect(trace.samples).toHaveLength(CAPTURE_SAMPLE_LIMIT);
  expect(trace.stopReason).toBe("sample_limit");
  expect(summarizePresenceQueue(trace).bufferedBytesHighWater).toBeNull();
  expect(summarizePresenceQueue(trace).queueWait).toBeNull();
});
