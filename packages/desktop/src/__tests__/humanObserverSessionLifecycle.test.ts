import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  exampleHumanDeviceToken,
  exampleObserverEvent,
  exampleObserverWelcome
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import { CollaborationService } from "../main/collaboration/collaborationService.js";
import { CollaborationCredentialVault } from "../main/collaboration/collaborationCredentialVault.js";
import { CollaborationProfileStore } from "../main/collaboration/collaborationProfileStore.js";
import { createApplicationCredentialStorage } from "../main/credentialStorage/applicationCredentialStorage.js";
import { WorkspaceConnectionProfileStore } from "../main/collaboration/workspaceConnectionProfileStore.js";
import { WorkspaceAuthoritativeSnapshotCache } from "../main/collaboration/WorkspaceAuthoritativeSnapshotCache.js";
import type { CollaborationObserverSignal, CollaborationStatus } from "../shared/collaboration.js";

class ObserverSocket extends WebSocket {
  constructor(url: string, options?: string | string[] | { headers?: Record<string, string> }) {
    const protocols = typeof options === "string" || Array.isArray(options) ? options : undefined;
    const config = typeof options === "string" || Array.isArray(options) ? undefined : options;
    super(url, protocols, config);
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

for (const termination of ["disconnect", "shutdown"] as const) {
  it(`does not open a late observer WebSocket after real session ${termination}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pw-observer-session-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    let resolveToken!: (token: string) => void;
    const pending = new Promise<string>((resolve) => {
      resolveToken = resolve;
    });
    let signalPending!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalPending = resolve;
    });
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ items: [], nextCursor: null }));
    });
    const ws = new WebSocketServer({ server });
    let connections = 0;
    ws.on("connection", () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}/`;
    cleanups.push(async () => {
      for (const client of ws.clients) client.terminate();
      await new Promise<void>((resolve, reject) =>
        ws.close((error) => (error ? reject(error) : resolve()))
      );
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    });
    let statusPublications = 0;
    const service = new CollaborationService({
      onStatusChange: () => {
        statusPublications += 1;
      },
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      workspaceProfileStorePaths: { profilesPath: join(root, "workspace.json") },
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: createApplicationCredentialStorage({ keyPath: join(root, "credential.key") })
      }),
      invitationsPath: join(root, "invitations.json"),
      exportedIdentityPath: join(root, "identity.json"),
      createClient: (options) => {
        let calls = 0;
        return new CollaborationClient({
          ...options,
          WebSocketImpl: ObserverSocket,
          credential: {
            getDeviceToken: () => {
              calls += 1;
              if (calls === 2) {
                signalPending();
                return pending;
              }
              return options.credential.getDeviceToken();
            }
          }
        });
      }
    });
    cleanups.push(async () => {
      resolveToken(exampleHumanDeviceToken);
      await service.shutdown();
    });
    await service.upsertProfile({
      profileId: "observer-session",
      displayName: "Session",
      serverBaseUrl: origin,
      projectId: "project-demo-001",
      allowInsecureTransport: true,
      endpoint: {
        topology: "loopback_http",
        serverOrigin: origin,
        allowedClientOrigins: [origin],
        tlsTrust: "not_applicable"
      }
    });
    await service.importDeviceCredential({
      profileId: "observer-session",
      deviceToken: exampleHumanDeviceToken
    });
    await service.connectSession({ profileId: "observer-session" });
    await entered;
    if (termination === "disconnect") await service.disconnectSession();
    else await service.shutdown();
    const before = termination === "disconnect" ? await service.getStatus() : null;
    const publications = statusPublications;
    resolveToken(exampleHumanDeviceToken);
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(connections).toBe(0);
    expect(statusPublications).toBe(publications);
    if (before) {
      const after = await service.getStatus();
      expect(after.session).toEqual(before.session);
      expect(after.session.phase).toBe("idle");
    } else {
      await expect(service.getStatus()).rejects.toThrow();
    }
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class ControlledSnapshotCache extends WorkspaceAuthoritativeSnapshotCache {
  nextFlush?: () => Promise<void>;

  override async flush(): Promise<void> {
    const action = this.nextFlush;
    this.nextFlush = undefined;
    await action?.();
    await super.flush();
  }
}

async function connectedForgetFixture() {
  const root = await mkdtemp(join(tmpdir(), "pw-forget-session-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const requests: Array<{ path: string; originalCredential: boolean }> = [];
  const connections: Array<{ path: string; socket: WebSocket; originalCredential: boolean }> = [];
  const commentEntered = deferred();
  const commentRelease = deferred();
  let holdComments = false;
  const servers: Array<{ origin: string; deviceToken: string; profileId: string }> = [];
  for (const [profileId, deviceToken] of [
    ["forget-A", exampleHumanDeviceToken],
    ["forget-B", `pw_hdev_${"B".repeat(43)}`]
  ]) {
    const server = createServer(async (request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      requests.push({
        path,
        originalCredential: request.headers.authorization === `Bearer ${exampleHumanDeviceToken}`
      });
      if (request.headers.authorization !== `Bearer ${deviceToken}`) {
        response.writeHead(401);
        response.end();
        return;
      }
      if (holdComments && path.endsWith("/comments")) {
        commentEntered.resolve();
        await commentRelease.promise;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ items: [], nextCursor: null }));
    });
    const ws = new WebSocketServer({ server });
    ws.on("connection", (socket, request) => {
      connections.push({
        path: new URL(request.url ?? "/", "http://localhost").pathname,
        socket,
        originalCredential: request.headers.authorization === `Bearer ${exampleHumanDeviceToken}`
      });
      if (request.headers.authorization !== `Bearer ${deviceToken}`) {
        socket.close(4001, "wrong Server credential");
        return;
      }
      socket.on("message", (bytes) => {
        const hello = JSON.parse(bytes.toString());
        if (hello.type === "human.observer.hello") {
          socket.send(JSON.stringify(exampleObserverWelcome));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    servers.push({ origin: `http://127.0.0.1:${address.port}/`, deviceToken, profileId });
    cleanups.push(async () => {
      commentRelease.resolve();
      for (const client of ws.clients) client.terminate();
      await new Promise<void>((resolve, reject) =>
        ws.close((error) => (error ? reject(error) : resolve()))
      );
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    });
  }
  const vault = new CollaborationCredentialVault({
    paths: { credentialsPath: join(root, "credentials.json") },
    safeStorage: createApplicationCredentialStorage({ keyPath: join(root, "credential.key") })
  });
  const workspaceProfiles = new WorkspaceConnectionProfileStore({
    profilesPath: join(root, "workspaces.json")
  });
  const cache = new ControlledSnapshotCache(join(root, "snapshots"));
  const statuses: CollaborationStatus[] = [];
  const signals: CollaborationObserverSignal[] = [];
  const clients: CollaborationClient[] = [];
  const service = new CollaborationService({
    profileStorePaths: { profilesPath: join(root, "profiles.json") },
    workspaceProfileStore: workspaceProfiles,
    vault,
    workspaceSnapshotCache: cache,
    invitationsPath: join(root, "invitations.json"),
    exportedIdentityPath: join(root, "identity.json"),
    onStatusChange: (status) => statuses.push(status),
    onObserverSignal: (signal) => signals.push(signal),
    createClient: (options) => {
      const client = new CollaborationClient({
        ...options,
        WebSocketImpl: ObserverSocket,
        limits: { reconnectInitialDelayMs: 2, reconnectMaxDelayMs: 2 },
        random: () => 0
      });
      clients.push(client);
      return client;
    }
  });
  cleanups.push(async () => {
    commentRelease.resolve();
    cache.nextFlush = undefined;
    await service.shutdown();
  });
  for (const { origin, profileId, deviceToken } of servers) {
    await service.upsertProfile({
      profileId,
      displayName: profileId,
      serverBaseUrl: origin,
      projectId: exampleObserverWelcome.projectId,
      allowInsecureTransport: true,
      endpoint: {
        topology: "loopback_http",
        serverOrigin: origin,
        allowedClientOrigins: [origin],
        tlsTrust: "not_applicable"
      }
    });
    await service.importDeviceCredential({ profileId, deviceToken });
    await workspaceProfiles.upsert({
      profile: {
        schemaVersion: "workspace-identity/v1",
        profileId,
        displayName: profileId,
        serverBaseUrl: origin,
        workspaceId: "workspace-forget",
        allowInsecureTransport: true
      },
      workspaceDisplayName: "Forget session",
      membershipRole: "owner",
      membershipActive: true
    });
  }
  await service.adoptWorkspaceAuthority({
    profileId: "forget-A",
    workspaceId: "workspace-forget",
    membershipRole: "owner"
  });
  await service.connectSession({ profileId: "forget-A" });
  await expect
    .poll(async () => (await service.getStatus()).session.detail)
    .toBe("observer:connected");
  const connected = await service.getStatus();
  const scope = connected.session.operationScope;
  if (!scope) throw new Error("forget_fixture_scope_missing");
  expect(connected.workspaceConnection.status).toBe("connected");
  const observer = connections.find((connection) => connection.path.endsWith("/human/observe"));
  if (!observer) throw new Error("forget_fixture_observer_missing");
  const comments = () =>
    service.listComments({
      operationScope: scope,
      workItem: { kind: "task", canvasId: "default", taskId: "T-001" }
    });
  return {
    root,
    service,
    vault,
    workspaceProfiles,
    cache,
    statuses,
    signals,
    clients,
    connections,
    requests,
    observer,
    scope,
    comments,
    holdComments: () => {
      holdComments = true;
      return { entered: commentEntered.promise, release: commentRelease.resolve };
    }
  };
}

it("forgets a connected Server without reauthenticating its retired project sockets or scope", async () => {
  const fixture = await connectedForgetFixture();
  const client = fixture.clients.at(-1);
  if (!client) throw new Error("forget_fixture_client_missing");
  client.startPresence("default");
  client.startLiveSync("default", 0);
  await expect.poll(() => fixture.connections.length).toBe(4);
  const connections = [...fixture.connections];
  const status = await fixture.service.forgetRememberedServerConnection({ profileId: "forget-A" });
  expect(status.session.operationScope).toBeNull();
  expect(await fixture.vault.getDeviceToken("forget-A")).toBeUndefined();
  for (const connection of connections) connection.socket.close();
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  expect(fixture.connections).toHaveLength(connections.length);
  expect(connections.every((connection) => connection.socket.readyState === WebSocket.CLOSED)).toBe(
    true
  );
  const after = await fixture.service.getStatus();
  expect(after.session).toMatchObject({ phase: "idle", operationScope: null });
  expect(after.workspaceConnection.status).toBe("local_only");
  const requests = fixture.requests.length;
  await expect(fixture.comments()).rejects.toMatchObject({
    code: "collaboration_operation_scope_stale"
  });
  expect(fixture.requests).toHaveLength(requests);
});

it("stops reauthentication and ignores late observer events during flush without aborting admitted HTTP", async () => {
  const fixture = await connectedForgetFixture();
  const client = fixture.clients.at(-1);
  if (!client) throw new Error("forget_fixture_client_missing");
  client.startPresence("default");
  client.startLiveSync("default", 0);
  await expect.poll(() => fixture.connections.length).toBe(4);
  const connections = [...fixture.connections];
  const projectConnections = connections.filter((connection) =>
    connection.path.startsWith("/api/v1/projects/")
  );
  expect(projectConnections).toHaveLength(3);
  const entered = deferred();
  const release = deferred();
  cleanups.push(async () => release.resolve());
  fixture.cache.nextFlush = async () => {
    entered.resolve();
    await release.promise;
  };
  const pendingRead = fixture.holdComments();
  const admitted = fixture.comments().then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  await pendingRead.entered;
  const forgetting = fixture.service.forgetRememberedServerConnection({ profileId: "forget-A" });
  expect(
    await Promise.race([entered.promise.then(() => "flushing"), forgetting.then(() => "done")])
  ).toBe("flushing");
  expect(await fixture.vault.getDeviceToken("forget-A")).toBeTruthy();
  const signalCount = fixture.signals.length;
  const statusCount = fixture.statuses.length;
  fixture.observer.socket.send(JSON.stringify(exampleObserverWelcome));
  fixture.observer.socket.send(JSON.stringify(exampleObserverEvent));
  for (const connection of projectConnections) connection.socket.close();
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  expect(fixture.connections).toHaveLength(connections.length);
  expect(fixture.signals).toHaveLength(signalCount);
  expect(fixture.statuses).toHaveLength(statusCount);
  const requests = fixture.requests.length;
  await expect(fixture.comments()).rejects.toMatchObject({
    code: "collaboration_operation_scope_stale"
  });
  expect(fixture.requests).toHaveLength(requests);
  pendingRead.release();
  await expect(admitted).resolves.toEqual({ value: { items: [], nextCursor: null } });
  expect(fixture.requests.every((request) => request.originalCredential)).toBe(true);
  release.resolve();
  await forgetting;
  await expect.poll(() => fixture.observer.socket.readyState).toBe(WebSocket.CLOSED);
});

it("keeps the current project scope and observer when forgetting another remembered Server", async () => {
  const fixture = await connectedForgetFixture();
  const connections = fixture.connections.length;
  const status = await fixture.service.forgetRememberedServerConnection({ profileId: "forget-B" });
  expect(status.session.operationScope).toEqual(fixture.scope);
  expect(status.session.phase).toBe("connected");
  expect(fixture.observer.socket.readyState).toBe(WebSocket.OPEN);
  await expect(fixture.comments()).resolves.toEqual({ items: [], nextCursor: null });
  expect(fixture.connections).toHaveLength(connections);
  expect(await fixture.vault.getDeviceToken("forget-B")).toBeUndefined();
});

it("retires the matching project even when the active Workspace belongs to another Server", async () => {
  const fixture = await connectedForgetFixture();
  await fixture.service.connectSession({ profileId: "forget-B" });
  await expect
    .poll(async () => (await fixture.service.getStatus()).session.detail)
    .toBe("observer:connected");
  const status = await fixture.service.forgetRememberedServerConnection({ profileId: "forget-B" });
  expect(status.workspaceConnection.profile?.profileId).toBe("forget-A");
  expect(status.session).toMatchObject({ phase: "idle", operationScope: null });
  await expect
    .poll(
      () =>
        fixture.connections.filter(
          (connection) =>
            connection.path.endsWith("/human/observe") &&
            connection.socket.readyState === WebSocket.OPEN
        ).length
    )
    .toBe(0);
});

it("keeps a different project session when forgetting the active Workspace Server", async () => {
  const fixture = await connectedForgetFixture();
  await fixture.service.connectSession({ profileId: "forget-B" });
  await expect
    .poll(async () => (await fixture.service.getStatus()).session.detail)
    .toBe("observer:connected");
  const scope = (await fixture.service.getStatus()).session.operationScope;
  const status = await fixture.service.forgetRememberedServerConnection({ profileId: "forget-A" });
  expect(status.workspaceConnection.status).toBe("local_only");
  expect(status.session.operationScope).toEqual(scope);
  expect(status.session.phase).toBe("connected");
  await expect(
    fixture.service.listComments({
      operationScope: scope,
      workItem: { kind: "task", canvasId: "default", taskId: "T-001" }
    })
  ).resolves.toEqual({
    items: [],
    nextCursor: null
  });
});

it.each([
  ["unknown-profile", "remembered_server_unknown"],
  ["planweave-local-test", "remembered_server_local_profile_forbidden"]
])("validates forgotten target %s before retiring the active project", async (profileId, code) => {
  const fixture = await connectedForgetFixture();
  await expect(
    fixture.service.forgetRememberedServerConnection({ profileId })
  ).rejects.toMatchObject({
    code
  });
  expect((await fixture.service.getStatus()).session.operationScope).toEqual(fixture.scope);
  expect(fixture.observer.socket.readyState).toBe(WebSocket.OPEN);
  await expect(fixture.comments()).resolves.toEqual({ items: [], nextCursor: null });
});

it("reports snapshot flush failure after detaching the project and keeps the remembered credential for retry", async () => {
  const fixture = await connectedForgetFixture();
  fixture.cache.nextFlush = async () => {
    throw new Error("forget_snapshot_flush_failed");
  };
  await expect(
    fixture.service.forgetRememberedServerConnection({ profileId: "forget-A" })
  ).rejects.toThrow("forget_snapshot_flush_failed");
  const status = await fixture.service.getStatus();
  expect(status.session).toMatchObject({ phase: "error", operationScope: null });
  expect(await fixture.vault.getDeviceToken("forget-A")).toBeTruthy();
  expect(await fixture.workspaceProfiles.get("forget-A")).not.toBeNull();
  await expect.poll(() => fixture.observer.socket.readyState).toBe(WebSocket.CLOSED);
  const requests = fixture.requests.length;
  await expect(fixture.comments()).rejects.toMatchObject({
    code: "collaboration_operation_scope_stale"
  });
  expect(fixture.requests).toHaveLength(requests);
  await fixture.service.forgetRememberedServerConnection({ profileId: "forget-A" });
  expect(await fixture.vault.getDeviceToken("forget-A")).toBeUndefined();
});

it("exposes credential persistence failure after retiring the matching project", async () => {
  const fixture = await connectedForgetFixture();
  await mkdir(join(fixture.root, "credentials.json.tmp"));
  await expect(
    fixture.service.forgetRememberedServerConnection({ profileId: "forget-A" })
  ).rejects.toThrow();
  expect((await fixture.service.getStatus()).session.operationScope).toBeNull();
  await expect.poll(() => fixture.observer.socket.readyState).toBe(WebSocket.CLOSED);
});

it("keeps a different project scope when forgetting the active Workspace fails to persist", async () => {
  const fixture = await connectedForgetFixture();
  await fixture.service.connectSession({ profileId: "forget-B" });
  await expect
    .poll(async () => (await fixture.service.getStatus()).session.detail)
    .toBe("observer:connected");
  const scope = (await fixture.service.getStatus()).session.operationScope;
  await mkdir(join(fixture.root, "credentials.json.tmp"));
  await expect(
    fixture.service.forgetRememberedServerConnection({ profileId: "forget-A" })
  ).rejects.toThrow();
  expect((await fixture.service.getStatus()).session.operationScope).toEqual(scope);
  await expect(
    fixture.service.listComments({
      operationScope: scope,
      workItem: { kind: "task", canvasId: "default", taskId: "T-001" }
    })
  ).resolves.toEqual({
    items: [],
    nextCursor: null
  });
});
