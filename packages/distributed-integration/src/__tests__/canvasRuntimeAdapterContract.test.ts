import {
  CANVAS_RUNTIME_CAPABILITY,
  agentHostProtocolVersion,
  canvasRuntimeResponseEventSchema,
  type CanvasRuntimeRequestCommand
} from "@planweave-ai/agent-host-protocol";
import type { RemoteBlockRuntimePort } from "@planweave-ai/runtime";
import { remoteBlockClaimInputSchema, remoteBlockInspectInputSchema } from "@planweave-ai/runtime";
import { canvasScopeRefSchema } from "../../../collaboration-protocol/src/primitives.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ArtifactStore } from "../../../server/src/artifacts.js";
import type {
  CanvasExecutionRuntimeLease,
  CanvasExecutionRuntimeLeasePort
} from "../../../server/src/canvas/executionRuntimePort.js";
import { LocalFilesystemExecutionRuntimeAdapter } from "../../../server/src/canvas/localFilesystemExecutionRuntimeAdapter.js";
import { createLocalFilesystemCanvasRuntimeAdapter } from "../../../server/src/canvas/localFilesystemRuntimeAdapter.js";
import { RemoteHostCanvasRuntimeAdapter } from "../../../server/src/canvas/remoteHostRuntimeAdapter.js";
import { RuntimeArtifactGrantRepository } from "../../../server/src/canvas/runtimeArtifactGrantRepository.js";
import { CanvasRuntimeHostLocator } from "../../../server/src/canvas/runtimeHostLocator.js";
import { CanvasRuntimeRpcBroker } from "../../../server/src/canvas/runtimeRpcBroker.js";
import type { CanvasRuntimeAvailabilityPort } from "../../../server/src/canvas/runtimePort.js";
import { AgentHostRepository } from "../../../server/src/hosts.js";
import { WorkspaceIdentityRepository } from "../../../server/src/identity/workspaceRepository.js";
import { DurableMailbox } from "../../../server/src/mailbox.js";
import { applyMigrations } from "../../../server/src/migrations.js";
import { ProjectAccessRepository } from "../../../server/src/projectAccessRepository.js";
import { createTrustedRuntimeRegistry } from "../../../server/src/runtimeProjectRegistry.js";
import { openServerDatabase } from "../../../server/src/sqlite.js";
import {
  contractClaimInput,
  contractError,
  registerCanvasRuntimeAdapterContract,
  type CanvasRuntimeAdapterContractFixture
} from "./support/canvasRuntimeAdapterContract.js";

const blockRef = "T-001#B-001";

function unavailable() {
  return {
    schemaVersion: "canvas-runtime-availability/v1" as const,
    kind: "unavailable" as const,
    reason: "runtime_not_attached" as const
  };
}

function contractFacade(
  availability: CanvasRuntimeAvailabilityPort,
  leases: CanvasExecutionRuntimeLeasePort,
  attached: () => boolean
) {
  let releases = 0;
  const released = new WeakSet<CanvasExecutionRuntimeLease>();
  const adapter: CanvasRuntimeAvailabilityPort & CanvasExecutionRuntimeLeasePort = {
    readAvailability(scope, capturedAt) {
      return attached()
        ? availability.readAvailability(scope, capturedAt)
        : Promise.resolve(unavailable());
    },
    async acquire(scope) {
      if (!attached()) throw contractError("runtime_unavailable");
      let raw: CanvasExecutionRuntimeLease;
      try {
        raw = await leases.acquire(scope);
      } catch {
        throw contractError("runtime_unavailable");
      }
      let releaseResult: void | Promise<void>;
      const runtime: RemoteBlockRuntimePort = {
        ...raw.runtime,
        inspect(input) {
          if (released.has(lease)) return Promise.reject(contractError("runtime_unavailable"));
          return raw.runtime.inspect(input);
        },
        async claim(input) {
          if (released.has(lease)) throw contractError("runtime_unavailable");
          try {
            return await raw.runtime.claim(input);
          } catch (error) {
            if (
              error instanceof Error &&
              (error.message === "canvas_runtime_reconcile_required" ||
                ("reconcileRequired" in error && error.reconcileRequired === true))
            ) {
              throw contractError("reconcile_required");
            }
            throw contractError("content_out_of_sync");
          }
        }
      };
      const lease: CanvasExecutionRuntimeLease = {
        runtime,
        artifacts: raw.artifacts,
        release() {
          if (released.has(lease)) return releaseResult;
          released.add(lease);
          releases += 1;
          releaseResult = raw.release();
          return releaseResult;
        }
      };
      return lease;
    }
  };
  return { adapter, releaseCount: () => releases };
}

async function createLocalFixture(): Promise<CanvasRuntimeAdapterContractFixture> {
  const manifest = basicManifest();
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
  };
  const workspace = await createTestWorkspace(manifest);
  const scope = canvasScopeRefSchema.parse({
    workspaceId: "workspace-contract-local",
    projectId: workspace.init.workspace.id,
    canvasId: "default"
  });
  const trusted = await createTrustedRuntimeRegistry([
    { ...scope, trustAllDeclaredCanvases: false, projectRoot: workspace.root }
  ]);
  let attached = true;
  const availability = createLocalFilesystemCanvasRuntimeAdapter({
    resolveExactCanvasLocation: (input) =>
      attached ? trusted.resolveExactCanvasLocation(input) : undefined
  });
  const facade = contractFacade(
    availability,
    new LocalFilesystemExecutionRuntimeAdapter(trusted),
    () => attached
  );
  return {
    scope,
    blockRef,
    adapter: facade.adapter,
    detach() {
      attached = false;
    },
    releaseCount: facade.releaseCount,
    async inspectReleased(lease) {
      return lease.runtime.inspect({ ref: blockRef });
    },
    async beginMutationThenDetach(_lease) {
      attached = false;
      throw contractError("reconcile_required");
    },
    async close() {
      trusted.close();
      await Promise.all([
        rm(workspace.home, { recursive: true, force: true }),
        rm(workspace.root, { recursive: true, force: true })
      ]);
    }
  };
}

async function createInMemoryFixture(): Promise<CanvasRuntimeAdapterContractFixture> {
  const seed = await createLocalFixture();
  const availability = await seed.adapter.readAvailability(seed.scope);
  const seedLease = await seed.adapter.acquire(seed.scope);
  const candidate = await seedLease.runtime.inspect({ ref: blockRef });
  await seed.close();
  let attached = true;
  const runtime: RemoteBlockRuntimePort = {
    inspect: async () => candidate,
    async claim(input) {
      if (
        input.sourceRevision !== candidate.sourceRevision ||
        input.graphFingerprint !== candidate.graphFingerprint
      ) {
        throw new Error("in_memory_source_drift");
      }
      throw new Error("in_memory_claim_not_needed");
    },
    activate: async () => {
      throw new Error("not_implemented");
    },
    query: async () => {
      throw new Error("not_implemented");
    },
    reconcile: async () => {
      throw new Error("not_implemented");
    },
    markInterrupted: async () => {
      throw new Error("not_implemented");
    },
    resumeAttempt: async () => {
      throw new Error("not_implemented");
    },
    retryAttempt: async () => {
      throw new Error("not_implemented");
    },
    complete: async () => {
      throw new Error("not_implemented");
    },
    fail: async () => {
      throw new Error("not_implemented");
    }
  };
  const facade = contractFacade(
    { readAvailability: async () => availability },
    {
      acquire: async () => ({
        runtime,
        artifacts: {
          read: async () => {
            throw new Error("not_implemented");
          }
        },
        release() {}
      })
    },
    () => attached
  );
  return {
    scope: seed.scope,
    blockRef,
    adapter: facade.adapter,
    detach() {
      attached = false;
    },
    releaseCount: facade.releaseCount,
    inspectReleased: async (lease) => lease.runtime.inspect({ ref: blockRef }),
    async beginMutationThenDetach() {
      attached = false;
      throw contractError("reconcile_required");
    },
    close() {}
  };
}

async function createRemoteFixture(): Promise<CanvasRuntimeAdapterContractFixture> {
  const local = await createLocalFixture();
  const database = await openServerDatabase(":memory:", 5_000);
  applyMigrations(database);
  new WorkspaceIdentityRepository(database).ensureConfiguredWorkspace(local.scope.workspaceId);
  const projects = new ProjectAccessRepository(database);
  projects.registerProjectInternal({
    workspaceId: local.scope.workspaceId,
    projectId: local.scope.projectId,
    projectRoot: "/not-on-server"
  });
  projects.registerCanvasInternal({ ...local.scope, packageDir: "/not-on-server/package" });
  database.prepare("UPDATE project_registry SET project_root_internal=NULL").run();
  database.prepare("UPDATE canvas_registry SET package_dir_internal=NULL").run();
  const hosts = new AgentHostRepository(database);
  const host = hosts.register("Contract Host").host;
  hosts.reportOnline(host.id, [CANVAS_RUNTIME_CAPABILITY], 1, {
    workspaceMappings: [],
    acpProfiles: [],
    runtimeProjects: [
      {
        workspaceId: local.scope.workspaceId,
        projectId: local.scope.projectId,
        status: "ready"
      }
    ]
  });
  const mailbox = new DurableMailbox(database);
  const broker = new CanvasRuntimeRpcBroker(database, hosts, mailbox, { requestTimeoutMs: 1_000 });
  let attached = true;
  broker.attachSessionLookup({ isActive: (hostId) => attached && hostId === host.id });
  const locator = new CanvasRuntimeHostLocator(hosts.runtimeBindings, hosts, broker, projects);
  const artifactDirectory = await mkdtemp(join(tmpdir(), "planweave-contract-artifacts-"));
  const artifacts = new ArtifactStore(database, artifactDirectory, 1024 * 1024);
  const grants = new RuntimeArtifactGrantRepository(database, {
    maxArtifactBytes: artifacts.maxArtifactBytes,
    leaseActive: () => attached
  });
  const raw = new RemoteHostCanvasRuntimeAdapter(locator, broker, { grants, artifacts });
  const facade = contractFacade(raw, raw, () => attached);
  const hostLeases = new Map<string, CanvasExecutionRuntimeLease>();
  let holdMutation = false;
  let heldMutation = false;

  const respond = (command: CanvasRuntimeRequestCommand, response: Record<string, unknown>) => {
    broker.handleResponse(
      host.id,
      canvasRuntimeResponseEventSchema.parse({
        type: "canvas_runtime.response",
        protocolVersion: agentHostProtocolVersion,
        messageId: randomUUID(),
        requestId: command.requestId,
        response
      })
    );
  };
  mailbox.subscribe(host.id, (message) => {
    const command = message.command;
    if (command.type !== "canvas_runtime.request") return;
    void (async () => {
      const operation = command.operation;
      if (holdMutation && operation.operation === "claim") {
        heldMutation = true;
        return;
      }
      try {
        if (operation.operation === "availability") {
          const result = await local.adapter.readAvailability(local.scope);
          if (result.kind !== "available") throw new Error("local_contract_unavailable");
          const { schemaVersion: _schemaVersion, ...portable } = result;
          respond(command, { outcome: "success", operation: "availability", result: portable });
          return;
        }
        if (operation.operation === "acquire") {
          const lease = await local.adapter.acquire(local.scope);
          const result = await local.adapter.readAvailability(local.scope);
          if (result.kind !== "available") throw new Error("local_contract_unavailable");
          const runtimeLeaseId = randomUUID();
          hostLeases.set(runtimeLeaseId, lease);
          respond(command, {
            outcome: "success",
            operation: "acquire",
            result: {
              runtimeLeaseId,
              sourceRevision: result.sourceRevision,
              graphFingerprint: result.graphFingerprint,
              acquiredAt: new Date().toISOString(),
              expiresAt: "2099-08-20T00:00:00.000Z"
            }
          });
          return;
        }
        if (!("runtimeLeaseId" in operation)) throw new Error("runtime_lease_required");
        const lease = hostLeases.get(operation.runtimeLeaseId);
        if (!lease) throw new Error("runtime_lease_not_found");
        if (operation.operation === "inspect") {
          respond(command, {
            outcome: "success",
            operation: "inspect",
            result: await lease.runtime.inspect(
              remoteBlockInspectInputSchema.parse(operation.input)
            )
          });
          return;
        }
        if (operation.operation === "claim") {
          respond(command, {
            outcome: "success",
            operation: "claim",
            result: await lease.runtime.claim(remoteBlockClaimInputSchema.parse(operation.input))
          });
          return;
        }
        if (operation.operation === "release") {
          await lease.release();
          hostLeases.delete(operation.runtimeLeaseId);
          respond(command, {
            outcome: "success",
            operation: "release",
            result: { released: true }
          });
          return;
        }
        throw new Error("operation_not_supported_by_contract_host");
      } catch {
        respond(command, {
          outcome: "error",
          operation: command.operation.operation,
          error: {
            code: "content_out_of_sync",
            message: "The Canvas Runtime request could not be completed.",
            retryable: false
          }
        });
      }
    })();
  });

  return {
    scope: local.scope,
    blockRef,
    adapter: facade.adapter,
    detach() {
      attached = false;
      broker.detachHost(host.id, "disconnected");
    },
    releaseCount: facade.releaseCount,
    inspectReleased: async (lease) => lease.runtime.inspect({ ref: blockRef }),
    async beginMutationThenDetach(lease, candidate) {
      holdMutation = true;
      const pending = lease.runtime.claim(contractClaimInput(candidate));
      for (let attempt = 0; attempt < 100 && !heldMutation; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      if (!heldMutation) throw new Error("contract_mutation_not_delivered");
      attached = false;
      broker.detachHost(host.id, "disconnected");
      return pending;
    },
    async close() {
      broker.close();
      database.close();
      await local.close();
      await rm(artifactDirectory, { recursive: true, force: true });
    }
  };
}

registerCanvasRuntimeAdapterContract([
  { name: "Local filesystem", create: createLocalFixture },
  { name: "Remote Host", create: createRemoteFixture },
  { name: "In-memory", create: createInMemoryFixture }
]);
