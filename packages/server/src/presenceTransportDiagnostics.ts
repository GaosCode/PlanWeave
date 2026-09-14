import {
  PRESENCE_PROBE_INTERVAL_MS,
  PRESENCE_PROBE_LEASE_MS,
  PRESENCE_TRANSPORT_RECORD_LIMIT,
  type CanvasPresenceServerTrace,
  type CanvasPresenceTransportRecord,
  type CanvasPresenceTransportReport
} from "@planweave-ai/collaboration-protocol/canvas/presence";

/** Per-connection bounded telemetry, enabled only by authenticated diagnostic probes. */
export class PresenceTransportDiagnostics {
  private records: CanvasPresenceTransportRecord[] = [];
  private dropped = 0;
  private pending = 0;
  private until = 0;
  private lastProbe = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private captureToken: string | undefined;

  constructor(private readonly now: () => number = () => performance.now()) {}

  probe(
    probeId: string,
    captureToken: string,
    serverClockId: string,
    received: number,
    bufferedBytes: number
  ): CanvasPresenceTransportReport | null {
    const now = this.now();
    if (this.closed || now - this.lastProbe < PRESENCE_PROBE_INTERVAL_MS / 2) return null;
    this.lastProbe = now;
    if (this.captureToken !== captureToken) {
      this.captureToken = captureToken;
      this.records = [];
      this.dropped = 0;
    }
    this.until = now + PRESENCE_PROBE_LEASE_MS;
    if (!this.timer) this.schedule();
    const records = this.records;
    this.records = [];
    const droppedRecords = this.dropped;
    this.dropped = 0;
    return {
      probeId,
      serverClockId,
      serverReceivedMs: received,
      serverRespondedMs: now,
      bufferedBytes,
      droppedRecords,
      pendingWrites: this.pending,
      records
    };
  }

  beginWrite(
    bufferedBytes: number,
    trace?: CanvasPresenceServerTrace
  ): ((failed: boolean) => void) | undefined {
    if (this.closed || this.now() >= this.until) return undefined;
    const started = this.now();
    const captureToken = this.captureToken;
    this.pending += 1;
    let completed = false;
    return (failed) => {
      if (completed) return;
      completed = true;
      this.pending -= 1;
      if (captureToken !== this.captureToken) return;
      this.record(
        {
          stage: "write",
          atMs: started,
          durationMs: Math.max(0, this.now() - started),
          bufferedBytes,
          failed,
          ...(trace ? { trace } : {})
        },
        true
      );
    };
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.records = [];
  }

  private record(record: CanvasPresenceTransportRecord, startedDuringLease = false): void {
    if (this.closed || (!startedDuringLease && this.now() >= this.until)) return;
    if (this.records.length >= PRESENCE_TRANSPORT_RECORD_LIMIT) {
      this.dropped += 1;
      return;
    }
    this.records.push(record);
  }

  private schedule(): void {
    const due = this.now() + 100;
    const captureToken = this.captureToken;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed) return;
      if (captureToken === this.captureToken && due <= this.until) {
        this.record(
          { stage: "event_loop", atMs: this.now(), durationMs: Math.max(0, this.now() - due) },
          true
        );
      }
      if (this.now() < this.until) this.schedule();
    }, 100);
  }
}
