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
  broker.attachSessionLookup({ isActive: (hostId) => hostId === host.id });
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
  return { adapter, broker, deliveries, host };
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
