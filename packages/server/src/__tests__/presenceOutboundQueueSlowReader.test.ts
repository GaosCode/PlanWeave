import { once } from "node:events";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { canvasPresenceServerMessageSchema } from "@planweave-ai/collaboration-protocol/canvas/presence";
import { PresenceOutboundQueue, PRESENCE_OUTBOUND_LIMITS } from "../presenceOutboundQueue.js";

it("bounds a real ws slow reader without stalling the healthy recipient", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const clients: WebSocket[] = [];
  const queues: PresenceOutboundQueue[] = [];
  try {
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("TCP address required");
    const connect = async () => {
      const accepted = once(server, "connection");
      const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
      clients.push(client);
      await once(client, "open");
      const [socket] = await accepted;
      if (!(socket instanceof WebSocket)) throw new Error("WebSocket required");
      return { client, socket };
    };
    const slow = await connect();
    const healthy = await connect();
    slow.client.pause();
    let latest = -1;
    let healthyReceived = 0;
    healthy.client.on("message", (data) => {
      const message = canvasPresenceServerMessageSchema.parse(JSON.parse(data.toString()));
      if (message.type === "canvas.presence.update" && message.session.pointer) {
        latest = message.session.pointer.x;
        healthyReceived++;
      }
    });
    let slowFailures = 0;
    let healthyFailures = 0;
    const slowQueue = new PresenceOutboundQueue({
      socket: slow.socket,
      authorize: () => true,
      limits: { blockedTimeoutMs: 250 },
      onFatal: () => {
        slowFailures++;
        slow.socket.terminate();
      }
    });
    const healthyQueue = new PresenceOutboundQueue({
      socket: healthy.socket,
      authorize: () => true,
      onFatal: () => {
        healthyFailures++;
        healthy.socket.terminate();
      }
    });
    queues.push(slowQueue, healthyQueue);
    const message = canvasPresenceServerMessageSchema.parse({
      type: "canvas.presence.update",
      protocolVersion: 1,
      projectId: "project",
      canvasId: "default",
      session: {
        identity: { sessionId: "peer", humanPrincipalId: "human", displayName: "Peer" },
        pointer: { x: 0, y: 0 },
        selectionIds: Array.from({ length: 32 }, (_, index) => `${index}-${"界".repeat(120)}`)
      }
    });
    if (message.type !== "canvas.presence.update") throw new Error("update required");
    let sequence = 0;
    while (slowQueue.statistics.coalescedUpdates < 100 && sequence < 10_000) {
      const next = {
        ...message,
        session: { ...message.session, pointer: { x: sequence++, y: 0 } }
      };
      slowQueue.enqueue(next);
      healthyQueue.enqueue(next);
      expect(slowQueue.statistics.pendingUpdates).toBeLessThanOrEqual(1);
      expect(slowQueue.statistics.pendingBytes).toBeLessThanOrEqual(
        PRESENCE_OUTBOUND_LIMITS.maxPendingBytes
      );
      expect(slow.socket.bufferedAmount).toBeLessThanOrEqual(
        PRESENCE_OUTBOUND_LIMITS.maxBufferedBytes
      );
      await yieldTurn();
    }
    expect(slowQueue.statistics.coalescedUpdates).toBeGreaterThanOrEqual(100);
    expect(healthyReceived).toBeGreaterThan(0);
    await expect.poll(() => slowFailures, { timeout: 3_000 }).toBe(1);
    const final = { ...message, session: { ...message.session, pointer: { x: 100_000, y: 0 } } };
    healthyQueue.enqueue(final);
    await expect.poll(() => latest, { timeout: 3_000 }).toBe(100_000);
    expect(healthyFailures).toBe(0);
    expect(healthy.client.readyState).toBe(WebSocket.OPEN);
    expect(slowQueue.statistics).toMatchObject({
      disposed: true,
      pendingBytes: 0,
      pendingUpdates: 0,
      inFlight: false
    });
  } finally {
    for (const queue of queues) queue.dispose();
    for (const client of clients) client.terminate();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}, 15_000);
