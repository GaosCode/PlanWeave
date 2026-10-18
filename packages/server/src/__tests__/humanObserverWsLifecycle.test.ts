import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { AuthorizationChangeSignal } from "../authorizationChangeSignal.js";
import { HumanObserverJournal } from "../humanObserverJournal.js";
import { attachHumanObserverWebSocketServer } from "../humanObserverWs.js";
import { hashHumanToken } from "../identity/crypto.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { openServerDatabase } from "../sqlite.js";
import { WebSocketUpgradeRouter } from "../webSocketUpgradeRouter.js";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";
import { bounded } from "./support/webSocketUpgradeBoundaryHarness.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});

async function setupObserver() {
  const database = await openServerDatabase(":memory:", 5_000);
  applyMigrations(database);
  const scope = { workspaceId: "lifecycle-workspace", projectId: "lifecycle-project" };
  const principalId = "lifecycle-owner";
  const token = `pw_hdev_${"L".repeat(43)}`;
  const now = new Date().toISOString();
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  workspaceIdentity.ensureConfiguredWorkspace(scope.workspaceId);
  database
    .prepare(`INSERT INTO workspace_principals
    (workspace_id,human_principal_id,display_name,created_at,revoked_at)
    VALUES(?,?,?,?,NULL)`)
    .run(scope.workspaceId, principalId, "Lifecycle Owner", now);
  database
    .prepare(`INSERT INTO workspace_memberships
    (workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at)
    VALUES(?,?,?,'owner',1,?,?,NULL)`)
    .run(scope.workspaceId, "lifecycle-member", principalId, now, now);
  database
    .prepare(`INSERT INTO workspace_device_sessions
    (workspace_id,device_session_id,human_principal_id,credential_sha256,issued_at,expires_at,revoked_at,last_used_at)
    VALUES(?,?,?,?,?,?,NULL,NULL)`)
    .run(
      scope.workspaceId,
      "lifecycle-device",
      principalId,
      hashHumanToken(token),
      now,
      new Date(Date.now() + 60_000).toISOString()
    );
  const projectAccess = new ProjectAccessRepository(database);
  projectAccess.registerProjectInternal({
    ...scope,
    projectRoot: "/tmp/observer-lifecycle",
    ownerHumanPrincipalId: principalId
  });
  const journal = new HumanObserverJournal(database, 20);
  const authorizationChanges = new AuthorizationChangeSignal();
  const server = createServer();
  const router = new WebSocketUpgradeRouter(server);
  const observer = attachHumanObserverWebSocketServer({
    upgradeRouter: router,
    journal,
    authorizationChanges,
    workspaceIdentity,
    projectAccess,
    repository: new HumanIdentityRepository(database),
    collaborationScopeAuthority: { hasScope: () => true, hasProject: () => true },
    transportAdmission: loopbackHttpTransportAdmission,
    maxPayloadBytes: 16_384,
    shutdownTimeoutMs: 1_000
  });
  const sockets = new Set<WebSocket>();
  cleanup.push(async () => {
    for (const socket of sockets) socket.terminate();
    await bounded(observer.close(), "observer shutdown");
    router.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("observer_address_required");
  const connect = async () => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/v1/projects/${scope.projectId}/human/observe`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    await bounded(
      new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      }),
      "observer open"
    );
    return socket;
  };
  return { scope, journal, authorizationChanges, workspaceIdentity, observer, connect };
}

function hello(socket: WebSocket, projectId: string, lastCursor: number) {
  socket.send(
    JSON.stringify({ type: "human.observer.hello", protocolVersion: 1, projectId, lastCursor })
  );
}

function holdSend(type: string) {
  const originalSend = WebSocket.prototype.send;
  const entered = Promise.withResolvers<WebSocket>();
  let release: (() => void) | undefined;
  const sends: string[] = [];
  vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
    this: WebSocket,
    data: Parameters<WebSocket["send"]>[0],
    optionsOrCallback: WebSocket.SendOptions | ((error?: Error) => void),
    callback?: (error?: Error) => void
  ) {
    if (!data.toString().startsWith("{")) {
      if (typeof optionsOrCallback === "function") originalSend.call(this, data, optionsOrCallback);
      else originalSend.call(this, data, optionsOrCallback, callback);
      return;
    }
    const message = JSON.parse(data.toString()) as { type: string };
    sends.push(message.type);
    if (message.type === type && typeof optionsOrCallback === "function" && !release) {
      release = () => optionsOrCallback();
      entered.resolve(this);
      return;
    }
    if (typeof optionsOrCallback === "function") originalSend.call(this, data, optionsOrCallback);
    else originalSend.call(this, data, optionsOrCallback, callback);
  });
  return {
    entered: bounded(entered.promise, "send barrier"),
    sends,
    release() {
      if (!release) throw new Error("send_barrier_not_entered");
      release();
    }
  };
}

describe("Observer terminal lifecycle", () => {
  it.each([
    "replay",
    "live"
  ])("releases subscriptions and pending sends on a real receive error during %s", async (phase) => {
    const fixture = await setupObserver();
    const first = fixture.journal.appendInCallerTransaction(fixture.scope, { kind: "membership" });
    fixture.journal.appendInCallerTransaction(fixture.scope, { kind: "invitation" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const unsubscribe = vi.fn();
    const subscribe = fixture.journal.subscribe.bind(fixture.journal);
    vi.spyOn(fixture.journal, "subscribe").mockImplementation((scope, listener) => {
      const detach = subscribe(scope, listener);
      return () => {
        unsubscribe();
        detach();
      };
    });
    const authenticate = vi.spyOn(fixture.workspaceIdentity, "authenticateWorkspaceDeviceSession");
    const head = vi.spyOn(fixture.journal, "head");
    const socket = await fixture.connect();
    const messages: string[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString()).type));
    if (phase === "live") {
      const welcome = new Promise<void>((resolve) => socket.once("message", () => resolve()));
      hello(socket, fixture.scope.projectId, 0);
      await bounded(welcome, "welcome");
    }
    const barrier = holdSend("human.observer.event");
    if (phase === "replay") hello(socket, fixture.scope.projectId, first.cursor);
    else fixture.journal.appendInCallerTransaction(fixture.scope, { kind: "membership" });
    const serverSocket = await barrier.entered;
    fixture.journal.appendInCallerTransaction(fixture.scope, { kind: "project" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const failed = new Promise<void>((resolve) => serverSocket.once("error", () => resolve()));
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    socket.send("x", { mask: false });
    await bounded(failed, "receiver error");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(fixture.authorizationChanges.subscriberCount()).toBe(0);
    expect(await bounded(closed, "fault connection close")).not.toBe(1000);
    const authCalls = authenticate.mock.calls.length;
    const sendCount = barrier.sends.length;
    barrier.release();
    fixture.authorizationChanges.publish(fixture.scope);
    fixture.journal.appendInCallerTransaction(fixture.scope, { kind: "membership" });
    const headCalls = head.mock.calls.length;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(authenticate).toHaveBeenCalledTimes(authCalls);
    expect(barrier.sends).toHaveLength(sendCount);
    expect(head).toHaveBeenCalledTimes(headCalls);
    expect(messages).toEqual(phase === "live" ? ["human.observer.welcome"] : []);
    await bounded(fixture.observer.close(), "shutdown after error");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps shutdown terminal when a welcome callback settles before its continuation", async () => {
    const fixture = await setupObserver();
    const socket = await fixture.connect();
    const authenticate = vi.spyOn(fixture.workspaceIdentity, "authenticateWorkspaceDeviceSession");
    const head = vi.spyOn(fixture.journal, "head");
    const messages: string[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString()).type));
    const barrier = holdSend("human.observer.welcome");
    hello(socket, fixture.scope.projectId, 0);
    const serverSocket = await barrier.entered;
    const received = new Promise<string>((resolve) =>
      serverSocket.once("message", (data) => resolve(JSON.parse(data.toString()).type))
    );
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    barrier.release();
    const shutdown = fixture.observer.close();
    const authCalls = authenticate.mock.calls.length;
    socket.send(JSON.stringify({ type: "human.observer.ping", protocolVersion: 1 }));
    fixture.authorizationChanges.publish(fixture.scope);
    fixture.journal.appendInCallerTransaction(fixture.scope, { kind: "membership" });
    const headCalls = head.mock.calls.length;
    expect(await bounded(received, "late observer ping received")).toBe("human.observer.ping");
    expect(await bounded(closed, "shutdown close")).toBe(1001);
    await bounded(shutdown, "shutdown with welcome in flight");
    expect(fixture.authorizationChanges.subscriberCount()).toBe(0);
    expect(authenticate).toHaveBeenCalledTimes(authCalls);
    expect(head).toHaveBeenCalledTimes(headCalls);
    expect(messages).toEqual([]);
    expect(barrier.sends).toEqual([
      "human.observer.hello",
      "human.observer.welcome",
      "human.observer.ping"
    ]);
  });
});
