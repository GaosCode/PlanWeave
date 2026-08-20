import { describe, expect, it } from "vitest";
import { CANVAS_LIVE_SYNC_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import {
  CollaborationCanvasLiveSyncSession,
  type CollaborationCanvasLiveSyncClientPort
} from "../main/collaboration/collaborationCanvasLiveSyncSession.js";
import type { CollaborationClientClock } from "../main/collaboration/collaborationClientTypes.js";
import type {
  CanvasLiveSyncHandlers,
  CanvasLiveSyncStatus
} from "../main/collaboration/CanvasLiveSyncClient.js";
import type { CanvasCommandSessionSnapshot } from "../main/collaboration/canvasCommandSession.js";

type Listener = (event: unknown) => void;

class TestSocket {
  static instances: TestSocket[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readyState = 0;

  constructor(_url: string, _options?: string | string[] | { headers?: Record<string, string> }) {
    TestSocket.instances.push(this);
  }

  send(): void {}

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

  emit(type: "open" | "message" | "error" | "close", event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const clock: CollaborationClientClock = {
  now: () => new Date("2026-08-02T00:00:00.000Z"),
  setTimeout: (callback) => callback,
  clearTimeout: () => undefined
};

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function acceptedEntryMessage(canvasId: string): string {
  return JSON.stringify({
    type: "canvas.live.accepted_entry",
    protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
    entry: {
      schemaVersion: "canvas-journal/v1",
      entryId: `journal-${canvasId}`,
      scope: { workspaceId: "workspace-1", projectId: "project-1", canvasId },
      revision: 1,
      previousRevision: 0,
      operationId: `operation-${canvasId}`,
      intent: { kind: "update_layout", nodes: [{ nodeId: "T-1", x: 1, y: 2 }] },
      intentDigest: "a".repeat(64),
      contentDigest: "b".repeat(64),
      actor: { kind: "human", id: "human-1" },
      acceptedAt: "2026-08-02T00:00:00.000Z"
    }
  });
}

describe("CollaborationCanvasLiveSyncSession", () => {
  it("keeps a scope idempotent, atomically replaces it, and discards old callbacks after reset", async () => {
    TestSocket.instances = [];
    const client = new CollaborationClient({
      profile: {
        profileId: "profile-1",
        displayName: "Demo",
        serverBaseUrl: "https://collab.example.com/",
        projectId: "project-1",
        allowInsecureTransport: false,
        endpoint: {
          topology: "public_https",
          serverOrigin: "https://collab.example.com/",
          allowedClientOrigins: ["https://collab.example.com/"],
          tlsTrust: "system_ca"
        }
      },
      credential: { getDeviceToken: () => "pw_hdev_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq" },
      WebSocketImpl: TestSocket,
      clock,
      random: () => 0,
      limits: { reconnectInitialDelayMs: 4, reconnectMaxDelayMs: 8 }
    });
    const signals: unknown[] = [];
    const session = new CollaborationCanvasLiveSyncSession({
      getClient: () => client,
      getClientProfileId: () => "profile-1",
      resolveCanvasBinding: async ({ localProjectId, canvasId }) => ({
        kind: "local" as const,
        localProjectId,
        canvasId,
        remoteProjectId: "project-1",
        remoteCanvasId: `remote-${canvasId}`
      }),
      publishCanvasLiveSyncSignal: (signal) => signals.push(signal),
      clearDeviceCredential: async () => undefined,
      publishStatus: async () => undefined
    });

    client.bindCanvasCommandSession("remote-first");
    await session.start({ kind: "local", localProjectId: "local-project", canvasId: "first" });
    await flush();
    const firstSocket = TestSocket.instances[0];
    await session.start({ kind: "local", localProjectId: "local-project", canvasId: "first" });
    await flush();
    expect(TestSocket.instances).toHaveLength(1);

    client.bindCanvasCommandSession("remote-second");
    await session.start({ kind: "local", localProjectId: "local-project", canvasId: "second" });
    await flush();
    const secondSocket = TestSocket.instances[1];
    expect(firstSocket.readyState).toBe(3);
    expect(secondSocket).toBeDefined();

    firstSocket.emit("message", { data: acceptedEntryMessage("remote-first") });
    expect(signals).toEqual([]);
    secondSocket.emit("message", { data: acceptedEntryMessage("remote-second") });
    expect(signals).toHaveLength(1);

    session.reset();
    secondSocket.emit("message", { data: acceptedEntryMessage("remote-second") });
    expect(signals).toHaveLength(1);

    // After rebind to second, frames for the first canvas must never be published with the old scope.
    client.bindCanvasCommandSession("remote-first");
    await session.start({ kind: "local", localProjectId: "local-project", canvasId: "first" });
    await flush();
    const reboundSocket = TestSocket.instances.at(-1)!;
    const signalsBefore = signals.length;
    reboundSocket.emit("message", { data: acceptedEntryMessage("remote-second") });
    expect(signals).toHaveLength(signalsBefore);

    client.dispose();
    expect(client.liveSyncState()).toEqual({ state: "stopped" });
  });

  it("subscribes without restarting an owned socket and clears credentials only for auth", async () => {
    class SessionClient implements CollaborationCanvasLiveSyncClientPort {
      readonly projectId = "project-1";
      revision = 0;
      status: CanvasLiveSyncStatus = { state: "stopped" };
      canvas: string | null = null;
      helloRevision: number | null = null;
      stopCalls = 0;
      starts: number[] = [];
      readonly listeners: CanvasLiveSyncHandlers[] = [];

      canvasCommandSession(): CanvasCommandSessionSnapshot {
        return {
          canvasId: "remote-first",
          revision: this.revision,
          contentDigest: null,
          lastOperationId: null,
          lastJournalEntryId: null,
          pendingOperationId: null,
          lastConflict: null,
          lastRejectCode: null
        };
      }

      liveSyncCanvas(): string | null {
        return this.canvas;
      }

      liveSyncHelloRevision(): number | null {
        return this.helloRevision;
      }

      liveSyncState(): CanvasLiveSyncStatus {
        return this.status;
      }

      subscribeLiveSync(handlers: CanvasLiveSyncHandlers): () => void {
        this.listeners.push(handlers);
        return () => {
          const index = this.listeners.indexOf(handlers);
          if (index >= 0) this.listeners.splice(index, 1);
        };
      }

      startLiveSync(
        _canvasId: string,
        lastRevision: number,
        _handlers?: CanvasLiveSyncHandlers
      ): void {
        this.canvas = "remote-first";
        this.helloRevision = lastRevision;
        this.status = { state: "connecting", canvasId: "remote-first", attempt: 1 };
        this.starts.push(lastRevision);
      }

      stopLiveSync(): void {
        this.stopCalls += 1;
        this.canvas = null;
        this.helloRevision = null;
        this.status = { state: "stopped" };
      }
    }

    const client = new SessionClient();
    const cleared: string[] = [];
    const session = new CollaborationCanvasLiveSyncSession({
      getClient: () => client,
      getClientProfileId: () => "profile-1",
      resolveCanvasBinding: async ({ localProjectId, canvasId }) => ({
        kind: "local" as const,
        localProjectId,
        canvasId,
        remoteProjectId: "project-1",
        remoteCanvasId: "remote-first"
      }),
      publishCanvasLiveSyncSignal: () => undefined,
      clearDeviceCredential: async (profileId) => {
        cleared.push(profileId);
      },
      publishStatus: async () => undefined
    });

    // First open establishes the socket once.
    await session.start({ kind: "local", localProjectId: "local-project", canvasId: "first" });
    expect(client.starts).toEqual([0]);
    expect(client.listeners).toHaveLength(1);

    // Re-start while already connected only re-subscribes — never restarts or stops the owner socket.
    await session.start({ kind: "local", localProjectId: "local-project", canvasId: "first" });
    expect(client.starts).toEqual([0]);
    expect(client.stopCalls).toBe(0);
    expect(client.listeners).toHaveLength(1);

    client.revision = 1;
    await session.start({ kind: "local", localProjectId: "local-project", canvasId: "first" });
    // Revision advances are owned by the command facade; session stays subscribe-only.
    expect(client.starts).toEqual([0]);
    expect(client.stopCalls).toBe(0);

    const currentHandlers = client.listeners.at(-1);
    currentHandlers?.onStatus?.({
      state: "access_denied",
      canvasId: "remote-first",
      code: "forbidden"
    });
    expect(cleared).toEqual([]);

    currentHandlers?.onStatus?.({
      state: "auth_expired",
      canvasId: "remote-first",
      code: "unauthorized"
    });
    await flush();
    expect(cleared).toEqual(["profile-1"]);
    // Session must not tear down the shared socket on auth signal.
    expect(client.stopCalls).toBe(0);
  });
});
