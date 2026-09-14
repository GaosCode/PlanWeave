import { randomUUID } from "node:crypto";
import {
  PRESENCE_PROBE_INTERVAL_MS,
  PRESENCE_PROBE_TIMEOUT_MS,
  PRESENCE_PROBE_PENDING_LIMIT,
  type CanvasPresenceTransportReport
} from "@planweave-ai/collaboration-protocol/canvas/presence";
import { transportCapture } from "./collaborationCaptureRecorder.js";

/** Requests use the active presence socket; no extra test connection or identity. */
export class PresenceTransportProbe {
  private ticket: number | null = null;
  private due = 0;
  private captureToken = randomUUID();
  private unavailable = false;
  private pending = new Map<string, number>();

  tick(
    supported: boolean,
    bufferedBytes: number | undefined,
    send: (id: string, captureToken: string) => void
  ): void {
    const ticket = transportCapture.ticket();
    if (ticket !== this.ticket) {
      this.reset();
      this.ticket = ticket;
    }
    if (ticket === null) return;
    if (!supported) {
      if (!this.unavailable) transportCapture.record("transport_probe_unavailable");
      this.unavailable = true;
      return;
    }
    const now = performance.now();
    for (const [id, started] of this.pending) {
      if (now - started >= PRESENCE_PROBE_TIMEOUT_MS) {
        transportCapture.record("transport_probe_timeout", { durationMs: now - started });
        this.pending.delete(id);
      }
    }
    if (now < this.due || this.pending.size >= PRESENCE_PROBE_PENDING_LIMIT) return;
    this.due = now + PRESENCE_PROBE_INTERVAL_MS;
    if (bufferedBytes !== undefined) transportCapture.record("socket_buffer", { bufferedBytes });
    const id = randomUUID();
    this.pending.set(id, now);
    try {
      send(id, this.captureToken);
    } catch {
      this.pending.delete(id);
      transportCapture.record("transport_probe_error");
    }
  }

  receive(report: CanvasPresenceTransportReport): void {
    const started = this.pending.get(report.probeId);
    if (started === undefined || this.ticket !== transportCapture.ticket()) return;
    this.pending.delete(report.probeId);
    transportCapture.record("transport_probe", {
      durationMs: performance.now() - started,
      diagnostics: report
    });
    for (const record of report.records) {
      transportCapture.record(
        record.stage === "write" ? "server_write" : "server_event_loop_delay",
        {
          durationMs: record.durationMs,
          bufferedBytes: record.bufferedBytes,
          failed: record.failed,
          trace: record.trace
        }
      );
    }
  }

  rejected(id: string): void {
    if (this.ticket !== transportCapture.ticket() || !this.pending.delete(id)) return;
    transportCapture.record("transport_probe_error");
  }

  reset(): void {
    this.pending.clear();
    this.captureToken = randomUUID();
    this.ticket = null;
    this.due = 0;
    this.unavailable = false;
  }
}
