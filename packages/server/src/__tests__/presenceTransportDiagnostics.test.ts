import { afterEach, expect, it, vi } from "vitest";
import { PresenceTransportDiagnostics } from "../presenceTransportDiagnostics.js";

afterEach(() => vi.useRealTimers());

it("records bounded writes and loop delay only during a probe lease", () => {
  vi.useFakeTimers();
  let now = 0;
  const telemetry = new PresenceTransportDiagnostics(() => now);
  expect(telemetry.beginWrite(42)).toBeUndefined();
  telemetry.probe("p", "capture", "clock", 0, 42);
  const complete = telemetry.beginWrite(42)!;
  now = 175;
  vi.advanceTimersByTime(100);
  complete(false);
  complete(false);
  now = 500;
  const report = telemetry.probe("p2", "capture", "clock", 500, 0)!;
  expect(report.pendingWrites).toBe(0);
  expect(report.records).toEqual([
    { stage: "event_loop", atMs: 175, durationMs: 75 },
    { stage: "write", atMs: 0, durationMs: 175, bufferedBytes: 42, failed: false }
  ]);
  for (let i = 0; i < 150; i++) telemetry.beginWrite(0)?.(false);
  now = 1000;
  const bounded = telemetry.probe("p3", "capture", "clock", 1000, 0)!;
  expect(bounded.records).toHaveLength(128);
  expect(bounded.droppedRecords).toBe(22);
  expect(telemetry.probe("fast", "capture", "clock", 1000, 0)).toBeNull();
  now = 4000;
  vi.advanceTimersByTime(4000);
  expect(telemetry.beginWrite(0)).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  telemetry.close();
});

it("does not attribute old writes to a new capture or retain data after close", () => {
  vi.useFakeTimers();
  let now = 0;
  const telemetry = new PresenceTransportDiagnostics(() => now);
  telemetry.probe("p", "first", "clock", now, 0);
  const late = telemetry.beginWrite(12)!;
  now = 500;
  telemetry.probe("p2", "second", "clock", now, 0);
  late(true);
  now = 1000;
  expect(telemetry.probe("p3", "second", "clock", now, 0)?.records).toEqual([]);
  telemetry.close();
  expect(telemetry.probe("p4", "second", "clock", now, 0)).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("retains a stall crossing the lease expiry instead of reporting no delay", () => {
  vi.useFakeTimers();
  let now = 0;
  const telemetry = new PresenceTransportDiagnostics(() => now);
  telemetry.probe("p", "capture", "clock", 0, 0);
  const lateWrite = telemetry.beginWrite(0)!;
  now = 3500;
  vi.advanceTimersByTime(100);
  lateWrite(false);
  const result = telemetry.probe("p2", "capture", "clock", now, 0)!;
  expect(result.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ stage: "event_loop", durationMs: 3400 }),
      expect.objectContaining({ stage: "write", durationMs: 3500 })
    ])
  );
  telemetry.close();
});
