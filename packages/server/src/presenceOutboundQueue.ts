import {
  CANVAS_PRESENCE_MAX_FRAME_BYTES,
  CANVAS_PRESENCE_MAX_SESSIONS_PER_CANVAS
} from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canvasPresenceServerMessageSchema,
  type CanvasPresenceServerMessage
} from "@planweave-ai/collaboration-protocol/canvas/presence";

export const PRESENCE_OUTBOUND_LIMITS = {
  maxFrameBytes: CANVAS_PRESENCE_MAX_FRAME_BYTES,
  maxBufferedBytes: 2 * CANVAS_PRESENCE_MAX_FRAME_BYTES,
  maxPendingBytes: 2 * CANVAS_PRESENCE_MAX_FRAME_BYTES,
  maxPendingUpdates: CANVAS_PRESENCE_MAX_SESSIONS_PER_CANVAS,
  maxControls: CANVAS_PRESENCE_MAX_SESSIONS_PER_CANVAS + 2,
  retryMs: 25,
  blockedTimeoutMs: 5_000
};

type PresenceSendPort = {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(text: string, callback: (error?: Error) => void): void;
};
type QueueClock = {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};
type Entry = { message: CanvasPresenceServerMessage; bytes: number; enqueuedAt: number };
export type PresenceQueueFailure =
  | "frame_too_large"
  | "queue_capacity"
  | "blocked_timeout"
  | "send_error"
  | "unauthorized";
export type PresenceOutboundQueueOptions = {
  socket: PresenceSendPort;
  authorize(): boolean;
  onFatal(reason: PresenceQueueFailure): void;
  clock?: QueueClock;
  limits?: Partial<typeof PRESENCE_OUTBOUND_LIMITS>;
  onSend?(
    message: CanvasPresenceServerMessage,
    bufferedBytes: number
  ): ((failed: boolean) => void) | undefined;
};

export class PresenceOutboundQueue {
  private readonly updates = new Map<string, Entry>();
  private readonly controls: Entry[] = [];
  private readonly clock: QueueClock;
  private readonly limits: typeof PRESENCE_OUTBOUND_LIMITS;
  private pendingBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: { startedAt: number } | undefined;
  private blockedSince: number | undefined;
  private flushing = false;
  private disposed = false;
  private coalescedUpdates = 0;
  private pendingBytesHighWater = 0;
  private bufferedBytesHighWater = 0;
  private queueWaitHighWaterMs = 0;
  private callbackDurationHighWaterMs = 0;

  constructor(private readonly options: PresenceOutboundQueueOptions) {
    this.clock = options.clock ?? { now: () => performance.now(), setTimeout, clearTimeout };
    this.limits = { ...PRESENCE_OUTBOUND_LIMITS, ...options.limits };
    if (
      Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value < 1) ||
      this.limits.maxBufferedBytes < this.limits.maxFrameBytes
    ) {
      throw new Error("presence_outbound_limits_invalid");
    }
  }

  get statistics() {
    return {
      pendingUpdates: this.updates.size,
      pendingControls: this.controls.length,
      pendingBytes: this.pendingBytes,
      inFlight: this.inFlight !== undefined,
      disposed: this.disposed,
      coalescedUpdates: this.coalescedUpdates,
      pendingBytesHighWater: this.pendingBytesHighWater,
      bufferedBytesHighWater: this.bufferedBytesHighWater,
      queueWaitHighWaterMs: this.queueWaitHighWaterMs,
      callbackDurationHighWaterMs: this.callbackDurationHighWaterMs
    };
  }

  enqueue(input: CanvasPresenceServerMessage): boolean {
    if (this.disposed) return false;
    const message = canvasPresenceServerMessageSchema.parse(input);
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (bytes > this.limits.maxFrameBytes) {
      this.fail("frame_too_large");
      return false;
    }
    const entry = { message, bytes, enqueuedAt: this.clock.now() };
    if (message.type === "canvas.presence.update") {
      const id = message.session.identity.sessionId;
      const previous = this.updates.get(id);
      if (previous) {
        this.pendingBytes -= previous.bytes;
        this.coalescedUpdates = Math.min(Number.MAX_SAFE_INTEGER, this.coalescedUpdates + 1);
      }
      // Map replacement preserves this peer's position in the next round.
      this.updates.set(id, entry);
    } else {
      if (message.type === "canvas.presence.leave") {
        const previous = this.updates.get(message.sessionId);
        if (previous) this.pendingBytes -= previous.bytes;
        this.updates.delete(message.sessionId);
      }
      this.controls.push(entry);
    }
    this.pendingBytes += bytes;
    if (
      this.pendingBytes > this.limits.maxPendingBytes ||
      this.updates.size > this.limits.maxPendingUpdates ||
      this.controls.length > this.limits.maxControls
    ) {
      this.fail("queue_capacity");
      return false;
    }
    this.pendingBytesHighWater = Math.max(this.pendingBytesHighWater, this.pendingBytes);
    this.flush();
    return !this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.updates.clear();
    this.controls.length = 0;
    this.pendingBytes = 0;
    this.inFlight = undefined;
    this.blockedSince = undefined;
    this.cancelTimer();
  }

  private fail(reason: PresenceQueueFailure): void {
    if (this.disposed) return;
    this.dispose();
    this.options.onFatal(reason);
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.timer !== undefined || this.disposed) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.limits.retryMs);
  }

  private flush(): void {
    if (this.flushing || this.disposed) return;
    this.flushing = true;
    try {
      while (!this.disposed) {
        if (this.options.socket.readyState !== 1) {
          this.dispose();
          return;
        }
        if (this.inFlight) {
          if (this.clock.now() - this.inFlight.startedAt >= this.limits.blockedTimeoutMs) {
            this.fail("blocked_timeout");
          } else this.schedule();
          return;
        }
        const entry = this.controls[0] ?? this.updates.values().next().value;
        if (!entry) {
          this.blockedSince = undefined;
          this.cancelTimer();
          return;
        }
        if (!this.options.authorize()) {
          this.fail("unauthorized");
          return;
        }
        if (this.disposed) return;
        const message = entry.message;
        const outbound =
          message.type === "canvas.presence.update" && message.trace
            ? { ...message, trace: { ...message.trace, serverForwardedMs: this.clock.now() } }
            : message;
        const text = JSON.stringify(outbound);
        const frameBytes = Buffer.byteLength(text, "utf8");
        if (frameBytes > this.limits.maxFrameBytes) {
          this.fail("frame_too_large");
          return;
        }
        const bufferedBytes = this.options.socket.bufferedAmount;
        this.bufferedBytesHighWater = Math.max(this.bufferedBytesHighWater, bufferedBytes);
        if (bufferedBytes + frameBytes > this.limits.maxBufferedBytes) {
          this.blockedSince ??= this.clock.now();
          if (this.clock.now() - this.blockedSince >= this.limits.blockedTimeoutMs) {
            this.fail("blocked_timeout");
          } else this.schedule();
          return;
        }
        if (message.type === "canvas.presence.update") {
          this.updates.delete(message.session.identity.sessionId);
        } else this.controls.shift();
        this.pendingBytes -= entry.bytes;
        this.blockedSince = undefined;
        const flight = { startedAt: this.clock.now() };
        this.inFlight = flight;
        this.queueWaitHighWaterMs = Math.max(
          this.queueWaitHighWaterMs,
          flight.startedAt - entry.enqueuedAt
        );
        const complete = this.options.onSend?.(outbound, bufferedBytes);
        this.options.socket.send(text, (error) => {
          if (this.disposed || this.inFlight !== flight) return;
          this.inFlight = undefined;
          this.callbackDurationHighWaterMs = Math.max(
            this.callbackDurationHighWaterMs,
            this.clock.now() - flight.startedAt
          );
          complete?.(Boolean(error));
          if (error) this.fail("send_error");
          else this.flush();
        });
        // Synchronous callbacks continue this loop, never recurse through send.
      }
    } catch {
      this.fail("send_error");
    } finally {
      this.flushing = false;
    }
  }
}
