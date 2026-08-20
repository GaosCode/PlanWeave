import { createServer, type Server as HttpServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  applyDefaultCanvasWorkspaceMigration,
  resolveTaskCanvasWorkspace,
  saveDesktopLayout
} from "@planweave-ai/runtime";
import { CANVAS_COMMAND_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import { exampleHumanDeviceToken } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { type HumanObserverEvent } from "@planweave-ai/collaboration-protocol/activity/observer";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { parseServerConfig } from "../../../server/src/config.js";
import { hashOperatorToken } from "../../../server/src/operatorAuth.js";
import { legacyWorkspaceIdForProject } from "../../../server/src/__tests__/support/legacyWorkspaceId.js";
import { seedOperatorSessions } from "../../../server/src/__tests__/support/operatorAuthFixture.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../../../server/src/serverComposition.js";
import { createLocalFilesystemCanvasRuntimeAdapter } from "../../../server/src/canvas/localFilesystemRuntimeAdapter.js";
import {
  CollaborationClient,
  type CollaborationWebSocketConstructor
} from "../main/collaboration/CollaborationClient.js";
import {
  CanvasCommandController,
  type CanvasCommandBridge,
  type CanvasCommandLabels
} from "../renderer/collaboration/CanvasCommandController.js";

const directories: string[] = [];
const servers: HttpServer[] = [];
const compositions: DistributedServerComposition[] = [];
const clients: CollaborationClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const labels: CanvasCommandLabels = {
  staleRevision: (expected, authoritative) => `stale:${expected}->${authoritative}`,
  rejected: (code) => `rejected:${code}`,
  reconnectFailed: (code) => `reconnect:${code}`,
  notConnected: "not-connected"
};

async function setup() {
  const workspace = await createTestWorkspace(basicManifest());
  directories.push(workspace.home, workspace.root);
  await applyDefaultCanvasWorkspaceMigration(workspace.init.workspace);
  const canonicalWorkspace = await resolveTaskCanvasWorkspace(workspace.root, "default");
  await saveDesktopLayout(workspace.root, {
    version: "desktop-layout/v1",
    projectId: workspace.init.workspace.id,
    nodes: [],
    updatedAt: "2026-01-01T00:00:00.000Z"
  });
  const projectId = workspace.init.workspace.id;
  const workspaceId = legacyWorkspaceIdForProject(projectId);
  const scope = { workspaceId, projectId, canvasId: "default" };
  const runtime = createLocalFilesystemCanvasRuntimeAdapter({
    resolveExactCanvasLocation(input) {
      return input.workspaceId === workspaceId &&
        input.projectId === projectId &&
        input.canvasId === "default"
        ? {
            ...scope,
            projectRoot: workspace.root,
            packageDir: canonicalWorkspace.packageDir
          }
        : undefined;
    }
  });
  const initialContent = await runtime.captureInitialContent(scope);
  const httpServer = createServer();
  servers.push(httpServer);
  const adminToken = `pw_operator_${"C".repeat(43)}`;
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7_445 },
    publicUrl: "http://127.0.0.1:7445",
    allowInsecureDevelopment: true,
    dataDirectory: join(workspace.root, "server-data"),
    trustedProjects: [
      {
        workspaceId,
        projectId,
        canvasId: "default",
        projectRoot: workspace.root
      }
    ],
    operatorCredentials: [
      {
        operatorId: "canvas-cmd-e2e-admin",
        tokenSha256: hashOperatorToken(adminToken),
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
    projectId,
    projectRoot: workspace.root,
    packageDir: canonicalWorkspace.packageDir,
    initialContent
  };
}

async function bootstrap(origin: string, projectId: string, displayName: string) {
  const response = await fetch(`${origin}/api/v1/projects/${projectId}/human/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName })
  });
  const body = await response.text();
  expect(response.status, body).toBe(201);
  return JSON.parse(body) as { deviceToken: string; principal: { id: string } };
}

function createClient(origin: string, projectId: string, profileId: string, token: string) {
  const client = new CollaborationClient({
    profile: {
      profileId,
      displayName: profileId,
      serverBaseUrl: `${origin}/`,
      projectId,
      allowInsecureTransport: true,
      endpoint: {
        topology: "loopback_http",
        serverOrigin: `${origin}/`,
        allowedClientOrigins: [`${origin}/`],
        tlsTrust: "not_applicable"
      }
    },
    credential: { getDeviceToken: () => token },
    WebSocketImpl: WebSocket as unknown as CollaborationWebSocketConstructor,
    limits: { requestTimeoutMs: 5_000, jsonBodyMaxBytes: 256_000 }
  });
  clients.push(client);
  return client;
}

function bridgeFor(client: CollaborationClient): CanvasCommandBridge {
  return {
    submitCollaborationCanvasCommand: async (input) => {
      const outcome = await client.submitCanvasCommand({
        canvasId: input.canvasId,
        operationId: `op-${Math.random().toString(36).slice(2, 12)}`,
        intent: input.intent
      });
      return { outcome, session: client.canvasCommandSession() };
    },
    reconnectCollaborationCanvas: async (input) => {
      const result = await client.reconnectCanvasCommands({
        canvasId: input.canvasId,
        afterRevision: input.afterRevision,
        afterContentDigest: input.afterContentDigest
      });
      return {
        response: result.response,
        entriesToApply: result.entriesToApply,
        snapshotRequired: result.snapshotRequired,
        session: result.session
      };
    },
    bindCollaborationCanvasBindingSession: async ({ canvasId }) => {
      client.bindCanvasCommandSession(canvasId);
      return client.canvasCommandSession();
    },
    getCollaborationCanvasCommandSession: async () => client.canvasCommandSession()
  };
}

describe("Desktop canvas command dual-client E2E (OSS-004 B-003)", () => {
  it("orders dual-client history, is idempotent, surfaces stale, reconnects, and rejects unauthorized/forbidden", async () => {
    const fixture = await setup();
    const owner = await bootstrap(fixture.origin, fixture.projectId, "Canvas Owner");
    expect(owner.deviceToken).not.toBe(exampleHumanDeviceToken);

    const clientA = createClient(fixture.origin, fixture.projectId, "profile-a", owner.deviceToken);
    const clientB = createClient(fixture.origin, fixture.projectId, "profile-b", owner.deviceToken);
    await expect(
      clientA.publishInitialContent({ canvasId: "default", content: fixture.initialContent })
    ).resolves.toMatchObject({ outcome: "rejected", reason: "head_already_exists" });
    const controllerA = new CanvasCommandController({ api: bridgeFor(clientA), labels });
    const controllerB = new CanvasCommandController({ api: bridgeFor(clientB), labels });

    let resolveCanvasEvent: ((event: HumanObserverEvent) => void) | undefined;
    const canvasEvent = new Promise<HumanObserverEvent>((resolve) => {
      resolveCanvasEvent = resolve;
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("observer connect timeout")), 3_000);
      clientB.startObserver({
        onEvent: (event) => {
          if (event.kind === "canvas") resolveCanvasEvent?.(event);
        },
        onStatus: (status) => {
          if (status.state !== "connected") return;
          clearTimeout(timer);
          resolve();
        }
      });
    });

    await controllerA.bind({ localProjectId: fixture.projectId, canvasId: "default" });
    await controllerB.bind({ localProjectId: fixture.projectId, canvasId: "default" });
    expect(controllerA.getSnapshot().session?.revision).toBe(0);
    expect(controllerB.getSnapshot().session?.revision).toBe(0);

    const firstIntent = {
      kind: "update_task_prompt" as const,
      taskId: "T-001",
      promptMarkdown: "# dual client first\n"
    };
    const first = await controllerA.submit({ intent: firstIntent });
    expect(first.outcome.type, JSON.stringify(first.outcome)).toBe("canvas.command.accepted");
    if (first.outcome.type !== "canvas.command.accepted") throw new Error("expected accept");
    expect(first.outcome.revision).toBe(1);
    expect(first.outcome.idempotentReplay).toBe(false);
    await expect(
      Promise.race([
        canvasEvent,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("canvas observer event timeout")), 3_000)
        )
      ])
    ).resolves.toMatchObject({
      kind: "canvas",
      canvasId: "default",
      canvasRevision: 1,
      canvasContentDigest: first.outcome.contentDigest
    });

    // Duplicate operationId is idempotent (no second apply).
    const replay = await clientA.submitCanvasCommand({
      canvasId: "default",
      operationId: first.outcome.operationId,
      intent: firstIntent,
      expectedRevision: 0
    });
    expect(replay.type).toBe("canvas.command.accepted");
    if (replay.type !== "canvas.command.accepted") throw new Error("expected replay");
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.revision).toBe(1);

    // Stale revision is surfaced without guessing.
    const stale = await controllerB.submit({
      intent: {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# stale attempt\n"
      }
    });
    expect(stale.outcome.type).toBe("canvas.command.rejected");
    if (stale.outcome.type !== "canvas.command.rejected") throw new Error("expected reject");
    expect(stale.outcome.code).toBe("stale_revision");
    expect(stale.outcome.conflict?.authoritativeRevision).toBe(1);
    expect(controllerB.getSnapshot().lastStaleConflict?.authoritativeRevision).toBe(1);
    expect(controllerB.getSnapshot().lastError).toContain("stale:0->1");
    expect(controllerB.getSnapshot().session?.revision).toBe(0);

    // Client B reconnects and converges on ordered history.
    const reconnect = await controllerB.reconnect();
    expect(reconnect.response.type).toBe("canvas.reconnect.snapshot");
    if (reconnect.response.type !== "canvas.reconnect.snapshot")
      throw new Error("expected snapshot");
    expect(reconnect.response.snapshot.metadata.revision).toBe(1);
    expect(reconnect.response.snapshot.content.canonicalDigest).toBe(
      reconnect.response.snapshot.metadata.contentDigest
    );
    expect(controllerB.getSnapshot().session?.revision).toBe(1);

    // Client B continues ordered history from authoritative revision.
    const second = await controllerB.submit({
      intent: {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# dual client second\n"
      }
    });
    expect(second.outcome.type).toBe("canvas.command.accepted");
    if (second.outcome.type !== "canvas.command.accepted") throw new Error("expected accept");
    expect(second.outcome.revision).toBe(2);

    const reconnectA = await controllerA.reconnect({ afterRevision: 1 });
    expect(reconnectA.response.type).toBe("canvas.reconnect.delta");
    if (reconnectA.response.type !== "canvas.reconnect.delta") throw new Error("expected delta");
    expect(reconnectA.response.entries.map((entry) => entry.operationId)).toEqual([
      second.outcome.operationId
    ]);
    expect(controllerA.getSnapshot().session?.revision).toBe(2);

    // Unauthorized cannot mutate or read reconnect snapshots.
    const unauth = createClient(
      fixture.origin,
      fixture.projectId,
      "profile-unauth",
      "pw_hdev_invalidtoken000000000000000000000000000"
    );
    const unauthMutate = await unauth.submitCanvasCommand({
      canvasId: "default",
      operationId: "op-unauth",
      intent: {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# no\n"
      },
      expectedRevision: 0
    });
    expect(unauthMutate.type).toBe("canvas.command.rejected");
    if (unauthMutate.type === "canvas.command.rejected") {
      expect(unauthMutate.code).toBe("unauthorized");
    }
    await expect(
      unauth.reconnectCanvasCommands({
        canvasId: "default",
        afterRevision: 0
      })
    ).rejects.toThrow();

    // Forbidden directory/watch/upload/download/sync under canvas namespace are rejected.
    // routeCanvasCommandHttp owns these paths and must fail closed with exact 404 + detail.
    for (const path of [
      `/api/v1/projects/${fixture.projectId}/fs/list`,
      `/api/v1/projects/${fixture.projectId}/files`,
      `/api/v1/projects/${fixture.projectId}/sync`,
      `/api/v1/projects/${fixture.projectId}/upload`,
      `/api/v1/projects/${fixture.projectId}/download`,
      `/api/v1/projects/${fixture.projectId}/directory`,
      `/api/v1/projects/${fixture.projectId}/watch`,
      `/api/v1/billing/plans`,
      `/api/v1/ssh/exec`
    ]) {
      const response = await fetch(`${fixture.origin}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${owner.deviceToken}`,
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(response.status, path).toBe(404);
      const body = (await response.json()) as { detail?: string; error?: string };
      expect(body.detail, path).toBe("canvas_feature_not_supported");
      expect(body.error, path).toBe("not_found");
    }

    // Presence remains independent: command protocol version constant is stable.
    expect(CANVAS_COMMAND_PROTOCOL_VERSION).toBe(1);

    await controllerA.unbind();
    await controllerB.unbind();
  });
});
