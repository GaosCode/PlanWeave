import { createServer, type Server as HttpServer } from "node:http";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import { parseServerConfig } from "../config.js";
import { hashHumanToken } from "../identity/crypto.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { HumanObserverJournal } from "../humanObserverJournal.js";
import {
  attachHumanObserverWebSocketServer,
  type HumanObserverDeliveryLimits
} from "../humanObserverWs.js";
import { applyMigrations } from "../migrations.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { seedOperatorSessions } from "./support/operatorAuthFixture.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { WebSocketUpgradeRouter } from "../webSocketUpgradeRouter.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../serverComposition.js";
import { AuthorizationChangeSignal } from "../authorizationChangeSignal.js";

const directories: string[] = [];
const servers: HttpServer[] = [];
const compositions: DistributedServerComposition[] = [];
const databases: SqliteDatabase[] = [];
const observerServers: Array<{ close(): Promise<void> }> = [];
const standardDeliveryLimits: HumanObserverDeliveryLimits = {
  replay: { maxEvents: 10, maxBytes: 100_000 },
  replayBatchEvents: 1,
  maxBufferedBytes: 16_384,
  maxPendingBytes: 16_384,
  controlFrameReserveBytes: 1_024,
  sendTimeoutMs: 1_000,
  helloTimeoutMs: 10_000
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const composition of compositions.splice(0)) await composition.close();
  for (const observer of observerServers.splice(0)) await observer.close();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup(options: { allowedClientOrigins?: string[] } = {}) {
  const workspace = await createTestWorkspace(basicManifest());
  directories.push(workspace.home, workspace.root);
  const httpServer = createServer();
  servers.push(httpServer);
  const operatorToken = `pw_operator_${"O".repeat(43)}`;
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7_443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    ...(options.allowedClientOrigins
      ? {
          deployment: {
            topology: "loopback_http" as const,
            serverOrigin: "http://127.0.0.1:7443",
            allowedClientOrigins: options.allowedClientOrigins,
            tlsTrust: "not_applicable" as const
          }
        }
      : {}),
    dataDirectory: join(workspace.root, "server-data"),
    trustedProjects: [
      {
        workspaceId: "observer-workspace",
        projectId: workspace.init.workspace.id,
        canvasId: "default",
        projectRoot: workspace.root
      }
    ],
    operatorCredentials: [
      {
        operatorId: "observer-admin",
        tokenSha256: hashOperatorToken(operatorToken),
        projectIds: [],
        serverAdmin: true
      }
    ],
    limits: { eventRetentionMaxEvents: 3 }
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
    projectId: workspace.init.workspace.id,
    operatorToken,
    composition
  };
}

function seedWorkspaceObserverPrincipal(input: {
  database: SqliteDatabase;
  workspaceId: string;
  suffix: string;
}): string {
  const { database } = input;
  const principalId = `observer-principal-${input.suffix}`;
  const createdAt = new Date().toISOString();
  database
    .prepare(
      "INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES(?,?,?,?,NULL)"
    )
    .run(input.workspaceId, principalId, `Observer ${input.suffix}`, createdAt);
  database
    .prepare(
      "INSERT INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at) VALUES(?,?,?,?,1,?,?,NULL)"
    )
    .run(
      input.workspaceId,
      `observer-membership-${input.suffix}`,
      principalId,
      "owner",
      createdAt,
      createdAt
    );
  return principalId;
}

function seedWorkspaceObserverDevice(input: {
  database: SqliteDatabase;
  workspaceId: string;
  suffix: string;
}): { token: string; principalId: string } {
  const { database } = input;
  const now = new Date();
  const issuedAt = now.toISOString();
  const token = `pw_hdev_${input.suffix.repeat(43)}`;
  const principalId = seedWorkspaceObserverPrincipal(input);
  database
    .prepare(
      "INSERT INTO workspace_device_sessions(workspace_id,device_session_id,human_principal_id,credential_sha256,issued_at,expires_at,revoked_at,last_used_at) VALUES(?,?,?,?,?,?,NULL,NULL)"
    )
    .run(
      input.workspaceId,
      `observer-device-${input.suffix}`,
      principalId,
      hashHumanToken(token),
      issuedAt,
      new Date(now.getTime() + 60_000).toISOString()
    );
  return { token, principalId };
}

function jsonHeaders(token?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function bootstrap(origin: string, projectId: string, principalId: string) {
  const response = await fetch(`${origin}/api/v1/projects/${projectId}/human/bootstrap`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ displayName: principalId, humanPrincipalId: principalId })
  });
  const body = (await response.json()) as {
    deviceToken: string;
    device: { deviceCredentialId: string };
  };
  expect([200, 201]).toContain(response.status);
  return body;
}

async function createInvitation(origin: string, projectId: string, token: string) {
  const response = await fetch(`${origin}/api/v1/projects/${projectId}/human/invitations`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({})
  });
  const body = (await response.json()) as {
    invitationToken: string;
    invitation: { invitationId: string };
  };
  expect(response.status).toBe(201);
  return body;
}

async function consumeInvitation(
  origin: string,
  projectId: string,
  invitationToken: string,
  displayName: string
) {
  const response = await fetch(`${origin}/api/v1/projects/${projectId}/human/invitations/consume`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ invitationToken, displayName })
  });
  const body = (await response.json()) as { deviceToken: string };
  expect(response.status).toBe(201);
  return body;
}

async function connect(url: string, token: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function websocketUpgradeStatus(url: string, token: string): Promise<number> {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  return new Promise((resolve) => {
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode));
  });
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("observer_message_timeout")), 3_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

function nextMessages(socket: WebSocket, count: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const timer = setTimeout(() => reject(new Error("observer_messages_timeout")), 3_000);
    const onMessage = (data: RawData) => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
      if (messages.length === count) {
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(messages);
      }
    };
    socket.on("message", onMessage);
  });
}

function nextClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", resolve));
}

function sendHello(socket: WebSocket, projectId: string, lastCursor: number): void {
  socket.send(
    JSON.stringify({
      type: "human.observer.hello",
      protocolVersion: 1,
      projectId,
      lastCursor
    })
  );
}

async function setupDirectObserver(
  deliveryLimits: HumanObserverDeliveryLimits,
  authorizationSafetyCheckIntervalMs = 25
) {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  const workspaceId = "bounded-observer-workspace";
  const projectId = "bounded-observer-project";
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  workspaceIdentity.ensureConfiguredWorkspace(workspaceId);
  const device = seedWorkspaceObserverDevice({ database, workspaceId, suffix: "c" });
  const authorizationChanges = new AuthorizationChangeSignal();
  const projectAccess = new ProjectAccessRepository(database, undefined, (change) =>
    authorizationChanges.publish(change)
  );
  const ownerHumanPrincipalId = seedWorkspaceObserverPrincipal({
    database,
    workspaceId,
    suffix: "direct-owner"
  });
  projectAccess.registerProjectInternal({
    workspaceId,
    projectId,
    projectRoot: `/tmp/${workspaceId}/${projectId}`,
    ownerHumanPrincipalId
  });
  const grant = projectAccess.grant({
    workspaceId,
    projectId,
    humanPrincipalId: device.principalId,
    role: "viewer",
    grantedBy: { kind: "human", id: ownerHumanPrincipalId }
  });
  const httpServer = createServer();
  servers.push(httpServer);
  const journal = new HumanObserverJournal(database, 20);
  const observer = attachHumanObserverWebSocketServer({
    upgradeRouter: new WebSocketUpgradeRouter(httpServer),
    journal,
    repository: new HumanIdentityRepository(database),
    workspaceIdentity,
    projectAccess,
    collaborationScopeAuthority: {
      hasScope: (scope) => scope.workspaceId === workspaceId && scope.projectId === projectId,
      hasProject: (candidateProjectId) => candidateProjectId === projectId
    },
    authorizationChanges,
    maxPayloadBytes: 16_384,
    shutdownTimeoutMs: 1_000,
    transportAdmission: loopbackHttpTransportAdmission,
    deliveryLimits,
    authorizationSafetyCheckIntervalMs
  });
  observerServers.push(observer);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("observer_test_address_missing");
  return {
    database,
    authorizationChanges,
    workspaceIdentity,
    projectAccess,
    grant,
    ownerHumanPrincipalId,
    journal,
    observer,
    scope: { workspaceId, projectId },
    projectId,
    token: device.token,
    url: `ws://127.0.0.1:${address.port}/api/v1/projects/${projectId}/human/observe`
  };
}

function stallServerObserverEvents() {
  const originalSend = WebSocket.prototype.send;
  return vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
    this: WebSocket,
    data: Parameters<WebSocket["send"]>[0],
    optionsOrCallback: WebSocket.SendOptions | ((error?: Error) => void),
    callback?: (error?: Error) => void
  ) {
    const parsed = JSON.parse(data.toString()) as { type?: string };
    if (parsed.type === "human.observer.event") return;
    if (typeof optionsOrCallback === "function") {
      originalSend.call(this, data, optionsOrCallback);
      return;
    }
    originalSend.call(this, data, optionsOrCallback, callback);
  });
}

function messagesThroughClose(socket: WebSocket) {
  const messages: Record<string, unknown>[] = [];
  socket.on("message", (data) => {
    messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  return new Promise<{ code: number; messages: Record<string, unknown>[] }>((resolve) => {
    socket.once("close", (code) => resolve({ code, messages }));
  });
}

describe("human observer WSS", () => {
  it("does not repeatedly authenticate an idle observer in a 250ms-scale window", async () => {
    const fixture = await setupDirectObserver(standardDeliveryLimits, 30_000);
    const authenticate = vi.spyOn(fixture.workspaceIdentity, "authenticateWorkspaceDeviceSession");
    const socket = await connect(fixture.url, fixture.token);
    sendHello(socket, fixture.projectId, 0);
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "human.observer.welcome" });
    const callsAfterHello = authenticate.mock.calls.length;

    await new Promise<void>((resolve) => setTimeout(resolve, 350));

    expect(authenticate).toHaveBeenCalledTimes(callsAfterHello);
    socket.close();
  });

  it("invalidates a revoked read grant immediately after commit", async () => {
    const fixture = await setupDirectObserver(standardDeliveryLimits);
    const socket = await connect(fixture.url, fixture.token);
    sendHello(socket, fixture.projectId, 0);
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "human.observer.welcome" });
    const closed = messagesThroughClose(socket);

    fixture.projectAccess.revoke({
      workspaceId: fixture.scope.workspaceId,
      projectId: fixture.projectId,
      grantId: fixture.grant.grantId,
      actor: { kind: "human", id: fixture.ownerHumanPrincipalId },
      expectedAclRevision: fixture.grant.aclRevision
    });

    await expect(closed).resolves.toEqual({
      code: 4001,
      messages: [
        {
          type: "human.observer.auth_expired",
          protocolVersion: 1,
          code: "human_auth_unauthenticated"
        }
      ]
    });
  });

  it("isolates authorization signals and removes the listener on close", async () => {
    const fixture = await setupDirectObserver(standardDeliveryLimits, 30_000);
    const socket = await connect(fixture.url, fixture.token);
    sendHello(socket, fixture.projectId, 0);
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "human.observer.welcome" });
    expect(fixture.authorizationChanges.subscriberCount()).toBe(1);

    fixture.authorizationChanges.publish({
      workspaceId: fixture.scope.workspaceId,
      projectId: "other-project"
    });
    fixture.authorizationChanges.publish({
      workspaceId: "other-workspace",
      projectId: fixture.projectId
    });
    socket.send(JSON.stringify({ type: "human.observer.ping", protocolVersion: 1 }));
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "human.observer.pong" });

    const closed = nextClose(socket);
    socket.close();
    await closed;
    await vi.waitFor(() => expect(fixture.authorizationChanges.subscriberCount()).toBe(0));
  });

  it("uses the safety deadline for non-eventized credential expiry", async () => {
    const fixture = await setupDirectObserver(standardDeliveryLimits);
    const socket = await connect(fixture.url, fixture.token);
    sendHello(socket, fixture.projectId, 0);
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "human.observer.welcome" });
    const closed = messagesThroughClose(socket);
    fixture.database
      .prepare("UPDATE workspace_device_sessions SET expires_at=? WHERE device_session_id=?")
      .run(new Date(Date.now() - 1).toISOString(), "observer-device-c");

    await expect(closed).resolves.toMatchObject({
      code: 4001,
      messages: [{ type: "human.observer.auth_expired" }]
    });
  });

  it("checks authorization before forwarding a new live event even without a signal", async () => {
    const fixture = await setupDirectObserver(
      {
        replay: { maxEvents: 10, maxBytes: 100_000 },
        replayBatchEvents: 1,
        maxBufferedBytes: 16_384,
        maxPendingBytes: 16_384,
        controlFrameReserveBytes: 1_024,
        sendTimeoutMs: 1_000,
        helloTimeoutMs: 10_000
      },
      30_000
    );
    const socket = await connect(fixture.url, fixture.token);
    sendHello(socket, fixture.projectId, 0);
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "human.observer.welcome" });
    const closed = messagesThroughClose(socket);
    fixture.database
      .prepare("UPDATE workspace_device_sessions SET revoked_at=? WHERE device_session_id=?")
      .run(new Date().toISOString(), "observer-device-c");

    fixture.journal.appendInCallerTransaction(fixture.scope, { kind: "membership" });

    await expect(closed).resolves.toMatchObject({
      code: 4001,
      messages: [{ type: "human.observer.auth_expired" }]
    });
  });

  it("does not initialize when shutdown and hello arrive in the same turn", async () => {
    const fixture = await setupDirectObserver(standardDeliveryLimits);
    const socket = await connect(fixture.url, fixture.token);
    const closed = messagesThroughClose(socket);

    sendHello(socket, fixture.projectId, 0);
    const shutdown = fixture.observer.close();

    await expect(closed).resolves.toEqual({ code: 1001, messages: [] });
    await shutdown;
  });

  it("does not initialize when hello follows the hello timeout", async () => {
    const fixture = await setupDirectObserver({
      replay: { maxEvents: 10, maxBytes: 100_000 },
      replayBatchEvents: 1,
      maxBufferedBytes: 16_384,
      maxPendingBytes: 16_384,
      controlFrameReserveBytes: 1_024,
      sendTimeoutMs: 1_000,
      helloTimeoutMs: 1
    });
    const socket = await connect(fixture.url, fixture.token);
    const closed = messagesThroughClose(socket);

    setTimeout(() => sendHello(socket, fixture.projectId, 0), 5);

    await expect(closed).resolves.toEqual({ code: 4002, messages: [] });
  });

  it("does not process a ping queued after protocol close", async () => {
    const fixture = await setupDirectObserver(standardDeliveryLimits);
    const socket = await connect(fixture.url, fixture.token);
    sendHello(socket, fixture.projectId, 0);
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "human.observer.welcome" });
    const closed = messagesThroughClose(socket);

    sendHello(socket, fixture.projectId, 0);
    socket.send(JSON.stringify({ type: "human.observer.ping", protocolVersion: 1 }));

    await expect(closed).resolves.toEqual({ code: 4000, messages: [] });
  });

  it("preserves auth-expired control delivery and close ownership with in-flight sends", async () => {
    const fixture = await setupDirectObserver(standardDeliveryLimits);
    const socket = await connect(fixture.url, fixture.token);
    sendHello(socket, fixture.projectId, 0);
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "human.observer.welcome" });
    const stalled = stallServerObserverEvents();
    const closed = messagesThroughClose(socket);
    fixture.journal.appendInCallerTransaction(fixture.scope, { kind: "membership" });
    fixture.journal.appendInCallerTransaction(fixture.scope, { kind: "invitation" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    fixture.database
      .prepare("UPDATE workspace_device_sessions SET revoked_at=? WHERE device_session_id=?")
      .run(new Date().toISOString(), "observer-device-c");

    await expect(closed).resolves.toEqual({
      code: 4001,
      messages: [
        {
          type: "human.observer.auth_expired",
          protocolVersion: 1,
          code: "human_auth_unauthenticated"
        }
      ]
    });
    expect(stalled).toHaveBeenCalled();
  });

  it("preserves graceful shutdown ownership with in-flight and pending sends", async () => {
    const fixture = await setupDirectObserver(standardDeliveryLimits);
    const socket = await connect(fixture.url, fixture.token);
    sendHello(socket, fixture.projectId, 0);
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "human.observer.welcome" });
    const stalled = stallServerObserverEvents();
    const closed = messagesThroughClose(socket);
    fixture.journal.appendInCallerTransaction(fixture.scope, { kind: "membership" });
    fixture.journal.appendInCallerTransaction(fixture.scope, { kind: "invitation" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    await fixture.observer.close();

    await expect(closed).resolves.toEqual({ code: 1001, messages: [] });
    expect(stalled).toHaveBeenCalled();
  });

  it("closes after bounded catch-up so the client can reconnect and resume live events", async () => {
    const fixture = await setupDirectObserver({
      replay: { maxEvents: 1, maxBytes: 100_000 },
      replayBatchEvents: 1,
      maxBufferedBytes: 16_384,
      maxPendingBytes: 16_384,
      controlFrameReserveBytes: 1_024,
      sendTimeoutMs: 1_000,
      helloTimeoutMs: 10_000
    });
    const first = fixture.journal.appendInCallerTransaction(fixture.scope, {
      kind: "membership"
    });
    fixture.journal.appendInCallerTransaction(fixture.scope, { kind: "invitation" });
    const head = fixture.journal.appendInCallerTransaction(fixture.scope, { kind: "assignment" });
    const socket = await connect(fixture.url, fixture.token);
    const serverClose = nextClose(socket);

    sendHello(socket, fixture.projectId, first.cursor);

    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: "human.observer.catchup_required",
      reason: "reset",
      resumeCursor: head.cursor
    });
    await expect(serverClose).resolves.toBe(4003);

    const resumed = await connect(fixture.url, fixture.token);
    sendHello(resumed, fixture.projectId, head.cursor);
    await expect(nextMessage(resumed)).resolves.toMatchObject({
      type: "human.observer.welcome",
      cursor: head.cursor
    });
    const liveEvent = nextMessage(resumed);
    fixture.journal.appendInCallerTransaction(fixture.scope, { kind: "project" });
    await expect(liveEvent).resolves.toMatchObject({
      type: "human.observer.event",
      previousCursor: head.cursor,
      kind: "project"
    });
    resumed.close();
  });

  it("bounds queued live delivery and orders catch-up after already-sent events", async () => {
    const fixture = await setupDirectObserver({
      replay: { maxEvents: 10, maxBytes: 100_000 },
      replayBatchEvents: 1,
      maxBufferedBytes: 16_384,
      maxPendingBytes: 350,
      controlFrameReserveBytes: 1_024,
      sendTimeoutMs: 1_000,
      helloTimeoutMs: 10_000
    });
    const socket = await connect(fixture.url, fixture.token);
    sendHello(socket, fixture.projectId, 0);
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "human.observer.welcome" });
    const messages = nextMessages(socket, 2);
    const serverClose = nextClose(socket);
    for (let index = 0; index < 3; index += 1) {
      fixture.journal.appendInCallerTransaction(fixture.scope, {
        kind: "membership",
        humanPrincipalId: `${index}-${"x".repeat(120)}`
      });
    }

    const [delivered, catchup] = await messages;
    expect(delivered).toMatchObject({ type: "human.observer.event", cursor: 1 });
    expect(catchup).toMatchObject({
      type: "human.observer.catchup_required",
      reason: "reset",
      resumeCursor: 3
    });
    await expect(serverClose).resolves.toBe(4003);
  });

  it("uses reserved control capacity when nonzero socket buffering blocks live delivery", async () => {
    const fixture = await setupDirectObserver({
      replay: { maxEvents: 10, maxBytes: 100_000 },
      replayBatchEvents: 1,
      maxBufferedBytes: 300,
      maxPendingBytes: 16_384,
      controlFrameReserveBytes: 256,
      sendTimeoutMs: 1_000,
      helloTimeoutMs: 10_000
    });
    const socket = await connect(fixture.url, fixture.token);
    sendHello(socket, fixture.projectId, 0);
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "human.observer.welcome" });
    const catchup = nextMessage(socket);
    const serverClose = nextClose(socket);
    const bufferedAmount = vi
      .spyOn(WebSocket.prototype, "bufferedAmount", "get")
      .mockReturnValue(200);

    fixture.journal.appendInCallerTransaction(fixture.scope, { kind: "membership" });

    await expect(catchup).resolves.toMatchObject({
      type: "human.observer.catchup_required",
      reason: "reset",
      resumeCursor: 1
    });
    await expect(serverClose).resolves.toBe(4003);
    expect(bufferedAmount).toHaveBeenCalled();
  });

  it("isolates same-project workspace subscriptions, cursors, replay, and revoked sessions", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    const workspaceIdentity = new WorkspaceIdentityRepository(database);
    workspaceIdentity.ensureConfiguredWorkspace("observer-workspace");
    workspaceIdentity.ensureConfiguredWorkspace("observer-workspace-b");
    const first = seedWorkspaceObserverDevice({
      database,
      workspaceId: "observer-workspace",
      suffix: "a"
    });
    const second = seedWorkspaceObserverDevice({
      database,
      workspaceId: "observer-workspace-b",
      suffix: "b"
    });
    const firstOwner = seedWorkspaceObserverPrincipal({
      database,
      workspaceId: "observer-workspace",
      suffix: "owner-a"
    });
    const secondOwner = seedWorkspaceObserverPrincipal({
      database,
      workspaceId: "observer-workspace-b",
      suffix: "owner-b"
    });
    const authorizationChanges = new AuthorizationChangeSignal();
    const projectAccess = new ProjectAccessRepository(database, undefined, (change) =>
      authorizationChanges.publish(change)
    );
    for (const [workspaceId, ownerHumanPrincipalId] of [
      ["observer-workspace", firstOwner],
      ["observer-workspace-b", secondOwner]
    ] as const) {
      projectAccess.registerProjectInternal({
        workspaceId,
        projectId: "shared-project",
        projectRoot: `/tmp/${workspaceId}/shared-project`,
        ownerHumanPrincipalId
      });
    }
    const httpServer = createServer();
    servers.push(httpServer);
    const journal = new HumanObserverJournal(database, 3);
    const observer = attachHumanObserverWebSocketServer({
      upgradeRouter: new WebSocketUpgradeRouter(httpServer),
      journal,
      repository: new HumanIdentityRepository(database),
      workspaceIdentity,
      projectAccess,
      collaborationScopeAuthority: {
        hasScope: ({ workspaceId, projectId }) =>
          projectId === "shared-project" &&
          (workspaceId === "observer-workspace" || workspaceId === "observer-workspace-b"),
        hasProject: () => false
      },
      authorizationChanges,
      maxPayloadBytes: 16_384,
      shutdownTimeoutMs: 1_000,
      transportAdmission: loopbackHttpTransportAdmission,
      authorizationSafetyCheckIntervalMs: 25
    });
    observerServers.push(observer);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("observer_test_address_missing");
    const url = `ws://127.0.0.1:${address.port}/api/v1/projects/shared-project/human/observe`;
    await expect(websocketUpgradeStatus(url, first.token)).resolves.toBe(403);
    projectAccess.grant({
      workspaceId: "observer-workspace",
      projectId: "shared-project",
      humanPrincipalId: first.principalId,
      role: "viewer",
      grantedBy: { kind: "human", id: firstOwner }
    });
    projectAccess.grant({
      workspaceId: "observer-workspace-b",
      projectId: "shared-project",
      humanPrincipalId: second.principalId,
      role: "viewer",
      grantedBy: { kind: "human", id: secondOwner }
    });
    const firstSocket = await connect(url, first.token);
    const secondSocket = await connect(url, second.token);
    sendHello(firstSocket, "shared-project", 0);
    sendHello(secondSocket, "shared-project", 0);
    await Promise.all([nextMessage(firstSocket), nextMessage(secondSocket)]);

    const firstEvent = nextMessage(firstSocket);
    const secondEvent = nextMessage(secondSocket);
    journal.appendInCallerTransaction(
      { workspaceId: "observer-workspace", projectId: "shared-project" },
      { kind: "membership" }
    );
    journal.appendInCallerTransaction(
      { workspaceId: "observer-workspace-b", projectId: "shared-project" },
      { kind: "invitation" }
    );
    await expect(firstEvent).resolves.toMatchObject({ kind: "membership" });
    const observedSecond = await secondEvent;
    expect(observedSecond).toMatchObject({ kind: "invitation" });

    firstSocket.close();
    journal.appendInCallerTransaction(
      { workspaceId: "observer-workspace", projectId: "shared-project" },
      { kind: "assignment" }
    );
    const replay = await connect(url, second.token);
    sendHello(replay, "shared-project", Number(observedSecond.cursor));
    await expect(nextMessage(replay)).resolves.toMatchObject({
      type: "human.observer.welcome",
      cursor: observedSecond.cursor
    });
    replay.close();

    const expired = nextMessage(secondSocket);
    database
      .prepare("UPDATE workspace_device_sessions SET revoked_at=? WHERE device_session_id=?")
      .run(new Date().toISOString(), "observer-device-b");
    await expect(expired).resolves.toMatchObject({ type: "human.observer.auth_expired" });
    secondSocket.close();
  });

  it("authenticates, pings, fans out durable events, replays, and reports retention gaps", async () => {
    const fixture = await setup();
    const owner = await bootstrap(fixture.origin, fixture.projectId, "observer-owner");
    const url = `${fixture.wsOrigin}/api/v1/projects/${fixture.projectId}/human/observe`;
    const first = await connect(url, owner.deviceToken);
    const second = await connect(url, owner.deviceToken);
    sendHello(first, fixture.projectId, 0);
    sendHello(second, fixture.projectId, 0);
    const firstWelcome = await nextMessage(first);
    const secondWelcome = await nextMessage(second);
    expect(firstWelcome).toMatchObject({ type: "human.observer.welcome" });
    expect(secondWelcome).toMatchObject({ type: "human.observer.welcome" });

    first.send(JSON.stringify({ type: "human.observer.ping", protocolVersion: 1 }));
    await expect(nextMessage(first)).resolves.toMatchObject({ type: "human.observer.pong" });

    const firstEventPromise = nextMessage(first);
    const secondEventPromise = nextMessage(second);
    await createInvitation(fixture.origin, fixture.projectId, owner.deviceToken);
    const [firstEvent, secondEvent] = await Promise.all([firstEventPromise, secondEventPromise]);
    expect(firstEvent).toMatchObject({ type: "human.observer.event", kind: "invitation" });
    expect(secondEvent).toMatchObject({ cursor: firstEvent.cursor, kind: "invitation" });
    const eventCursor = Number(firstEvent.cursor);
    first.close();
    second.close();

    await createInvitation(fixture.origin, fixture.projectId, owner.deviceToken);
    const replay = await connect(url, owner.deviceToken);
    const replayMessages = nextMessages(replay, 2);
    sendHello(replay, fixture.projectId, eventCursor);
    const [replayedEvent, replayWelcome] = await replayMessages;
    expect(replayedEvent).toMatchObject({
      type: "human.observer.event",
      kind: "invitation"
    });
    expect(replayWelcome).toMatchObject({ type: "human.observer.welcome" });
    replay.close();

    await createInvitation(fixture.origin, fixture.projectId, owner.deviceToken);
    await createInvitation(fixture.origin, fixture.projectId, owner.deviceToken);
    const gap = await connect(url, owner.deviceToken);
    sendHello(gap, fixture.projectId, 1);
    await expect(nextMessage(gap)).resolves.toMatchObject({
      type: "human.observer.catchup_required",
      reason: "retention_gap"
    });
    gap.close();
  });

  it("accepts an invited member when the project is shared", async () => {
    const fixture = await setup();
    const owner = await bootstrap(fixture.origin, fixture.projectId, "observer-shared-owner");
    const visibility = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/canvases/default/access`,
      {
        method: "POST",
        headers: jsonHeaders(owner.deviceToken),
        body: JSON.stringify({
          operation: "visibility",
          scope: {
            scopeKind: "project",
            workspaceId: "observer-workspace",
            projectId: fixture.projectId,
            canvasId: null
          },
          expectedAclRevision: 0,
          visibility: "shared"
        })
      }
    );
    expect(visibility.status).toBe(200);

    const invitation = await createInvitation(fixture.origin, fixture.projectId, owner.deviceToken);
    const member = await consumeInvitation(
      fixture.origin,
      fixture.projectId,
      invitation.invitationToken,
      "Observer shared member"
    );
    const socket = await connect(
      `${fixture.wsOrigin}/api/v1/projects/${fixture.projectId}/human/observe`,
      member.deviceToken
    );
    sendHello(socket, fixture.projectId, 0);
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: "human.observer.welcome",
      projectId: fixture.projectId
    });
    socket.close();
  });

  it("rejects invalid upgrades, expires revoked devices, and drains active sessions", async () => {
    const fixture = await setup();
    const owner = await bootstrap(fixture.origin, fixture.projectId, "observer-revoked-owner");
    const url = `${fixture.wsOrigin}/api/v1/projects/${fixture.projectId}/human/observe`;
    const rejected = new WebSocket(url, {
      headers: { Authorization: "Bearer operator-token-not-human" }
    });
    const rejectedStatus = await new Promise<number>((resolve) => {
      rejected.once("unexpected-response", (_request, response) => resolve(response.statusCode));
    });
    expect(rejectedStatus).toBe(401);

    const untrusted = new WebSocket(
      `${fixture.wsOrigin}/api/v1/projects/untrusted-project/human/observe`,
      { headers: { Authorization: `Bearer ${owner.deviceToken}` } }
    );
    const untrustedStatus = await new Promise<number>((resolve) => {
      untrusted.once("unexpected-response", (_request, response) => resolve(response.statusCode));
    });
    expect(untrustedStatus).toBe(403);

    const hostPath = new WebSocket(`${fixture.wsOrigin}/agent-hosts/missing-host/connect`, {
      headers: { Authorization: "Bearer pw_host_invalid" }
    });
    const hostStatus = await new Promise<number>((resolve) => {
      hostPath.once("unexpected-response", (_request, response) => resolve(response.statusCode));
    });
    expect(hostStatus).toBe(401);

    const unknown = new WebSocket(`${fixture.wsOrigin}/unknown-upgrade`);
    const unknownStatus = await new Promise<number>((resolve) => {
      unknown.once("unexpected-response", (_request, response) => resolve(response.statusCode));
    });
    expect(unknownStatus).toBe(404);

    const invitation = await createInvitation(fixture.origin, fixture.projectId, owner.deviceToken);
    const joined = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/human/invitations/consume`,
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          invitationToken: invitation.invitationToken,
          displayName: "Revoked Member"
        })
      }
    );
    const member = (await joined.json()) as {
      deviceToken: string;
      principal: { humanPrincipalId: string };
    };
    expect(joined.status).toBe(201);
    const grant = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/canvases/default/access`,
      {
        method: "POST",
        headers: jsonHeaders(owner.deviceToken),
        body: JSON.stringify({
          operation: "grant",
          scope: {
            scopeKind: "project",
            workspaceId: "observer-workspace",
            projectId: fixture.projectId,
            canvasId: null
          },
          expectedAclRevision: 0,
          humanPrincipalId: member.principal.humanPrincipalId,
          role: "viewer"
        })
      }
    );
    expect(grant.status).toBe(200);
    const memberSocket = await connect(url, member.deviceToken);
    const memberWelcome = nextMessage(memberSocket);
    sendHello(memberSocket, fixture.projectId, 0);
    await memberWelcome;
    const membershipExpired = nextMessage(memberSocket);
    const removed = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/human/members/${member.principal.humanPrincipalId}/remove`,
      { method: "POST", headers: jsonHeaders(owner.deviceToken), body: JSON.stringify({}) }
    );
    expect(removed.status).toBe(200);
    await expect(membershipExpired).resolves.toMatchObject({
      type: "human.observer.auth_expired"
    });

    const socket = await connect(url, owner.deviceToken);
    sendHello(socket, fixture.projectId, 0);
    await nextMessage(socket);
    const expired = nextMessage(socket);
    const revoke = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/human/devices/${owner.device.deviceCredentialId}/revoke`,
      { method: "POST", headers: jsonHeaders(owner.deviceToken), body: JSON.stringify({}) }
    );
    expect(revoke.status).toBe(200);
    await expect(expired).resolves.toMatchObject({ type: "human.observer.auth_expired" });

    const replacement = await bootstrap(
      fixture.origin,
      fixture.projectId,
      "observer-revoked-owner"
    );
    const draining = await connect(url, replacement.deviceToken);
    sendHello(draining, fixture.projectId, 0);
    await nextMessage(draining);
    const closed = new Promise<number>((resolve) => draining.once("close", resolve));
    await fixture.composition.drainTransports();
    await expect(closed).resolves.toBe(1001);
  });

  it("rejects missing and unlisted browser origins when a deployment bounds them", async () => {
    const fixture = await setup({ allowedClientOrigins: ["http://localhost:5173/"] });
    const owner = await bootstrap(fixture.origin, fixture.projectId, "observer-origin-owner");
    const url = `${fixture.wsOrigin}/api/v1/projects/${fixture.projectId}/human/observe`;
    for (const origin of [undefined, "http://localhost:5174"]) {
      const rejected = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${owner.deviceToken}`,
          ...(origin ? { Origin: origin } : {})
        }
      });
      const status = await new Promise<number>((resolve) => {
        rejected.once("unexpected-response", (_request, response) => resolve(response.statusCode));
      });
      expect(status).toBe(403);
    }
  });
});
