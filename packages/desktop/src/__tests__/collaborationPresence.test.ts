import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { deploymentEndpointSchema } from "@planweave-ai/collaboration-protocol/connection";
import { CANVAS_PRESENCE_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import { exampleHumanDeviceToken } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import {
  CollaborationClient,
  CollaborationCredentialVault,
  CollaborationProfileStore,
  CollaborationService,
  type CollaborationPresenceHandlers
} from "../main/collaboration/index.js";
import type { CollaborationPresenceSignal } from "../shared/collaboration.js";

type Fixture = { server: Server; close(): Promise<void>; origin: string };

function loopbackEndpoint(serverOrigin: string) {
  return deploymentEndpointSchema.parse({
    topology: "loopback_http",
    serverOrigin,
    allowedClientOrigins: [serverOrigin],
    tlsTrust: "not_applicable"
  });
}

const publicEndpoint = deploymentEndpointSchema.parse({
  topology: "public_https",
  serverOrigin: "https://collab.example.com/",
  allowedClientOrigins: ["https://collab.example.com/"],
  tlsTrust: "system_ca"
});

async function fixture(): Promise<Fixture> {
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    origin: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

describe("desktop canvas presence transport", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it("uses the canonical scoped socket, sends bounded updates, and refreshes on reconnect", async () => {
    const http = await fixture();
    cleanups.push(http.close);
    const wss = new WebSocketServer({ noServer: true });
    cleanups.push(
      () =>
        new Promise((resolve, reject) => wss.close((error) => (error ? reject(error) : resolve())))
    );
    let connections = 0;
    const hellos: Array<Record<string, unknown>> = [];
    const updates: Array<Record<string, unknown>> = [];
    http.server.on("upgrade", (request, socket, head) => {
      expect(request.url).toBe("/api/v1/projects/project-demo-001/canvases/default/human/presence");
      expect(request.headers.authorization).toBe(`Bearer ${exampleHumanDeviceToken}`);
      expect(request.headers.origin).toBe(new URL(http.origin).origin);
      wss.handleUpgrade(request, socket, head, (ws) => {
        connections += 1;
        ws.on("message", (raw) => {
          const message = JSON.parse(String(raw)) as Record<string, unknown>;
          if (message.type === "canvas.presence.hello") {
            hellos.push(message);
            ws.send(
              JSON.stringify({
                type: "canvas.presence.snapshot",
                protocolVersion: CANVAS_PRESENCE_PROTOCOL_VERSION,
                projectId: "project-demo-001",
                canvasId: "default",
                sessions: []
              })
            );
            if (connections === 1) setTimeout(() => ws.close(4000, "test reconnect"), 10);
          } else {
            updates.push(message);
          }
        });
      });
    });

    const snapshots: number[] = [];
    const statuses: string[] = [];
    const client = new CollaborationClient({
      profile: {
        profileId: "profile-test",
        displayName: "Test",
        serverBaseUrl: http.origin,
        projectId: "project-demo-001",
        allowInsecureTransport: true,
        endpoint: loopbackEndpoint(http.origin)
      },
      credential: { getDeviceToken: () => exampleHumanDeviceToken },
      WebSocketImpl: WebSocket as never,
      random: () => 0,
      limits: { reconnectInitialDelayMs: 5, reconnectMaxDelayMs: 10 }
    });
    cleanups.push(async () => client.dispose());

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("presence timeout")), 2_000);
      client.startPresence("default", {
        onSnapshot: () => {
          snapshots.push(connections);
          if (snapshots.length === 1) {
            client.publishPresence({ pointer: { x: 4.5, y: -2 }, selectionIds: ["T-1"] });
          }
          if (snapshots.length === 2) {
            clearTimeout(timer);
            resolve();
          }
        },
        onStatus: (status) => statuses.push(status.state)
      });
    });

    expect(hellos).toHaveLength(2);
    expect(hellos[0]).not.toHaveProperty("lastCursor");
    expect(updates).toEqual([
      expect.objectContaining({
        type: "canvas.presence.update",
        projectId: "project-demo-001",
        canvasId: "default",
        pointer: { x: 4.5, y: -2 },
        selectionIds: ["T-1"]
      })
    ]);
    expect(statuses).toContain("reconnecting");
    client.stopPresence();
    expect(client.presenceCanvas()).toBeNull();
  });

  it("drops a stale credential callback after scope teardown", async () => {
    let release!: (value: string | undefined) => void;
    const credential = new Promise<string | undefined>((resolve) => {
      release = resolve;
    });
    let constructed = 0;
    class FakeSocket {
      readonly readyState = 0;
      constructor() {
        constructed += 1;
      }
      send(): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    const client = new CollaborationClient({
      profile: {
        profileId: "profile-test",
        displayName: "Test",
        serverBaseUrl: "https://collab.example.com/",
        projectId: "project-demo-001",
        allowInsecureTransport: false,
        endpoint: publicEndpoint
      },
      credential: { getDeviceToken: () => credential },
      WebSocketImpl: FakeSocket as never
    });
    client.startPresence("default");
    client.stopPresence();
    release(exampleHumanDeviceToken);
    await Promise.resolve();
    await Promise.resolve();
    expect(constructed).toBe(0);
    client.dispose();
  });

  it("binds service presence to the active profile and clears it on scope teardown", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-presence-service-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const safeStorage = {
      isEncryptionAvailable: () => false,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString()
    };
    const startPresence = [] as string[];
    const stopPresence = [] as number[];
    let activeHandlers: CollaborationPresenceHandlers | undefined;
    const presenceSignals: CollaborationPresenceSignal[] = [];
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage
      }),
      onPresenceSignal: (signal) => presenceSignals.push(signal),
      createClient: () =>
        ({
          verifyAccess: vi.fn().mockResolvedValue(undefined),
          projectId: "project-demo-001",
          presenceCanvas: () => startPresence.at(-1) ?? null,
          startObserver: vi.fn(),
          stopObserver: vi.fn(),
          startPresence: (canvasId: string, handlers: typeof activeHandlers) => {
            startPresence.push(canvasId);
            activeHandlers = handlers;
          },
          stopPresence: () => stopPresence.push(1),
          publishPresence: vi.fn(),
          dispose: vi.fn(),
          lastObserverCursor: () => 0,
          bootstrapOwner: vi.fn(),
          consumeInvitation: vi.fn()
        }) as never
    });
    await service.upsertProfile({
      profileId: "profile-test",
      displayName: "Test",
      serverBaseUrl: "https://collab.example.com/",
      projectId: "project-demo-001",
      allowInsecureTransport: false,
      endpoint: publicEndpoint
    });
    await service.importDeviceCredential({
      profileId: "profile-test",
      deviceToken: exampleHumanDeviceToken
    });
    await service.connectSession({ profileId: "profile-test" });
    await service.startPresence({ canvasId: "default" });
    expect(startPresence).toEqual(["default"]);
    activeHandlers?.onSnapshot?.({
      type: "canvas.presence.snapshot",
      protocolVersion: CANVAS_PRESENCE_PROTOCOL_VERSION,
      projectId: "project-demo-001",
      canvasId: "default",
      sessions: []
    });
    activeHandlers?.onStatus?.({
      state: "reconnecting",
      canvasId: "default",
      attempt: 1,
      delayMs: 10
    });
    expect(presenceSignals.at(-1)).toEqual({
      profileId: "profile-test",
      reset: { canvasId: "default", reason: "disconnected" }
    });
    activeHandlers?.onStatus?.({
      state: "error",
      canvasId: "default",
      code: "rate_limited"
    });
    expect((await service.getStatus()).session).toMatchObject({
      phase: "connected",
      lastErrorCode: null,
      lastErrorMessage: null
    });
    await service.stopPresence();
    expect(stopPresence).toHaveLength(1);
    await service.disconnectSession();
    expect(stopPresence).toHaveLength(2);
    await service.shutdown();
  });

  it("forwards reconnect snapshots without main-process re-publish (renderer owns replay)", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-presence-no-main-replay-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const safeStorage = {
      isEncryptionAvailable: () => false,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString()
    };
    const published: Array<{ pointer: { x: number; y: number } | null; selectionIds: string[] }> =
      [];
    let activeHandlers: CollaborationPresenceHandlers | undefined;
    const presenceSignals: CollaborationPresenceSignal[] = [];
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage
      }),
      onPresenceSignal: (signal) => presenceSignals.push(signal),
      createClient: () =>
        ({
          verifyAccess: vi.fn().mockResolvedValue(undefined),
          projectId: "project-demo-001",
          presenceCanvas: () => "default",
          startObserver: vi.fn(),
          stopObserver: vi.fn(),
          startPresence: (_canvasId: string, handlers: typeof activeHandlers) => {
            activeHandlers = handlers;
          },
          stopPresence: vi.fn(),
          publishPresence: (input: {
            pointer: { x: number; y: number } | null;
            selectionIds: string[];
          }) => {
            published.push(input);
          },
          dispose: vi.fn(),
          lastObserverCursor: () => 0,
          bootstrapOwner: vi.fn(),
          consumeInvitation: vi.fn()
        }) as never
    });
    await service.upsertProfile({
      profileId: "profile-test",
      displayName: "Test",
      serverBaseUrl: "https://collab.example.com/",
      projectId: "project-demo-001",
      allowInsecureTransport: false,
      endpoint: publicEndpoint
    });
    await service.importDeviceCredential({
      profileId: "profile-test",
      deviceToken: exampleHumanDeviceToken
    });
    await service.connectSession({ profileId: "profile-test" });
    await service.startPresence({ canvasId: "default" });
    activeHandlers?.onSnapshot?.({
      type: "canvas.presence.snapshot",
      protocolVersion: CANVAS_PRESENCE_PROTOCOL_VERSION,
      projectId: "project-demo-001",
      canvasId: "default",
      sessions: []
    });
    await service.publishPresence({ pointer: { x: 3, y: 4 }, selectionIds: ["T-1"] });
    expect(published).toEqual([{ pointer: { x: 3, y: 4 }, selectionIds: ["T-1"] }]);

    activeHandlers?.onStatus?.({
      state: "reconnecting",
      canvasId: "default",
      attempt: 1,
      delayMs: 5
    });
    activeHandlers?.onSnapshot?.({
      type: "canvas.presence.snapshot",
      protocolVersion: CANVAS_PRESENCE_PROTOCOL_VERSION,
      projectId: "project-demo-001",
      canvasId: "default",
      sessions: []
    });
    // Main only forwards the snapshot signal; it must not auto re-send lastUpdate.
    expect(published).toEqual([{ pointer: { x: 3, y: 4 }, selectionIds: ["T-1"] }]);
    expect(presenceSignals.at(-1)).toEqual({
      profileId: "profile-test",
      message: expect.objectContaining({ type: "canvas.presence.snapshot" })
    });
    await service.shutdown();
  });
});
