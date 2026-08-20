import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  createRemoteBlockArtifactSource,
  createRemoteBlockRuntimePort,
  type PlanPackageManifest
} from "@planweave-ai/runtime";
import { afterEach, vi } from "vitest";
import {
  createTestWorkspace,
  basicManifest
} from "../../../../runtime/src/__tests__/promptTestHelpers.js";
import { ArtifactStore } from "../../artifacts.js";
import { createRemoteBlockCoordination } from "../../distributedCoordination.js";
import { startPlanweaveServer, type PlanweaveServer } from "../../lifecycle.js";
import { RemoteRuntimePortRegistry } from "../../remoteRuntimeLocator.js";
import { WorkspaceIdentityRepository } from "../../identity/workspaceRepository.js";
import { registerEndpointDispatchAccess } from "./endpointCoordinatorFixture.js";

export const directories: string[] = [];
const servers: PlanweaveServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

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
  registry.bind(locator, runtime, createRemoteBlockArtifactSource({ projectRoot: workspace.root }));
  const artifacts = new ArtifactStore(server.database, dataDirectory, 1024 * 1024);
  const materialize = vi.fn(async (candidate: Awaited<ReturnType<typeof runtime.inspect>>) => {
    if (candidate.inputArtifacts.length !== 0) throw new Error("unexpected_test_artifact");
  });
  const coordination = createRemoteBlockCoordination(
    server.database,
    {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      runtimeLeases: registry,
      inputArtifacts: { materialize },
      artifactContent: { readReport: async (ref) => artifacts.read(ref) },
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
    projectRoot: workspace.root,
    packageDir: workspace.init.workspace.packageDir
  });
  const host = withHost ? coordination.hosts.register("Coordinator Host").host : undefined;
  if (host) {
    coordination.hosts.bindToWorkspace(host.id, workspaceId);
    coordination.hosts.reportOnline(host.id, ["acp.codex"], hostCapacity, {
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
    });
  }
  return {
    workspace,
    server,
    locator,
    runtime,
    registry,
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
    artifactAuthorization: coordination.artifactAuthorization
  };
}
