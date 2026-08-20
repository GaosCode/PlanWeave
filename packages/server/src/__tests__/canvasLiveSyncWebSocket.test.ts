import { createServer, type Server as HttpServer } from "node:http";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { canvasCommandServerMessageSchema } from "@planweave-ai/collaboration-protocol/canvas/commands";
import { CanvasCommandRepository } from "../canvas/repository.js";
import { ContentVersionRepository } from "../canvas/contentVersionRepository.js";
import { attachCanvasLiveSyncWebSocketServer } from "../canvas/canvasLiveSyncWebSocket.js";
import { attachCanvasCommandWebSocketServer } from "../canvas/ws.js";
import { CanvasCommandService } from "../canvas/service.js";
import { SqliteAuthoritativeCanvasCommitStore } from "../canvas/sqliteAuthoritativeCanvasCommitStore.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { WebSocketUpgradeRouter } from "../webSocketUpgradeRouter.js";
import {
  canonicalContentVersionDigestPayload,
  type CompleteContentVersion
} from "@planweave-ai/collaboration-protocol/content/version";
import {
  AUTHORIZATION_SAFETY_CHECK_INTERVAL_MS,
  AuthorizationChangeSignal
} from "../authorizationChangeSignal.js";

const servers: HttpServer[] = [];
const databases: SqliteDatabase[] = [];
const liveServers: Array<{ close(): Promise<void> }> = [];
const sockets: WebSocket[] = [];

function initialContent(): CompleteContentVersion {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const members = [
    {
      kind: "desktop_layout" as const,
      path: "desktop/layout.json",
      content: JSON.stringify({
        version: "desktop-layout/v1",
        projectId: "project-live",
        nodes: [],
        updatedAt: "2026-08-02T00:00:00.000Z"
      })
    },
    {
      kind: "manifest" as const,
      path: "manifest.json",
      content: JSON.stringify({
        version: "plan-package/v1",
        project: { title: "Plan", description: "" },
        execution: { parallel: { enabled: false, maxConcurrent: 1 } },
        review: { maxFeedbackCycles: 1, completionPolicy: "strict" },
        executors: {},
        nodes: [
          {
            id: "T-001",
            type: "task",
            title: "Task",
            prompt: "nodes/T-001/prompt.md",
            acceptance: ["done"],
            blocks: [
              {
                id: "B-001",
                type: "implementation",
                title: "Block",
                prompt: "nodes/T-001/blocks/B-001.prompt.md"
              }
            ]
          }
        ],
        edges: []
      })
    },
    { kind: "task_prompt" as const, path: "nodes/T-001/prompt.md", content: "# Task\n" },
    {
      kind: "block_prompt" as const,
      path: "nodes/T-001/blocks/B-001.prompt.md",
      content: "# Block\n"
    }
  ]
    .map((member) => ({
      ...member,
      digestSha256: digest(member.content),
      sizeBytes: Buffer.byteLength(member.content, "utf8")
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const totalBytes = members.reduce((sum, member) => sum + member.sizeBytes, 0);
  return {
    members,
    totalBytes,
    canonicalDigest: digest(
      canonicalContentVersionDigestPayload({ members, totalBytes, canonicalDigest: "0".repeat(64) })
    )
  };
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of liveServers.splice(0)) await server.close();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

async function setup(
  options: {
    publishAuthorizationChanges?: boolean;
    authCheckIntervalMs?: number;
    withoutRuntimePaths?: boolean;
  } = {}
) {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const workspaceId = workspaceIdentity.ensureWorkspaceForLegacyProject("project-live");
  const identity = new HumanIdentityRepository(database);
  const owner = identity.bootstrapOwner({
    kind: "local_administrative_proof",
    projectId: "project-live",
    humanPrincipalId: "owner",
    displayName: "Owner",
    issuedAt: "2026-08-02T00:00:00.000Z"
  });
  const invitation = identity.createInvitation({
    projectId: "project-live",
    createdByHumanPrincipalId: "owner"
  });
  const viewer = identity.consumeInvitation({
    projectId: "project-live",
    invitationToken: invitation.invitationToken,
    displayName: "Viewer"
  });
  const authorizationChanges = new AuthorizationChangeSignal();
  const access = new ProjectAccessRepository(
    database,
    () => new Date("2026-08-02T00:00:00.000Z"),
    options.publishAuthorizationChanges === false
      ? undefined
      : (change) => authorizationChanges.publish(change)
  );
  access.registerProjectInternal({
    workspaceId,
    projectId: "project-live",
    projectRoot: "/srv/project-live",
    ownerHumanPrincipalId: "owner"
  });
  access.registerCanvasInternal({
    workspaceId,
    projectId: "project-live",
    canvasId: "default",
    packageDir: "/srv/project-live/default",
    ownerHumanPrincipalId: "owner"
  });
  access.markCanvasCutover(workspaceId, "project-live", "default");
  access.finalizeProjectCutover(workspaceId, "project-live");
  if (options.withoutRuntimePaths) {
    database.exec(`
      UPDATE project_registry SET project_root_internal=NULL WHERE project_id='project-live';
      UPDATE canvas_registry SET package_dir_internal=NULL
      WHERE project_id='project-live' AND canvas_id='default';
    `);
  }
  const viewerGrant = access.grant({
    workspaceId,
    projectId: "project-live",
    canvasId: "default",
    humanPrincipalId: viewer.principal.humanPrincipalId,
    role: "viewer",
    grantedBy: { kind: "human", id: "owner" }
  });
  const repository = new CanvasCommandRepository(database, {
    clock: () => new Date("2026-08-02T00:00:00.000Z")
  });
  const contentVersions = new ContentVersionRepository(
    database,
    () => new Date("2026-08-02T00:00:00.000Z")
  );
  contentVersions.publishInitial({
    scope: { workspaceId, projectId: "project-live", canvasId: "default" },
    content: initialContent(),
    createdBy: { kind: "human", id: "owner", displayName: "Owner" }
  });
  const httpServer = createServer();
  servers.push(httpServer);
  const router = new WebSocketUpgradeRouter(httpServer);
  const projectAuthority = {
    hasScope: (scope: { workspaceId: string; projectId: string; canvasId: string }) =>
      scope.workspaceId === workspaceId &&
      scope.projectId === "project-live" &&
      scope.canvasId === "default",
    hasProject: (projectId: string) => projectId === "project-live"
  };
  const live = attachCanvasLiveSyncWebSocketServer({
    upgradeRouter: router,
    repository,
    contentVersions,
    identityRepository: identity,
    workspaceIdentity,
    projectAccess: access,
    projectAuthority,
    authorizationChanges,
    maxPayloadBytes: 64 * 1024,
    shutdownTimeoutMs: 1_000,
    transportAdmission: loopbackHttpTransportAdmission,
    authCheckIntervalMs: options.authCheckIntervalMs
  });
  liveServers.push(live);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("expected TCP listener");
  return {
    database,
    identity,
    router,
    projectAuthority,
    live,
    access,
    workspaceIdentity,
    repository,
    contentVersions,
    authorizationChanges,
    scope: { workspaceId, projectId: "project-live", canvasId: "default" },
    ownerToken: owner.deviceToken,
    viewerToken: viewer.deviceToken,
    viewerGrantId: viewerGrant.grantId,
    url: `ws://127.0.0.1:${address.port}/api/v1/projects/project-live/canvases/default/human/live`,
    commandUrl: `ws://127.0.0.1:${address.port}/api/v1/projects/project-live/canvases/default/human/commands`
  };
}

async function connect(url: string, token: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("canvas_live_sync_message_timeout")), 3_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

function nextMessages(socket: WebSocket, count: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("canvas_live_sync_messages_timeout"));
    }, 3_000);
    const onMessage = (data: Buffer) => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
      if (messages.length !== count) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(messages);
    };
    socket.on("message", onMessage);
  });
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

function hello(socket: WebSocket, lastRevision: number): void {
  socket.send(
    JSON.stringify({
      type: "canvas.live.hello",
      protocolVersion: 1,
      projectId: "project-live",
      canvasId: "default",
      lastRevision
    })
  );
}

function commit(
  repository: CanvasCommandRepository,
  scope: { workspaceId: string; projectId: string; canvasId: string },
  revision: number
) {
  const digest = String(revision).repeat(64);
  const accepted = repository.commitAccepted({
    scope,
    operationId: `op-live-${revision}`,
    intent: {
      kind: "update_task_prompt",
      taskId: "T-001",
      promptMarkdown: `# revision ${revision}`
    },
    intentDigest: "a".repeat(64),
    actor: { kind: "human", id: "owner", displayName: "Owner" },
    previousRevision: revision - 1,
    revision,
    contentDigest: digest
  });
  const entry = repository.journalEntryAt(scope, accepted.revision);
  if (!entry) throw new Error("expected committed journal entry");
  return entry;
}

describe("canvas live sync WebSocket", () => {
  it("uses a 30-second authorization safety interval instead of per-socket 250ms polling", () => {
    expect(AUTHORIZATION_SAFETY_CHECK_INTERVAL_MS).toBe(30_000);
  });

  it("allows owner and viewer subscriptions, broadcasts ordered entries, and never accepts mutation frames", async () => {
    const fixture = await setup();
    const owner = await connect(fixture.url, fixture.ownerToken);
    const viewer = await connect(fixture.url, fixture.viewerToken);

    const ownerWelcome = nextMessage(owner);
    hello(owner, 0);
    await expect(ownerWelcome).resolves.toMatchObject({
      type: "canvas.live.welcome",
      headRevision: 0
    });
    const viewerWelcome = nextMessage(viewer);
    hello(viewer, 0);
    await expect(viewerWelcome).resolves.toMatchObject({
      type: "canvas.live.welcome",
      headRevision: 0
    });

    const ownerFirst = nextMessage(owner);
    const viewerFirst = nextMessage(viewer);
    fixture.live.publishAcceptedEntry(commit(fixture.repository, fixture.scope, 1));
    await expect(ownerFirst).resolves.toMatchObject({
      type: "canvas.live.accepted_entry",
      entry: { revision: 1, previousRevision: 0, operationId: "op-live-1" }
    });
    await expect(viewerFirst).resolves.toMatchObject({
      type: "canvas.live.accepted_entry",
      entry: { revision: 1, previousRevision: 0 }
    });

    const ownerSecond = nextMessage(owner);
    const viewerSecond = nextMessage(viewer);
    fixture.live.publishAcceptedEntry(commit(fixture.repository, fixture.scope, 2));
    await expect(ownerSecond).resolves.toMatchObject({
      type: "canvas.live.accepted_entry",
      entry: { revision: 2, previousRevision: 1 }
    });
    await expect(viewerSecond).resolves.toMatchObject({
      type: "canvas.live.accepted_entry",
      entry: { revision: 2, previousRevision: 1 }
    });

    const rejected = nextMessage(viewer);
    viewer.send(JSON.stringify({ type: "canvas.command.submit", protocolVersion: 1 }));
    await expect(rejected).resolves.toMatchObject({
      type: "canvas.live.error",
      code: "invalid_message"
    });
    expect(fixture.repository.head(fixture.scope).revision).toBe(2);
  });

  it("connects and reauthorizes from the active registry without Runtime paths", async () => {
    const fixture = await setup({ withoutRuntimePaths: true });
    const owner = await connect(fixture.url, fixture.ownerToken);
    const welcome = nextMessage(owner);
    hello(owner, 0);
    await expect(welcome).resolves.toMatchObject({
      type: "canvas.live.welcome",
      headRevision: 0
    });

    const accepted = nextMessage(owner);
    fixture.live.publishAcceptedEntry(commit(fixture.repository, fixture.scope, 1));
    await expect(accepted).resolves.toMatchObject({
      type: "canvas.live.accepted_entry",
      entry: { revision: 1, previousRevision: 0 }
    });

    const expired = nextMessage(owner);
    const closed = waitForClose(owner);
    fixture.database.exec(
      "UPDATE canvas_registry SET revoked_at='2026-08-03T00:00:00.000Z' WHERE project_id='project-live' AND canvas_id='default'"
    );
    fixture.authorizationChanges.publish(fixture.scope);
    await expect(expired).resolves.toMatchObject({ type: "canvas.live.auth_expired" });
    await expect(closed).resolves.toBe(4003);
  });

  it("rejects unauthorized and cross-canvas subscriptions, and explicitly requires HTTP catchup", async () => {
    const fixture = await setup();
    const unauthenticated = new WebSocket(fixture.url, {
      headers: { Authorization: "Bearer invalid" }
    });
    await expect(
      new Promise<number>((resolve) =>
        unauthenticated.once("unexpected-response", (_request, response) =>
          resolve(response.statusCode)
        )
      )
    ).resolves.toBe(401);
    const crossCanvas = new WebSocket(fixture.url.replace("/default/", "/other/"), {
      headers: { Authorization: `Bearer ${fixture.ownerToken}` }
    });
    await expect(
      new Promise<number>((resolve) =>
        crossCanvas.once("unexpected-response", (_request, response) =>
          resolve(response.statusCode)
        )
      )
    ).resolves.toBe(403);

    commit(fixture.repository, fixture.scope, 1);
    const owner = await connect(fixture.url, fixture.ownerToken);
    const welcomeAndCatchup = nextMessages(owner, 2);
    const closed = waitForClose(owner);
    hello(owner, 0);
    const [welcome, catchup] = await welcomeAndCatchup;
    expect(welcome).toMatchObject({ type: "canvas.live.welcome", headRevision: 1 });
    expect(catchup).toMatchObject({
      type: "canvas.live.catchup_required",
      reason: "revision_behind",
      recovery: "http_reconnect",
      headRevision: 1
    });
    await expect(closed).resolves.toBe(4004);
  });

  it("does not leak an accepted entry after the subscriber's canvas read grant is revoked", async () => {
    const fixture = await setup();
    const viewer = await connect(fixture.url, fixture.viewerToken);
    const welcome = nextMessage(viewer);
    hello(viewer, 0);
    await expect(welcome).resolves.toMatchObject({ type: "canvas.live.welcome" });

    fixture.access.revoke({
      workspaceId: fixture.scope.workspaceId,
      projectId: fixture.scope.projectId,
      canvasId: fixture.scope.canvasId,
      grantId: fixture.viewerGrantId,
      actor: { kind: "human", id: "owner" },
      expectedAclRevision: 1
    });
    const expired = nextMessage(viewer);
    const closed = waitForClose(viewer);
    fixture.live.publishAcceptedEntry(commit(fixture.repository, fixture.scope, 1));
    await expect(expired).resolves.toMatchObject({
      type: "canvas.live.auth_expired",
      code: "forbidden"
    });
    await expect(closed).resolves.toBe(4003);
  });

  it("keeps unrelated authorization changes scoped and removes the subscription on close", async () => {
    const fixture = await setup();
    const owner = await connect(fixture.url, fixture.ownerToken);
    const welcome = nextMessage(owner);
    hello(owner, 0);
    await expect(welcome).resolves.toMatchObject({ type: "canvas.live.welcome" });
    expect(fixture.authorizationChanges.subscriberCount()).toBe(1);

    for (const change of [
      { ...fixture.scope, projectId: "other-project" },
      { ...fixture.scope, humanPrincipalId: "other-principal" },
      { ...fixture.scope, deviceSessionId: "other-device" },
      fixture.scope
    ]) {
      fixture.authorizationChanges.publish(change);
    }
    const pong = nextMessage(owner);
    owner.send(JSON.stringify({ type: "canvas.live.ping", protocolVersion: 1 }));
    await expect(pong).resolves.toMatchObject({ type: "canvas.live.pong" });

    const closed = waitForClose(owner);
    owner.close(1000, "test complete");
    await expect(closed).resolves.toBe(1000);
    await vi.waitFor(() => expect(fixture.authorizationChanges.subscriberCount()).toBe(0));
  });

  it("uses the safety timer to detect a missed authorization signal", async () => {
    const fixture = await setup({ publishAuthorizationChanges: false, authCheckIntervalMs: 25 });
    const viewer = await connect(fixture.url, fixture.viewerToken);
    const welcome = nextMessage(viewer);
    hello(viewer, 0);
    await expect(welcome).resolves.toMatchObject({ type: "canvas.live.welcome" });
    const expired = nextMessage(viewer);
    const closed = waitForClose(viewer);

    fixture.access.revoke({
      workspaceId: fixture.scope.workspaceId,
      projectId: fixture.scope.projectId,
      canvasId: fixture.scope.canvasId,
      grantId: fixture.viewerGrantId,
      actor: { kind: "human", id: "owner" },
      expectedAclRevision: 1
    });

    await expect(expired).resolves.toMatchObject({
      type: "canvas.live.auth_expired",
      code: "forbidden"
    });
    await expect(closed).resolves.toBe(4003);
  });

  it("forces connected clients to HTTP recovery when post-commit publication throws", async () => {
    const fixture = await setup();
    const owner = await connect(fixture.url, fixture.ownerToken);
    const welcome = nextMessage(owner);
    hello(owner, 0);
    await expect(welcome).resolves.toMatchObject({ type: "canvas.live.welcome" });
    const service = new CanvasCommandService({
      repository: fixture.repository,
      access: fixture.access,
      workspaceIdentity: fixture.workspaceIdentity,
      runtime: {
        async apply(input) {
          const contentDigest = "c".repeat(64);
          return {
            ok: true as const,
            contentDigest,
            digestManifest: {
              manifest: { digestSha256: contentDigest, sizeBytes: 1 },
              prompts: [],
              totalBytes: 1
            },
            packageDir: String(input.projectRoot),
            sizeBytes: 1
          };
        },
        async readDigest(input) {
          const contentDigest = "b".repeat(64);
          return {
            ok: true as const,
            contentDigest,
            digestManifest: {
              manifest: { digestSha256: contentDigest, sizeBytes: 1 },
              prompts: [],
              totalBytes: 1
            },
            packageDir: String(input.projectRoot),
            sizeBytes: 1
          };
        }
      },
      contentVersions: fixture.contentVersions,
      authoritativeCommits: new SqliteAuthoritativeCanvasCommitStore(
        fixture.database,
        fixture.contentVersions,
        fixture.repository
      ),
      onAcceptedEntry: () => {
        throw new Error("live_publish_failed");
      },
      onAcceptedEntryUnavailable: (input) => fixture.live.invalidateScope(input)
    });
    const recovery = nextMessage(owner);
    const closed = waitForClose(owner);
    const outcome = await service.submit(
      {
        humanPrincipalId: "owner",
        displayName: "Owner",
        deviceCredentialId: "device-owner",
        projectId: fixture.scope.projectId,
        role: "owner",
        membershipId: "membership-owner"
      },
      {
        type: "canvas.command.submit",
        protocolVersion: 1,
        schemaVersion: "canvas-command/v1",
        projectId: fixture.scope.projectId,
        canvasId: fixture.scope.canvasId,
        operationId: "op-live-publication-throws",
        expectedRevision: 0,
        intent: {
          kind: "update_task_prompt",
          taskId: "T-001",
          promptMarkdown: "# publish failure"
        }
      }
    );
    expect(outcome).toMatchObject({ type: "canvas.command.accepted", revision: 1 });
    await expect(recovery).resolves.toMatchObject({
      type: "canvas.live.catchup_required",
      recovery: "http_reconnect",
      headRevision: 1
    });
    await expect(closed).resolves.toBe(4004);
  });

  it("sends a schema-valid repair-required outcome on the command WebSocket", async () => {
    const fixture = await setup();
    const service = new CanvasCommandService({
      repository: fixture.repository,
      access: fixture.access,
      workspaceIdentity: fixture.workspaceIdentity,
      runtime: {
        async apply(input) {
          const contentDigest = "c".repeat(64);
          return {
            ok: true as const,
            contentDigest,
            digestManifest: {
              manifest: { digestSha256: contentDigest, sizeBytes: 1 },
              prompts: [],
              totalBytes: 1
            },
            packageDir: String(input.projectRoot),
            sizeBytes: 1
          };
        },
        async readDigest(input) {
          const contentDigest = "b".repeat(64);
          return {
            ok: true as const,
            contentDigest,
            digestManifest: {
              manifest: { digestSha256: contentDigest, sizeBytes: 1 },
              prompts: [],
              totalBytes: 1
            },
            packageDir: String(input.projectRoot),
            sizeBytes: 1
          };
        }
      },
      contentVersions: fixture.contentVersions,
      authoritativeCommits: new SqliteAuthoritativeCanvasCommitStore(
        fixture.database,
        fixture.contentVersions,
        fixture.repository
      )
    });
    const commands = attachCanvasCommandWebSocketServer({
      upgradeRouter: fixture.router,
      service,
      repository: fixture.identity,
      workspaceIdentity: fixture.workspaceIdentity,
      projectAuthority: fixture.projectAuthority,
      authorizationChanges: fixture.authorizationChanges,
      maxPayloadBytes: 64 * 1024,
      shutdownTimeoutMs: 1_000,
      transportAdmission: loopbackHttpTransportAdmission
    });
    liveServers.push(commands);
    fixture.database.exec(`
      CREATE TRIGGER corrupt_canvas_receipt_over_websocket
      BEFORE INSERT ON canvas_command_operation_receipts
      BEGIN
        UPDATE canvas_command_operation_retention_scopes
           SET status='repair_required',failure_code='injected_websocket_corruption';
      END
    `);
    const socket = await connect(fixture.commandUrl, fixture.ownerToken);
    const received = nextMessage(socket);
    socket.send(
      JSON.stringify({
        type: "canvas.command.submit",
        protocolVersion: 1,
        schemaVersion: "canvas-command/v1",
        projectId: "project-live",
        canvasId: "default",
        operationId: "op-websocket-corruption",
        expectedRevision: 0,
        intent: {
          kind: "update_task_prompt",
          taskId: "T-001",
          promptMarkdown: "# corrupt receipt"
        }
      })
    );

    expect(canvasCommandServerMessageSchema.parse(await received)).toMatchObject({
      type: "canvas.command.rejected",
      operationId: "op-websocket-corruption",
      code: "server_error",
      detail: "canvas_operation_retention_repair_required"
    });
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS count FROM canvas_command_pending_scopes").get()
        ?.count
    ).toBe(1);
    expect(
      fixture.database.prepare("SELECT status FROM canvas_command_operation_retention_scopes").get()
        ?.status
    ).toBe("repair_required");

    expect(fixture.authorizationChanges.subscriberCount()).toBe(1);
    const closed = waitForClose(socket);
    vi.spyOn(fixture.projectAuthority, "hasScope").mockReturnValue(false);
    fixture.authorizationChanges.publish({
      workspaceId: fixture.scope.workspaceId,
      projectId: fixture.scope.projectId,
      humanPrincipalId: "owner"
    });
    await expect(closed).resolves.toBe(4001);
    await vi.waitFor(() => expect(fixture.authorizationChanges.subscriberCount()).toBe(0));
  });

  it("invalidates subscribers from accepted head data without reading the journal repository", async () => {
    const fixture = await setup();
    const owner = await connect(fixture.url, fixture.ownerToken);
    const welcome = nextMessage(owner);
    hello(owner, 0);
    await expect(welcome).resolves.toMatchObject({ type: "canvas.live.welcome" });
    vi.spyOn(fixture.repository, "head").mockImplementation(() => {
      throw new Error("journal_unavailable");
    });
    const recovery = nextMessage(owner);
    const closed = waitForClose(owner);
    fixture.live.invalidateScope({
      scope: fixture.scope,
      headRevision: 1,
      headContentDigest: "a".repeat(64)
    });
    await expect(recovery).resolves.toMatchObject({
      type: "canvas.live.catchup_required",
      headRevision: 1,
      headContentDigest: "a".repeat(64)
    });
    await expect(closed).resolves.toBe(4004);
  });

  it("closes and releases subscribers on second-head and publication-gap catchup", async () => {
    const fixture = await setup();
    const head = fixture.repository.head(fixture.scope);
    vi.spyOn(fixture.repository, "head")
      .mockReturnValueOnce(head)
      .mockReturnValueOnce({
        revision: 1,
        contentDigest: "b".repeat(64),
        updatedAt: head.updatedAt
      });
    const secondHeadSocket = await connect(fixture.url, fixture.ownerToken);
    const secondHeadMessages = nextMessages(secondHeadSocket, 2);
    const secondHeadClosed = waitForClose(secondHeadSocket);
    hello(secondHeadSocket, 0);
    const [welcome, catchup] = await secondHeadMessages;
    expect(welcome).toMatchObject({ type: "canvas.live.welcome", headRevision: 1 });
    expect(catchup).toMatchObject({ type: "canvas.live.catchup_required", reason: "head_changed" });
    await expect(secondHeadClosed).resolves.toBe(4004);

    vi.restoreAllMocks();
    const gapSocket = await connect(fixture.url, fixture.ownerToken);
    const gapWelcome = nextMessage(gapSocket);
    hello(gapSocket, 0);
    await expect(gapWelcome).resolves.toMatchObject({
      type: "canvas.live.welcome",
      headRevision: 0
    });
    commit(fixture.repository, fixture.scope, 1);
    const catchupMessage = nextMessage(gapSocket);
    const gapClosed = waitForClose(gapSocket);
    fixture.live.publishAcceptedEntry(commit(fixture.repository, fixture.scope, 2));
    await expect(catchupMessage).resolves.toMatchObject({
      type: "canvas.live.catchup_required",
      reason: "head_changed",
      recovery: "http_reconnect",
      headRevision: 2
    });
    await expect(gapClosed).resolves.toBe(4004);
  });
});
