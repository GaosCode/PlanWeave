import { afterEach, describe, expect, it, vi } from "vitest";
import { CANVAS_PRESENCE_MAX_FRAME_BYTES } from "@planweave-ai/collaboration-protocol/core/limits";
import { deploymentEndpointSchema } from "@planweave-ai/collaboration-protocol/connection";
import type { CanvasPresenceClientUpdate } from "@planweave-ai/collaboration-protocol/canvas/presence";
import { CanvasPresenceClient } from "../main/collaboration/CanvasPresenceClient.js";
import {
  PresencePendingUpdate,
  PRESENCE_MAX_BUFFERED_BYTES
} from "../main/collaboration/PresencePendingUpdate.js";
import { systemCollaborationClock } from "../main/collaboration/collaborationClientTypes.js";
import { CAPTURE_SAMPLE_LIMIT } from "../shared/collaborationCapture.js";
import { transportCapture } from "../main/collaboration/collaborationCaptureRecorder.js";

class TestSocket {
  static instances: TestSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  close = vi.fn(() => {
    this.readyState = 3;
    this.emit("close");
  });
  send = vi.fn((text: string, callback?: (error?: Error) => void) => {
    this.sent.push(text);
    callback?.();
  });
  private listeners = new Map<string, Set<(event: unknown) => void>>();
  constructor() {
    TestSocket.instances.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  snapshot(canvasId = "default"): void {
    this.emit("message", {
      data: JSON.stringify({
        type: "canvas.presence.snapshot",
        protocolVersion: 1,
        projectId: "project-demo-001",
        canvasId,
        sessions: [],
        diagnosticsVersion: 1
      })
    });
  }
}

const clients: CanvasPresenceClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  TestSocket.instances = [];
  transportCapture.stop();
  transportCapture.bind(null);
  vi.useRealTimers();
});

async function startClient() {
  vi.useFakeTimers();
  const client = new CanvasPresenceClient({
    profile: {
      profileId: "profile-test",
      displayName: "Test",
      serverBaseUrl: "https://collab.example.com/",
      projectId: "project-demo-001",
      allowInsecureTransport: false,
      endpoint: deploymentEndpointSchema.parse({
        topology: "public_https",
        serverOrigin: "https://collab.example.com/",
        allowedClientOrigins: ["https://collab.example.com/"],
        tlsTrust: "system_ca"
      })
    },
    credential: { getDeviceToken: () => "test-device-credential" },
    WebSocketImpl: TestSocket,
    clock: systemCollaborationClock,
    random: () => 0,
    reconnectInitialDelayMs: 100,
    reconnectMaxDelayMs: 100
  });
  clients.push(client);
  client.start("default");
  await Promise.resolve();
  const socket = TestSocket.instances.at(-1)!;
  socket.open();
  return { client, socket };
}
const update = (x: number): CanvasPresenceClientUpdate => ({
  type: "canvas.presence.update",
  protocolVersion: 1,
  projectId: "project-demo-001",
  canvasId: "default",
  pointer: { x, y: 2 },
  selectionIds: [`T-${x}`]
});

describe("desktop presence single pending update", () => {
  it("sends hello first and keeps only the complete latest state behind the snapshot", async () => {
    const { client, socket } = await startClient();
    client.publish(update(1));
    client.publish({ pointer: null, selectionIds: [] });
    expect(socket.sent.map((text) => JSON.parse(text).type)).toEqual(["canvas.presence.hello"]);
    expect(vi.getTimerCount()).toBe(1);
    socket.snapshot();
    expect(JSON.parse(socket.sent[1])).toMatchObject({ pointer: null, selectionIds: [] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces thousands of blocked updates, then sends only the latest with contiguous trace sequence", async () => {
    const { client, socket } = await startClient();
    socket.snapshot();
    transportCapture.start("queue-test", JSON.stringify(["profile-test", "default"]));
    const captureTimers = vi.getTimerCount();
    client.publish(update(0));
    socket.bufferedAmount = PRESENCE_MAX_BUFFERED_BYTES;
    for (let index = 1; index <= 1_000; index += 1) client.publish(update(index));
    expect(vi.getTimerCount()).toBe(captureTimers + 1);
    expect(socket.sent).toHaveLength(2);
    const samples = transportCapture.snapshot()!.samples;
    expect(samples.filter((sample) => sample.stage === "presence_coalesced")).toHaveLength(999);
    expect(samples.filter((sample) => sample.stage === "socket_send")).toHaveLength(1);
    vi.advanceTimersByTime(50);
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(25);
    expect(JSON.parse(socket.sent[2])).toMatchObject({
      pointer: { x: 1_000 },
      selectionIds: ["T-1000"],
      trace: { sequence: 1 }
    });
    const sentSamples = transportCapture
      .snapshot()!
      .samples.filter((sample) => sample.stage === "socket_send");
    expect(sentSamples).toHaveLength(2);
    expect(sentSamples.map((sample) => sample.trace?.sequence)).toEqual([0, 1]);
    expect(transportCapture.snapshot()!.samples).toContainEqual(
      expect.objectContaining({ stage: "presence_queue_wait", durationMs: 75 })
    );
    expect(vi.getTimerCount()).toBe(captureTimers);
  });

  it("replaces a blocked pointer and selection with explicit clear", async () => {
    const { client, socket } = await startClient();
    socket.snapshot();
    socket.bufferedAmount = PRESENCE_MAX_BUFFERED_BYTES;
    client.publish(update(1));
    client.publish({ pointer: null, selectionIds: [] });
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(25);
    expect(JSON.parse(socket.sent[1])).toMatchObject({ pointer: null, selectionIds: [] });
  });

  it.each([
    "stop",
    "scope",
    "close",
    "error",
    "auth"
  ])("clears old pending state and timers on %s", async (action) => {
    const { client, socket } = await startClient();
    socket.snapshot();
    socket.bufferedAmount = PRESENCE_MAX_BUFFERED_BYTES;
    client.publish(update(1));
    if (action === "stop") client.stop();
    if (action === "scope") client.start("other");
    if (action === "close") socket.close();
    if (action === "error") socket.emit("error");
    if (action === "auth")
      socket.emit("message", {
        data: JSON.stringify({
          type: "canvas.presence.error",
          protocolVersion: 1,
          projectId: "project-demo-001",
          canvasId: "default",
          code: "forbidden"
        })
      });
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(25);
    expect(socket.sent).toHaveLength(1);
    if (action === "stop" || action === "auth") expect(vi.getTimerCount()).toBe(0);
    if (action === "auth") expect(client.state().state).toBe("auth_expired");
  });

  it("does not replay old updates on reconnect and accepts newly published state", async () => {
    const { client, socket } = await startClient();
    socket.snapshot();
    socket.bufferedAmount = PRESENCE_MAX_BUFFERED_BYTES;
    client.publish(update(1));
    socket.close();
    await vi.advanceTimersByTimeAsync(100);
    const next = TestSocket.instances.at(-1)!;
    next.open();
    next.snapshot();
    expect(next.sent).toHaveLength(1);
    client.publish(update(2));
    expect(JSON.parse(next.sent[1])).toMatchObject({ pointer: { x: 2 } });
    socket.snapshot();
    expect(next.sent).toHaveLength(2);
  });

  it.each([
    false,
    true
  ])("disconnects after 5 seconds without progress, including before snapshot: %s", async (initializing) => {
    const { client, socket } = await startClient();
    if (!initializing) socket.snapshot();
    socket.bufferedAmount = PRESENCE_MAX_BUFFERED_BYTES;
    client.publish(update(1));
    vi.advanceTimersByTime(4_975);
    client.publish(update(2));
    expect(socket.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(25);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(client.state().state).toBe("reconnecting");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not schedule retries or disconnect an idle client", async () => {
    const { socket } = await startClient();
    socket.snapshot();
    socket.bufferedAmount = PRESENCE_MAX_BUFFERED_BYTES;
    vi.advanceTimersByTime(10_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("tears down once on synchronous send failure without requiring a write callback", async () => {
    const { client, socket } = await startClient();
    socket.snapshot();
    transportCapture.start("send-test", JSON.stringify(["profile-test", "default"]));
    const captureTimers = vi.getTimerCount();
    socket.send.mockImplementation((text) => {
      socket.sent.push(text);
    });
    client.publish(update(0));
    expect(socket.sent).toHaveLength(2);
    expect(
      transportCapture.snapshot()!.samples.filter((sample) => sample.stage === "socket_send")
    ).toHaveLength(1);
    socket.send.mockImplementationOnce(() => {
      throw new Error("write failed");
    });
    client.publish(update(1));
    expect(socket.close).toHaveBeenCalledOnce();
    expect(client.state().state).toBe("reconnecting");
    expect(vi.getTimerCount()).toBe(captureTimers + 1);
  });

  it("does not send a stale trace when buffering metrics end capture at the sample limit", async () => {
    const { client, socket } = await startClient();
    socket.snapshot();
    transportCapture.start("limit-test", JSON.stringify(["profile-test", "default"]));
    for (let index = 0; index < CAPTURE_SAMPLE_LIMIT; index += 1)
      transportCapture.record("socket_open");
    client.publish(update(1));
    expect(transportCapture.snapshot()?.stopReason).toBe("sample_limit");
    expect(JSON.parse(socket.sent[1])).not.toHaveProperty("trace");
  });

  it("rejects initialization messages received before hello", async () => {
    const { client } = await startClient();
    client.stop();
    client.start("default");
    await Promise.resolve();
    const next = TestSocket.instances.at(-1)!;
    next.snapshot();
    expect(next.sent).toHaveLength(0);
    expect(next.close).toHaveBeenCalledOnce();
    expect(client.state().state).toBe("reconnecting");
  });

  it("rejects publishing without an open socket and rejects an over-budget hello", async () => {
    const { client, socket } = await startClient();
    client.stop();
    expect(() => client.publish(update(1))).toThrow("not connected");
    client.start("default");
    await Promise.resolve();
    const next = TestSocket.instances.at(-1)!;
    next.bufferedAmount = PRESENCE_MAX_BUFFERED_BYTES;
    next.open();
    expect(next.sent).toHaveLength(0);
    expect(next.close).toHaveBeenCalledOnce();
    expect(socket.sent).toHaveLength(1);
  });
});

it("measures final UTF-8 JSON bytes, accepts the exact boundary and preserves pending state on rejection", () => {
  vi.useFakeTimers();
  const socket = new TestSocket();
  socket.readyState = 1;
  const onFatal = vi.fn();
  const send = vi.fn();
  const queue = new PresencePendingUpdate({
    socket,
    clock: systemCollaborationClock,
    serialize: JSON.stringify,
    send,
    onCoalesced: vi.fn(),
    onBuffered: vi.fn(),
    onFatal
  });
  queue.connected();
  const base = { ...update(1), selectionIds: [""] };
  const remaining = CANVAS_PRESENCE_MAX_FRAME_BYTES - Buffer.byteLength(JSON.stringify(base));
  const selection = "界".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
  const exact = { ...base, selectionIds: [selection] };
  socket.bufferedAmount = CANVAS_PRESENCE_MAX_FRAME_BYTES;
  queue.publish(exact);
  expect(send).toHaveBeenCalledOnce();
  expect(Buffer.byteLength(send.mock.calls[0][0])).toBe(CANVAS_PRESENCE_MAX_FRAME_BYTES);
  socket.bufferedAmount += 1;
  queue.publish(exact);
  expect(send).toHaveBeenCalledOnce();
  expect(() => queue.publish({ ...base, selectionIds: [`${selection}x`] })).toThrow("size limit");
  socket.bufferedAmount = 0;
  vi.advanceTimersByTime(25);
  expect(send).toHaveBeenCalledTimes(2);
  expect(onFatal).not.toHaveBeenCalled();
  queue.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
