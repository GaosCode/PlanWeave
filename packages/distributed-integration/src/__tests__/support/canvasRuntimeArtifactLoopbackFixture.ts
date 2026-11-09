import { createHash } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_RUNTIME_CAPABILITY } from "@planweave-ai/agent-host-protocol";
import { canvasRuntimeContentTargetSchema } from "../../../../collaboration-protocol/src/contentVersion.js";
import { canvasScopeRefSchema } from "../../../../collaboration-protocol/src/primitives.js";
import {
  AgentHostClient,
  CanvasRuntimeArtifactTransfer,
  CanvasRuntimeContentTransfer,
  CanvasRuntimeService,
  openAgentHostState,
  type AgentHostExecutor,
  type AgentHostState
} from "@planweave-ai/agent-host";
import {
  basicManifest,
  createTestWorkspace
} from "../../../../runtime/src/__tests__/promptTestHelpers.js";
import {
  captureAuthorizedCanvasContent,
  readAuthorizedCanvasRuntimeStatus,
  type PlanPackageManifest
} from "@planweave-ai/runtime";
import { afterEach, expect, vi } from "vitest";
import { ArtifactStore } from "../../../../server/src/artifacts.js";
import { handleCanvasRuntimeArtifactRequest } from "../../../../server/src/canvas/runtimeArtifactHttp.js";
import { ContentVersionRepository } from "../../../../server/src/canvas/contentVersionRepository.js";
import { handleCanvasRuntimeContentRequest } from "../../../../server/src/canvas/runtimeContentHttp.js";
import { RuntimeArtifactGrantRepository } from "../../../../server/src/canvas/runtimeArtifactGrantRepository.js";
import { CanvasRuntimeHostLocator } from "../../../../server/src/canvas/runtimeHostLocator.js";
import { RemoteHostCanvasRuntimeAdapter } from "../../../../server/src/canvas/remoteHostRuntimeAdapter.js";
import { CanvasRuntimeRpcBroker } from "../../../../server/src/canvas/runtimeRpcBroker.js";
import { createRemoteBlockCoordination } from "../../../../server/src/distributedCoordination.js";
import { WorkspaceIdentityRepository } from "../../../../server/src/identity/workspaceRepository.js";
import { startPlanweaveServer, type PlanweaveServer } from "../../../../server/src/lifecycle.js";
import { ProjectAccessRepository } from "../../../../server/src/projectAccessRepository.js";
import {
  attachAgentHostWebSocketServer,
  type AgentHostWebSocketServer
} from "../../../../server/src/wsServer.js";
import { loopbackHttpTransportAdmission } from "../../../../server/src/__tests__/support/transportAdmission.js";

export const scope = canvasScopeRefSchema.parse({
  workspaceId: "workspace-runtime-loopback",
  projectId: "project-runtime-loopback",
  canvasId: "default"
});
const directories: string[] = [];
const servers: PlanweaveServer[] = [];
const httpServers: HttpServer[] = [];
const transports: AgentHostWebSocketServer[] = [];
const clients: AgentHostClient[] = [];
const hostStates: AgentHostState[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  await Promise.all(
    httpServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  for (const state of hostStates.splice(0)) state.close();
  for (const server of servers.splice(0)) server.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function dependencyManifest(): PlanPackageManifest {
  const manifest = basicManifest();
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
  };
  const task = manifest.nodes[0];
  if (task.type !== "task") throw new Error("test_task_required");
  task.blocks.splice(1, 0, {
    id: "B-002",
    type: "implementation",
    title: "Consume remote report",
    prompt: "nodes/T-001/blocks/B-002.prompt.md",
    depends_on: ["B-001"]
  });
  const review = task.blocks.find((block) => block.id === "R-001");
  if (review) review.depends_on = ["B-002"];
  return manifest;
}

async function waitUntil(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("test_runtime_host_connection_timeout");
}

export async function setup(options: { clock?: () => Date } = {}) {
  const workspace = await createTestWorkspace(dependencyManifest());
  directories.push(workspace.home, workspace.root);
  const serverDirectory = await mkdtemp(join(tmpdir(), "planweave-runtime-artifact-server-"));
  const hostDirectory = await mkdtemp(join(tmpdir(), "planweave-runtime-artifact-host-"));
  directories.push(serverDirectory, hostDirectory);
  const server = await startPlanweaveServer({
    dataDirectory: serverDirectory,
    databasePath: join(serverDirectory, "planweave-server.sqlite"),
    busyTimeoutMs: 5_000
  });
  servers.push(server);
  const coordination = createRemoteBlockCoordination(
    server.database,
    {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      runtimeLeases: {
        acquire: () => Promise.reject(new Error("acp_runtime_not_used")),
        acquireForHost: () => Promise.reject(new Error("acp_runtime_not_used"))
      },
      inputArtifacts: { async materialize() {} },
      artifactContent: {
        async readReport() {
          return new Uint8Array();
        }
      }
    },
    { serverInstanceOwnerToken: server.serverInstanceOwnerToken }
  );
  new WorkspaceIdentityRepository(server.database).ensureConfiguredWorkspace(scope.workspaceId);
  const projectAccess = new ProjectAccessRepository(server.database);
  projectAccess.registerProjectInternal({
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    projectRoot: workspace.root
  });
  projectAccess.registerCanvasInternal({
    ...scope,
    packageDir: workspace.init.workspace.packageDir
  });
  server.database
    .prepare("UPDATE project_registry SET project_root_internal=NULL WHERE project_id=?")
    .run(scope.projectId);
  server.database
    .prepare("UPDATE canvas_registry SET package_dir_internal=NULL WHERE project_id=?")
    .run(scope.projectId);
  const broker = new CanvasRuntimeRpcBroker(
    server.database,
    coordination.hosts,
    coordination.mailbox,
    {
      requestTimeoutMs: 5_000
    }
  );
  const artifacts = new ArtifactStore(server.database, serverDirectory, 1024 * 1024);
  const locator = new CanvasRuntimeHostLocator(
    coordination.hosts.runtimeBindings,
    coordination.hosts,
    broker,
    projectAccess
  );
  const contentVersions = new ContentVersionRepository(server.database);
  const grants = new RuntimeArtifactGrantRepository(server.database, {
    maxArtifactBytes: artifacts.maxArtifactBytes,
    clock: options.clock,
    leaseActive: (lease) => {
      const located = locator.locate({
        workspaceId: lease.workspaceId,
        projectId: lease.projectId,
        canvasId: lease.canvasId
      });
      return (
        broker.isActive(lease.hostId) &&
        broker.attachmentVersion(lease.hostId) === lease.attachmentVersion &&
        located.kind === "available" &&
        located.hostId === lease.hostId
      );
    }
  });
  const hostRegistration = coordination.hosts.register("Canvas Runtime Loopback Host");
  coordination.hosts.bindToWorkspace(hostRegistration.host.id, scope.workspaceId);
  const httpServer = createServer((request, response) => {
    void (async () => {
      const contentHandled = await handleCanvasRuntimeContentRequest(request, response, {
        hosts: coordination.hosts,
        authorization: broker,
        contentVersions,
        transportAdmission: loopbackHttpTransportAdmission
      });
      if (contentHandled) return;
      const artifactHandled = await handleCanvasRuntimeArtifactRequest(request, response, {
        hosts: coordination.hosts,
        grants,
        artifacts,
        transportAdmission: loopbackHttpTransportAdmission
      });
      if (!artifactHandled) {
        response.writeHead(404);
        response.end();
      }
    })();
  });
  httpServers.push(httpServer);
  const transport = attachAgentHostWebSocketServer({
    server: httpServer,
    hosts: coordination.hosts,
    mailbox: coordination.mailbox,
    dispatches: coordination.dispatches,
    acpEvents: coordination.acpEvents,
    interactions: coordination.interactions,
    actions: coordination.actions,
    runtimeRpc: broker,
    heartbeatIntervalMs: 30_000,
    leaseDurationMs: 60_000,
    transportAdmission: loopbackHttpTransportAdmission
  });
  transports.push(transport);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("test_http_address_missing");
  const origin = `http://127.0.0.1:${address.port}`;
  let hostState = await openAgentHostState(join(hostDirectory, "state.sqlite"));
  hostStates.push(hostState);
  const transfer = new CanvasRuntimeArtifactTransfer({
    baseUrl: new URL(origin),
    hostId: hostRegistration.host.id,
    token: hostRegistration.token
  });
  const contentTransfer = new CanvasRuntimeContentTransfer({
    baseUrl: new URL(origin),
    hostId: hostRegistration.host.id,
    token: hostRegistration.token
  });
  const runtimeStatus = await readAuthorizedCanvasRuntimeStatus({
    projectRoot: workspace.init.workspace,
    canvasId: scope.canvasId,
    expectedPackageDir: workspace.init.workspace.packageDir,
    scope
  });
  const captured = await captureAuthorizedCanvasContent({
    projectRoot: workspace.init.workspace,
    canvasId: scope.canvasId,
    expectedPackageDir: workspace.init.workspace.packageDir,
    authorityProjectId: scope.projectId
  });
  const published = contentVersions.publishInitial({
    scope,
    content: captured.content,
    createdBy: { kind: "system", id: "runtime-loopback" }
  });
  const contentTarget = canvasRuntimeContentTargetSchema.parse({
    revision: published.head.revision,
    content: published.head.content,
    graphFingerprint: runtimeStatus.packageFingerprint
  });
  const createClient = (hostState: AgentHostState) => {
    const canvasRuntime = new CanvasRuntimeService({
      resolver: {
        configured: () => true,
        mappings: () => [{ workspaceId: scope.workspaceId, projectId: scope.projectId, path: "." }],
        async resolveProject(workspaceId, projectId) {
          expect({ workspaceId, projectId }).toEqual({
            workspaceId: scope.workspaceId,
            projectId: scope.projectId
          });
          return workspace.init.workspace;
        },
        async resolve(input) {
          expect(input).toEqual(scope);
          return { scope, project: workspace.init.workspace, canvas: workspace.init.workspace };
        }
      },
      receipts: hostState.canvasRuntime,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      artifactTransfer: transfer,
      contentTransfer
    });
    const executor: AgentHostExecutor = { execute: vi.fn() };
    return new AgentHostClient({
      serverUrl: origin,
      hostId: hostRegistration.host.id,
      token: hostRegistration.token,
      capabilities: [CANVAS_RUNTIME_CAPABILITY],
      capacity: 1,
      readiness: {
        workspaceMappings: [],
        acpProfiles: [],
        runtimeProjects: [
          { workspaceId: scope.workspaceId, projectId: scope.projectId, status: "ready" }
        ]
      },
      state: hostState,
      executor,
      canvasRuntime,
      request: async (input, init) => {
        const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
        if (url.pathname !== "/version") return await fetch(input, init);
        return new Response(
          JSON.stringify({
            remoteRunnerEvents: {
              available: true,
              acceptedVersions: [2],
              preferredVersion: 2,
              v1Accepted: 0,
              v2Accepted: 0,
              v1Degraded: 0,
              usageSnapshotsAccepted: 0,
              usageSnapshotRegressions: 0
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
      allowInsecureTransport: true
    });
  };
  let client = createClient(hostState);
  clients.push(client);
  client.start();
  await waitUntil(() => broker.isActive(hostRegistration.host.id));
  return {
    adapter: new RemoteHostCanvasRuntimeAdapter(
      locator,
      broker,
      { read: () => contentTarget },
      {
        grants,
        artifacts
      }
    ),
    artifacts,
    grants,
    hostRegistration,
    contentTarget,
    contentVersions,
    coordination,
    origin,
    server,
    workspace,
    transfer,
    transport,
    httpServer,
    async restartHost() {
      const version = broker.attachmentVersion(hostRegistration.host.id);
      await client.stop();
      clients.splice(clients.indexOf(client), 1);
      hostState.close();
      hostStates.splice(hostStates.indexOf(hostState), 1);
      hostState = await openAgentHostState(join(hostDirectory, "state.sqlite"));
      hostStates.push(hostState);
      client = createClient(hostState);
      clients.push(client);
      client.start();
      await waitUntil(
        () =>
          broker.isActive(hostRegistration.host.id) &&
          broker.attachmentVersion(hostRegistration.host.id) > version
      );
    },
    async stop() {
      await client.stop();
      clients.splice(clients.indexOf(client), 1);
      await transport.close();
      transports.splice(transports.indexOf(transport), 1);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      httpServers.splice(httpServers.indexOf(httpServer), 1);
      hostState.close();
      hostStates.splice(hostStates.indexOf(hostState), 1);
      server.close();
      servers.splice(servers.indexOf(server), 1);
    }
  };
}

export async function storeReport(artifacts: ArtifactStore, bytes: Buffer) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  async function* chunks() {
    yield bytes;
  }
  return artifacts.put({
    expectedSha256: sha256,
    expectedSizeBytes: bytes.byteLength,
    mediaType: "text/markdown",
    chunks: chunks()
  });
}
