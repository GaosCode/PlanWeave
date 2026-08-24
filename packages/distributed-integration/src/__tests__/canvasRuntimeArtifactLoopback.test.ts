import { createHash } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_RUNTIME_CAPABILITY } from "@planweave-ai/agent-host-protocol";
import { canvasRuntimeContentTargetSchema } from "../../../collaboration-protocol/src/contentVersion.js";
import { canvasScopeRefSchema } from "../../../collaboration-protocol/src/primitives.js";
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
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import {
  remoteBlockClaimInputSchema,
  remoteBlockRefIdentitySchema,
  captureAuthorizedCanvasContent,
  readAuthorizedCanvasRuntimeStatus,
  type PlanPackageManifest
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../../../server/src/artifacts.js";
import { handleCanvasRuntimeArtifactRequest } from "../../../server/src/canvas/runtimeArtifactHttp.js";
import { ContentVersionRepository } from "../../../server/src/canvas/contentVersionRepository.js";
import { handleCanvasRuntimeContentRequest } from "../../../server/src/canvas/runtimeContentHttp.js";
import { RuntimeArtifactGrantRepository } from "../../../server/src/canvas/runtimeArtifactGrantRepository.js";
import { CanvasRuntimeHostLocator } from "../../../server/src/canvas/runtimeHostLocator.js";
import { RemoteHostCanvasRuntimeAdapter } from "../../../server/src/canvas/remoteHostRuntimeAdapter.js";
import { CanvasRuntimeRpcBroker } from "../../../server/src/canvas/runtimeRpcBroker.js";
import { createRemoteBlockCoordination } from "../../../server/src/distributedCoordination.js";
import { WorkspaceIdentityRepository } from "../../../server/src/identity/workspaceRepository.js";
import { startPlanweaveServer, type PlanweaveServer } from "../../../server/src/lifecycle.js";
import { ProjectAccessRepository } from "../../../server/src/projectAccessRepository.js";
import {
  attachAgentHostWebSocketServer,
  type AgentHostWebSocketServer
} from "../../../server/src/wsServer.js";
import { loopbackHttpTransportAdmission } from "../../../server/src/__tests__/support/transportAdmission.js";

const scope = canvasScopeRefSchema.parse({
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

async function setup() {
  const workspace = await createTestWorkspace(dependencyManifest());
  directories.push(workspace.home, workspace.root);
  const serverDirectory = await mkdtemp(join(tmpdir(), "planweave-runtime-artifact-server-"));
  const hostDirectory = await mkdtemp(join(tmpdir(), "planweave-runtime-artifact-host-"));
  directories.push(serverDirectory, hostDirectory);
  const server = await startPlanweaveServer({
    dataDirectory: serverDirectory,
    databasePath: join(serverDirectory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  servers.push(server);
  const coordination = createRemoteBlockCoordination(
    server.database,
    {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      runtimeLeases: { acquire: () => Promise.reject(new Error("acp_runtime_not_used")) },
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
        locator,
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
  const hostState = await openAgentHostState(join(hostDirectory, "state.sqlite"));
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
  const client = new AgentHostClient({
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
    allowInsecureTransport: true
  });
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
    workspace
  };
}

async function storeReport(artifacts: ArtifactStore, bytes: Buffer) {
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

describe("Canvas Runtime artifact loopback", () => {
  it("moves complete and artifact_read bytes through one authenticated HTTP listener", async () => {
    const fixture = await setup();
    const firstLease = await fixture.adapter.acquire(scope);
    const firstRef = "T-001#B-001";
    const candidate = await firstLease.runtime.inspect({ ref: firstRef });
    const identity = remoteBlockRefIdentitySchema.parse({
      ref: firstRef,
      operationId: "operation-loopback-complete",
      controlPlane: "collaboration" as const,
      sourceRevision: candidate.sourceRevision,
      graphFingerprint: candidate.graphFingerprint,
      dispatchId: "dispatch-loopback",
      executionAttemptId: "attempt-loopback"
    });
    const {
      dispatchId: _dispatchId,
      executionAttemptId: _attemptId,
      ref: _ref,
      ...claimIdentity
    } = identity;
    await firstLease.runtime.claim(
      remoteBlockClaimInputSchema.parse({ ref: firstRef, ...claimIdentity })
    );
    await firstLease.runtime.activate(identity);
    const reportBytes = Buffer.from("# Runtime loopback report\n");
    const report = await storeReport(fixture.artifacts, reportBytes);
    await firstLease.runtime.complete({
      ...identity,
      reportArtifactRef: report.ref,
      reportBytes,
      transcript: {
        sessionId: "session-loopback",
        executor: "codex-acp",
        agentId: "codex",
        events: []
      }
    });
    const oldGrant = fixture.server.database
      .prepare(
        "SELECT grant_id,runtime_lease_id,sha256 FROM canvas_runtime_artifact_grants WHERE direction='download'"
      )
      .get();
    if (!oldGrant) throw new Error("test_download_grant_required");
    await firstLease.release();
    const denied = await fetch(
      `${fixture.origin}/agent-hosts/${fixture.hostRegistration.host.id}/canvas-runtime/leases/${oldGrant.runtime_lease_id}/artifacts/${oldGrant.sha256}`,
      {
        headers: {
          Authorization: `Bearer ${fixture.hostRegistration.token}`,
          "x-planweave-runtime-artifact-grant-id": String(oldGrant.grant_id)
        }
      }
    );
    expect(denied.status).toBe(403);

    const secondLease = await fixture.adapter.acquire(scope);
    const dependent = await secondLease.runtime.inspect({ ref: "T-001#B-002" });
    const declared = dependent.inputArtifacts[0];
    if (!declared) throw new Error("test_input_artifact_required");
    if (!declared.mediaType) throw new Error("test_input_artifact_media_type_required");
    const uploaded = await secondLease.artifacts.read({
      targetBlockRef: dependent.blockRef,
      sourceRevision: dependent.sourceRevision,
      artifactRef: declared.artifactRef,
      logicalName: declared.logicalName,
      mediaType: declared.mediaType
    });
    expect(Buffer.from(uploaded.bytes)).toEqual(reportBytes);
    expect(uploaded.artifactRef).toBe(report.ref);
    expect(await fixture.artifacts.read(report.ref)).toEqual(reportBytes);
    await secondLease.release();
  });

  it("protects authoritative content downloads by Host credential, scope, binding, and head", async () => {
    const fixture = await setup();
    const contentPath =
      `${fixture.origin}/agent-hosts/${fixture.hostRegistration.host.id}/canvas-runtime/content/` +
      `${scope.projectId}/${scope.canvasId}/${fixture.contentTarget.content.versionId}`;
    const contentUrl = new URL(contentPath);
    contentUrl.searchParams.set("workspaceId", scope.workspaceId);
    contentUrl.searchParams.set("canonicalDigest", fixture.contentTarget.content.canonicalDigest);

    const badToken = await fetch(contentUrl, {
      headers: { Authorization: `Bearer pw_host_${"x".repeat(43)}` }
    });
    expect(badToken.status).toBe(401);
    expect(await badToken.json()).toEqual({ error: "runtime_content_unauthorized" });

    const wrongWorkspace = new URL(contentUrl);
    wrongWorkspace.searchParams.set("workspaceId", "workspace-other");
    const crossScope = await fetch(wrongWorkspace, {
      headers: { Authorization: `Bearer ${fixture.hostRegistration.token}` }
    });
    expect(crossScope.status).toBe(401);
    expect(await crossScope.json()).toEqual({ error: "runtime_content_unauthorized" });

    const staleDigest = "f".repeat(64);
    const staleTarget = new URL(contentUrl);
    staleTarget.pathname = staleTarget.pathname.replace(/\/[^/]+$/u, `/version-${staleDigest}`);
    staleTarget.searchParams.set("canonicalDigest", staleDigest);
    const stale = await fetch(staleTarget, {
      headers: { Authorization: `Bearer ${fixture.hostRegistration.token}` }
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "runtime_content_target_stale" });

    vi.spyOn(fixture.contentVersions, "head").mockImplementationOnce(() => {
      throw new Error("simulated_repository_failure");
    });
    const internalFailure = await fetch(contentUrl, {
      headers: { Authorization: `Bearer ${fixture.hostRegistration.token}` }
    });
    expect(internalFailure.status).toBe(500);
    expect(await internalFailure.json()).toEqual({ error: "runtime_content_internal_error" });

    fixture.coordination.hosts.runtimeBindings.synchronizeReadiness(
      fixture.hostRegistration.host.id,
      []
    );
    const unbound = await fetch(contentUrl, {
      headers: { Authorization: `Bearer ${fixture.hostRegistration.token}` }
    });
    expect(unbound.status).toBe(403);
    expect(await unbound.json()).toEqual({ error: "runtime_content_scope_forbidden" });
  });
});
