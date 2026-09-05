import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";
import { hashHumanToken } from "../identity/crypto.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { HumanObserverJournal } from "../humanObserverJournal.js";
import { attachHumanObserverWebSocketServer } from "../humanObserverWs.js";
import { applyMigrations } from "../migrations.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { WebSocketUpgradeRouter } from "../webSocketUpgradeRouter.js";
import { AuthorizationChangeSignal } from "../authorizationChangeSignal.js";

const databases: SqliteDatabase[] = [];
const servers: HttpServer[] = [];
const observerServers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const observer of observerServers.splice(0)) await observer.close();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

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
  const now = new Date();
  const issuedAt = now.toISOString();
  const token = `pw_hdev_${input.suffix.repeat(43)}`;
  const principalId = seedWorkspaceObserverPrincipal(input);
  input.database
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

async function connect(url: string, token: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
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

async function setupCanvasOnlyObserver() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  const workspaceId = "canvas-filter-observer-workspace";
  const projectId = "canvas-filter-observer-project";
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  workspaceIdentity.ensureConfiguredWorkspace(workspaceId);
  const member = seedWorkspaceObserverDevice({
    database,
    workspaceId,
    suffix: "e"
  });
  const authorizationChanges = new AuthorizationChangeSignal();
  const projectAccess = new ProjectAccessRepository(database, undefined, (change) =>
    authorizationChanges.publish(change)
  );
  const ownerHumanPrincipalId = seedWorkspaceObserverPrincipal({
    database,
    workspaceId,
    suffix: "owner"
  });
  projectAccess.registerProjectInternal({
    workspaceId,
    projectId,
    projectRoot: `/tmp/${workspaceId}/${projectId}`,
    ownerHumanPrincipalId
  });
  for (const canvasId of ["canvas-visible", "canvas-hidden"] as const) {
    projectAccess.registerCanvasInternal({
      workspaceId,
      projectId,
      canvasId,
      packageDir: `/tmp/${workspaceId}/${projectId}/${canvasId}`,
      ownerHumanPrincipalId
    });
  }
  projectAccess.grant({
    workspaceId,
    projectId,
    canvasId: "canvas-visible",
    humanPrincipalId: member.principalId,
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
    deliveryLimits: {
      replay: { maxEvents: 10, maxBytes: 100_000 },
      replayBatchEvents: 1,
      maxBufferedBytes: 16_384,
      maxPendingBytes: 16_384,
      controlFrameReserveBytes: 1_024,
      sendTimeoutMs: 1_000,
      helloTimeoutMs: 10_000
    },
    authorizationSafetyCheckIntervalMs: 25
  });
  observerServers.push(observer);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("observer_test_address_missing");
  return {
    journal,
    member,
    projectId,
    workspaceId,
    digest: "a".repeat(64),
    url: `ws://127.0.0.1:${address.port}/api/v1/projects/${projectId}/human/observe`
  };
}

describe("human observer canvas-filter replay", () => {
  it("rewrites previousCursor across hidden events inside replay", async () => {
    const fixture = await setupCanvasOnlyObserver();
    const scope = { workspaceId: fixture.workspaceId, projectId: fixture.projectId };
    const invitation = fixture.journal.appendInCallerTransaction(scope, { kind: "invitation" });
    fixture.journal.appendInCallerTransaction(scope, {
      kind: "canvas",
      canvasId: "canvas-hidden",
      canvasRevision: 1,
      canvasContentDigest: fixture.digest
    });
    const visibleCanvas = fixture.journal.appendInCallerTransaction(scope, {
      kind: "canvas",
      canvasId: "canvas-visible",
      canvasRevision: 2,
      canvasContentDigest: fixture.digest
    });
    fixture.journal.appendInCallerTransaction(scope, {
      kind: "assignment",
      workItem: { kind: "task", canvasId: "canvas-hidden", taskId: "T-002" }
    });
    const visibleRuntime = fixture.journal.appendInCallerTransaction(scope, {
      kind: "runtime",
      canvasId: "canvas-visible",
      runtimeRevision: 1
    });

    const socket = await connect(fixture.url, fixture.member.token);
    const replayed = nextMessages(socket, 3);
    sendHello(socket, fixture.projectId, invitation.cursor);
    const [replayedCanvas, replayedRuntime, welcome] = await replayed;
    expect(replayedCanvas).toMatchObject({
      type: "human.observer.event",
      kind: "canvas",
      canvasId: "canvas-visible",
      cursor: visibleCanvas.cursor,
      previousCursor: invitation.cursor
    });
    expect(replayedRuntime).toMatchObject({
      type: "human.observer.event",
      kind: "runtime",
      canvasId: "canvas-visible",
      cursor: visibleRuntime.cursor,
      previousCursor: visibleCanvas.cursor
    });
    expect(welcome).toMatchObject({
      type: "human.observer.welcome",
      projectId: fixture.projectId,
      cursor: visibleRuntime.cursor
    });
    socket.close();
  });
});
