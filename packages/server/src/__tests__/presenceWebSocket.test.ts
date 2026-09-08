import { createServer, type Server as HttpServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { parseServerConfig } from "../config.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { seedOperatorSessions } from "./support/operatorAuthFixture.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../serverComposition.js";

const directories: string[] = [];
const servers: HttpServer[] = [];
const compositions: DistributedServerComposition[] = [];
const sockets: WebSocket[] = [];
const AUTHORITATIVE_CANVAS_FIELDS = ["content", "snapshot", "layout", "prompt"];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  }
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup() {
  const workspace = await createTestWorkspace(basicManifest());
  directories.push(workspace.home, workspace.root);
  const httpServer = createServer();
  servers.push(httpServer);
  const operatorToken = `pw_operator_${"P".repeat(43)}`;
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7_443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    dataDirectory: join(workspace.root, "server-data"),
    trustedProjects: [
      {
        workspaceId: "presence-workspace",
        projectId: workspace.init.workspace.id,
        canvasId: "default",
        projectRoot: workspace.root
      }
    ],
    operatorCredentials: [
      {
        operatorId: "presence-test-admin",
        tokenSha256: hashOperatorToken(operatorToken),
        projectIds: [],
        serverAdmin: true
      }
    ]
  });
  const composition = await createDistributedServerComposition({
    httpServer,
    config
  });
  compositions.push(composition);
  await seedOperatorSessions(config.databasePath, config.operatorCredentials);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    wsOrigin: `ws://127.0.0.1:${address.port}`,
    projectId: workspace.init.workspace.id
  };
}

async function bootstrap(origin: string, projectId: string) {
  const response = await fetch(`${origin}/api/v1/projects/${projectId}/human/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Presence Owner", humanPrincipalId: "presence-owner" })
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { deviceToken: string; device: { deviceCredentialId: string } };
}

async function inviteMember(origin: string, projectId: string, ownerDeviceToken: string) {
  const invitationResponse = await fetch(
    `${origin}/api/v1/projects/${projectId}/human/invitations`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${ownerDeviceToken}`
      },
      body: JSON.stringify({})
    }
  );
  expect(invitationResponse.status).toBe(201);
  const invitation = (await invitationResponse.json()) as { invitationToken: string };
  const consumeResponse = await fetch(
    `${origin}/api/v1/projects/${projectId}/human/invitations/consume`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invitationToken: invitation.invitationToken,
        displayName: "Presence Member"
      })
    }
  );
  const body = await consumeResponse.text();
  expect(consumeResponse.status, body).toBe(201);
  return JSON.parse(body) as { deviceToken: string };
}

async function connect(url: string, token: string, diagnostics = false): Promise<WebSocket> {
  const socket = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(diagnostics ? { "x-planweave-presence-diagnostics": "1" } : {})
    }
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("presence_message_timeout")), 3_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

function recordFrom(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected presence record");
  }
  return value as Record<string, unknown>;
}

function sessionIdFrom(message: Record<string, unknown>): string {
  const sessionId = recordFrom(recordFrom(message.session).identity).sessionId;
  if (typeof sessionId !== "string") throw new Error("Expected presence session id");
  return sessionId;
}

function expectNoAuthoritativeCanvasFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) expectNoAuthoritativeCanvasFields(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    expect(AUTHORITATIVE_CANVAS_FIELDS).not.toContain(key);
    expectNoAuthoritativeCanvasFields(nested);
  }
}

function hello(socket: WebSocket, projectId: string): void {
  socket.send(
    JSON.stringify({
      type: "canvas.presence.hello",
      protocolVersion: 1,
      projectId,
      canvasId: "default"
    })
  );
}

describe("canvas presence WebSocket", () => {
  it("negotiates trace timing without adding fields to legacy receivers", async () => {
    const fixture = await setup();
    const owner = await bootstrap(fixture.origin, fixture.projectId);
    const url = `${fixture.wsOrigin}/api/v1/projects/${fixture.projectId}/canvases/default/human/presence`;
    const sender = await connect(url, owner.deviceToken, true);
    const receiver = await connect(url, owner.deviceToken, true);
    const legacy = await connect(url, owner.deviceToken);
    for (const socket of [sender, receiver, legacy]) {
      const pending = nextMessage(socket);
      hello(socket, fixture.projectId);
      const snapshot = await pending;
      if (socket === legacy) expect(snapshot).not.toHaveProperty("diagnosticsVersion");
      else expect(snapshot.diagnosticsVersion).toBe(1);
    }
    const trace = { streamId: "12345678-1234-4234-8234-123456789012", sequence: 7 };
    const received = nextMessage(receiver);
    const receivedLegacy = nextMessage(legacy);
    const update = {
      type: "canvas.presence.update",
      protocolVersion: 1,
      projectId: fixture.projectId,
      canvasId: "default",
      pointer: { x: 1, y: 2 },
      selectionIds: []
    };
    sender.send(JSON.stringify({ ...update, trace }));
    const body = await received;
    const timing = recordFrom(body.trace);
    expect(timing).toMatchObject(trace);
    expect(timing.serverClockId).toEqual(expect.any(String));
    expect(typeof timing.serverReceivedMs).toBe("number");
    expect(Number(timing.serverForwardedMs)).toBeGreaterThanOrEqual(
      Number(timing.serverReceivedMs)
    );
    expect(await receivedLegacy).not.toHaveProperty("trace");
    const ordinary = nextMessage(receiver);
    sender.send(JSON.stringify(update));
    expect(await ordinary).not.toHaveProperty("trace");
  });

  it("keeps two members mutually visible through disconnects and same-device reconnects", async () => {
    const fixture = await setup();
    const owner = await bootstrap(fixture.origin, fixture.projectId);
    const member = await inviteMember(fixture.origin, fixture.projectId, owner.deviceToken);
    const url = `${fixture.wsOrigin}/api/v1/projects/${fixture.projectId}/canvases/default/human/presence`;
    const ownerSocket = await connect(url, owner.deviceToken);
    const memberSocket = await connect(url, member.deviceToken);

    const ownerSnapshot = nextMessage(ownerSocket);
    hello(ownerSocket, fixture.projectId);
    const ownerSnapshotBody = await ownerSnapshot;
    expect(ownerSnapshotBody).toMatchObject({
      type: "canvas.presence.snapshot",
      sessions: []
    });
    expectNoAuthoritativeCanvasFields(ownerSnapshotBody);

    const memberSnapshot = nextMessage(memberSocket);
    hello(memberSocket, fixture.projectId);
    const memberSnapshotBody = await memberSnapshot;
    expect(memberSnapshotBody).toMatchObject({
      type: "canvas.presence.snapshot",
      sessions: [
        {
          pointer: null,
          selectionIds: []
        }
      ]
    });
    expectNoAuthoritativeCanvasFields(memberSnapshotBody);

    const memberUpdateOnOwner = nextMessage(ownerSocket);
    memberSocket.send(
      JSON.stringify({
        type: "canvas.presence.update",
        protocolVersion: 1,
        projectId: fixture.projectId,
        canvasId: "default",
        pointer: { x: 20, y: 30 },
        selectionIds: ["T-001"]
      })
    );
    const memberUpdateBody = await memberUpdateOnOwner;
    expect(memberUpdateBody).toMatchObject({
      type: "canvas.presence.update",
      session: { pointer: { x: 20, y: 30 }, selectionIds: ["T-001"] }
    });
    expectNoAuthoritativeCanvasFields(memberUpdateBody);
    const firstMemberSessionId = sessionIdFrom(memberUpdateBody);

    const ownerUpdateOnMember = nextMessage(memberSocket);
    ownerSocket.send(
      JSON.stringify({
        type: "canvas.presence.update",
        protocolVersion: 1,
        projectId: fixture.projectId,
        canvasId: "default",
        pointer: { x: 40, y: 50 },
        selectionIds: ["T-002"]
      })
    );
    const ownerUpdateBody = await ownerUpdateOnMember;
    expect(ownerUpdateBody).toMatchObject({
      type: "canvas.presence.update",
      session: { pointer: { x: 40, y: 50 }, selectionIds: ["T-002"] }
    });
    expectNoAuthoritativeCanvasFields(ownerUpdateBody);

    const normalLeave = nextMessage(ownerSocket);
    const normalMemberClose = waitForClose(memberSocket);
    memberSocket.close(1000, "presence normal disconnect");
    await expect(normalLeave).resolves.toMatchObject({
      type: "canvas.presence.leave",
      sessionId: firstMemberSessionId
    });
    await expect(normalMemberClose).resolves.toBe(1000);

    const reconnectedMemberSocket = await connect(url, member.deviceToken);
    const reconnectSnapshot = nextMessage(reconnectedMemberSocket);
    hello(reconnectedMemberSocket, fixture.projectId);
    const reconnectSnapshotBody = await reconnectSnapshot;
    expect(reconnectSnapshotBody).toMatchObject({
      type: "canvas.presence.snapshot",
      sessions: [
        {
          pointer: { x: 40, y: 50 },
          selectionIds: ["T-002"]
        }
      ]
    });
    expectNoAuthoritativeCanvasFields(reconnectSnapshotBody);

    const reconnectedMemberUpdateOnOwner = nextMessage(ownerSocket);
    reconnectedMemberSocket.send(
      JSON.stringify({
        type: "canvas.presence.update",
        protocolVersion: 1,
        projectId: fixture.projectId,
        canvasId: "default",
        pointer: { x: 60, y: 70 },
        selectionIds: ["T-003"]
      })
    );
    const reconnectedMemberUpdateBody = await reconnectedMemberUpdateOnOwner;
    expect(reconnectedMemberUpdateBody).toMatchObject({
      type: "canvas.presence.update",
      session: { pointer: { x: 60, y: 70 }, selectionIds: ["T-003"] }
    });
    expect(sessionIdFrom(reconnectedMemberUpdateBody)).not.toBe(firstMemberSessionId);
    expectNoAuthoritativeCanvasFields(reconnectedMemberUpdateBody);

    const abnormalLeave = nextMessage(ownerSocket);
    const abnormalMemberClose = waitForClose(reconnectedMemberSocket);
    reconnectedMemberSocket.terminate();
    await expect(abnormalLeave).resolves.toMatchObject({
      type: "canvas.presence.leave",
      sessionId: sessionIdFrom(reconnectedMemberUpdateBody)
    });
    await abnormalMemberClose;

    const ownerClose = waitForClose(ownerSocket);
    ownerSocket.close(1000, "presence final close");
    await expect(ownerClose).resolves.toBe(1000);

    const verifierSocket = await connect(url, owner.deviceToken);
    const verifierSnapshot = nextMessage(verifierSocket);
    hello(verifierSocket, fixture.projectId);
    const verifierSnapshotBody = await verifierSnapshot;
    expect(verifierSnapshotBody).toMatchObject({
      type: "canvas.presence.snapshot",
      sessions: []
    });
    expectNoAuthoritativeCanvasFields(verifierSnapshotBody);
    verifierSocket.close(1000, "presence cleanup verification complete");
  });

  it("rejects unknown canvas and non-human credentials before upgrade", async () => {
    const fixture = await setup();
    const owner = await bootstrap(fixture.origin, fixture.projectId);
    const unknownCanvas = new WebSocket(
      `${fixture.wsOrigin}/api/v1/projects/${fixture.projectId}/canvases/other/human/presence`,
      { headers: { Authorization: `Bearer ${owner.deviceToken}` } }
    );
    const unknownStatus = await new Promise<number>((resolve) => {
      unknownCanvas.once("unexpected-response", (_request, response) =>
        resolve(response.statusCode)
      );
    });
    expect(unknownStatus).toBe(403);
    const unauthorized = new WebSocket(
      `${fixture.wsOrigin}/api/v1/projects/${fixture.projectId}/canvases/default/human/presence`,
      { headers: { Authorization: "Bearer operator-token-not-human" } }
    );
    const unauthorizedStatus = await new Promise<number>((resolve) => {
      unauthorized.once("unexpected-response", (_request, response) =>
        resolve(response.statusCode)
      );
    });
    expect(unauthorizedStatus).toBe(401);
  });

  it("removes a revoked device session and broadcasts leave to the still-authorized peer", async () => {
    const fixture = await setup();
    const owner = await bootstrap(fixture.origin, fixture.projectId);
    const invitationResponse = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/human/invitations`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${owner.deviceToken}`
        },
        body: JSON.stringify({})
      }
    );
    expect(invitationResponse.status).toBe(201);
    const invitation = (await invitationResponse.json()) as { invitationToken: string };
    const consumeResponse = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/human/invitations/consume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          invitationToken: invitation.invitationToken,
          displayName: "Presence Member"
        })
      }
    );
    const consumeBody = await consumeResponse.text();
    expect(consumeResponse.status, consumeBody).toBe(201);
    const secondDevice = JSON.parse(consumeBody) as { deviceToken: string };

    const url = `${fixture.wsOrigin}/api/v1/projects/${fixture.projectId}/canvases/default/human/presence`;
    const revokedSocket = await connect(url, owner.deviceToken);
    const peerSocket = await connect(url, secondDevice.deviceToken);
    const revokedClose = new Promise<number>((resolve) =>
      revokedSocket.once("close", (code) => resolve(code))
    );
    hello(revokedSocket, fixture.projectId);
    await nextMessage(revokedSocket);
    hello(peerSocket, fixture.projectId);
    await nextMessage(peerSocket);
    const revokedError = nextMessage(revokedSocket);
    const peerLeave = nextMessage(peerSocket);

    const revokeResponse = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/human/devices/${owner.device.deviceCredentialId}/revoke`,
      { method: "POST", headers: { Authorization: `Bearer ${owner.deviceToken}` } }
    );
    expect(revokeResponse.status).toBe(200);
    await expect(revokedError).resolves.toMatchObject({
      type: "canvas.presence.error",
      code: "unauthorized"
    });
    await expect(peerLeave).resolves.toMatchObject({
      type: "canvas.presence.leave"
    });
    await expect(revokedClose).resolves.toBe(4001);
  });

  it("returns bounded protocol errors for malformed frames and closes the session", async () => {
    const fixture = await setup();
    const owner = await bootstrap(fixture.origin, fixture.projectId);
    const url = `${fixture.wsOrigin}/api/v1/projects/${fixture.projectId}/canvases/default/human/presence`;
    const socket = await connect(url, owner.deviceToken);
    hello(socket, fixture.projectId);
    await nextMessage(socket);
    const error = nextMessage(socket);
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    socket.send("not-json");
    await expect(error).resolves.toMatchObject({
      type: "canvas.presence.error",
      code: "invalid_message"
    });
    await expect(closed).resolves.toBe(4000);
  });
});
