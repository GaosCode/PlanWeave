import {
  CANVAS_RUNTIME_CAPABILITY,
  agentHostProtocolVersion,
  type CanvasRuntimeRequestCommand
} from "@planweave-ai/agent-host-protocol";
import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalFirstCanvasRuntimeRouter,
  RemoteHostCanvasRuntimeAdapter
} from "../canvas/remoteHostRuntimeAdapter.js";
import { CanvasRuntimeHostLocator } from "../canvas/runtimeHostLocator.js";
import { CanvasRuntimeRpcBroker } from "../canvas/runtimeRpcBroker.js";
import { CanvasRuntimeUnavailableError } from "../canvas/executionRuntimePort.js";
import { AgentHostRepository } from "../hosts.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { DurableMailbox, type MailboxMessage } from "../mailbox.js";
import { applyMigrations } from "../migrations.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { ArtifactStore } from "../artifacts.js";
import { RuntimeArtifactGrantRepository } from "../canvas/runtimeArtifactGrantRepository.js";
import { RemoteHostWorkRuntimeFactsAdapter } from "../work/remoteHostRuntimeFactsAdapter.js";

const databases: SqliteDatabase[] = [];
const scope = canvasScopeRefSchema.parse({
  workspaceId: "workspace-remote-adapter",
  projectId: "project-remote-adapter",
  canvasId: "default"
});

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function setup() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  new WorkspaceIdentityRepository(database).ensureConfiguredWorkspace(scope.workspaceId);
  const projectAccess = new ProjectAccessRepository(database);
  projectAccess.registerProjectInternal({
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    projectRoot: "/runtime/project"
  });
  projectAccess.registerCanvasInternal({ ...scope, packageDir: "/runtime/project/package" });
  database
    .prepare("UPDATE project_registry SET project_root_internal=NULL WHERE project_id=?")
    .run(scope.projectId);
  database
    .prepare("UPDATE canvas_registry SET package_dir_internal=NULL WHERE project_id=?")
    .run(scope.projectId);
  const hosts = new AgentHostRepository(database);
  const host = hosts.register("Remote Runtime").host;
  hosts.reportOnline(host.id, [CANVAS_RUNTIME_CAPABILITY], 1, {
    workspaceMappings: [{ workspaceId: scope.workspaceId, status: "ready" }],
    acpProfiles: [],
    runtimeProjects: [
      { workspaceId: scope.workspaceId, projectId: scope.projectId, status: "ready" }
    ]
  });
  const mailbox = new DurableMailbox(database);
  const broker = new CanvasRuntimeRpcBroker(database, hosts, mailbox, {
    requestTimeoutMs: 1_000
  });
  let sessionActive = true;
  broker.attachSessionLookup({ isActive: (hostId) => sessionActive && hostId === host.id });
  const deliveries: MailboxMessage[] = [];
  mailbox.subscribe(host.id, (message) => deliveries.push(message));
  const locator = new CanvasRuntimeHostLocator(hosts.runtimeBindings, hosts, broker, projectAccess);
  const grants = new RuntimeArtifactGrantRepository(database, {
    maxArtifactBytes: 1024 * 1024,
    leaseActive: (lease) =>
      broker.isActive(lease.hostId) &&
      broker.attachmentVersion(lease.hostId) === lease.attachmentVersion
  });
  const adapter = new RemoteHostCanvasRuntimeAdapter(locator, broker, {
    grants,
    artifacts: new ArtifactStore(database, "/not-observed", 1024 * 1024)
  });
  const factsAdapter = new RemoteHostWorkRuntimeFactsAdapter(locator, broker);
  return {
    adapter,
    factsAdapter,
    broker,
    deliveries,
    host,
    database,
    disconnect() {
      sessionActive = false;
      broker.detachHost(host.id, "disconnected");
    }
  };
}

function commandAt(deliveries: MailboxMessage[], index: number): CanvasRuntimeRequestCommand {
  const command = deliveries[index]?.command;
  if (command?.type !== "canvas_runtime.request") {
    throw new Error("test_canvas_runtime_request_expected");
  }
  return command;
}

function respond(
  broker: CanvasRuntimeRpcBroker,
  hostId: string,
  command: CanvasRuntimeRequestCommand,
  response: Record<string, unknown>
) {
  broker.handleResponse(hostId, {
    type: "canvas_runtime.response",
    protocolVersion: agentHostProtocolVersion,
    messageId: randomUUID(),
    requestId: command.requestId,
    response
  });
}

describe("RemoteHostCanvasRuntimeAdapter", () => {
  it("distinguishes missing bindings from disconnected Host sessions", async () => {
    const missing = await setup();
    missing.database.prepare("DELETE FROM canvas_runtime_host_bindings").run();
    await expect(
      missing.factsAdapter.acquireFacts({
        scope,
        workItems: [{ kind: "task", canvasId: scope.canvasId, taskId: "T-001" }]
      })
    ).rejects.toMatchObject({ code: "runtime_not_attached" });

    const offline = await setup();
    offline.disconnect();
    await expect(
      offline.factsAdapter.acquireFacts({
        scope,
        workItems: [{ kind: "task", canvasId: scope.canvasId, taskId: "T-001" }]
      })
    ).rejects.toMatchObject({ code: "host_offline" });
    expect(offline.deliveries).toHaveLength(0);
  });

  it.each([
    "runtime_canvas_not_found",
    "runtime_project_identity_mismatch"
  ])("maps Host resolver drift %s to content_out_of_sync", async (code) => {
    const fixture = await setup();
    const pending = fixture.factsAdapter.acquireFacts({
      scope,
      workItems: [{ kind: "task", canvasId: scope.canvasId, taskId: "T-001" }]
    });
    respond(fixture.broker, fixture.host.id, commandAt(fixture.deliveries, 0), {
      outcome: "error",
      operation: "resolve_work_items",
      error: {
        code,
        message: "The Canvas Runtime request could not be completed.",
        retryable: false
      }
    });
    await expect(pending).rejects.toMatchObject({ code: "content_out_of_sync" });
  });

  it("resolves one bounded Work facts batch with strict identity and no execution lease", async () => {
    const fixture = await setup();
    const workItems = [
      { kind: "task" as const, canvasId: scope.canvasId, taskId: "T-001" },
      { kind: "block" as const, canvasId: scope.canvasId, blockRef: "T-001#B-001" }
    ];
    const pending = fixture.factsAdapter.acquireFacts({ scope, workItems });
    const command = commandAt(fixture.deliveries, 0);
    expect(command.operation).toEqual({
      operation: "resolve_work_items",
      input: { workItems }
    });
    const graphFingerprint = `pkg-${"a".repeat(64)}`;
    respond(fixture.broker, fixture.host.id, command, {
      outcome: "success",
      operation: "resolve_work_items",
      result: {
        sourceRevision: "snapshot:test",
        graphFingerprint,
        facts: [
          {
            kind: "task",
            canvasId: scope.canvasId,
            taskId: "T-001",
            exists: true,
            requiredCapabilities: []
          },
          {
            kind: "block",
            canvasId: scope.canvasId,
            blockRef: "T-001#B-001",
            taskId: "T-001",
            blockType: "implementation",
            exists: true,
            requiredCapabilities: ["acp.codex"]
          }
        ]
      }
    });
    const lease = await pending;
    expect(lease?.package.resolveWorkItems(workItems)).toHaveLength(2);
    expect(fixture.deliveries).toHaveLength(1);
    lease?.release();
    expect(() => lease?.package.resolveWorkItem(workItems[0]!)).toThrow(
      "runtime_package_scope_released"
    );
  });

  it("serves remote availability with no local trusted project", async () => {
    const fixture = await setup();
    const router = new LocalFirstCanvasRuntimeRouter(
      {
        async readAvailability() {
          throw new Error("local_should_not_run");
        }
      },
      {
        acquire() {
          throw new CanvasRuntimeUnavailableError();
        }
      },
      { hasRuntimeProject: () => false, hasRuntimeScope: () => false }
    );
    router.attachRemote(fixture.adapter);

    const pending = router.readAvailability(scope, "2026-08-20T00:00:00.000Z");
    const command = commandAt(fixture.deliveries, 0);
    const graphFingerprint = `pkg-${"a".repeat(64)}`;
    respond(fixture.broker, fixture.host.id, command, {
      outcome: "success",
      operation: "availability",
      result: {
        kind: "available",
        sourceRevision: `snapshot:${"b".repeat(64)}`,
        graphFingerprint,
        status: {
          schemaVersion: "canvas-runtime-status/v2",
          scope,
          packageFingerprint: graphFingerprint,
          capturedAt: "2026-08-20T00:00:00.000Z",
          tasks: [],
          blocks: []
        }
      }
    });

    await expect(pending).resolves.toMatchObject({
      kind: "available",
      graphFingerprint,
      status: { scope }
    });
  });

  it("acquires one remote lease and releases it exactly once", async () => {
    const fixture = await setup();
    const acquiring = fixture.adapter.acquire(scope);
    const acquireCommand = commandAt(fixture.deliveries, 0);
    respond(fixture.broker, fixture.host.id, acquireCommand, {
      outcome: "success",
      operation: "acquire",
      result: {
        runtimeLeaseId: randomUUID(),
        sourceRevision: `snapshot:${"b".repeat(64)}`,
        graphFingerprint: `pkg-${"a".repeat(64)}`,
        acquiredAt: "2026-08-20T00:00:00.000Z",
        expiresAt: "2099-08-20T00:01:00.000Z"
      }
    });
    const lease = await acquiring;

    const inspecting = lease.runtime.inspect({ ref: "T-001#B-001" });
    const inspectCommand = commandAt(fixture.deliveries, 1);
    expect(inspectCommand.operation).toMatchObject({
      operation: "inspect",
      input: { ref: "T-001#B-001" }
    });
    respond(fixture.broker, fixture.host.id, inspectCommand, {
      outcome: "success",
      operation: "inspect",
      result: { workspaceId: "invalid-incomplete-result" }
    });
    await expect(inspecting).rejects.toThrow();

    const firstRelease = lease.release();
    const secondRelease = lease.release();
    expect(fixture.deliveries).toHaveLength(3);
    const releaseCommand = commandAt(fixture.deliveries, 2);
    expect(releaseCommand.operation.operation).toBe("release");
    respond(fixture.broker, fixture.host.id, releaseCommand, {
      outcome: "success",
      operation: "release",
      result: { released: true }
    });
    await expect(firstRelease).resolves.toBeUndefined();
    await expect(secondRelease).resolves.toBeUndefined();
    expect(fixture.deliveries).toHaveLength(3);
  });

  it("preserves local-first behavior when a local Runtime is attached", async () => {
    const localLease = { runtime: {}, artifacts: {}, release: vi.fn() };
    const localAcquire = vi.fn(() => localLease);
    const localRead = vi.fn(async () => ({
      schemaVersion: "canvas-runtime-availability/v1" as const,
      kind: "unavailable" as const,
      reason: "runtime_not_attached" as const
    }));
    const router = new LocalFirstCanvasRuntimeRouter(
      { readAvailability: localRead },
      { acquire: localAcquire },
      { hasRuntimeProject: () => true, hasRuntimeScope: () => true }
    );

    await expect(router.readAvailability(scope)).resolves.toMatchObject({
      kind: "unavailable",
      reason: "runtime_not_attached"
    });
    await expect(router.acquire(scope)).resolves.toBe(localLease);
    expect(localRead).toHaveBeenCalledOnce();
    expect(localAcquire).toHaveBeenCalledOnce();
  });
});
