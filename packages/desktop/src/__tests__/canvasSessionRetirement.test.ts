import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  accessCapabilityFlags,
  currentCanvasAccessViewSchema
} from "@planweave-ai/collaboration-protocol/access/control";
import { contentVersionTransferMediaType } from "@planweave-ai/collaboration-protocol/content/transfer";
import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  exampleHumanDeviceToken,
  exampleObserverWelcome
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { encodeCanvasReplicaDocument, parseCanvasReplicaDocument } from "@planweave-ai/runtime";
import { basicManifest } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import { CollaborationService } from "../main/collaboration/CollaborationService.js";
import { CollaborationCredentialVault } from "../main/collaboration/collaborationCredentialVault.js";
import { WorkspaceConnectionProfileStore } from "../main/collaboration/workspaceConnectionProfileStore.js";
import { WorkspaceAuthoritativeSnapshotCache } from "../main/collaboration/WorkspaceAuthoritativeSnapshotCache.js";
import { createApplicationCredentialStorage } from "../main/credentialStorage/applicationCredentialStorage.js";
import type { WorkspaceCanvasProjection } from "../shared/workspaceCanvasProjection.js";

class TestSocket extends WebSocket {
  constructor(url: string, options?: string | string[] | { headers?: Record<string, string> }) {
    const protocols = typeof options === "string" || Array.isArray(options) ? options : undefined;
    const config = typeof options === "string" || Array.isArray(options) ? undefined : options;
    super(url, protocols, config);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class HeldSnapshotCache extends WorkspaceAuthoritativeSnapshotCache {
  readonly writeEntered = deferred();
  readonly writeRelease = deferred();
  readonly flushEntered = deferred();
  watchFlush = false;
  nextWrite: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null =
    null;

  override async put(input: Parameters<WorkspaceAuthoritativeSnapshotCache["put"]>[0]) {
    this.writeEntered.resolve();
    await this.writeRelease.promise;
    const nextWrite = this.nextWrite;
    this.nextWrite = null;
    if (nextWrite) {
      nextWrite.entered.resolve();
      await nextWrite.release.promise;
    }
    return super.put(input);
  }

  override async flush(): Promise<void> {
    if (this.watchFlush) this.flushEntered.resolve();
    await super.flush();
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connectedCanvasFixture(expectWriteFailure = false) {
  const root = await mkdtemp(join(tmpdir(), "pw-canvas-retirement-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const scope = {
    workspaceId: workspaceIdSchema.parse("workspace-retirement"),
    projectId: exampleObserverWelcome.projectId,
    canvasId: "default"
  };
  const profileId = "canvas-retirement";
  const locator = { kind: "workspace" as const, connectionProfileId: profileId, ...scope };
  const manifest = basicManifest();
  const content = encodeCanvasReplicaDocument(
    parseCanvasReplicaDocument({
      schemaVersion: "canvas-replica-document/v1",
      manifest,
      promptMarkdownByPath: Object.fromEntries(
        manifest.nodes.flatMap((task) => [
          [task.prompt, `# ${task.id}\n`],
          ...task.blocks.map((block) => [block.prompt, `# ${block.id}\n`])
        ])
      ),
      layout: {
        version: "desktop-layout/v1",
        projectId: scope.projectId,
        nodes: [{ nodeId: "T-001", x: 10, y: 20 }],
        updatedAt: "2026-08-02T00:00:00.000Z"
      }
    })
  );
  const completed = {
    versionId: `version-${content.canonicalDigest}`,
    canonicalDigest: content.canonicalDigest,
    verification: "complete"
  };
  const projectScope = { scopeKind: "project", ...scope, canvasId: null };
  const canvasScope = { scopeKind: "canvas", ...scope };
  const access = currentCanvasAccessViewSchema.parse({
    scope: canvasScope,
    projectVisibility: "shared",
    canvasVisibility: "shared",
    projectAclRevision: 1,
    canvasAclRevision: 1,
    project: {
      scope: projectScope,
      aclRevision: 1,
      effectiveRole: "owner",
      roleSource: "scope_owner",
      capabilities: accessCapabilityFlags("owner"),
      disabledReason: null
    },
    canvas: {
      scope: canvasScope,
      aclRevision: 1,
      effectiveRole: "owner",
      roleSource: "scope_owner",
      capabilities: accessCapabilityFlags("owner"),
      disabledReason: null
    },
    people: []
  });
  const accessEntered = deferred();
  const accessRelease = deferred();
  const commentEntered = deferred();
  const commentRelease = deferred();
  const secondLiveConnection = deferred();
  let holdAccess = false;
  let accessFails = false;
  let holdComments = false;
  const requests: Array<{ path: string; originalCredential: boolean }> = [];
  const liveConnections: WebSocket[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const originalCredential =
      request.headers.authorization === `Bearer ${exampleHumanDeviceToken}`;
    requests.push({ path, originalCredential });
    if (!originalCredential) {
      response.writeHead(401).end();
      return;
    }
    if (path.endsWith("/content/fetch")) {
      response.writeHead(200, { "content-type": contentVersionTransferMediaType });
      const frames = [
        {
          type: "header",
          schemaVersion: "content-version/v1",
          scope,
          completed,
          canonicalDigest: content.canonicalDigest,
          totalBytes: content.totalBytes,
          memberCount: content.members.length,
          createdAt: "2026-08-02T00:00:00.000Z",
          createdBy: { kind: "human", id: "human-retirement", displayName: "Retirement" }
        },
        ...content.members.map((member, index) => ({ type: "member", index, member })),
        {
          type: "complete",
          canonicalDigest: content.canonicalDigest,
          totalBytes: content.totalBytes,
          memberCount: content.members.length
        }
      ];
      response.end(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`);
      return;
    }
    let body: unknown = { items: [], nextCursor: null };
    if (path.endsWith("/access")) {
      if (holdAccess) {
        accessEntered.resolve();
        await accessRelease.promise;
        if (accessFails) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ code: "temporarily_unavailable", message: "Retry later" }));
          return;
        }
      }
      body = access;
    } else if (path.endsWith("/reconnect")) {
      let text = "";
      for await (const chunk of request) text += chunk;
      const { afterRevision } = JSON.parse(text);
      body =
        afterRevision === 0
          ? {
              type: "canvas.reconnect.snapshot",
              protocolVersion: 1,
              schemaVersion: "canvas-command/v1",
              scope,
              reason: "truncated_journal",
              afterRevision: 0,
              snapshot: {
                metadata: {
                  schemaVersion: "canvas-snapshot/v2",
                  scope,
                  revision: 1,
                  contentDigest: content.canonicalDigest,
                  createdAt: "2026-08-02T00:00:00.000Z",
                  sizeBytes: content.totalBytes
                },
                encoding: "content_version_ref",
                content: completed
              }
            }
          : {
              type: "canvas.reconnect.delta",
              protocolVersion: 1,
              schemaVersion: "canvas-command/v1",
              scope,
              afterRevision,
              headRevision: 1,
              headContentDigest: content.canonicalDigest,
              entries: []
            };
    } else if (path.endsWith("/runtime-availability")) {
      body = {
        schemaVersion: "canvas-runtime-view/v1",
        state: { kind: "uninitialized" },
        execution: {
          schemaVersion: "canvas-runtime-availability/v1",
          kind: "unavailable",
          reason: "runtime_not_attached"
        }
      };
    } else if (holdComments && path.endsWith("/comments")) {
      commentEntered.resolve();
      await commentRelease.promise;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket, request) => {
    expect(request.headers.authorization).toBe(`Bearer ${exampleHumanDeviceToken}`);
    if (request.url?.includes("/live")) {
      liveConnections.push(socket);
      if (liveConnections.length === 2) secondLiveConnection.resolve();
    }
    socket.on("message", (bytes) => {
      const hello = JSON.parse(bytes.toString());
      if (hello.type === "human.observer.hello") {
        socket.send(JSON.stringify(exampleObserverWelcome));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("retirement_fixture_address");
  const origin = `http://127.0.0.1:${address.port}/`;
  cleanups.push(async () => {
    accessRelease.resolve();
    commentRelease.resolve();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      sockets.close((error) => (error ? reject(error) : resolve()))
    );
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });
  const cache = new HeldSnapshotCache(join(root, "snapshots"));
  const vault = new CollaborationCredentialVault({
    paths: { credentialsPath: join(root, "credentials.json") },
    safeStorage: createApplicationCredentialStorage({ keyPath: join(root, "credential.key") })
  });
  const profiles = new WorkspaceConnectionProfileStore({
    profilesPath: join(root, "workspaces.json")
  });
  const projections: WorkspaceCanvasProjection[] = [];
  const clients: CollaborationClient[] = [];
  const service = new CollaborationService({
    profileStorePaths: { profilesPath: join(root, "profiles.json") },
    workspaceProfileStore: profiles,
    vault,
    workspaceSnapshotCache: cache,
    invitationsPath: join(root, "invitations.json"),
    exportedIdentityPath: join(root, "identity.json"),
    onWorkspaceCanvasProjection: (projection) => projections.push(projection),
    createClient: (options) => {
      const client = new CollaborationClient({ ...options, WebSocketImpl: TestSocket });
      clients.push(client);
      return client;
    }
  });
  cleanups.push(async () => {
    accessRelease.resolve();
    commentRelease.resolve();
    cache.writeRelease.resolve();
    if (expectWriteFailure) {
      await service.shutdown().catch((error: unknown) => {
        expect(error).toMatchObject({ code: "collaboration_unknown" });
      });
    } else {
      await service.shutdown();
    }
  });
  await service.upsertProfile({
    profileId,
    displayName: "Canvas retirement",
    serverBaseUrl: origin,
    projectId: scope.projectId,
    allowInsecureTransport: true,
    endpoint: {
      topology: "loopback_http",
      serverOrigin: origin,
      allowedClientOrigins: [origin],
      tlsTrust: "not_applicable"
    }
  });
  await service.importDeviceCredential({ profileId, deviceToken: exampleHumanDeviceToken });
  await profiles.upsert({
    profile: {
      schemaVersion: "workspace-identity/v1",
      profileId,
      displayName: "Canvas retirement",
      serverBaseUrl: origin,
      workspaceId: scope.workspaceId,
      allowInsecureTransport: true
    },
    workspaceDisplayName: "Canvas retirement",
    membershipRole: "owner",
    membershipActive: true
  });
  await service.adoptWorkspaceAuthority({
    profileId,
    workspaceId: scope.workspaceId,
    membershipRole: "owner"
  });
  await service.connectSession({ profileId });
  await service.openWorkspaceCanvasSession(locator);
  await cache.writeEntered.promise;
  await expect.poll(() => liveConnections.length).toBe(1);
  const client = clients.at(-1);
  const operationScope = (await service.getStatus()).session.operationScope;
  if (!client || !operationScope) throw new Error("retirement_fixture_session");
  const comments = () =>
    service.listComments({
      operationScope,
      workItem: { kind: "task", canvasId: scope.canvasId, taskId: "T-001" }
    });
  return {
    service,
    client,
    vault,
    profiles,
    cache,
    requests,
    liveConnections,
    projections,
    content,
    profileId,
    locator,
    operationScope,
    comments,
    secondLiveConnection,
    cacheKey: { connectionProfileId: profileId, serverOrigin: new URL(origin).origin, ...scope },
    holdComments() {
      holdComments = true;
      return { entered: commentEntered.promise, release: commentRelease.resolve };
    },
    async beginCatchup(fails: boolean) {
      holdAccess = true;
      accessFails = fails;
      const settled = deferred();
      const getAccess = client.getCurrentCanvasAccess.bind(client);
      vi.spyOn(client, "getCurrentCanvasAccess").mockImplementation(async (canvasId) => {
        try {
          return await getAccess(canvasId);
        } finally {
          settled.resolve();
        }
      });
      liveConnections[0].send(
        JSON.stringify({
          type: "canvas.live.catchup_required",
          protocolVersion: 1,
          projectId: scope.projectId,
          canvasId: scope.canvasId,
          reason: "head_changed",
          recovery: "http_reconnect",
          headRevision: 1,
          headContentDigest: content.canonicalDigest
        })
      );
      await accessEntered.promise;
      return { release: accessRelease.resolve, settled: settled.promise };
    }
  };
}

it.each([
  "success",
  "retryable failure",
  "waiting retry"
] as const)("retires Canvas catchup before forget waits for captured snapshots (late access %s)", async (result) => {
  const fixture = await connectedCanvasFixture();
  const pendingComments = fixture.holdComments();
  const admitted = fixture.comments();
  await pendingComments.entered;
  const catchup = await fixture.beginCatchup(result !== "success");
  const recovering = vi.spyOn(fixture.client, "reportLiveSyncCatchupRecovering");
  if (result === "waiting retry") {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    catchup.release();
    await catchup.settled;
    await setImmediate();
    expect(fixture.client.liveSyncState().state).toBe("catchup_recovering");
  }
  fixture.cache.watchFlush = true;
  const liveClosed = new Promise<void>((resolve) =>
    fixture.liveConnections[0].once("close", resolve)
  );
  let forgetFinished = false;
  const forgetting = fixture.service
    .forgetRememberedServerConnection({ profileId: fixture.profileId })
    .then((status) => {
      forgetFinished = true;
      return status;
    });
  await fixture.cache.flushEntered.promise;
  await liveClosed;
  const projectionCount = fixture.projections.length;
  const requestCount = fixture.requests.length;
  if (result !== "waiting retry") {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    catchup.release();
    await catchup.settled;
    // The real access body has been consumed; one event-loop turn drains its owner continuations.
    await setImmediate();
  }
  if (result === "success" && fixture.client.liveSyncState().state !== "stopped") {
    await fixture.secondLiveConnection.promise;
  }
  await vi.advanceTimersByTimeAsync(1_000);
  vi.useRealTimers();
  expect(fixture.liveConnections).toHaveLength(1);
  expect(fixture.client.liveSyncState().state).toBe("stopped");
  expect(recovering).not.toHaveBeenCalled();
  expect(fixture.requests).toHaveLength(requestCount);
  expect(fixture.service.getWorkspaceCanvasProjection()).toBeNull();
  expect(fixture.projections).toHaveLength(projectionCount);
  expect(forgetFinished).toBe(false);
  expect(await fixture.vault.getDeviceToken(fixture.profileId)).toBe(exampleHumanDeviceToken);
  await expect(fixture.comments()).rejects.toMatchObject({
    code: "collaboration_operation_scope_stale"
  });
  pendingComments.release();
  await expect(admitted).resolves.toEqual({ items: [], nextCursor: null });
  expect(fixture.requests.every((request) => request.originalCredential)).toBe(true);
  fixture.cache.writeRelease.resolve();
  const status = await forgetting;
  expect(status.session).toMatchObject({ phase: "idle", operationScope: null });
  expect(status.workspaceConnection.status).toBe("local_only");
  expect(await fixture.vault.getDeviceToken(fixture.profileId)).toBeUndefined();
  expect(await fixture.profiles.get(fixture.profileId)).toBeNull();
  const reopened = new WorkspaceAuthoritativeSnapshotCache(
    dirname(fixture.cache.pathForKey(fixture.cacheKey))
  );
  expect(await reopened.get(fixture.cacheKey)).toMatchObject({
    contentRevision: 1,
    contentDigest: fixture.content.canonicalDigest,
    content: fixture.content
  });
});

it.each([
  "forgetRememberedServerConnection",
  "removeProfile",
  "clearDeviceCredential",
  "setActiveProfile"
] as const)("keeps %s blocked until the retired Service snapshot is really persisted", async (action) => {
  const fixture = await connectedCanvasFixture(true);
  if (action === "setActiveProfile") {
    const profile = fixture.client.connectionProfile;
    await fixture.service.upsertProfile({
      profileId: "other-profile",
      displayName: "Other profile",
      serverBaseUrl: profile.serverBaseUrl,
      projectId: profile.projectId,
      endpoint: profile.endpoint,
      allowInsecureTransport: profile.allowInsecureTransport
    });
  }
  const retry = () =>
    fixture.service[action]({
      profileId: action === "setActiveProfile" ? "other-profile" : fixture.profileId
    });
  const directory = dirname(fixture.cache.pathForKey(fixture.cacheKey));
  await writeFile(directory, "snapshot directory blocked", "utf8");
  fixture.cache.watchFlush = true;
  const forgetting = fixture.service.forgetRememberedServerConnection({
    profileId: fixture.profileId
  });
  const outcome = forgetting.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  await fixture.cache.flushEntered.promise;
  expect(fixture.service.getWorkspaceCanvasProjection()).toBeNull();
  fixture.cache.writeRelease.resolve();
  await expect(outcome).resolves.toMatchObject({
    error: { code: "collaboration_unknown", message: expect.stringContaining("EEXIST") }
  });
  expect((await fixture.service.getStatus()).session).toMatchObject({
    phase: "error",
    detail: "remembered_server_forget_failed"
  });
  expect(fixture.client.liveSyncState().state).toBe("stopped");
  expect(await fixture.vault.getDeviceToken(fixture.profileId)).toBe(exampleHumanDeviceToken);
  expect(await fixture.profiles.get(fixture.profileId)).not.toBeNull();
  await expect(fixture.comments()).rejects.toMatchObject({
    code: "collaboration_operation_scope_stale"
  });
  try {
    await expect(retry()).rejects.toMatchObject({
      code: "collaboration_unknown",
      message: expect.stringContaining("EEXIST")
    });
    expect(await fixture.vault.getDeviceToken(fixture.profileId)).toBe(exampleHumanDeviceToken);
    expect(await fixture.profiles.get(fixture.profileId)).not.toBeNull();
    const status = await fixture.service.getStatus();
    expect(status.profiles.some((profile) => profile.profileId === fixture.profileId)).toBe(true);
    expect(status.activeProfileId).toBe(fixture.profileId);
    expect(fixture.service.getWorkspaceCanvasProjection()).toBeNull();
  } finally {
    await rm(directory);
  }
  const retryWrite = { entered: deferred(), release: deferred() };
  fixture.cache.nextWrite = retryWrite;
  const recovering = retry();
  try {
    await retryWrite.entered.promise;
    expect(await fixture.vault.getDeviceToken(fixture.profileId)).toBe(exampleHumanDeviceToken);
    expect(await fixture.profiles.get(fixture.profileId)).not.toBeNull();
    expect(
      await new WorkspaceAuthoritativeSnapshotCache(directory).get(fixture.cacheKey)
    ).toBeNull();
  } finally {
    retryWrite.release.resolve();
  }
  const status = await recovering;
  expect(
    await new WorkspaceAuthoritativeSnapshotCache(directory).get(fixture.cacheKey)
  ).toMatchObject({
    contentRevision: 1,
    contentDigest: fixture.content.canonicalDigest,
    content: fixture.content
  });
  expect(status.session.operationScope).toBeNull();
  expect(await fixture.vault.getDeviceToken(fixture.profileId)).toBe(
    action === "setActiveProfile" ? exampleHumanDeviceToken : undefined
  );
  if (action === "forgetRememberedServerConnection") {
    expect(status.session.phase).toBe("idle");
    expect(status.workspaceConnection.status).toBe("local_only");
    expect(await fixture.profiles.get(fixture.profileId)).toBeNull();
  } else if (action === "setActiveProfile") {
    expect(status.activeProfileId).toBe("other-profile");
  } else if (action === "removeProfile") {
    expect(status.profiles.some((profile) => profile.profileId === fixture.profileId)).toBe(false);
  }
});
