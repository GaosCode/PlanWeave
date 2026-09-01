import { createHash } from "node:crypto";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { WORKSPACE_CANVAS_EXECUTION_CAPABILITY } from "@planweave-ai/agent-host-protocol";
import {
  captureAuthorizedCanvasContent,
  createRemoteBlockArtifactSource,
  createRemoteBlockRuntimePort,
  type PlanPackageManifest,
  type RemoteBlockDispatchCandidate
} from "@planweave-ai/runtime";
import { afterEach, vi } from "vitest";
import {
  createTestWorkspace,
  basicManifest
} from "../../../../runtime/src/__tests__/promptTestHelpers.js";
import { ArtifactStore } from "../../artifacts.js";
import {
  createRemoteBlockCoordination,
  startRemoteBlockCoordinationServer,
  type RemoteBlockCoordinationOptions
} from "../../distributedCoordination.js";
import { startPlanweaveServer, type PlanweaveServer } from "../../lifecycle.js";
import { RemoteRuntimePortRegistry } from "../../remoteRuntimeLocator.js";
import { WorkspaceIdentityRepository } from "../../identity/workspaceRepository.js";
import { ProjectAccessRepository } from "../../projectAccessRepository.js";
import {
  endpointDispatchRequest,
  registerEndpointDispatchAccess
} from "./endpointCoordinatorFixture.js";
import { ownHostRemoteAgents, TEST_REMOTE_AGENT_OWNER_ID } from "./remoteAgentOwnerFixture.js";
import { exactHostRuntimeRouteFixture } from "./exactHostRuntimeRoute.js";
import { ContentVersionRepository } from "../../canvas/contentVersionRepository.js";
import {
  readStableCanvasRuntimeContentTarget,
  readStableCanvasRuntimeEvidence
} from "../../canvas/contentFingerprint.js";
import type { RemoteCoordinatorCheckpointPort } from "../../remoteBlockCoordinatorPorts.js";

export const directories: string[] = [];
const servers: PlanweaveServer[] = [];
const restartHarnesses: OwnerCanvasRestartHarness[] = [];

afterEach(async () => {
  for (const harness of restartHarnesses.splice(0)) harness.close();
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

type StartedCoordination = Awaited<ReturnType<typeof startRemoteBlockCoordinationServer>>;

export class OwnerCanvasRestartHarness {
  private server?: PlanweaveServer;
  private coordination?: StartedCoordination["coordination"];

  private constructor(
    readonly workspace: Awaited<ReturnType<typeof createTestWorkspace>>,
    readonly dataDirectory: string,
    readonly databasePath: string,
    readonly locator: { workspaceId: string; projectId: string; canvasId: string }
  ) {}

  static async create(): Promise<OwnerCanvasRestartHarness> {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const dataDirectory = join(workspace.root, "server-data-owner-restart");
    const harness = new OwnerCanvasRestartHarness(
      workspace,
      dataDirectory,
      join(dataDirectory, "server.sqlite"),
      {
        workspaceId: "workspace-owner-restart",
        projectId: workspace.init.workspace.id,
        canvasId: "default"
      }
    );
    restartHarnesses.push(harness);
    await harness.start();
    return harness;
  }

  async start(checkpoints?: RemoteCoordinatorCheckpointPort) {
    this.close();
    const runtime = createRemoteBlockRuntimePort({ projectRoot: this.workspace.root });
    const capturedContent = await captureAuthorizedCanvasContent({
      projectRoot: this.workspace.root,
      canvasId: this.locator.canvasId,
      expectedPackageDir: this.workspace.init.workspace.packageDir,
      authorityProjectId: this.locator.projectId
    });
    const registry = new RemoteRuntimePortRegistry();
    const started = await startRemoteBlockCoordinationServer(
      {
        dataDirectory: this.dataDirectory,
        databasePath: this.databasePath,
        busyTimeoutMs: 5_000
      },
      (database): RemoteBlockCoordinationOptions => {
        const workspaceId = new WorkspaceIdentityRepository(
          database
        ).ensureWorkspaceForLegacyProject(this.locator.projectId);
        this.locator.workspaceId = workspaceId;
        const contentVersions = new ContentVersionRepository(database);
        if (!contentVersions.head(this.locator)) {
          contentVersions.publishInitial({
            scope: this.locator,
            content: capturedContent.content,
            createdBy: { kind: "system", id: "owner-restart-test" }
          });
        }
        const evidence = readStableCanvasRuntimeEvidence(contentVersions, this.locator);
        if (!evidence) throw new Error("owner_restart_content_evidence_missing");
        registry.bind(
          this.locator,
          runtime,
          createRemoteBlockArtifactSource({ projectRoot: this.workspace.root }),
          async () => ({
            sourceRevision: evidence.sourceRevision,
            graphFingerprint: evidence.target.graphFingerprint,
            status: {
              schemaVersion: "canvas-runtime-status/v2",
              scope: this.locator,
              packageFingerprint: evidence.target.graphFingerprint,
              capturedAt: "2026-08-27T00:00:00.000Z",
              tasks: [],
              blocks: []
            }
          })
        );
        registerEndpointDispatchAccess({
          database,
          locator: this.locator,
          dispatchLocator: {
            ...this.locator,
            contentRevision: evidence.sourceRevision,
            graphFingerprint: evidence.target.graphFingerprint
          },
          projectRoot: this.workspace.root,
          packageDir: this.workspace.init.workspace.packageDir
        });
        return {
          leaseDurationMs: 60_000,
          hostOfflineAfterMs: 60_000,
          runtimeLeases: exactHostRuntimeRouteFixture(registry),
          runtimeContentTargets: {
            read: (scope) => readStableCanvasRuntimeContentTarget(contentVersions, scope)
          },
          ownerEndpointScopeAuthorized: (scope) =>
            scope.workspaceId === this.locator.workspaceId &&
            scope.projectId === this.locator.projectId &&
            scope.canvasId === this.locator.canvasId,
          inputArtifacts: { materialize: async () => {} },
          checkpoints
        };
      }
    );
    this.server = started.server;
    this.coordination = started.coordination;
    return started.coordination;
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
    this.coordination = undefined;
  }

  requireServer(): PlanweaveServer {
    if (!this.server) throw new Error("owner_restart_server_not_started");
    return this.server;
  }

  requireCoordination(): StartedCoordination["coordination"] {
    if (!this.coordination) throw new Error("owner_restart_coordination_not_started");
    return this.coordination;
  }

  registerHost(managedCanvasRuntime = true, bindWorkspace = false): string {
    const coordination = this.requireCoordination();
    const host = coordination.hosts.register("Owner Restart Host").host;
    ownHostRemoteAgents({ database: this.requireServer().database, hostId: host.id });
    if (bindWorkspace) coordination.hosts.bindToWorkspace(host.id, this.locator.workspaceId);
    this.reportHostOnline(host.id, managedCanvasRuntime);
    return host.id;
  }

  reportHostOnline(hostId: string, managedCanvasRuntime = true): void {
    this.requireCoordination().hosts.reportOnline(
      hostId,
      ["acp.codex", ...(managedCanvasRuntime ? [WORKSPACE_CANVAS_EXECUTION_CAPABILITY] : [])],
      1,
      {
        workspaceMappings: [],
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
  }

  request(idempotencyKey: string) {
    const evidence = readStableCanvasRuntimeEvidence(
      new ContentVersionRepository(this.requireServer().database),
      this.locator
    );
    if (!evidence) throw new Error("owner_restart_content_evidence_missing");
    return endpointDispatchRequest({
      agentEndpoints: this.requireCoordination().agentEndpoints,
      locator: {
        ...this.locator,
        contentRevision: evidence.sourceRevision,
        graphFingerprint: evidence.target.graphFingerprint
      },
      blockRef: "T-001#B-001",
      idempotencyKey,
      targetKind: "owner_canvas"
    });
  }
}

export function remoteManifest(includeSecondTask = false): PlanPackageManifest {
  const manifest = basicManifest(
    includeSecondTask ? { parallel: true, maxConcurrent: 2, includeSecondTask: true } : undefined
  );
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": {
      adapter: "agent",
      agent: "codex",
      runner: { transport: "acp" }
    }
  };
  return manifest;
}

export async function setup(
  withHost: boolean,
  manifest: PlanPackageManifest = remoteManifest(),
  hostCapacity = 1
) {
  const workspace = await createTestWorkspace(manifest);
  directories.push(workspace.home, workspace.root);
  const dataDirectory = join(workspace.root, "server-data");
  const server = await startPlanweaveServer({
    dataDirectory,
    databasePath: join(dataDirectory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  servers.push(server);
  const workspaceId = new WorkspaceIdentityRepository(
    server.database
  ).ensureWorkspaceForLegacyProject(workspace.init.workspace.id);
  const locator = {
    workspaceId,
    projectId: workspace.init.workspace.id,
    canvasId: "default"
  };
  const runtime = createRemoteBlockRuntimePort({ projectRoot: workspace.root });
  const registry = new RemoteRuntimePortRegistry();
  const runtimeArtifacts = createRemoteBlockArtifactSource({ projectRoot: workspace.root });
  const capturedContent = await captureAuthorizedCanvasContent({
    projectRoot: workspace.root,
    canvasId: locator.canvasId,
    expectedPackageDir: workspace.init.workspace.packageDir,
    authorityProjectId: locator.projectId
  });
  const contentVersions = new ContentVersionRepository(server.database);
  contentVersions.publishInitial({
    scope: locator,
    content: capturedContent.content,
    createdBy: { kind: "human", id: "test-owner" }
  });
  const contentEvidence = readStableCanvasRuntimeEvidence(contentVersions, locator);
  if (!contentEvidence) throw new Error("remote_block_content_evidence_missing");
  const contentTarget = contentEvidence.target;
  const dispatchLocator = {
    ...locator,
    contentRevision: contentEvidence.sourceRevision,
    graphFingerprint: contentTarget.graphFingerprint
  };
  const runtimeInitializationEvidenceFor = (scope: typeof locator) => async () => ({
    sourceRevision: `snapshot:${"a".repeat(64)}`,
    graphFingerprint: contentTarget.graphFingerprint,
    status: {
      schemaVersion: "canvas-runtime-status/v2",
      scope,
      packageFingerprint: contentTarget.graphFingerprint,
      capturedAt: "2026-08-27T00:00:00.000Z",
      tasks: [],
      blocks: []
    }
  });
  registry.bind(locator, runtime, runtimeArtifacts, runtimeInitializationEvidenceFor(locator));
  const artifacts = new ArtifactStore(server.database, dataDirectory, 1024 * 1024);
  const materialize = vi.fn(async (candidate: RemoteBlockDispatchCandidate) => {
    if (candidate.inputArtifacts.length !== 0) throw new Error("unexpected_test_artifact");
  });
  const coordination = createRemoteBlockCoordination(
    server.database,
    {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      runtimeLeases: exactHostRuntimeRouteFixture(registry),
      runtimeContentTargets: {
        read: (scope) => readStableCanvasRuntimeContentTarget(contentVersions, scope)
      },
      inputArtifacts: { materialize },
      artifactContent: {
        readReport: async (ref) => artifacts.read(ref),
        readReportMediaType: async (ref) => artifacts.getRequired(ref).mediaType
      },
      ownerEndpointScopeAuthorized: (scope) =>
        scope.workspaceId === locator.workspaceId &&
        scope.projectId === locator.projectId &&
        scope.canvasId === locator.canvasId
    },
    { serverInstanceOwnerToken: server.serverInstanceOwnerToken }
  );
  registerEndpointDispatchAccess({
    database: server.database,
    locator,
    dispatchLocator,
    projectRoot: workspace.root,
    packageDir: workspace.init.workspace.packageDir
  });
  const host = withHost ? coordination.hosts.register("Coordinator Host").host : undefined;
  const callerHumanPrincipalId = host
    ? ownHostRemoteAgents({
        database: server.database,
        hostId: host.id,
        grantWorkspaceId: workspaceId
      })
    : TEST_REMOTE_AGENT_OWNER_ID;
  if (host) {
    coordination.hosts.bindToWorkspace(host.id, workspaceId);
    coordination.hosts.reportOnline(
      host.id,
      ["acp.codex", WORKSPACE_CANVAS_EXECUTION_CAPABILITY],
      hostCapacity,
      {
        workspaceMappings: [{ workspaceId, status: "ready" }],
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
  }
  return {
    workspace,
    server,
    locator,
    dispatchLocator,
    runtime,
    registry,
    runtimeInitializationEvidenceFor,
    hosts: coordination.hosts,
    host,
    mailbox: coordination.mailbox,
    acpEvents: coordination.acpEvents,
    artifacts,
    materialize,
    operations: coordination.operations,
    coordinator: coordination.coordinator,
    dispatches: coordination.dispatches,
    reservations: coordination.reservations,
    agentEndpoints: coordination.agentEndpoints,
    remoteAgents: coordination.remoteAgents,
    remoteAgentAccess: coordination.remoteAgentAccess,
    interactions: coordination.interactions,
    artifactAuthorization: coordination.artifactAuthorization,
    callerHumanPrincipalId
  };
}

export async function setupFleetUnboundHost(manifest: PlanPackageManifest = remoteManifest()) {
  const fixture = await setup(false, manifest);
  const host = fixture.hosts.register("Fleet Unbound Host").host;
  ownHostRemoteAgents({ database: fixture.server.database, hostId: host.id });
  fixture.hosts.reportOnline(host.id, ["acp.codex", WORKSPACE_CANVAS_EXECUTION_CAPABILITY], 1, {
    workspaceMappings: [],
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
  const access = new ProjectAccessRepository(fixture.server.database);
  access.registerProjectInternal({
    workspaceId: fixture.locator.workspaceId,
    projectId: fixture.locator.projectId,
    projectRoot: fixture.workspace.root
  });
  access.registerCanvasInternal({
    workspaceId: fixture.locator.workspaceId,
    projectId: fixture.locator.projectId,
    canvasId: fixture.locator.canvasId,
    packageDir: fixture.workspace.init.workspace.packageDir
  });
  return { ...fixture, host };
}

export async function completeDispatchToTerminal(
  fixture: Awaited<ReturnType<typeof setupFleetUnboundHost>>,
  outcome: Awaited<ReturnType<typeof fixture.coordinator.dispatch>>
) {
  const report = Buffer.from("# Remote result\n\nCompleted by the remote host.\n");
  const artifact = await fixture.artifacts.put({
    expectedSha256: createHash("sha256").update(report).digest("hex"),
    expectedSizeBytes: report.byteLength,
    mediaType: "text/markdown",
    chunks: (async function* () {
      yield report;
    })()
  });
  const dispatch = fixture.dispatches.getRequired(outcome.operation.dispatchId);
  fixture.dispatches.accept(
    fixture.host.id,
    "accept-fleet-unbound",
    dispatch.id,
    dispatch.leaseId,
    dispatch.executionAttemptId
  );
  const grant = fixture.artifactAuthorization.createOutputGrant({
    operationId: "fleet-unbound-completion-report",
    workspaceId: dispatch.workspaceId,
    projectId: dispatch.projectId,
    hostId: dispatch.hostId,
    dispatchId: dispatch.id,
    leaseId: dispatch.leaseId,
    executionAttemptId: dispatch.executionAttemptId,
    permission: "report_write",
    expectedSha256: artifact.sha256,
    expectedSizeBytes: artifact.sizeBytes,
    expectedMediaType: artifact.mediaType
  });
  fixture.artifactAuthorization.acceptOutputUpload(
    {
      workspaceId: dispatch.workspaceId,
      projectId: dispatch.projectId,
      hostId: dispatch.hostId,
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      grantId: grant.grantId
    },
    artifact
  );
  await fixture.dispatches.complete(
    dispatch.hostId,
    "complete-fleet-unbound",
    dispatch.id,
    dispatch.leaseId,
    dispatch.executionAttemptId,
    {
      summary: "Remote completion.",
      reportArtifactRef: artifact.ref,
      artifactRefs: []
    }
  );
}
