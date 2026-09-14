import { CANVAS_PRESENCE_MAX_FRAME_BYTES } from "@planweave-ai/collaboration-protocol/core/limits";
import type { CanvasPresenceClientUpdate } from "@planweave-ai/collaboration-protocol/canvas/presence";
import type {
  CollaborationClientClock,
  CollaborationWebSocketLike
} from "./collaborationClientTypes.js";
import { CollaborationClientError } from "./collaborationErrors.js";

export const PRESENCE_MAX_BUFFERED_BYTES = 2 * CANVAS_PRESENCE_MAX_FRAME_BYTES;
export const PRESENCE_SEND_RETRY_MS = 25;
export const PRESENCE_SEND_BLOCKED_MS = 5_000;

type PendingUpdateOptions = {
  socket: CollaborationWebSocketLike;
  clock: CollaborationClientClock;
  serialize(update: CanvasPresenceClientUpdate): string;
  send(
    text: string,
    update: CanvasPresenceClientUpdate,
    waitMs: number,
    bufferedBytes: number
  ): void;
  onCoalesced(): void;
  onBuffered(bufferedBytes: number): void;
  onFatal(error: Error): void;
};

/** One complete, replaceable update owned by one socket, behind its hello/snapshot barrier. */
export class PresencePendingUpdate {
  private pending?: { update: CanvasPresenceClientUpdate; enqueuedAt: number };
  private timer?: unknown;
  private blockedSince?: number;
  private ready = false;
  private disposed = false;

  constructor(private readonly options: PendingUpdateOptions) {}

  publish(update: CanvasPresenceClientUpdate): void {
    if (this.disposed) {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_presence_not_connected",
        message: "Canvas presence is not connected."
      });
    }
    this.frame(update);
    const replaced = this.pending !== undefined;
    this.pending = { update, enqueuedAt: this.options.clock.now().getTime() };
    if (replaced) this.options.onCoalesced();
    this.flush();
  }

  connected(): void {
    if (this.disposed) return;
    this.ready = true;
    this.flush();
  }

  dispose(): void {
    this.disposed = true;
    this.pending = undefined;
    this.clearRetry();
    this.blockedSince = undefined;
  }

  private frame(update: CanvasPresenceClientUpdate): { text: string; bytes: number } {
    const text = this.options.serialize(update);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > CANVAS_PRESENCE_MAX_FRAME_BYTES) {
      throw new CollaborationClientError({
        kind: "payload_too_large",
        code: "collaboration_presence_payload_too_large",
        message: "Presence payload exceeded size limit."
      });
    }
    return { text, bytes };
  }

  private flush(): void {
    if (this.disposed || !this.pending) return;
    const { socket, clock } = this.options;
    if (socket.readyState !== 1) {
      this.dispose();
      return;
    }
    try {
      this.options.onBuffered(socket.bufferedAmount);
      const { text, bytes } = this.frame(this.pending.update);
      const now = clock.now().getTime();
      if (!this.ready || socket.bufferedAmount + bytes > PRESENCE_MAX_BUFFERED_BYTES) {
        this.blockedSince ??= now;
        if (now - this.blockedSince >= PRESENCE_SEND_BLOCKED_MS) {
          throw new Error("Presence send remained blocked for 5 seconds.");
        }
        if (this.timer === undefined) {
          this.timer = clock.setTimeout(() => {
            this.timer = undefined;
            this.flush();
          }, PRESENCE_SEND_RETRY_MS);
        }
        return;
      }
      const pending = this.pending;
      this.pending = undefined;
      this.blockedSince = undefined;
      this.clearRetry();
      this.options.send(
        text,
        pending.update,
        Math.max(0, now - pending.enqueuedAt),
        socket.bufferedAmount
      );
    } catch (error) {
      this.dispose();
      this.options.onFatal(error instanceof Error ? error : new Error("Presence send failed."));
    }
  }

  private clearRetry(): void {
    if (this.timer !== undefined) this.options.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
