import { rm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { join } from "node:path";
import {
  applyDefaultCanvasWorkspaceMigration,
  createCanvasWorkspace,
  resolveTaskCanvasWorkspace,
  saveDesktopLayout
} from "@planweave-ai/runtime";
import { expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import {
  basicManifest,
  createTestWorkspace
} from "../../../../runtime/src/__tests__/promptTestHelpers.js";
import { parseServerConfig } from "../../../../server/src/config.js";
import { AgentHostRepository } from "../../../../server/src/hosts.js";
import { hashOperatorToken } from "../../../../server/src/operatorAuth.js";
import { ProjectAccessRepository } from "../../../../server/src/projectAccessRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../../../../server/src/sqlite.js";
import { legacyWorkspaceIdForProject } from "../../../../server/src/__tests__/support/legacyWorkspaceId.js";
import { seedOperatorSessions } from "../../../../server/src/__tests__/support/operatorAuthFixture.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../../../../server/src/serverComposition.js";
import { createLocalFilesystemCanvasRuntimeAdapter } from "../../../../server/src/canvas/localFilesystemRuntimeAdapter.js";
import { CollaborationCredentialVault } from "../../main/collaboration/collaborationCredentialVault.js";
import { CollaborationWorkspaceConnection } from "../../main/collaboration/collaborationWorkspaceConnection.js";

const directories: string[] = [];
const servers: HttpServer[] = [];
const compositions: DistributedServerComposition[] = [];
export const adminToken = `pw_operator_${"F".repeat(43)}`;

afterEach(async () => {
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(resolve)))
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

export async function setupSelfHostedTwoClientFixture() {
  const manifest = basicManifest();
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
  };
  const workspace = await createTestWorkspace(manifest);
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
  await createCanvasWorkspace({ cwd: workspace.root, id: "private", title: "Private canvas" });
  directories.push(workspace.home, workspace.root);
  const httpServer = createServer();
  servers.push(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("expected_http_address");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: address.port },
    publicUrl: origin,
    allowInsecureDevelopment: true,
    dataDirectory: join(workspace.root, "server-data"),
    trustedProjects: [
      { workspaceId, projectId, projectRoot: workspace.root, trustAllDeclaredCanvases: true }
    ],
    operatorCredentials: [
      {
        operatorId: "two-client-e2e-admin",
        tokenSha256: hashOperatorToken(adminToken),
        projectIds: [],
        serverAdmin: true
      }
    ]
  });
  compositions.push(await createDistributedServerComposition({ httpServer, config }));
  await seedOperatorSessions(config.databasePath, config.operatorCredentials);
  return {
    projectId,
    workspaceId,
    origin,
    home: workspace.home,
    databasePath: config.databasePath,
    initialContent
  };
}

export async function issueDeviceSetupCode(origin: string, workspaceId: string) {
  const response = await fetch(
    `${origin}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/setup-codes`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: "workspace-setup/v1", purpose: "device_session" })
    }
  );
  const body = await response.json();
  expect(response.status).toBe(201);
  return body as { setupCode: string; grant: { setupCodeId: string } };
}

export async function redeemDesktop(input: {
  home: string;
  name: string;
  origin: string;
  setupCode: string;
}) {
  const vault = new CollaborationCredentialVault({
    paths: { credentialsPath: join(input.home, input.name, "credentials.json") }
  });
  const connection = new CollaborationWorkspaceConnection({
    vault,
    storePaths: { profilesPath: join(input.home, input.name, "workspace-profiles.json") }
  });
  const view = await connection.redeemDeviceSetupCode({
    serverBaseUrl: input.origin,
    allowInsecureTransport: true,
    setupCode: input.setupCode,
    displayName: input.name
  });
  return { connection, view, vault };
}

export async function deviceToken(desktop: Awaited<ReturnType<typeof redeemDesktop>>) {
  if (!desktop.view.profile) throw new Error("desktop_profile_missing");
  const token = await desktop.vault.getDeviceToken(desktop.view.profile.profileId);
  if (!token) throw new Error("desktop_device_token_missing");
  return token;
}

export async function postJson(origin: string, path: string, token: string, body: unknown) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

/** Discover authoritative content head for a canvas (POST content/head). */
export async function discoverContentHead(
  origin: string,
  projectId: string,
  canvasId: string,
  token: string
) {
  const response = await postJson(
    origin,
    `/api/v1/projects/${encodeURIComponent(projectId)}/canvases/${encodeURIComponent(canvasId)}/content/head`,
    token,
    { localReplica: null, knownRevision: null }
  );
  const body = (await response.json()) as {
    canPublishInitial?: boolean;
    authoritativeHead?: {
      revision: number;
      content: { versionId: string; canonicalDigest: string };
    } | null;
    replicaStatus?: string;
  };
  return { status: response.status, body };
}

/**
 * Remove content head rows for one canvas inside an isolated test database only.
 * Used to exercise HTTP initial-publish against an empty head without mutating user data.
 * Server bootstrap normally publishes trusted canvases at composition time.
 */
export async function clearIsolatedCanvasContentHead(input: {
  databasePath: string;
  workspaceId: string;
  projectId: string;
  canvasId: string;
}): Promise<void> {
  const database = await openServerDatabase(input.databasePath, 5_000);
  try {
    database
      .prepare(
        `DELETE FROM canvas_content_journal
         WHERE workspace_id=? AND project_id=? AND canvas_id=?`
      )
      .run(input.workspaceId, input.projectId, input.canvasId);
    database
      .prepare(
        `DELETE FROM canvas_content_acknowledgements
         WHERE workspace_id=? AND project_id=? AND canvas_id=?`
      )
      .run(input.workspaceId, input.projectId, input.canvasId);
    database
      .prepare(
        `DELETE FROM canvas_content_version_members
         WHERE version_id IN (
           SELECT version_id FROM canvas_content_versions
           WHERE workspace_id=? AND project_id=? AND canvas_id=?
         )`
      )
      .run(input.workspaceId, input.projectId, input.canvasId);
    database
      .prepare(
        `DELETE FROM canvas_content_versions
         WHERE workspace_id=? AND project_id=? AND canvas_id=?`
      )
      .run(input.workspaceId, input.projectId, input.canvasId);
    database
      .prepare(
        `DELETE FROM canvas_content_heads
         WHERE workspace_id=? AND project_id=? AND canvas_id=?`
      )
      .run(input.workspaceId, input.projectId, input.canvasId);
  } finally {
    database.close();
  }
}

export function assertFixturesDoNotShareAcceptanceState(
  left: Awaited<ReturnType<typeof setupSelfHostedTwoClientFixture>>,
  right: Awaited<ReturnType<typeof setupSelfHostedTwoClientFixture>>
): void {
  expect(left.databasePath).not.toBe(right.databasePath);
  expect(left.projectId).not.toBe(right.projectId);
  expect(left.workspaceId).not.toBe(right.workspaceId);
  expect(left.origin).not.toBe(right.origin);
  expect(left.home).not.toBe(right.home);
}

export async function configureWorkspaceAccess(input: {
  databasePath: string;
  workspaceId: string;
  projectId: string;
  ownerId: string;
  memberId: string;
}): Promise<{ database: SqliteDatabase; hostId: string }> {
  const database = await openServerDatabase(input.databasePath, 5_000);
  const access = new ProjectAccessRepository(database);
  access.initializeProjectOwner(input.workspaceId, input.projectId, input.ownerId);
  access.initializeCanvasOwner(input.workspaceId, input.projectId, "default", input.ownerId);
  access.initializeCanvasOwner(input.workspaceId, input.projectId, "private", input.ownerId);
  database
    .prepare(
      "UPDATE canvas_registry SET visibility='shared' WHERE workspace_id=? AND project_id=? AND canvas_id='default'"
    )
    .run(input.workspaceId, input.projectId);
  access.grant({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    canvasId: "default",
    humanPrincipalId: input.memberId,
    role: "editor",
    grantedBy: { kind: "human", id: input.ownerId }
  });
  const hosts = new AgentHostRepository(database);
  const host = hosts.register("E2E exact-block host").host;
  hosts.bindToWorkspace(host.id, input.workspaceId);
  hosts.reportOnline(host.id, ["acp.codex"], 1, {
    workspaceMappings: [{ workspaceId: input.workspaceId, status: "ready" }],
    acpProfiles: [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Test Agent",
        status: "ready",
        capabilities: ["acp.codex"]
      }
    ]
  });
  return { database, hostId: host.id };
}

export async function openPresence(
  origin: string,
  projectId: string,
  canvasId: string,
  token: string
) {
  const url = new URL(origin);
  url.protocol = "ws:";
  url.pathname = `/api/v1/projects/${encodeURIComponent(projectId)}/canvases/${encodeURIComponent(canvasId)}/human/presence`;
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

export function sendPresenceHello(socket: WebSocket, projectId: string, canvasId: string): void {
  socket.send(
    JSON.stringify({ type: "canvas.presence.hello", protocolVersion: 1, projectId, canvasId })
  );
}

export function nextPresenceMessage(
  socket: WebSocket,
  type: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`presence_message_timeout:${type}`));
    }, 2_000);
    const onMessage = (raw: Buffer) => {
      const message = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      if (message.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

export async function expectRouteUnavailable(origin: string, path: string, expected: unknown) {
  const response = await fetch(`${origin}${path}`);
  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual(expected);
}
