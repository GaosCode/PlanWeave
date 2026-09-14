import { describe, expect, it } from "vitest";
import { CANVAS_LIVE_SYNC_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import { CanvasLiveSyncClient } from "../main/collaboration/CanvasLiveSyncClient.js";
import type { CollaborationClientClock } from "../main/collaboration/collaborationClientTypes.js";

type Listener = (event: unknown) => void;

class TestSocket {
  static instances: TestSocket[] = [];
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readyState = 0;
  bufferedAmount = 0;

  constructor(
    readonly url: string,
    readonly options?: string | string[] | { headers?: Record<string, string> }
  ) {
    TestSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code });
  }

  addEventListener(type: "open" | "message" | "error" | "close", listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: "open" | "message" | "error" | "close", listener: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry !== listener)
    );
  }

  emit(type: "open" | "message" | "error" | "close", event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function deferredClock(): {
  clock: CollaborationClientClock;
  timers: Array<() => void>;
} {
  const timers: Array<() => void> = [];
  return {
    timers,
    clock: {
      now: () => new Date("2026-08-02T00:00:00.000Z"),
      setTimeout: (callback) => {
        timers.push(callback);
        return callback;
      },
      clearTimeout: () => undefined
    }
  };
}

function createClient(clock: CollaborationClientClock): CanvasLiveSyncClient {
  return new CanvasLiveSyncClient({
    profile: {
      profileId: "profile-1",
      displayName: "Demo",
      serverBaseUrl: "https://collab.example.com/",
      projectId: "project-1",
      allowInsecureTransport: false
    },
    credential: { getDeviceToken: () => "pw_hdev_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq" },
    WebSocketImpl: TestSocket,
    clock,
    random: () => 0,
    reconnectInitialDelayMs: 4,
    reconnectMaxDelayMs: 8
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("CanvasLiveSyncClient", () => {
  it("uses the scoped URL, authenticated Origin, strict hello, and forwards accepted entries", async () => {
    TestSocket.instances = [];
    const { clock } = deferredClock();
    const messages: unknown[] = [];
    const client = createClient(clock);
    client.start("canvas-1", 0, { onMessage: (message) => messages.push(message) });
    await flush();

    const socket = TestSocket.instances[0];
    expect(socket.url).toBe(
      "wss://collab.example.com/api/v1/projects/project-1/canvases/canvas-1/human/live"
    );
    expect(socket.options).toEqual({
      headers: {
        Authorization: "Bearer pw_hdev_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
        Origin: "https://collab.example.com"
      }
    });
    socket.emit("open");
    expect(JSON.parse(socket.sent[0] ?? "")).toEqual({
      type: "canvas.live.hello",
      protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
      projectId: "project-1",
      canvasId: "canvas-1",
      lastRevision: 0
    });
    socket.emit("message", {
      data: JSON.stringify({
        type: "canvas.live.accepted_entry",
        protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
        entry: {
          schemaVersion: "canvas-journal/v1",
          entryId: "journal-1",
          scope: { workspaceId: "workspace-1", projectId: "project-1", canvasId: "canvas-1" },
          revision: 1,
          previousRevision: 0,
          operationId: "operation-1",
          intent: { kind: "update_layout", nodes: [{ nodeId: "T-1", x: 1, y: 2 }] },
          intentDigest: "a".repeat(64),
          contentDigest: "b".repeat(64),
          actor: { kind: "human", id: "human-1" },
          acceptedAt: "2026-08-02T00:00:00.000Z"
        }
      })
    });
    expect(messages).toEqual([expect.objectContaining({ type: "canvas.live.accepted_entry" })]);
    // Cursor does not advance on receive — only after acknowledgeAppliedRevision.
    expect(client.helloRevision()).toBe(0);
    client.acknowledgeAppliedRevision(1);
    expect(client.helloRevision()).toBe(1);
  });

  it("allows monotone head jumps via acknowledgeMaterializedHead after HTTP recovery", async () => {
    TestSocket.instances = [];
    const { clock } = deferredClock();
    const client = createClient(clock);
    client.start("canvas-1", 1);
    await flush();
    expect(client.helloRevision()).toBe(1);
    // Strict +1 cannot jump 1 → 5.
    client.acknowledgeAppliedRevision(5);
    expect(client.helloRevision()).toBe(1);
    // Recovery head jump is allowed and monotone.
    client.acknowledgeMaterializedHead(5);
    expect(client.helloRevision()).toBe(5);
    client.acknowledgeMaterializedHead(3);
    expect(client.helloRevision()).toBe(5);
    client.acknowledgeMaterializedHead(6);
    expect(client.helloRevision()).toBe(6);
  });

  it("fans out to multiple subscribers without overwriting handlers", async () => {
    TestSocket.instances = [];
    const { clock } = deferredClock();
    const client = createClient(clock);
    const a: unknown[] = [];
    const b: unknown[] = [];
    client.start("canvas-1", 0);
    client.subscribe({ onMessage: (m) => a.push(m.type) });
    client.subscribe({ onMessage: (m) => b.push(m.type) });
    await flush();
    const socket = TestSocket.instances[0];
    socket.emit("message", {
      data: JSON.stringify({
        type: "canvas.live.accepted_entry",
        protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
        entry: {
          schemaVersion: "canvas-journal/v1",
          entryId: "journal-1",
          scope: { workspaceId: "workspace-1", projectId: "project-1", canvasId: "canvas-1" },
          revision: 1,
          previousRevision: 0,
          operationId: "operation-1",
          intent: { kind: "update_layout", nodes: [{ nodeId: "T-1", x: 1, y: 2 }] },
          intentDigest: "a".repeat(64),
          contentDigest: "b".repeat(64),
          actor: { kind: "human", id: "human-1" },
          acceptedAt: "2026-08-02T00:00:00.000Z"
        }
      })
    });
    expect(a).toEqual(["canvas.live.accepted_entry"]);
    expect(b).toEqual(["canvas.live.accepted_entry"]);
  });

  it("uses the active hello revision after a retryable network close and pauses after catchup", async () => {
    TestSocket.instances = [];
    const { clock, timers } = deferredClock();
    const statuses: string[] = [];
    const client = createClient(clock);
    client.start("canvas-1", 1, { onStatus: (status) => statuses.push(status.state) });
    await flush();
    const socket = TestSocket.instances[0];
    socket.emit("close", { code: 1001 });
    expect(statuses).toContain("reconnecting");
    timers.shift()?.();
    await flush();
    expect(TestSocket.instances).toHaveLength(2);

    const replacement = TestSocket.instances[1];
    replacement.emit("open");
    expect(JSON.parse(replacement.sent[0] ?? "")).toMatchObject({
      type: "canvas.live.hello",
      lastRevision: 1
    });
    replacement.emit("message", {
      data: JSON.stringify({
        type: "canvas.live.catchup_required",
        protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
        projectId: "project-1",
        canvasId: "canvas-1",
        reason: "revision_behind",
        recovery: "http_reconnect",
        headRevision: 1,
        headContentDigest: "a".repeat(64)
      })
    });
    replacement.emit("close", { code: 4004 });
    expect(statuses).toContain("catchup_required");
    expect(timers).toHaveLength(0);
  });

  it("treats local protocol violations as terminal without reconnecting", async () => {
    TestSocket.instances = [];
    const { clock, timers } = deferredClock();
    const messages: unknown[] = [];
    const client = createClient(clock);
    client.start("canvas-1", 0, { onMessage: (message) => messages.push(message) });
    await flush();
    const socket = TestSocket.instances[0];
    socket.emit("message", { data: "x".repeat(1_048_577) });
    expect(messages).toEqual([]);
    expect(client.state()).toEqual({
      state: "failed",
      canvasId: "canvas-1",
      code: "collaboration_live_sync_protocol_error"
    });
    expect(timers).toHaveLength(0);
    expect(TestSocket.instances).toHaveLength(1);
  });

  it("treats cross-scope frames and unsupported versions as terminal without reconnecting", async () => {
    TestSocket.instances = [];
    const { clock, timers } = deferredClock();
    const messages: unknown[] = [];
    const client = createClient(clock);
    client.start("canvas-1", 0, { onMessage: (message) => messages.push(message) });
    await flush();
    const socket = TestSocket.instances[0];
    socket.emit("message", {
      data: JSON.stringify({
        type: "canvas.live.catchup_required",
        protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
        projectId: "project-other",
        canvasId: "canvas-1",
        reason: "revision_behind",
        recovery: "http_reconnect",
        headRevision: 1,
        headContentDigest: "a".repeat(64)
      })
    });
    expect(messages).toEqual([]);
    expect(client.state()).toEqual({
      state: "failed",
      canvasId: "canvas-1",
      code: "collaboration_live_sync_protocol_error"
    });
    expect(timers).toHaveLength(0);

    const terminalClient = createClient(clock);
    terminalClient.start("canvas-1", 0);
    await flush();
    const terminal = TestSocket.instances[1];
    terminal.emit("message", {
      data: JSON.stringify({
        type: "canvas.live.error",
        protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
        projectId: "project-1",
        canvasId: "canvas-1",
        code: "unsupported_version"
      })
    });
    expect(terminalClient.state()).toEqual({
      state: "failed",
      canvasId: "canvas-1",
      code: "unsupported_version"
    });
    expect(timers).toHaveLength(0);
  });

  it("keeps access denial terminal without expiring the credential", async () => {
    TestSocket.instances = [];
    const { clock, timers } = deferredClock();
    const client = createClient(clock);
    client.start("canvas-1", 0);
    await flush();
    TestSocket.instances[0].emit("message", {
      data: JSON.stringify({
        type: "canvas.live.auth_expired",
        protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
        projectId: "project-1",
        canvasId: "canvas-1",
        code: "forbidden"
      })
    });
    expect(client.state()).toEqual({
      state: "access_denied",
      canvasId: "canvas-1",
      code: "forbidden"
    });
    expect(timers).toHaveLength(0);
  });

  it.each([4000, 4002, 1009])("does not retry protocol close %s", async (closeCode) => {
    TestSocket.instances = [];
    const { clock, timers } = deferredClock();
    const client = createClient(clock);
    client.start("canvas-1", 0);
    await flush();
    TestSocket.instances[0].emit("close", { code: closeCode });
    expect(client.state()).toEqual({
      state: "failed",
      canvasId: "canvas-1",
      code: `websocket_${closeCode}`
    });
    expect(timers).toHaveLength(0);
    expect(TestSocket.instances).toHaveLength(1);
  });

  it("does not let stopped generations construct a socket after an async credential resolves", async () => {
    TestSocket.instances = [];
    const { clock } = deferredClock();
    let resolveCredential!: (value: string | undefined) => void;
    const credential = new Promise<string | undefined>((resolve) => {
      resolveCredential = resolve;
    });
    const client = new CanvasLiveSyncClient({
      profile: {
        profileId: "profile-1",
        displayName: "Demo",
        serverBaseUrl: "https://collab.example.com/",
        projectId: "project-1",
        allowInsecureTransport: false
      },
      credential: { getDeviceToken: () => credential },
      WebSocketImpl: TestSocket,
      clock,
      random: () => 0,
      reconnectInitialDelayMs: 4,
      reconnectMaxDelayMs: 8
    });
    client.start("canvas-1", 0);
    client.stop();
    resolveCredential("pw_hdev_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq");
    await flush();
    expect(TestSocket.instances).toHaveLength(0);
  });
});
