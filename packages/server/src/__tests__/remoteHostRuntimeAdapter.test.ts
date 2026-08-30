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
import { RemoteOwnershipConflictError } from "@planweave-ai/runtime";
import {
  CanvasRuntimeHostAmbiguousError,
  CanvasRuntimeHostLocator
} from "../canvas/runtimeHostLocator.js";
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
const runtimeContentTarget = {
  revision: 1,
  content: {
    versionId: `version-${"c".repeat(64)}`,
    canonicalDigest: "c".repeat(64),
    verification: "complete" as const
  },
  graphFingerprint: `pkg-${"a".repeat(64)}`
};
const runtimeSourceRevision = "snapshot:test";

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function setup(requestTimeoutMs = 1_000) {
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
  const reportRuntimeHost = (hostId: string) =>
    hosts.reportOnline(hostId, [CANVAS_RUNTIME_CAPABILITY], 1, {
      workspaceMappings: [{ workspaceId: scope.workspaceId, status: "ready" }],
      acpProfiles: [],
      runtimeProjects: [
        { workspaceId: scope.workspaceId, projectId: scope.projectId, status: "ready" }
      ]
    });
  const host = hosts.register("Remote Runtime").host;
  reportRuntimeHost(host.id);
  const mailbox = new DurableMailbox(database);
  const broker = new CanvasRuntimeRpcBroker(database, hosts, mailbox, {
    requestTimeoutMs
  });
  const activeHostIds = new Set([host.id]);
  broker.attachSessionLookup({ isActive: (hostId) => activeHostIds.has(hostId) });
  const deliveries: MailboxMessage[] = [];
  mailbox.subscribe(host.id, (message) => deliveries.push(message));
  const locator = new CanvasRuntimeHostLocator(hosts.runtimeBindings, hosts, broker, projectAccess);
  const grants = new RuntimeArtifactGrantRepository(database, {
    maxArtifactBytes: 1024 * 1024,
    leaseActive: (lease) =>
      broker.isActive(lease.hostId) &&
      broker.attachmentVersion(lease.hostId) === lease.attachmentVersion
  });
  const contentTargets = { read: () => runtimeContentTarget };
  const readContentAuthority = vi.fn(() => ({
    target: runtimeContentTarget,
    sourceRevision: runtimeSourceRevision
  }));
  const adapter = new RemoteHostCanvasRuntimeAdapter(locator, broker, contentTargets, {
    grants,
    artifacts: new ArtifactStore(database, "/not-observed", 1024 * 1024)
  });
  const factsAdapter = new RemoteHostWorkRuntimeFactsAdapter(locator, broker, {
    read: readContentAuthority
  });
  return {
    adapter,
    factsAdapter,
    broker,
    locator,
    readContentAuthority,
    deliveries,
    host,
    database,
    addHost(name: string) {
      const additionalHost = hosts.register(name).host;
      reportRuntimeHost(additionalHost.id);
      activeHostIds.add(additionalHost.id);
      const hostDeliveries: MailboxMessage[] = [];
      mailbox.subscribe(additionalHost.id, (message) => hostDeliveries.push(message));
      return { host: additionalHost, deliveries: hostDeliveries };
    },
    disconnectHost(hostId: string) {
      activeHostIds.delete(hostId);
      broker.detachHost(hostId, "disconnected");
    },
    disconnect() {
      this.disconnectHost(host.id);
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

function taskFactsResult(
  sourceRevision = runtimeSourceRevision,
  graphFingerprint = runtimeContentTarget.graphFingerprint
) {
  return {
    sourceRevision,
    graphFingerprint,
    facts: [
      {
        kind: "task",
        canvasId: scope.canvasId,
        taskId: "T-001",
        exists: true,
        requiredCapabilities: []
      }
    ]
  };
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
      contentTarget: runtimeContentTarget,
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

  it("selects exact Task and Project facts from two Hosts while generic Runtime routing stays ambiguous", async () => {
    const fixture = await setup();
    const second = fixture.addHost("Current Project Runtime");
    const workItems = [{ kind: "task" as const, canvasId: scope.canvasId, taskId: "T-001" }];

    expect(() => fixture.adapter.acquire(scope)).toThrow(CanvasRuntimeHostAmbiguousError);
    const pending = fixture.factsAdapter.acquireFacts({ scope, workItems });
    const staleCommand = commandAt(fixture.deliveries, 0);
    const exactCommand = commandAt(second.deliveries, 0);
    expect(staleCommand.scope).toEqual(scope);
    expect(exactCommand.scope).toEqual(scope);
    expect(staleCommand.operation).toMatchObject({ contentTarget: runtimeContentTarget });
    expect(exactCommand.operation).toMatchObject({ contentTarget: runtimeContentTarget });

    respond(fixture.broker, fixture.host.id, staleCommand, {
      outcome: "success",
      operation: "resolve_work_items",
      result: taskFactsResult(`snapshot:${"d".repeat(64)}`)
    });
    respond(fixture.broker, second.host.id, exactCommand, {
      outcome: "success",
      operation: "resolve_work_items",
      result: taskFactsResult()
    });

    const lease = await pending;
    expect(lease?.evidence).toEqual({
      sourceRevision: runtimeSourceRevision,
      graphFingerprint: runtimeContentTarget.graphFingerprint
    });
    expect(lease?.package.resolveWorkItem(workItems[0]!)).toMatchObject({
      kind: "task",
      taskId: "T-001",
      exists: true
    });
    expect(fixture.readContentAuthority).toHaveBeenCalledTimes(1);
  });

  it("uses an exact facts peer when another candidate disconnects", async () => {
    const fixture = await setup();
    const second = fixture.addHost("Exact Runtime");
    const workItems = [{ kind: "task" as const, canvasId: scope.canvasId, taskId: "T-001" }];
    const pending = fixture.factsAdapter.acquireFacts({ scope, workItems });
    const exactCommand = commandAt(second.deliveries, 0);

    fixture.disconnectHost(fixture.host.id);
    respond(fixture.broker, second.host.id, exactCommand, {
      outcome: "success",
      operation: "resolve_work_items",
      result: taskFactsResult()
    });

    await expect(pending).resolves.toMatchObject({
      evidence: {
        sourceRevision: runtimeSourceRevision,
        graphFingerprint: runtimeContentTarget.graphFingerprint
      }
    });
  });

  it("fails with content_out_of_sync when no Host facts match Server authority", async () => {
    const fixture = await setup();
    const second = fixture.addHost("Drifted Runtime");
    const pending = fixture.factsAdapter.acquireFacts({
      scope,
      workItems: [{ kind: "task", canvasId: scope.canvasId, taskId: "T-001" }]
    });

    respond(fixture.broker, fixture.host.id, commandAt(fixture.deliveries, 0), {
      outcome: "success",
      operation: "resolve_work_items",
      result: taskFactsResult(runtimeSourceRevision, `pkg-${"d".repeat(64)}`)
    });
    respond(fixture.broker, second.host.id, commandAt(second.deliveries, 0), {
      outcome: "error",
      operation: "resolve_work_items",
      error: {
        code: "runtime_project_identity_mismatch",
        message: "The Runtime Project does not match Server authority.",
        retryable: false
      }
    });

    await expect(pending).rejects.toMatchObject({ code: "content_out_of_sync" });
  });

  it("fails with host_offline when every candidate facts request times out", async () => {
    const fixture = await setup(20);
    const second = fixture.addHost("Offline Runtime");

    await expect(
      fixture.factsAdapter.acquireFacts({
        scope,
        workItems: [{ kind: "task", canvasId: scope.canvasId, taskId: "T-001" }]
      })
    ).rejects.toMatchObject({ code: "host_offline" });
    expect(fixture.deliveries).toHaveLength(1);
    expect(second.deliveries).toHaveLength(1);
  });

  it("does not hide an unknown facts RPC error behind an exact peer", async () => {
    const fixture = await setup();
    const second = fixture.addHost("Failing Runtime");
    const pending = fixture.factsAdapter.acquireFacts({
      scope,
      workItems: [{ kind: "task", canvasId: scope.canvasId, taskId: "T-001" }]
    });

    respond(fixture.broker, fixture.host.id, commandAt(fixture.deliveries, 0), {
      outcome: "success",
      operation: "resolve_work_items",
      result: taskFactsResult()
    });
    respond(fixture.broker, second.host.id, commandAt(second.deliveries, 0), {
      outcome: "error",
      operation: "resolve_work_items",
      error: {
        code: "unexpected_facts_failure",
        message: "Unexpected Work facts failure.",
        retryable: false
      }
    });

    await expect(pending).rejects.toMatchObject({ code: "unexpected_facts_failure" });
  });

  it("does not hide malformed facts behind an exact peer", async () => {
    const fixture = await setup();
    const second = fixture.addHost("Malformed Runtime");
    const pending = fixture.factsAdapter.acquireFacts({
      scope,
      workItems: [{ kind: "task", canvasId: scope.canvasId, taskId: "T-001" }]
    });

    respond(fixture.broker, fixture.host.id, commandAt(fixture.deliveries, 0), {
      outcome: "success",
      operation: "resolve_work_items",
      result: taskFactsResult()
    });
    respond(fixture.broker, second.host.id, commandAt(second.deliveries, 0), {
      outcome: "success",
      operation: "resolve_work_items",
      result: { ...taskFactsResult(), facts: [] }
    });

    await expect(pending).rejects.toMatchObject({ name: "ZodError" });
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
    expect(command.operation).toMatchObject({
      operation: "availability",
      contentTarget: runtimeContentTarget
    });
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
      hostId: fixture.host.id,
      graphFingerprint,
      status: { scope }
    });
  });

  it("aggregates matching read evidence while generic routing remains ambiguous", async () => {
    const fixture = await setup();
    const second = fixture.addHost("Second Runtime");

    expect(fixture.adapter.hasRuntimeScope(scope)).toBe(true);
    expect(
      fixture.adapter.hasRuntimeProject({
        workspaceId: scope.workspaceId,
        projectId: scope.projectId
      })
    ).toBe(true);
    expect(() => fixture.adapter.acquire(scope)).toThrow(CanvasRuntimeHostAmbiguousError);

    const currentSourceRevision = `snapshot:${"b".repeat(64)}`;
    const pending = fixture.adapter.readAvailabilityForAuthority(scope, undefined, {
      target: runtimeContentTarget,
      sourceRevision: currentSourceRevision
    });
    const staleCommand = commandAt(fixture.deliveries, 0);
    const currentCommand = commandAt(second.deliveries, 0);
    respond(fixture.broker, fixture.host.id, staleCommand, {
      outcome: "success",
      operation: "availability",
      result: {
        kind: "available",
        sourceRevision: `snapshot:${"e".repeat(64)}`,
        graphFingerprint: runtimeContentTarget.graphFingerprint,
        status: {
          schemaVersion: "canvas-runtime-status/v2",
          scope,
          packageFingerprint: runtimeContentTarget.graphFingerprint,
          capturedAt: "2026-08-20T00:00:00.000Z",
          tasks: [],
          blocks: []
        }
      }
    });
    respond(fixture.broker, second.host.id, currentCommand, {
      outcome: "success",
      operation: "availability",
      result: {
        kind: "available",
        sourceRevision: currentSourceRevision,
        graphFingerprint: runtimeContentTarget.graphFingerprint,
        status: {
          schemaVersion: "canvas-runtime-status/v2",
          scope,
          packageFingerprint: runtimeContentTarget.graphFingerprint,
          capturedAt: "2026-08-20T00:00:01.000Z",
          tasks: [],
          blocks: []
        }
      }
    });

    await expect(pending).resolves.toMatchObject({
      kind: "available",
      hostId: second.host.id,
      graphFingerprint: runtimeContentTarget.graphFingerprint
    });
  });

  it("does not hide unexpected locator failures in scope availability", async () => {
    const fixture = await setup();
    vi.spyOn(fixture.locator, "locateCandidates").mockImplementationOnce(() => {
      throw new Error("unexpected_locator_failure");
    });

    expect(() => fixture.adapter.hasRuntimeScope(scope)).toThrow("unexpected_locator_failure");
  });

  it("returns a safe unavailable result when no Host provides matching evidence", async () => {
    const fixture = await setup();
    const second = fixture.addHost("Second Runtime");
    const pending = fixture.adapter.readAvailability(scope);
    const failedCommand = commandAt(fixture.deliveries, 0);
    const mismatchedCommand = commandAt(second.deliveries, 0);
    respond(fixture.broker, fixture.host.id, failedCommand, {
      outcome: "success",
      operation: "availability",
      result: { kind: "unavailable", reason: "host_offline" }
    });
    const mismatchedFingerprint = `pkg-${"d".repeat(64)}`;
    respond(fixture.broker, second.host.id, mismatchedCommand, {
      outcome: "success",
      operation: "availability",
      result: {
        kind: "available",
        sourceRevision: `snapshot:${"e".repeat(64)}`,
        graphFingerprint: mismatchedFingerprint,
        status: {
          schemaVersion: "canvas-runtime-status/v2",
          scope,
          packageFingerprint: mismatchedFingerprint,
          capturedAt: "2026-08-20T00:00:00.000Z",
          tasks: [],
          blocks: []
        }
      }
    });

    await expect(pending).resolves.toMatchObject({
      kind: "unavailable",
      reason: "content_out_of_sync"
    });
  });

  it("contains rejected Host reads instead of rejecting availability", async () => {
    const fixture = await setup(10);

    await expect(fixture.adapter.readAvailability(scope)).resolves.toMatchObject({
      kind: "unavailable",
      reason: "host_offline",
      hostId: fixture.host.id
    });
  });

  it("prefers an attached-but-missing Runtime over another offline Host", async () => {
    const fixture = await setup();
    const second = fixture.addHost("Second Runtime");
    const pending = fixture.adapter.readAvailability(scope);
    const secondCommand = commandAt(second.deliveries, 0);

    respond(fixture.broker, second.host.id, secondCommand, {
      outcome: "success",
      operation: "availability",
      result: { kind: "unavailable", reason: "runtime_not_attached" }
    });
    fixture.disconnectHost(fixture.host.id);

    await expect(pending).resolves.toMatchObject({
      kind: "unavailable",
      reason: "runtime_not_attached",
      hostId: second.host.id
    });
  });

  it("does not hide an unclassified Host domain error", async () => {
    const fixture = await setup();
    const pending = fixture.adapter.readAvailability(scope);
    respond(fixture.broker, fixture.host.id, commandAt(fixture.deliveries, 0), {
      outcome: "error",
      operation: "availability",
      error: {
        code: "runtime_canvas_not_found",
        message: "The Canvas Runtime resolver failed.",
        retryable: false
      }
    });

    await expect(pending).rejects.toMatchObject({ code: "runtime_canvas_not_found" });
  });

  it("acquires one remote lease and releases it exactly once", async () => {
    const fixture = await setup();
    const acquiring = fixture.adapter.acquire(scope);
    const acquireCommand = commandAt(fixture.deliveries, 0);
    expect(acquireCommand.operation).toMatchObject({
      operation: "acquire",
      contentTarget: runtimeContentTarget
    });
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

  it("restores Host ownership errors at the remote Runtime domain boundary", async () => {
    const fixture = await setup();
    const acquiring = fixture.adapter.acquire(scope);
    const acquireCommand = commandAt(fixture.deliveries, 0);
    const sourceRevision = `snapshot:${"b".repeat(64)}`;
    const graphFingerprint = `pkg-${"a".repeat(64)}`;
    respond(fixture.broker, fixture.host.id, acquireCommand, {
      outcome: "success",
      operation: "acquire",
      result: {
        runtimeLeaseId: randomUUID(),
        sourceRevision,
        graphFingerprint,
        acquiredAt: "2026-08-20T00:00:00.000Z",
        expiresAt: "2099-08-20T00:01:00.000Z"
      }
    });
    const lease = await acquiring;
    const failing = lease.runtime.fail({
      ref: "T-001#B-001",
      operationId: "operation-previous",
      controlPlane: "collaboration",
      sourceRevision,
      graphFingerprint,
      dispatchId: "dispatch-previous",
      executionAttemptId: "attempt-previous",
      failure: { code: "remote_test_failure", message: "Failed.", retryable: false }
    });
    const failCommand = commandAt(fixture.deliveries, 1);
    respond(fixture.broker, fixture.host.id, failCommand, {
      outcome: "error",
      operation: "fail",
      error: {
        code: "remote_ownership_operation_conflict",
        message: "Another operation owns the block.",
        retryable: false
      }
    });

    await expect(failing).rejects.toBeInstanceOf(RemoteOwnershipConflictError);
    await expect(failing).rejects.toMatchObject({
      code: "remote_ownership_operation_conflict"
    });
  });

  it("routes reset through the acquired Host lease with matching evidence", async () => {
    const fixture = await setup();
    const acquiring = fixture.adapter.acquire(scope);
    const acquireCommand = commandAt(fixture.deliveries, 0);
    const graphFingerprint = `pkg-${"a".repeat(64)}`;
    const sourceRevision = `snapshot:${"b".repeat(64)}`;
    respond(fixture.broker, fixture.host.id, acquireCommand, {
      outcome: "success",
      operation: "acquire",
      result: {
        runtimeLeaseId: randomUUID(),
        sourceRevision,
        graphFingerprint,
        acquiredAt: "2026-08-20T00:00:00.000Z",
        expiresAt: "2099-08-20T00:01:00.000Z"
      }
    });
    const lease = await acquiring;
    if (!lease.reset) throw new Error("remote_reset_expected");
    const resetting = lease.reset({
      operationId: "reset-remote-1",
      expectedSourceRevision: sourceRevision,
      expectedGraphFingerprint: graphFingerprint,
      reason: "Remote reset test."
    });
    const resetStatusCommand = commandAt(fixture.deliveries, 1);
    expect(resetStatusCommand.operation).toEqual({
      operation: "reset_status",
      operationId: "reset-remote-1"
    });
    respond(fixture.broker, fixture.host.id, resetStatusCommand, {
      outcome: "success",
      operation: "reset_status",
      result: { kind: "not_found" }
    });
    await vi.waitFor(() => expect(fixture.deliveries).toHaveLength(3));
    const resetCommand = commandAt(fixture.deliveries, 2);
    expect(resetCommand.operation).toMatchObject({
      operation: "reset",
      evidence: { operationId: "reset-remote-1", sourceRevision, graphFingerprint },
      input: { operationId: "reset-remote-1", sourceRevision, graphFingerprint }
    });
    respond(fixture.broker, fixture.host.id, resetCommand, {
      outcome: "success",
      operation: "reset",
      result: {
        operationId: "reset-remote-1",
        sourceRevision,
        graphFingerprint,
        status: {
          schemaVersion: "canvas-runtime-status/v2",
          scope,
          packageFingerprint: graphFingerprint,
          capturedAt: "2026-08-20T00:00:01.000Z",
          tasks: [],
          blocks: []
        }
      }
    });
    await expect(resetting).resolves.toMatchObject({ operationId: "reset-remote-1" });
  });

  it("reuses the durable reset result on the acquired Host", async () => {
    const fixture = await setup();
    const acquiring = fixture.adapter.acquire(scope);
    const acquireCommand = commandAt(fixture.deliveries, 0);
    const graphFingerprint = `pkg-${"a".repeat(64)}`;
    const sourceRevision = `snapshot:${"b".repeat(64)}`;
    respond(fixture.broker, fixture.host.id, acquireCommand, {
      outcome: "success",
      operation: "acquire",
      result: {
        runtimeLeaseId: randomUUID(),
        sourceRevision,
        graphFingerprint,
        acquiredAt: "2026-08-20T00:00:00.000Z",
        expiresAt: "2099-08-20T00:01:00.000Z"
      }
    });
    const lease = await acquiring;
    if (!lease.reset) throw new Error("remote_reset_expected");
    const resetting = lease.reset({
      operationId: "reset-remote-replay",
      expectedSourceRevision: sourceRevision,
      expectedGraphFingerprint: graphFingerprint
    });
    const resetStatusCommand = commandAt(fixture.deliveries, 1);
    respond(fixture.broker, fixture.host.id, resetStatusCommand, {
      outcome: "success",
      operation: "reset_status",
      result: {
        kind: "succeeded",
        result: {
          operationId: "reset-remote-replay",
          sourceRevision,
          graphFingerprint,
          status: {
            schemaVersion: "canvas-runtime-status/v2",
            scope,
            packageFingerprint: graphFingerprint,
            capturedAt: "2026-08-20T00:00:01.000Z",
            tasks: [],
            blocks: []
          }
        }
      }
    });

    await expect(resetting).resolves.toMatchObject({ operationId: "reset-remote-replay" });
    expect(fixture.deliveries).toHaveLength(2);
  });

  it("retries a prior active-lease reset failure under the current Host lease", async () => {
    const fixture = await setup();
    const acquiring = fixture.adapter.acquire(scope);
    const acquireCommand = commandAt(fixture.deliveries, 0);
    const graphFingerprint = `pkg-${"a".repeat(64)}`;
    const sourceRevision = `snapshot:${"b".repeat(64)}`;
    const runtimeLeaseId = randomUUID();
    respond(fixture.broker, fixture.host.id, acquireCommand, {
      outcome: "success",
      operation: "acquire",
      result: {
        runtimeLeaseId,
        sourceRevision,
        graphFingerprint,
        acquiredAt: "2026-08-20T00:00:00.000Z",
        expiresAt: "2099-08-20T00:01:00.000Z"
      }
    });
    const lease = await acquiring;
    if (!lease.reset) throw new Error("remote_reset_expected");
    const resetting = lease.reset({
      operationId: "reset-after-active-lease",
      expectedSourceRevision: sourceRevision,
      expectedGraphFingerprint: graphFingerprint
    });
    const originalStatus = commandAt(fixture.deliveries, 1);
    respond(fixture.broker, fixture.host.id, originalStatus, {
      outcome: "success",
      operation: "reset_status",
      result: { kind: "failed", error: { code: "active_lease", retryable: false } }
    });
    await vi.waitFor(() => expect(fixture.deliveries).toHaveLength(3));
    const retryStatus = commandAt(fixture.deliveries, 2);
    expect(retryStatus.operation.operation).toBe("reset_status");
    const retryOperationId =
      retryStatus.operation.operation === "reset_status"
        ? retryStatus.operation.operationId
        : "unexpected";
    expect(retryOperationId).toMatch(/^reset-retry:[a-f0-9]{64}$/);
    respond(fixture.broker, fixture.host.id, retryStatus, {
      outcome: "success",
      operation: "reset_status",
      result: { kind: "not_found" }
    });
    await vi.waitFor(() => expect(fixture.deliveries).toHaveLength(4));
    const retryReset = commandAt(fixture.deliveries, 3);
    expect(retryReset.operation).toMatchObject({
      operation: "reset",
      runtimeLeaseId,
      evidence: { operationId: retryOperationId }
    });
    respond(fixture.broker, fixture.host.id, retryReset, {
      outcome: "success",
      operation: "reset",
      result: {
        operationId: retryOperationId,
        sourceRevision,
        graphFingerprint,
        status: {
          schemaVersion: "canvas-runtime-status/v2",
          scope,
          packageFingerprint: graphFingerprint,
          capturedAt: "2026-08-20T00:00:01.000Z",
          tasks: [],
          blocks: []
        }
      }
    });

    await expect(resetting).resolves.toMatchObject({
      operationId: "reset-after-active-lease",
      sourceRevision,
      graphFingerprint
    });
  });

  it("queries the durable Host reset receipt without acquiring a second lease", async () => {
    const fixture = await setup();
    const router = new LocalFirstCanvasRuntimeRouter(
      {
        readAvailability: async () => {
          throw new Error("local_should_not_run");
        }
      },
      {
        acquire: async () => {
          throw new Error("local_should_not_run");
        }
      },
      { hasRuntimeProject: () => false, hasRuntimeScope: () => false }
    );
    router.attachRemote(fixture.adapter);
    const graphFingerprint = `pkg-${"a".repeat(64)}`;
    const sourceRevision = `snapshot:${"b".repeat(64)}`;
    const reconciliation = router.reconcileReset(scope, {
      operationId: "reset-remote-query",
      expectedSourceRevision: sourceRevision,
      expectedGraphFingerprint: graphFingerprint
    });
    const query = commandAt(fixture.deliveries, 0);
    expect(query.operation).toEqual({
      operation: "reset_status",
      operationId: "reset-remote-query"
    });
    respond(fixture.broker, fixture.host.id, query, {
      outcome: "success",
      operation: "reset_status",
      result: {
        kind: "succeeded",
        result: {
          operationId: "reset-remote-query",
          sourceRevision,
          graphFingerprint,
          status: {
            schemaVersion: "canvas-runtime-status/v2",
            scope,
            packageFingerprint: graphFingerprint,
            capturedAt: "2026-08-20T00:00:01.000Z",
            tasks: [],
            blocks: []
          }
        }
      }
    });
    await expect(reconciliation).resolves.toMatchObject({
      kind: "succeeded",
      result: { operationId: "reset-remote-query" }
    });
    expect(fixture.deliveries).toHaveLength(1);
  });

  it("preserves local-first behavior when a local Runtime is attached", async () => {
    const localLease = { runtime: {}, artifacts: {}, release: vi.fn() };
    const localAcquire = vi.fn(() => localLease);
    const localReconcile = vi.fn(async () => ({ kind: "not_found" as const }));
    const localRead = vi.fn(async () => ({
      schemaVersion: "canvas-runtime-availability/v1" as const,
      kind: "unavailable" as const,
      reason: "runtime_not_attached" as const
    }));
    const router = new LocalFirstCanvasRuntimeRouter(
      { readAvailability: localRead },
      { acquire: localAcquire, reconcileReset: localReconcile },
      { hasRuntimeProject: () => true, hasRuntimeScope: () => true }
    );

    await expect(router.readAvailability(scope)).resolves.toMatchObject({
      kind: "unavailable",
      reason: "runtime_not_attached"
    });
    await expect(router.acquire(scope)).resolves.toBe(localLease);
    await expect(
      router.reconcileReset(scope, {
        operationId: "local-reset-status",
        expectedSourceRevision: `snapshot:${"b".repeat(64)}`,
        expectedGraphFingerprint: `pkg-${"a".repeat(64)}`
      })
    ).resolves.toEqual({ kind: "not_found" });
    expect(localRead).toHaveBeenCalledOnce();
    expect(localAcquire).toHaveBeenCalledOnce();
    expect(localReconcile).toHaveBeenCalledOnce();
  });
});
