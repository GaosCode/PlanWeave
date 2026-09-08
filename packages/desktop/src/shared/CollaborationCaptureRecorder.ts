import {
  CAPTURE_DURATION_MS,
  CAPTURE_SAMPLE_LIMIT,
  captureIdSchema,
  type CaptureSample,
  type CaptureStage,
  type CaptureTrace
} from "./collaborationCapture.js";

/** Opt-in, bounded diagnostics. Scope keys and peer identities never enter the export. */
export class CollaborationCaptureRecorder {
  private scope: string | null = null;
  private scopeTag: string | null = null;
  private trace: CaptureTrace | null = null;
  private started = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private peers = new Map<string, number>();
  private pending = new Map<string, { received: number; trace?: CaptureSample["trace"] }>();
  private generation = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  scopeKey(): string | null {
    return this.scope;
  }
  running(): boolean {
    return this.trace?.stopReason === "running";
  }
  ticket(): number | null {
    return this.running() ? this.generation : null;
  }
  bind(scope: string | null, scopeTag: string | null = null): void {
    if (scope !== this.scope) this.stop("scope_changed");
    this.scope = scope;
    this.scopeTag = scopeTag;
  }

  start(captureId: string, expectedScope: string): void {
    captureIdSchema.parse(captureId);
    if (!this.scope || this.scope !== expectedScope) throw new Error("capture_scope_unavailable");
    if (this.running()) throw new Error("capture_already_running");
    this.started = this.now();
    this.generation += 1;
    this.peers.clear();
    this.pending.clear();
    this.trace = {
      captureId,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      stopReason: "running",
      scopeTag: this.scopeTag,
      samples: []
    };
    this.timer = setTimeout(() => this.stop("time_limit"), CAPTURE_DURATION_MS);
  }

  record(
    stage: CaptureStage,
    options: {
      peer?: string;
      pointer?: boolean;
      durationMs?: number;
      trace?: CaptureSample["trace"];
    } = {}
  ): void {
    if (!this.running() || !this.trace) return;
    const atMs = this.now() - this.started;
    if (atMs >= CAPTURE_DURATION_MS) {
      this.stop("time_limit");
      return;
    }
    if (this.trace.samples.length >= CAPTURE_SAMPLE_LIMIT) {
      this.stop("sample_limit");
      return;
    }
    let peer: number | undefined;
    if (options.peer !== undefined) {
      peer = this.peers.get(options.peer);
      if (peer === undefined) {
        peer = this.peers.size;
        this.peers.set(options.peer, peer);
      }
      if (stage === "renderer_receive")
        this.pending.set(options.peer, { received: this.now(), trace: options.trace });
    }
    const sample: CaptureSample = { stage, atMs };
    if (peer !== undefined) sample.peer = peer;
    if (options.pointer !== undefined) sample.pointer = options.pointer;
    if (options.durationMs !== undefined) sample.durationMs = Math.max(0, options.durationMs);
    if (options.trace) sample.trace = { ...options.trace };
    this.trace.samples.push(sample);
  }

  commit(peer: string): void {
    if (!this.running()) return;
    const received = this.pending.get(peer);
    if (received === undefined) return;
    this.pending.delete(peer);
    this.record("renderer_commit", {
      peer,
      durationMs: this.now() - received.received,
      trace: received.trace
    });
  }

  stop(reason: Exclude<CaptureTrace["stopReason"], "running"> = "manual"): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.running() || !this.trace) return;
    this.trace.durationMs = Math.max(0, this.now() - this.started);
    this.trace.stopReason = reason;
    this.pending.clear();
  }

  snapshot(): CaptureTrace | null {
    if (!this.trace) return null;
    return {
      ...this.trace,
      durationMs: this.running() ? Math.max(0, this.now() - this.started) : this.trace.durationMs,
      samples: this.trace.samples.map((sample) => ({
        ...sample,
        ...(sample.trace ? { trace: { ...sample.trace } } : {})
      }))
    };
  }
}
