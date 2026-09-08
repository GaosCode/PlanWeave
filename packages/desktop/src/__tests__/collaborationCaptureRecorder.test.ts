import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationCaptureRecorder } from "../shared/CollaborationCaptureRecorder.js";
import { CAPTURE_SAMPLE_LIMIT, captureExportSchema } from "../shared/collaborationCapture.js";
import { summarizeCapture } from "../shared/collaborationCaptureSummary.js";

afterEach(() => vi.useRealTimers());

describe("collaboration capture", () => {
  it("is off by default, rejects stale scopes, and never exports peer identities", () => {
    const recorder = new CollaborationCaptureRecorder(() => 10);
    recorder.record("socket_send");
    expect(recorder.snapshot()).toBeNull();
    expect(() => recorder.start("sample", "a")).toThrow("scope");
    recorder.bind("private-profile:canvas");
    recorder.start("sample", "private-profile:canvas");
    recorder.record("socket_receive", { peer: "private-device", pointer: true });
    recorder.stop();
    const trace = recorder.snapshot()!;
    expect(trace.samples[0].peer).toBe(0);
    expect(JSON.stringify(trace)).not.toContain("private");
    expect(
      captureExportSchema.safeParse({ renderer: trace, transport: trace, longTaskSupported: false })
        .success
    ).toBe(true);
  });

  it("stops on scope changes and does not append another canvas's events", () => {
    let now = 0;
    const recorder = new CollaborationCaptureRecorder(() => now);
    recorder.bind("a");
    recorder.start("test", "a");
    recorder.record("pointer_input");
    now = 20;
    recorder.bind("b");
    recorder.record("socket_receive");
    expect(recorder.snapshot()).toMatchObject({
      durationMs: 20,
      stopReason: "scope_changed",
      samples: [{ stage: "pointer_input" }]
    });
    recorder.start("test", "b");
    expect(recorder.snapshot()?.samples).toEqual([]);
    recorder.stop();
  });

  it("bounds duration and memory even when no page timer runs", () => {
    vi.useFakeTimers();
    const recorder = new CollaborationCaptureRecorder();
    recorder.bind("a");
    recorder.start("test", "a");
    vi.advanceTimersByTime(60_000);
    expect(recorder.snapshot()?.stopReason).toBe("time_limit");
    recorder.start("test", "a");
    for (let i = 0; i <= CAPTURE_SAMPLE_LIMIT; i++) recorder.record("frame", { durationMs: 16 });
    expect(recorder.snapshot()?.samples).toHaveLength(CAPTURE_SAMPLE_LIMIT);
    expect(recorder.snapshot()?.stopReason).toBe("sample_limit");
  });

  it("measures coalesced commits from the last update for each peer and only once", () => {
    let now = 0;
    const recorder = new CollaborationCaptureRecorder(() => now);
    recorder.bind("a");
    recorder.start("test", "a");
    recorder.record("renderer_receive", { peer: "A" });
    now = 5;
    recorder.record("renderer_receive", { peer: "B" });
    now = 7;
    recorder.record("renderer_receive", { peer: "A" });
    now = 10;
    recorder.commit("A");
    recorder.commit("B");
    recorder.commit("A");
    expect(
      recorder
        .snapshot()
        ?.samples.filter((s) => s.stage === "renderer_commit")
        .map((s) => s.durationMs)
    ).toEqual([3, 5]);
    recorder.stop();
  });

  it("keeps idle gaps and separates interleaved peer streams instead of inventing latency", () => {
    let now = 0;
    const recorder = new CollaborationCaptureRecorder(() => now);
    recorder.bind("a");
    recorder.start("test", "a");
    recorder.record("socket_receive", { peer: "A", pointer: true });
    now = 25;
    recorder.record("socket_receive", { peer: "B", pointer: true });
    now = 200;
    recorder.record("socket_receive", { peer: "A", pointer: true });
    now = 5000;
    recorder.record("socket_receive", { peer: "A", pointer: true });
    recorder.stop();
    const summary = summarizeCapture(recorder.snapshot()!);
    expect(summary[0].intervalsIncludingInputPauses).toMatchObject({
      count: 2,
      p50Ms: 200,
      p95Ms: 4800
    });
    expect(summary[1].intervalsIncludingInputPauses).toBeNull();
  });

  it("uses a fresh ticket even when the user repeats a capture ID", () => {
    const recorder = new CollaborationCaptureRecorder();
    recorder.bind("a");
    recorder.start("test", "a");
    const first = recorder.ticket();
    expect(() => recorder.start("test", "a")).toThrow("already_running");
    recorder.stop();
    recorder.start("test", "a");
    expect(recorder.ticket()).not.toBe(first);
    recorder.stop();
  });
});
