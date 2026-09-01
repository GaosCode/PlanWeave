import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupProxyHarness,
  nextProxyMessage as nextMessage,
  nextProxyMessages as nextMessages,
  openProxyWebSocket as openWebSocket,
  proxyAdminToken as adminToken,
  proxyAdvertisedOrigin as advertisedOrigin,
  proxyRequestStatus as requestStatus,
  proxyWebSocketStatus as webSocketStatus,
  setupProxyHarness as setupProxy,
  waitForProxyClose as waitForClose
} from "./support/tailscaleProxyHarness.js";

afterEach(async () => {
  await cleanupProxyHarness();
});

describe("Tailscale HTTPS proxy transport", () => {
  it("preserves HTTP authorization and rejects forwarded-header privilege forgery", async () => {
    const fixture = await setupProxy();
    await expect(
      requestStatus({
        ...fixture,
        path: "/api/v1/hosts?limit=1",
        headers: { Authorization: `Bearer ${adminToken}` }
      })
    ).resolves.toBe(200);
    await expect(
      requestStatus({
        ...fixture,
        path: "/api/v1/hosts?limit=1",
        headers: {
          "x-forwarded-for": "127.0.0.1",
          "x-forwarded-proto": "https",
          "x-forwarded-authorization": `Bearer ${adminToken}`
        }
      })
    ).resolves.toBe(401);
    await expect(
      requestStatus({
        ...fixture,
        path: `/api/v1/projects/${fixture.projectId}/human/bootstrap`,
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
        body: JSON.stringify({ displayName: "Proxy user", deviceLabel: "Proxy device" })
      })
    ).resolves.toBe(403);
    await expect(
      requestStatus({
        ...fixture,
        path: `/api/v1/projects/${fixture.projectId}/human/invitations`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${fixture.ownerToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ displayName: "x".repeat(20_000) })
      })
    ).resolves.toBe(413);
  });

  it("forwards all five WebSocket upgrades without weakening Origin or auth", async () => {
    const fixture = await setupProxy();
    const humanPaths = [
      `/api/v1/projects/${fixture.projectId}/canvases/default/human/presence`,
      `/api/v1/projects/${fixture.projectId}/canvases/default/human/live`,
      `/api/v1/projects/${fixture.projectId}/human/observe`,
      `/api/v1/projects/${fixture.projectId}/canvases/default/human/commands`
    ];
    for (const path of humanPaths) {
      const status = await webSocketStatus({
        url: `${fixture.wsOrigin}${path}`,
        certificate: fixture.certificate,
        origin: advertisedOrigin
      });
      expect(status).toBe(401);
      const rejectedOriginStatus = await webSocketStatus({
        url: `${fixture.wsOrigin}${path}`,
        certificate: fixture.certificate,
        origin: "https://forged.example.test",
        token: fixture.ownerToken
      });
      expect(rejectedOriginStatus).toBe(403);
    }
    const hostStatus = await webSocketStatus({
      url: `${fixture.wsOrigin}/agent-hosts/missing-host/connect?workspaceId=${fixture.workspaceId}`,
      certificate: fixture.certificate
    });
    expect(hostStatus).toBe(401);
    await expect(
      webSocketStatus({
        url: `${fixture.wsOrigin}/agent-hosts/missing-host/connect?workspaceId=${fixture.workspaceId}`,
        certificate: fixture.certificate,
        origin: advertisedOrigin
      })
    ).resolves.toBe(403);

    const host = await openWebSocket({
      url: `${fixture.wsOrigin}/agent-hosts/${fixture.hostId}/connect?workspaceId=${fixture.workspaceId}`,
      certificate: fixture.certificate,
      token: fixture.hostToken
    });
    const hostWelcome = nextMessage(host);
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
    const heartbeatAcknowledgement = nextMessage(host);
    host.send(
      JSON.stringify({
        type: "host.heartbeat",
        protocolVersion: 1,
        messageId: "proxy-heartbeat-1",
        activeLeases: []
      })
    );
    await expect(heartbeatAcknowledgement).resolves.toEqual({
      type: "host.event_ack",
      protocolVersion: 1,
      messageId: "proxy-heartbeat-1"
    });

    const presenceUrl = `${fixture.wsOrigin}${humanPaths[0]}`;
    const ownerPresence = await openWebSocket({
      url: presenceUrl,
      certificate: fixture.certificate,
      token: fixture.ownerToken,
      origin: advertisedOrigin
    });
    const memberPresence = await openWebSocket({
      url: presenceUrl,
      certificate: fixture.certificate,
      token: fixture.memberToken,
      origin: advertisedOrigin
    });
    const ownerSnapshot = nextMessage(ownerPresence);
    ownerPresence.send(
      JSON.stringify({
        type: "canvas.presence.hello",
        protocolVersion: 1,
        projectId: fixture.projectId,
        canvasId: "default"
      })
    );
    await expect(ownerSnapshot).resolves.toMatchObject({
      type: "canvas.presence.snapshot",
      sessions: []
    });
    const memberSnapshot = nextMessage(memberPresence);
    memberPresence.send(
      JSON.stringify({
        type: "canvas.presence.hello",
        protocolVersion: 1,
        projectId: fixture.projectId,
        canvasId: "default"
      })
    );
    await expect(memberSnapshot).resolves.toMatchObject({
      type: "canvas.presence.snapshot",
      sessions: [expect.objectContaining({ pointer: null })]
    });
    const presenceUpdate = nextMessage(ownerPresence);
    memberPresence.send(
      JSON.stringify({
        type: "canvas.presence.update",
        protocolVersion: 1,
        projectId: fixture.projectId,
        canvasId: "default",
        pointer: { x: 20, y: 30 },
        selectionIds: ["T-001"]
      })
    );
    await expect(presenceUpdate).resolves.toMatchObject({
      type: "canvas.presence.update",
      session: { pointer: { x: 20, y: 30 }, selectionIds: ["T-001"] }
    });

    const live = await openWebSocket({
      url: `${fixture.wsOrigin}${humanPaths[1]}`,
      certificate: fixture.certificate,
      token: fixture.ownerToken,
      origin: advertisedOrigin
    });
    const liveWelcome = nextMessage(live);
    live.send(
      JSON.stringify({
        type: "canvas.live.hello",
        protocolVersion: 1,
        projectId: fixture.projectId,
        canvasId: "default",
        lastRevision: 0
      })
    );
    await expect(liveWelcome).resolves.toMatchObject({ type: "canvas.live.welcome" });

    const observer = await openWebSocket({
      url: `${fixture.wsOrigin}${humanPaths[2]}`,
      certificate: fixture.certificate,
      token: fixture.ownerToken,
      origin: advertisedOrigin
    });
    const observerWelcome = nextMessage(observer);
    observer.send(
      JSON.stringify({
        type: "human.observer.hello",
        protocolVersion: 1,
        projectId: fixture.projectId,
        lastCursor: 0
      })
    );
    await expect(observerWelcome).resolves.toMatchObject({ type: "human.observer.welcome" });

    const command = await openWebSocket({
      url: `${fixture.wsOrigin}${humanPaths[3]}`,
      certificate: fixture.certificate,
      token: fixture.ownerToken,
      origin: advertisedOrigin
    });
    const accepted = nextMessage(command);
    const liveEntry = nextMessage(live);
    const observerEvent = nextMessage(observer);
    command.send(
      JSON.stringify({
        type: "canvas.command.submit",
        protocolVersion: 1,
        schemaVersion: "canvas-command/v1",
        projectId: fixture.projectId,
        canvasId: "default",
        operationId: "proxy-command-1",
        expectedRevision: 0,
        intent: {
          kind: "update_task_prompt",
          taskId: "T-001",
          promptMarkdown: "# Through the TLS proxy"
        }
      })
    );
    await expect(accepted).resolves.toMatchObject({
      type: "canvas.command.accepted",
      revision: 1
    });
    await expect(liveEntry).resolves.toMatchObject({
      type: "canvas.live.accepted_entry",
      entry: { revision: 1, previousRevision: 0 }
    });
    await expect(observerEvent).resolves.toMatchObject({ type: "human.observer.event" });

    const memberLeave = nextMessage(ownerPresence);
    memberPresence.close();
    await expect(memberLeave).resolves.toMatchObject({ type: "canvas.presence.leave" });
    const reconnectedMember = await openWebSocket({
      url: presenceUrl,
      certificate: fixture.certificate,
      token: fixture.memberToken,
      origin: advertisedOrigin
    });
    const recoveredPresence = nextMessage(reconnectedMember);
    reconnectedMember.send(
      JSON.stringify({
        type: "canvas.presence.hello",
        protocolVersion: 1,
        projectId: fixture.projectId,
        canvasId: "default"
      })
    );
    await expect(recoveredPresence).resolves.toMatchObject({
      type: "canvas.presence.snapshot",
      sessions: [expect.objectContaining({ pointer: null })]
    });

    live.close();
    const recoveredLive = await openWebSocket({
      url: `${fixture.wsOrigin}${humanPaths[1]}`,
      certificate: fixture.certificate,
      token: fixture.ownerToken,
      origin: advertisedOrigin
    });
    const recoveredLiveMessages = nextMessages(recoveredLive, 2);
    const catchupClose = waitForClose(recoveredLive);
    recoveredLive.send(
      JSON.stringify({
        type: "canvas.live.hello",
        protocolVersion: 1,
        projectId: fixture.projectId,
        canvasId: "default",
        lastRevision: 0
      })
    );
    await expect(recoveredLiveMessages).resolves.toEqual([
      expect.objectContaining({ type: "canvas.live.welcome" }),
      expect.objectContaining({ type: "canvas.live.catchup_required", headRevision: 1 })
    ]);
    await expect(catchupClose).resolves.toBe(4004);

    const oversized = await openWebSocket({
      url: `${fixture.wsOrigin}${humanPaths[3]}`,
      certificate: fixture.certificate,
      token: fixture.ownerToken,
      origin: advertisedOrigin
    });
    const oversizedClose = waitForClose(oversized);
    oversized.send(Buffer.alloc(300_000));
    await expect(oversizedClose).resolves.toBe(1009);
    expect(host.readyState).toBe(WebSocket.OPEN);
  });
});
