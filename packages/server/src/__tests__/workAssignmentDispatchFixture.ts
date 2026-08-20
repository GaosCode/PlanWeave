import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createRemoteBlockArtifactSource,
  createRemoteBlockRuntimePort,
  type PlanPackageManifest,
  type RemoteBlockRuntimePort
} from "@planweave-ai/runtime";
import { afterEach } from "vitest";
import {
  createTestWorkspace,
  basicManifest
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ArtifactStore } from "../artifacts.js";
import { canonicalRemoteRuntimePort } from "../canonicalRemoteRuntimePort.js";
import { ActivityRepository } from "../comments/activityRepository.js";
import { ActivityProjectionService } from "../comments/service.js";
import { createRemoteBlockCoordination } from "../distributedCoordination.js";
import { AgentHostRepository } from "../hosts.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import type { HumanAuthContext } from "../identity/schemas.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import type { RemoteCoordinatorCheckpointPort } from "../remoteBlockCoordinatorPorts.js";
import { RemoteRuntimePortRegistry } from "../remoteRuntimeLocator.js";
import {
  createActiveDispatchResolver,
  createAssignmentDispatchGate,
  type DispatchHostSelectionSnapshot
} from "../work/dispatchIntegration.js";
import { createHostAssignmentPort, createIdentityMembershipPort } from "../work/ports.js";
import { WorkAssignmentRepository } from "../work/repository.js";
import { WorkAssignmentService } from "../work/service.js";
import type { WorkItemRef } from "../work/schemas.js";
import { seedLegacyRemoteOperation } from "./support/legacyRemoteOperationSeed.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];

export function registerWorkAssignmentTestDirectory(directory: string): void {
  directories.push(directory);
}

export function registerWorkAssignmentTestServer(server: PlanweaveServer): void {
  servers.push(server);
}

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

export function remoteManifest(): PlanPackageManifest {
  const manifest = basicManifest();
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

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

export async function setup(
  options: {
    strictGate?: boolean;
    withHosts?: Array<{ name: string; capabilities: string[]; capacity: number }>;
    checkpoints?: RemoteCoordinatorCheckpointPort;
    decorateRuntime?: (runtime: RemoteBlockRuntimePort) => RemoteBlockRuntimePort;
    projectActivity?: boolean;
  } = {}
) {
  const workspace = await createTestWorkspace(remoteManifest());
  directories.push(workspace.home, workspace.root);
  const dataDirectory = join(workspace.root, "server-data");
  const server = await startPlanweaveServer({
    dataDirectory,
    databasePath: join(dataDirectory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  servers.push(server);
  const activity = options.projectActivity ? new ActivityRepository(server.database) : undefined;
  const activityProjection = activity ? new ActivityProjectionService({ activity }) : undefined;

  const workspaceIdentity = new WorkspaceIdentityRepository(server.database);
  const workspaceId = workspaceIdentity.ensureLegacyProjectAdapter(
    workspace.init.workspace.id,
    workspace.init.workspace.id
  );
  const locator = {
    workspaceId,
    projectId: workspace.init.workspace.id,
    canvasId: "default"
  };
  const workAssignments = new WorkAssignmentRepository(server.database);
  const assignmentGate = options.strictGate
    ? createAssignmentDispatchGate({
        repository: workAssignments,
        hostPort: createHostAssignmentPort({
          hosts: new AgentHostRepository(server.database),
          hostOfflineAfterMs: 60_000
        }),
        defaultAllowHumanOverride: false
      })
    : undefined;

  let activeRuntime: RemoteBlockRuntimePort | undefined;
  const buildCoordination = (checkpoints?: RemoteCoordinatorCheckpointPort) => {
    const baseRuntime = createRemoteBlockRuntimePort({ projectRoot: workspace.root });
    const runtime = options.decorateRuntime?.(baseRuntime) ?? baseRuntime;
    activeRuntime = runtime;
    const registry = new RemoteRuntimePortRegistry();
    registry.bind(
      locator,
      runtime,
      createRemoteBlockArtifactSource({ projectRoot: workspace.root })
    );
    const artifacts = new ArtifactStore(server.database, dataDirectory, 1024 * 1024);
    return createRemoteBlockCoordination(
      server.database,
      {
        leaseDurationMs: 60_000,
        hostOfflineAfterMs: 60_000,
        runtimeLeases: registry,
        inputArtifacts: {
          materialize: async (candidate) => {
            if (candidate.inputArtifacts.length !== 0) throw new Error("unexpected_test_artifact");
          }
        },
        artifactContent: { readReport: async (ref) => artifacts.read(ref) },
        assignmentGate,
        checkpoints,
        ...(activityProjection
          ? {
              onDispatchActivityTransitionInTransaction: (input) => {
                activityProjection.projectRemoteRunEventInCallerTransaction({
                  projectId: input.dispatch.projectId,
                  type: input.type,
                  dispatchId: input.dispatch.id,
                  hostId: input.dispatch.hostId,
                  occurredAt: input.occurredAt
                });
              }
            }
          : {})
      },
      { serverInstanceOwnerToken: server.serverInstanceOwnerToken }
    );
  };

  let coordination = buildCoordination(options.checkpoints);

  // Host reservation is workspace-scoped; map the legacy project and bind hosts so
  // preferred-host selection can resolve online capacity (same as production enrollment).
  const registeredHosts: Array<{ id: string; name: string }> = [];
  for (const hostSpec of options.withHosts ?? [
    { name: "Primary Host", capabilities: ["acp.codex"], capacity: 2 }
  ]) {
    const host = coordination.hosts.register(hostSpec.name).host;
    coordination.hosts.bindToWorkspace(host.id, workspaceId);
    coordination.hosts.reportOnline(host.id, hostSpec.capabilities, hostSpec.capacity, {
      workspaceMappings: [{ workspaceId, status: "ready" }],
      acpProfiles: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Test Agent",
          status: "ready",
          capabilities: hostSpec.capabilities
        }
      ]
    });
    registeredHosts.push({ id: host.id, name: hostSpec.name });
  }

  const identity = new HumanIdentityRepository(server.database);
  const ownerBoot = identity.bootstrapOwner({
    kind: "local_administrative_proof",
    projectId: locator.projectId,
    humanPrincipalId: "human-owner",
    displayName: "Ada Owner",
    issuedAt: new Date().toISOString()
  });
  const ownerContext: HumanAuthContext = {
    humanPrincipalId: ownerBoot.principal.humanPrincipalId,
    displayName: ownerBoot.principal.displayName,
    deviceCredentialId: ownerBoot.device.deviceCredentialId,
    projectId: locator.projectId,
    role: "owner",
    membershipId: ownerBoot.membership.membershipId
  };

  const assignmentService = new WorkAssignmentService({
    workspaceId,
    repository: workAssignments,
    packagePort: {
      resolveWorkItem(workItem) {
        if (workItem.kind === "block" && workItem.blockRef === "T-001#B-001") {
          return {
            canvasId: "default",
            kind: "block",
            exists: true,
            blockRef: "T-001#B-001",
            taskId: "T-001",
            blockType: "implementation",
            requiredCapabilities: []
          };
        }
        if (workItem.kind === "task" && workItem.taskId === "T-001") {
          return {
            canvasId: "default",
            kind: "task",
            exists: true,
            taskId: "T-001",
            requiredCapabilities: []
          };
        }
        return {
          canvasId: workItem.canvasId,
          kind: workItem.kind,
          exists: false,
          taskId: workItem.kind === "task" ? workItem.taskId : undefined,
          blockRef: workItem.kind === "block" ? workItem.blockRef : undefined,
          requiredCapabilities: []
        };
      },
      resolveWorkItems(workItems) {
        return workItems.map((workItem) => this.resolveWorkItem(workItem));
      }
    },
    membershipPort: createIdentityMembershipPort({ identity }),
    hostPort: createHostAssignmentPort({
      hosts: coordination.hosts,
      hostOfflineAfterMs: 60_000,
      countActiveDispatches: () => 0
    }),
    resolveActiveDispatch: createActiveDispatchResolver(server.database)
  });

  const blockItem: WorkItemRef = {
    kind: "block",
    canvasId: "default",
    blockRef: "T-001#B-001"
  };

  return {
    workspace,
    workspaceId,
    server,
    locator,
    get coordination() {
      return coordination;
    },
    get runtime() {
      if (!activeRuntime) throw new Error("test_runtime_not_initialized");
      return activeRuntime;
    },
    async seedLegacyOperation(
      idempotencyKey: string,
      hostSelection?: DispatchHostSelectionSnapshot
    ) {
      if (!activeRuntime) throw new Error("test_runtime_not_initialized");
      const candidate = await canonicalRemoteRuntimePort(activeRuntime, workspaceId).inspect({
        ref: "T-001#B-001"
      });
      return seedLegacyRemoteOperation({
        database: server.database,
        operations: coordination.operations,
        locator,
        candidate,
        idempotencyKey,
        ...(hostSelection === undefined ? {} : { hostSelection })
      });
    },
    rebuildCoordination(checkpoints?: RemoteCoordinatorCheckpointPort) {
      // A new coordinator simulates process restart; Host selection must recover from the durable operation snapshot.
      coordination = buildCoordination(checkpoints);
      return coordination;
    },
    workAssignments,
    assignmentService,
    assignmentGate,
    activity,
    ownerContext,
    blockItem,
    hosts: registeredHosts
  };
}
