import type { CanvasCommandIntent } from "@planweave-ai/collaboration-protocol/canvas/commands";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import {
  WorkspaceCanvasPresenceController,
  type CanvasPresenceBridge
} from "../renderer/collaboration/WorkspaceCanvasPresenceController.js";
import type { CollaborationPresenceSignal } from "../shared/collaboration.js";
import {
  cleanupProxyHarness,
  createProxyDesktopTransports,
  nextProxyMessage,
  openProxyWebSocket,
  proxyAdvertisedOrigin,
  setupProxyHarness
} from "../../../server/src/__tests__/support/tailscaleProxyHarness.js";

const clients: CollaborationClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  await cleanupProxyHarness();
});

function waitFor(assertion: () => void, detail: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const poll = () => {
      try {
        assertion();
        resolve();
      } catch (error) {
        if (Date.now() >= deadline) {
          reject(new Error(`timeout:${detail}`, { cause: error }));
          return;
        }
        setTimeout(poll, 10);
      }
    };
    poll();
  });
}

function bridgeFor(client: CollaborationClient, profileId: string): CanvasPresenceBridge {
  let listener: ((signal: CollaborationPresenceSignal) => void) | null = null;
  return {
    startCollaborationPresence: ({ canvasId }) =>
      new Promise<void>((resolve, reject) => {
        client.startPresence(canvasId, {
          onSnapshot: (message) => {
            listener?.({ profileId, message });
            resolve();
          },
          onUpdate: (message) => listener?.({ profileId, message }),
          onLeave: (message) => listener?.({ profileId, message }),
          onError: (message) => {
            listener?.({ profileId, message });
            reject(new Error(`presence:${message.code}`));
          },
          onStatus: (status) => {
            if (status.state === "reconnecting") {
              listener?.({ profileId, reset: { canvasId, reason: "disconnected" } });
            }
          }
        });
      }),
    stopCollaborationPresence: async () => client.stopPresence(),
    publishCollaborationPresence: async (input) => client.publishPresence(input),
    onCollaborationPresenceSignal: (callback) => {
      listener = callback;
      return () => {
        if (listener === callback) listener = null;
      };
    }
  };
}

describe("Tailscale proxy with two Desktop clients", () => {
  it("keeps Presence, canvas live sync, compensation, and Agent Host online together", async () => {
    const fixture = await setupProxyHarness();
    const transports = createProxyDesktopTransports({
      proxyOrigin: fixture.origin,
      certificate: fixture.certificate
    });
    const createClient = (profileId: string, token: string) => {
      const client = new CollaborationClient({
        profile: {
          profileId,
          displayName: profileId,
          serverBaseUrl: `${proxyAdvertisedOrigin}/`,
          projectId: fixture.projectId,
          allowInsecureTransport: false,
          endpoint: {
            topology: "private_https",
            serverOrigin: `${proxyAdvertisedOrigin}/`,
            allowedClientOrigins: [`${proxyAdvertisedOrigin}/`],
            tlsTrust: "system_ca"
          }
        },
        credential: { getDeviceToken: () => token },
        request: transports.request,
        WebSocketImpl: transports.WebSocketImpl,
        random: () => 0,
        limits: {
          requestTimeoutMs: 5_000,
          jsonBodyMaxBytes: 256_000,
          reconnectInitialDelayMs: 20,
          reconnectMaxDelayMs: 40
        }
      });
      clients.push(client);
      return client;
    };
    const ownerClient = createClient("proxy-owner-desktop", fixture.ownerToken);
    const memberClient = createClient("proxy-member-desktop", fixture.memberToken);
    const ownerPresence = new WorkspaceCanvasPresenceController({
      api: bridgeFor(ownerClient, "proxy-owner-desktop"),
      labels: { error: (code) => `presence:${code}` }
    });
    const memberPresence = new WorkspaceCanvasPresenceController({
      api: bridgeFor(memberClient, "proxy-member-desktop"),
      labels: { error: (code) => `presence:${code}` }
    });
    const liveRevisions = { owner: [] as number[], member: [] as number[] };
    ownerClient.subscribeLiveSync({
      onMessage: (message) => {
        if (message.type !== "canvas.live.accepted_entry") return;
        liveRevisions.owner.push(message.entry.revision);
        ownerClient.acknowledgeLiveSyncRevision(message.entry.revision);
      }
    });
    memberClient.subscribeLiveSync({
      onMessage: (message) => {
        if (message.type !== "canvas.live.accepted_entry") return;
        liveRevisions.member.push(message.entry.revision);
        memberClient.acknowledgeLiveSyncRevision(message.entry.revision);
      }
    });

    const host = await openProxyWebSocket({
      url: `${fixture.wsOrigin}/agent-hosts/${fixture.hostId}/connect?workspaceId=${fixture.workspaceId}`,
      certificate: fixture.certificate,
      token: fixture.hostToken
    });
    const hostWelcome = nextProxyMessage(host);
    host.send(
      JSON.stringify({
        type: "host.hello",
        protocolVersion: 1,
        supportedExecutionEnvelopeVersions: [1, 2],
        lastAcknowledgedSequence: 0,
        capabilities: ["acp.codex"],
        capacity: 1,
        readiness: {
          workspaceMappings: [{ workspaceId: fixture.workspaceId, status: "ready" }],
          acpProfiles: []
        }
      })
    );
    await expect(hostWelcome).resolves.toMatchObject({ type: "host.welcome" });

    await ownerPresence.start({ profileId: "proxy-owner-desktop", canvasId: "default" });
    await memberPresence.start({ profileId: "proxy-member-desktop", canvasId: "default" });
    await memberPresence.publish({
      pointer: { x: 24, y: 36 },
      selectionIds: ["T-001"]
    });
    await waitFor(
      () =>
        expect(ownerPresence.getSnapshot().sessions).toEqual([
          expect.objectContaining({
            pointer: { x: 24, y: 36 },
            selectionIds: ["T-001"]
          })
        ]),
      "owner-observes-member-presence"
    );

    ownerClient.bindCanvasCommandSession("default");
    memberClient.bindCanvasCommandSession("default");
    ownerClient.startLiveSync("default", 0);
    memberClient.startLiveSync("default", 0);
    await waitFor(() => {
      expect(ownerClient.liveSyncState().state).toBe("connected");
      expect(memberClient.liveSyncState().state).toBe("connected");
    }, "both-live-sync-clients-connected");

    const firstIntent: CanvasCommandIntent = {
      kind: "update_layout",
      nodes: [{ nodeId: "T-001", x: 111, y: 222 }],
      updatedAt: "2026-08-04T00:00:00.000Z"
    };
    await expect(
      ownerClient.submitCanvasCommand({
        canvasId: "default",
        operationId: "proxy-desktop-command-1",
        expectedRevision: 0,
        intent: firstIntent
      })
    ).resolves.toMatchObject({ type: "canvas.command.accepted", revision: 1 });
    await waitFor(
      () => expect(liveRevisions.member).toContain(1),
      "member-receives-live-revision-1"
    );

    memberClient.stopLiveSync();
    const secondIntent: CanvasCommandIntent = {
      kind: "update_layout",
      nodes: [{ nodeId: "T-001", x: 333, y: 444 }],
      updatedAt: "2026-08-04T00:00:01.000Z"
    };
    await expect(
      ownerClient.submitCanvasCommand({
        canvasId: "default",
        operationId: "proxy-desktop-command-2",
        expectedRevision: 1,
        intent: secondIntent
      })
    ).resolves.toMatchObject({ type: "canvas.command.accepted", revision: 2 });
    await waitFor(() => expect(liveRevisions.owner).toContain(2), "owner-receives-live-revision-2");
    expect(liveRevisions.member).not.toContain(2);
    const compensation = await memberClient.reconnectCanvasCommands({
      canvasId: "default",
      afterRevision: 1
    });
    expect(compensation).toMatchObject({
      response: {
        type: "canvas.reconnect.delta",
        entries: [{ revision: 2, previousRevision: 1 }],
        headRevision: 2
      },
      entriesToApply: [{ revision: 2, previousRevision: 1 }],
      snapshotRequired: false
    });
    memberClient.startLiveSync("default", 2);
    await waitFor(() => {
      expect(memberClient.liveSyncState().state).toBe("connected");
    }, "member-recovers-delta-and-live-sync");
    const thirdIntent: CanvasCommandIntent = {
      kind: "update_layout",
      nodes: [{ nodeId: "T-001", x: 555, y: 666 }],
      updatedAt: "2026-08-04T00:00:02.000Z"
    };
    await expect(
      ownerClient.submitCanvasCommand({
        canvasId: "default",
        operationId: "proxy-desktop-command-3",
        expectedRevision: 2,
        intent: thirdIntent
      })
    ).resolves.toMatchObject({ type: "canvas.command.accepted", revision: 3 });
    await waitFor(
      () => expect(liveRevisions.member).toContain(3),
      "member-receives-live-revision-after-recovery"
    );
    expect(ownerPresence.getSnapshot().sessions).toEqual([
      expect.objectContaining({ pointer: { x: 24, y: 36 }, selectionIds: ["T-001"] })
    ]);

    const heartbeatAcknowledgement = nextProxyMessage(host);
    host.send(
      JSON.stringify({
        type: "host.heartbeat",
        protocolVersion: 1,
        messageId: "two-desktop-proxy-heartbeat",
        activeLeases: []
      })
    );
    await expect(heartbeatAcknowledgement).resolves.toEqual({
      type: "host.event_ack",
      protocolVersion: 1,
      messageId: "two-desktop-proxy-heartbeat"
    });
    expect(host.readyState).toBe(WebSocket.OPEN);

    await Promise.all([ownerPresence.stop(), memberPresence.stop()]);
  });
});
