import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canvasPresenceServerMessageSchema,
  type CanvasPresenceServerMessage
} from "@planweave-ai/collaboration-protocol/canvas/presence";
import {
  PresenceOutboundQueue,
  type PresenceOutboundQueueOptions
} from "../presenceOutboundQueue.js";

const scope = { protocolVersion: 1, projectId: "project", canvasId: "default" } as const;
function update(id = "peer", x: number | null = 1, selectionIds = ["selected"]) {
  return canvasPresenceServerMessageSchema.parse({
    ...scope,
    type: "canvas.presence.update",
    session: {
      identity: { sessionId: id, humanPrincipalId: "human", displayName: "Peer" },
      pointer: x === null ? null : { x, y: 2 },
      selectionIds
    }
  });
}
function fixture(overrides: Partial<PresenceOutboundQueueOptions> = {}) {
  vi.useFakeTimers();
  const callbacks: ((error?: Error) => void)[] = [];
  const messages: CanvasPresenceServerMessage[] = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 1_000_000,
    send: vi.fn((text: string, callback: (error?: Error) => void) => {
      messages.push(canvasPresenceServerMessageSchema.parse(JSON.parse(text)));
      callbacks.push(callback);
    })
  };
  const fatal = vi.fn();
  const authorize = vi.fn(() => true);
  const queue = new PresenceOutboundQueue({
    socket,
    onFatal: fatal,
    authorize,
    clock: { now: () => Date.now(), setTimeout, clearTimeout },
    ...overrides
  });
  return { queue, socket, callbacks, messages, fatal, authorize };
}
afterEach(() => {
  vi.useRealTimers();
});

describe("PresenceOutboundQueue", () => {
  it("coalesces complete states, retaining peer order and null/empty clears", () => {
    const f = fixture();
    f.queue.enqueue(update("a"));
    f.queue.enqueue(update("b", 2));
    for (let i = 0; i < 1000; i++) f.queue.enqueue(update("a", i));
    f.queue.enqueue(update("a", null, []));
    expect(f.queue.statistics).toMatchObject({ pendingUpdates: 2, coalescedUpdates: 1001 });
    expect(vi.getTimerCount()).toBe(1);
    f.socket.bufferedAmount = 0;
    vi.advanceTimersByTime(25);
    expect(f.messages[0]).toMatchObject({
      session: { identity: { sessionId: "a" }, pointer: null, selectionIds: [] }
    });
    f.queue.enqueue(update("a", 999));
    f.callbacks[0]?.();
    expect(f.messages[1]).toMatchObject({ session: { identity: { sessionId: "b" } } });
    f.callbacks[1]?.();
    expect(f.messages[2]).toMatchObject({ session: { pointer: { x: 999 } } });
    f.callbacks[2]?.();
    expect(f.queue.statistics.pendingBytes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves snapshot/control FIFO, removes pending leave states, ignores late callbacks", () => {
    const f = fixture();
    const state = update();
    if (state.type !== "canvas.presence.update") throw new Error("update required");
    f.queue.enqueue({ ...scope, type: "canvas.presence.snapshot", sessions: [state.session] });
    f.queue.enqueue(state);
    f.queue.enqueue({
      ...scope,
      type: "canvas.presence.leave",
      sessionId: state.session.identity.sessionId
    });
    f.queue.enqueue({ ...scope, type: "canvas.presence.error", code: "rate_limited" });
    expect(f.queue.statistics.pendingUpdates).toBe(0);
    f.socket.bufferedAmount = 0;
    vi.advanceTimersByTime(25);
    expect(f.messages.map((m) => m.type)).toEqual(["canvas.presence.snapshot"]);
    f.callbacks[0]?.();
    f.callbacks[0]?.();
    expect(f.messages.map((m) => m.type)).toEqual([
      "canvas.presence.snapshot",
      "canvas.presence.leave"
    ]);
    f.callbacks[1]?.();
    f.callbacks[2]?.();
    expect(f.messages.map((m) => m.type)).toEqual([
      "canvas.presence.snapshot",
      "canvas.presence.leave",
      "canvas.presence.error"
    ]);
    f.queue.dispose();
    f.callbacks[2]?.();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds new updates behind an in-flight snapshot", () => {
    const f = fixture();
    f.socket.bufferedAmount = 0;
    f.queue.enqueue({ ...scope, type: "canvas.presence.snapshot", sessions: [] });
    f.queue.enqueue(update());
    expect(f.messages).toHaveLength(1);
    f.callbacks[0]?.();
    expect(f.messages.map((m) => m.type)).toEqual([
      "canvas.presence.snapshot",
      "canvas.presence.update"
    ]);
    f.queue.dispose();
  });

  it("rechecks authorization at drain time and disposes all pending state", () => {
    const f = fixture();
    f.queue.enqueue(update());
    f.authorize.mockReturnValue(false);
    f.socket.bufferedAmount = 0;
    vi.advanceTimersByTime(25);
    expect(f.socket.send).not.toHaveBeenCalled();
    expect(f.fatal).toHaveBeenCalledExactlyOnceWith("unauthorized");
    expect(f.queue.statistics).toMatchObject({ disposed: true, pendingBytes: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["buffered", "callback"])("bounds %s stalls even when updates keep arriving", (mode) => {
    const f = fixture();
    if (mode === "callback") f.socket.bufferedAmount = 0;
    f.queue.enqueue(update());
    for (let i = 0; i < 49; i++) {
      vi.advanceTimersByTime(100);
      f.queue.enqueue(update());
    }
    expect(f.fatal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(f.fatal).toHaveBeenCalledExactlyOnceWith("blocked_timeout");
    f.callbacks[0]?.();
    expect(f.queue.statistics).toMatchObject({
      pendingBytes: 0,
      pendingUpdates: 0,
      inFlight: false
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not time out an idle connection", () => {
    const f = fixture();
    vi.advanceTimersByTime(60_000);
    expect(f.fatal).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["throw", "callback"])("tears down exactly once after a send %s", (mode) => {
    const f = fixture();
    f.socket.bufferedAmount = 0;
    if (mode === "throw")
      f.socket.send.mockImplementation(() => {
        throw new Error("write");
      });
    f.queue.enqueue(update());
    f.callbacks[0]?.(new Error("write"));
    f.callbacks[0]?.(new Error("late"));
    f.queue.enqueue(update());
    expect(f.fatal).toHaveBeenCalledExactlyOnceWith("send_error");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains synchronous callbacks iteratively without nested send calls", () => {
    const f = fixture();
    let depth = 0;
    let highWater = 0;
    f.socket.send.mockImplementation((_text, cb) => {
      depth++;
      highWater = Math.max(highWater, depth);
      cb();
      depth--;
    });
    for (let i = 0; i < 32; i++) f.queue.enqueue(update(`peer-${i}`));
    f.socket.bufferedAmount = 0;
    vi.advanceTimersByTime(25);
    expect(f.socket.send).toHaveBeenCalledTimes(32);
    expect(highWater).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["updates", "controls", "bytes"])("enforces pending %s capacity", (kind) => {
    const f = fixture({
      limits: {
        maxPendingUpdates: 1,
        maxControls: 1,
        ...(kind === "bytes" ? { maxPendingBytes: 1 } : {})
      }
    });
    f.queue.enqueue(update());
    if (kind === "updates") f.queue.enqueue(update("other"));
    if (kind === "controls") {
      f.queue.enqueue({ ...scope, type: "canvas.presence.error", code: "rate_limited" });
      f.queue.enqueue({ ...scope, type: "canvas.presence.error", code: "rate_limited" });
    }
    expect(f.fatal).toHaveBeenCalledExactlyOnceWith("queue_capacity");
    expect(f.queue.statistics.pendingBytes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses UTF-8 bytes for frame limits and the exact remaining transport budget", () => {
    const message = update("peer", 1, ["界".repeat(100)]);
    const text = JSON.stringify(message);
    const bytes = Buffer.byteLength(text, "utf8");
    expect(bytes).toBeGreaterThan(text.length);
    const rejected = fixture({ limits: { maxFrameBytes: bytes - 1 } });
    rejected.queue.enqueue(message);
    expect(rejected.fatal).toHaveBeenCalledWith("frame_too_large");
    const f = fixture({ limits: { maxFrameBytes: bytes, maxBufferedBytes: bytes * 2 } });
    f.socket.bufferedAmount = bytes + 1;
    f.queue.enqueue(message);
    expect(f.socket.send).not.toHaveBeenCalled();
    expect(f.queue.statistics.pendingBytes).toBe(bytes);
    f.socket.bufferedAmount = bytes;
    vi.advanceTimersByTime(25);
    expect(f.socket.send).toHaveBeenCalledOnce();
    f.queue.dispose();
  });

  it("stamps forwarding time and records queue/callback delays only at the real send", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const onSend = vi.fn(() => vi.fn());
    const f = fixture({ onSend });
    const message = update();
    if (message.type !== "canvas.presence.update") throw new Error("update required");
    f.queue.enqueue({
      ...message,
      trace: {
        streamId: "12345678-1234-4234-8234-123456789012",
        sequence: 1,
        serverClockId: "12345678-1234-4234-8234-123456789013",
        serverReceivedMs: 100,
        serverForwardedMs: 100
      }
    });
    vi.advanceTimersByTime(500);
    expect(onSend).not.toHaveBeenCalled();
    f.socket.bufferedAmount = 0;
    vi.advanceTimersByTime(25);
    expect(f.messages[0]).toMatchObject({ trace: { serverForwardedMs: 625 } });
    expect(onSend).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(75);
    f.callbacks[0]?.();
    expect(f.queue.statistics).toMatchObject({
      queueWaitHighWaterMs: 525,
      callbackDurationHighWaterMs: 75
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["dispose", "closed"])("clears timers and ignores completions after %s", (mode) => {
    const f = fixture();
    f.socket.bufferedAmount = 0;
    f.queue.enqueue(update());
    f.queue.enqueue(update("other"));
    if (mode === "dispose") f.queue.dispose();
    else {
      f.socket.readyState = 3;
      vi.advanceTimersByTime(25);
    }
    f.callbacks[0]?.();
    expect(f.messages).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.queue.statistics.pendingBytes).toBe(0);
  });
});
