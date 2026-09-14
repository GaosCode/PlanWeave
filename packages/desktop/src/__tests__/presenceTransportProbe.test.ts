import { afterEach, expect, it, vi } from "vitest";
import { PresenceTransportProbe } from "../main/collaboration/PresenceTransportProbe.js";
import { transportCapture } from "../main/collaboration/collaborationCaptureRecorder.js";

afterEach(() => {
  transportCapture.stop();
  transportCapture.bind(null);
  vi.restoreAllMocks();
});

it("reports unsupported servers, timeouts and send failures without failing presence", () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  transportCapture.bind("s");
  transportCapture.start("test", "s");
  const probe = new PresenceTransportProbe();
  const send = vi.fn();
  probe.tick(false, 0, send);
  probe.tick(false, 0, send);
  expect(send).not.toHaveBeenCalled();
  probe.tick(true, 123, send);
  probe.tick(true, 123, send);
  expect(send).toHaveBeenCalledTimes(1);
  now = 5500;
  probe.tick(true, 123, () => {
    throw new Error("socket closed");
  });
  expect(transportCapture.snapshot()?.samples.map((s) => s.stage)).toEqual([
    "transport_probe_unavailable",
    "socket_buffer",
    "transport_probe_timeout",
    "socket_buffer",
    "transport_probe_error"
  ]);
});

it("matches replies on the same capture and rejects late replies after restart", () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  transportCapture.bind("s");
  transportCapture.start("test", "s");
  const probe = new PresenceTransportProbe();
  let id = "";
  probe.tick(true, 0, (next) => {
    id = next;
  });
  const report = {
    probeId: id,
    serverClockId: "12345678-1234-4234-8234-123456789012",
    serverReceivedMs: 1000,
    serverRespondedMs: 1001,
    bufferedBytes: 0,
    droppedRecords: 0,
    pendingWrites: 0,
    records: []
  };
  now = 100;
  probe.receive(report);
  expect(transportCapture.snapshot()?.samples.at(-1)).toMatchObject({
    stage: "transport_probe",
    durationMs: 100
  });
  transportCapture.stop();
  transportCapture.start("test", "s");
  probe.receive(report);
  expect(transportCapture.snapshot()?.samples).toEqual([]);
});
