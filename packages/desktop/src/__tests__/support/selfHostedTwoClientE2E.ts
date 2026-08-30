import { rm } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CANVAS_RUNTIME_CAPABILITY,
  WORKSPACE_CANVAS_EXECUTION_CAPABILITY,
  agentHostProtocolVersion,
  canvasRuntimeRequestCommandSchema,
  canvasRuntimeResponseEventSchema,
  type CanvasRuntimeLogicalScope,
  type CanvasRuntimeOperation
} from "@planweave-ai/agent-host-protocol";
import {
  applyDefaultCanvasWorkspaceMigration,
  createCanvasWorkspace,
  createRemoteBlockRuntimePort,
  readAuthorizedCanvasRuntimeStatus,
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
import { ContentVersionRepository } from "../../../../server/src/canvas/contentVersionRepository.js";
import { readStableCanvasRuntimeEvidence } from "../../../../server/src/canvas/contentFingerprint.js";
import { legacyWorkspaceIdForProject } from "../../../../server/src/__tests__/support/legacyWorkspaceId.js";
import { seedOperatorSessions } from "../../../../server/src/__tests__/support/operatorAuthFixture.js";
import { ownHostRemoteAgents } from "../../../../server/src/__tests__/support/remoteAgentOwnerFixture.js";
import { syncRemoteAgentsFromHost } from "../../../../server/src/remoteAgent/sync.js";
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
const runtimeHostSockets: WebSocket[] = [];
export const adminToken = `pw_operator_${"F".repeat(43)}`;

afterEach(async () => {
  for (const socket of runtimeHostSockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  }
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
    projectRoot: workspace.root,
    packageDir: canonicalWorkspace.packageDir,
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

/** Read the Server-authoritative content head for a canvas. */
export async function discoverContentHead(
  origin: string,
  projectId: string,
  canvasId: string,
  token: string
) {
  const response = await fetch(
    `${origin}/api/v1/projects/${encodeURIComponent(projectId)}/canvases/${encodeURIComponent(canvasId)}/content/head`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  const body = (await response.json()) as {
    revision: number;
    content: { versionId: string; canonicalDigest: string };
  } | null;
  return { status: response.status, body };
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
}): Promise<{ database: SqliteDatabase; hostId: string; hostToken: string }> {
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
  const hosts = new AgentHostRepository(database, undefined, (host) => {
    syncRemoteAgentsFromHost({ database, host, clock: () => new Date() });
  });
  const registration = hosts.register("E2E exact-block host");
  const host = registration.host;
  ownHostRemoteAgents({
    database,
    hostId: host.id,
    ownerHumanPrincipalId: input.ownerId,
    accessMode: "workspace_restricted",
    grantWorkspaceId: input.workspaceId
  });
  hosts.bindToWorkspace(host.id, input.workspaceId);
  hosts.reportOnline(
    host.id,
    ["acp.codex", CANVAS_RUNTIME_CAPABILITY, WORKSPACE_CANVAS_EXECUTION_CAPABILITY],
    1,
    {
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
    }
  );
  return { database, hostId: host.id, hostToken: registration.token };
}

type FixtureRuntimeAuthority = {
  sourceRevision: string;
  graphFingerprint: string;
};

export type FixtureCanvasRuntimeTrace = {
  operations: Array<CanvasRuntimeOperation["operation"]>;
};

async function readFixtureRuntimeAuthority(input: {
  databasePath: string;
  scope: CanvasRuntimeLogicalScope;
}): Promise<FixtureRuntimeAuthority> {
  const database = await openServerDatabase(input.databasePath, 5_000);
  try {
    const evidence = readStableCanvasRuntimeEvidence(
      new ContentVersionRepository(database),
      input.scope
    );
    if (!evidence) throw new Error("desktop_e2e_content_evidence_missing");
    return {
      sourceRevision: evidence.sourceRevision,
      graphFingerprint: evidence.target.graphFingerprint
    };
  } finally {
    database.close();
  }
}

function fixtureRuntimeError(operation: CanvasRuntimeOperation["operation"], code: string) {
  return {
    outcome: "error" as const,
    operation,
    error: {
      code,
      message: "The Canvas Runtime fixture could not complete the request.",
      retryable: false
    }
  };
}

function fixtureRuntimeErrorCode(error: unknown): string {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "canvas_runtime_operation_failed";
}

function fixtureRuntimeSuccess(operation: CanvasRuntimeOperation["operation"], result: unknown) {
  return { outcome: "success" as const, operation, result };
}

async function answerFixtureRuntimeRequest(input: {
  runtime: ReturnType<typeof createRemoteBlockRuntimePort>;
  scope: CanvasRuntimeLogicalScope;
  operation: CanvasRuntimeOperation;
  projectRoot: string;
  packageDir: string;
  authority: FixtureRuntimeAuthority;
}): Promise<Record<string, unknown>> {
  const { runtime, scope, operation, projectRoot, packageDir, authority } = input;
  try {
    switch (operation.operation) {
      case "availability": {
        const status = await readAuthorizedCanvasRuntimeStatus({
          projectRoot,
          canvasId: scope.canvasId,
          expectedPackageDir: packageDir,
          scope
        });
        return fixtureRuntimeSuccess("availability", {
          kind: "available",
          status,
          ...authority
        });
      }
      case "acquire": {
        const acquiredAt = new Date().toISOString();
        return fixtureRuntimeSuccess("acquire", {
          runtimeLeaseId: randomUUID(),
          ...authority,
          acquiredAt,
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        });
      }
      case "release":
        return fixtureRuntimeSuccess("release", { released: true });
      case "status":
        return fixtureRuntimeSuccess(
          "status",
          await readAuthorizedCanvasRuntimeStatus({
            projectRoot,
            canvasId: scope.canvasId,
            expectedPackageDir: packageDir,
            scope
          })
        );
      case "claim":
        return fixtureRuntimeSuccess("claim", await runtime.claim(operation.input));
      case "activate":
        return fixtureRuntimeSuccess("activate", await runtime.activate(operation.input));
      case "query":
        return fixtureRuntimeSuccess("query", await runtime.query(operation.input));
      case "reconcile":
        return fixtureRuntimeSuccess("reconcile", await runtime.reconcile(operation.input));
      default:
        return fixtureRuntimeError(operation.operation, "canvas_runtime_operation_failed");
    }
  } catch (error) {
    return fixtureRuntimeError(operation.operation, fixtureRuntimeErrorCode(error));
  }
}

export function attachFixtureCanvasRuntimeResponder(input: {
  socket: WebSocket;
  databasePath: string;
  projectRoot: string;
  packageDir: string;
}): FixtureCanvasRuntimeTrace {
  const runtime = createRemoteBlockRuntimePort({ projectRoot: input.projectRoot });
  const trace: FixtureCanvasRuntimeTrace = { operations: [] };
  input.socket.on("message", (data) => {
    const event = JSON.parse(data.toString()) as {
      type?: unknown;
      messageId?: unknown;
      sequence?: unknown;
      command?: unknown;
    };
    if (event.type !== "mailbox.message") return;
    if (typeof event.sequence !== "number" || typeof event.messageId !== "string") return;
    input.socket.send(
      JSON.stringify({
        type: "mailbox.ack",
        protocolVersion: agentHostProtocolVersion,
        messageId: `fixture-mailbox-${event.messageId}`,
        sequence: event.sequence
      })
    );
    const command = canvasRuntimeRequestCommandSchema.safeParse(event.command);
    if (!command.success) return;
    trace.operations.push(command.data.operation.operation);
    const sendResponse = (response: Record<string, unknown>) => {
      if (input.socket.readyState !== WebSocket.OPEN) return;
      input.socket.send(
        JSON.stringify(
          canvasRuntimeResponseEventSchema.parse({
            type: "canvas_runtime.response",
            protocolVersion: agentHostProtocolVersion,
            messageId: `fixture-runtime-${command.data.requestId}`,
            requestId: command.data.requestId,
            response
          })
        )
      );
    };
    void (async () => {
      try {
        const authority = await readFixtureRuntimeAuthority({
          databasePath: input.databasePath,
          scope: command.data.scope
        });
        sendResponse(
          await answerFixtureRuntimeRequest({
            runtime,
            scope: command.data.scope,
            operation: command.data.operation,
            projectRoot: input.projectRoot,
            packageDir: input.packageDir,
            authority
          })
        );
      } catch (error) {
        sendResponse(
          fixtureRuntimeError(command.data.operation.operation, fixtureRuntimeErrorCode(error))
        );
      }
    })().catch(() => undefined);
  });
  return trace;
}

export async function connectFixtureCanvasRuntimeHost(input: {
  origin: string;
  hostId: string;
  hostToken: string;
  workspaceId: string;
  databasePath: string;
  projectRoot: string;
  packageDir: string;
}): Promise<FixtureCanvasRuntimeTrace> {
  const socket = new WebSocket(
    `${input.origin.replace(/^http:/, "ws:")}/agent-hosts/${input.hostId}/connect?workspaceId=${encodeURIComponent(input.workspaceId)}`,
    { headers: { Authorization: `Bearer ${input.hostToken}` } }
  );
  runtimeHostSockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const welcomed = new Promise<void>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      const event = JSON.parse(data.toString()) as { type?: unknown; code?: unknown };
      if (event.type === "host.welcome") {
        socket.off("message", onMessage);
        resolve();
      } else if (event.type === "protocol.error") {
        socket.off("message", onMessage);
        reject(new Error(typeof event.code === "string" ? event.code : "host_hello_rejected"));
      }
    };
    socket.on("message", onMessage);
  });
  socket.send(
    JSON.stringify({
      type: "host.hello",
      protocolVersion: agentHostProtocolVersion,
      lastAcknowledgedSequence: 0,
      capabilities: [
        "acp.codex",
        "acp.session.load",
        CANVAS_RUNTIME_CAPABILITY,
        WORKSPACE_CANVAS_EXECUTION_CAPABILITY
      ],
      capacity: 1,
      readiness: {
        workspaceMappings: [{ workspaceId: input.workspaceId, status: "ready" }],
        acpProfiles: [
          {
            profileId: "codex-acp",
            agentId: "codex",
            displayName: "Test Agent",
            status: "ready",
            capabilities: ["acp.codex", "acp.session.load"]
          }
        ],
        runtimeProjects: []
      }
    })
  );
  await welcomed;
  return attachFixtureCanvasRuntimeResponder({ socket, ...input });
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
