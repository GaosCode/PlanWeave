import { afterEach, expect, it, vi } from "vitest";
import {
  canvasPresenceServerMessageSchema,
  type CanvasPresenceServerMessage
} from "@planweave-ai/collaboration-protocol/canvas/presence";
import { CanvasPresenceHub } from "../presenceHub.js";
import { PresenceOutboundQueue } from "../presenceOutboundQueue.js";

const scope = { workspaceId: "workspace", projectId: "project", canvasId: "default" };
const hubs: CanvasPresenceHub[] = [];
const queues: PresenceOutboundQueue[] = [];

afterEach(() => {
  for (const queue of queues.splice(0)) queue.dispose();
  for (const hub of hubs.splice(0)) hub.close();
  vi.useRealTimers();
});

function createHub(sessionId?: () => string) {
  vi.useFakeTimers();
  let sequence = 0;
  const hub = new CanvasPresenceHub({ sessionId: sessionId ?? (() => `session-${sequence++}`) });
  hubs.push(hub);
  return hub;
}

function peer(hub: CanvasPresenceHub, name: string, blocked: boolean, onRemoved?: () => void) {
  let sessionId = "";
  const received: CanvasPresenceServerMessage[] = [];
  const queue = new PresenceOutboundQueue({
    socket: {
      readyState: 1,
      bufferedAmount: blocked ? 1_000_000 : 0,
      send(text, callback) {
        received.push(canvasPresenceServerMessageSchema.parse(JSON.parse(text)));
        callback();
      }
    },
    authorize: () => true,
    ...(blocked ? { limits: { maxPendingBytes: 1 } } : {}),
    onFatal: () => {
      hub.leave(sessionId, "disconnect");
    }
  });
  queues.push(queue);
  const connected = hub.connect({
    scope,
    humanPrincipalId: name,
    displayName: name,
    onRemoved,
    send: (message) => {
      queue.enqueue(message);
    }
  });
  sessionId = connected.session.identity.sessionId;
  return { sessionId, received };
}

it("stops a fanout when nested queue failures remove its source before the next recipient", () => {
  const hub = createHub();
  const a = peer(hub, "A", true);
  const b = peer(hub, "B", true);
  const c = peer(hub, "C", false);

  hub.update(a.sessionId, scope, { x: 1, y: 1 }, ["T-1"]);

  expect(c.received).toEqual([
    expect.objectContaining({ type: "canvas.presence.leave", sessionId: a.sessionId }),
    expect.objectContaining({ type: "canvas.presence.leave", sessionId: b.sessionId })
  ]);
  expect(hub.snapshot(scope).map((session) => session.identity.sessionId)).toEqual([c.sessionId]);
});

it("does not resume an old update when a new session reuses the removed source ID", () => {
  const ids = ["source", "slow", "healthy", "source"];
  const hub = createHub(() => {
    const id = ids.shift();
    if (!id) throw new Error("Session ID fixture exhausted");
    return id;
  });
  const a = peer(hub, "A", true, () => {
    peer(hub, "Replacement", false);
  });
  const b = peer(hub, "B", true);
  const c = peer(hub, "C", false);

  hub.update(a.sessionId, scope, { x: 1, y: 1 }, []);

  expect(c.received).toEqual([
    expect.objectContaining({ type: "canvas.presence.leave", sessionId: a.sessionId }),
    expect.objectContaining({ type: "canvas.presence.leave", sessionId: b.sessionId })
  ]);
  expect(hub.snapshot(scope).map((session) => session.identity.displayName)).toEqual([
    "C",
    "Replacement"
  ]);
});

it("continues delivering the live source update after only the slow recipient is removed", () => {
  const hub = createHub();
  const a = peer(hub, "A", false);
  const b = peer(hub, "B", true);
  const c = peer(hub, "C", false);

  hub.update(a.sessionId, scope, { x: 2, y: 3 }, ["T-2"]);

  expect(c.received).toEqual([
    expect.objectContaining({ type: "canvas.presence.leave", sessionId: b.sessionId }),
    expect.objectContaining({
      type: "canvas.presence.update",
      session: expect.objectContaining({ pointer: { x: 2, y: 3 }, selectionIds: ["T-2"] })
    })
  ]);
  expect(hub.snapshot(scope).map((session) => session.identity.sessionId)).toEqual([
    a.sessionId,
    c.sessionId
  ]);
});
