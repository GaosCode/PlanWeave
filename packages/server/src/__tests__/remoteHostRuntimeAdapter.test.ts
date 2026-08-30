import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthoritySelectingCanvasRuntimeRouter,
  LocalFirstCanvasExecutionRuntimeRouter,
  RemoteHostCanvasRuntimeAdapter
} from "../canvas/remoteHostRuntimeAdapter.js";
import { RemoteOwnershipConflictError } from "@planweave-ai/runtime";
import { CanvasRuntimeHostAmbiguousError } from "../canvas/runtimeHostLocator.js";
import { RemoteHostWorkRuntimeFactsAdapter } from "../work/remoteHostRuntimeFactsAdapter.js";
import { AuthoritySelectingWorkRuntimeFactsAdapter } from "../work/runtimeFactsAdapters.js";
import {
  createRemoteHostRuntimeTestEnvironment,
  type RemoteHostRuntimeTestEnvironment,
  respondToRuntimeRequest as respond,
  runtimeRequestCommandAt as commandAt
} from "./support/remoteHostRuntimeTestEnvironment.js";

const environments: RemoteHostRuntimeTestEnvironment[] = [];
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
  for (const environment of environments.splice(0)) environment.close();
});

async function setup(requestTimeoutMs = 1_000) {
  const environment = await createRemoteHostRuntimeTestEnvironment({ scope, requestTimeoutMs });
  environments.push(environment);
  const contentTargets = { read: () => runtimeContentTarget };
  const readContentAuthority = vi.fn(() => ({
    target: runtimeContentTarget,
    sourceRevision: runtimeSourceRevision
  }));
  const adapter = new RemoteHostCanvasRuntimeAdapter(
    environment.locator,
    environment.broker,
    contentTargets,
    {
      grants: environment.grants,
      artifacts: environment.artifacts
    }
  );
  const remoteFactsAdapter = new RemoteHostWorkRuntimeFactsAdapter(
    environment.locator,
    environment.broker,
    { requestTimeoutMs }
  );
  const factsAdapter = new AuthoritySelectingWorkRuntimeFactsAdapter(
    { acquireFacts: async () => undefined },
    { read: readContentAuthority }
  );
  factsAdapter.attachRemote(remoteFactsAdapter);
  return {
    ...environment,
    adapter,
    factsAdapter,
    remoteFactsAdapter,
    readContentAuthority,
    disconnect() {
      environment.disconnectHost(environment.host.id);
    }
  };
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
  it("fails safely when neither local nor remote Work facts are available", async () => {
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
    ).rejects.toMatchObject({ code: "runtime_not_attached" });
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
    expect(fixture.readContentAuthority).toHaveBeenCalledTimes(2);
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

  it("prefers the unattached local candidate when every remote facts request times out", async () => {
    const fixture = await setup(20);
    const second = fixture.addHost("Offline Runtime");

    await expect(
      fixture.factsAdapter.acquireFacts({
        scope,
        workItems: [{ kind: "task", canvasId: scope.canvasId, taskId: "T-001" }]
      })
    ).rejects.toMatchObject({ code: "runtime_not_attached" });
    expect(fixture.deliveries).toHaveLength(1);
    expect(second.deliveries).toHaveLength(1);
    expect(fixture.broker.pendingCount()).toBe(0);
  });

  it("uses exact facts when another peer returns an unknown RPC error", async () => {
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

    await expect(pending).resolves.toMatchObject({
      evidence: {
        sourceRevision: runtimeSourceRevision,
        graphFingerprint: runtimeContentTarget.graphFingerprint
      }
    });
  });

  it("uses exact facts when another peer returns malformed facts", async () => {
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

    await expect(pending).resolves.toMatchObject({
      evidence: {
        sourceRevision: runtimeSourceRevision,
        graphFingerprint: runtimeContentTarget.graphFingerprint
      }
    });
  });

  it("fails closed with malformed facts when no exact peer exists", async () => {
    const fixture = await setup();
    const second = fixture.addHost("Drifted Runtime");
    const pending = fixture.factsAdapter.acquireFacts({
      scope,
      workItems: [{ kind: "task", canvasId: scope.canvasId, taskId: "T-001" }]
    });

    respond(fixture.broker, fixture.host.id, commandAt(fixture.deliveries, 0), {
      outcome: "success",
      operation: "resolve_work_items",
      result: { ...taskFactsResult(), facts: [] }
    });
    respond(fixture.broker, second.host.id, commandAt(second.deliveries, 0), {
      outcome: "success",
      operation: "resolve_work_items",
      result: taskFactsResult(`snapshot:${"d".repeat(64)}`)
    });

    await expect(pending).rejects.toMatchObject({ name: "ZodError" });
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

  it.each([
    "authority-selecting",
    "local-first"
  ] as const)("%s routing honors an explicit remote Host when a local Runtime exists", async (kind) => {
    const fixture = await setup();
    const decoy = fixture.addHost("Decoy Runtime");
    const localAcquire = vi.fn(() => ({ runtime: {}, artifacts: {}, release: vi.fn() }));
    const localScopes = { hasRuntimeProject: () => true, hasRuntimeScope: () => true };
    const router =
      kind === "authority-selecting"
        ? new AuthoritySelectingCanvasRuntimeRouter(
            {
              readAvailability: async () => ({
                schemaVersion: "canvas-runtime-availability/v1",
                kind: "unavailable",
                reason: "runtime_not_attached"
              })
            },
            { acquire: localAcquire },
            localScopes
          )
        : new LocalFirstCanvasExecutionRuntimeRouter({ acquire: localAcquire }, localScopes);
    router.attachRemote(fixture.adapter);

    const acquiring = router.acquireForHost(scope, fixture.host.id);
    expect(localAcquire).not.toHaveBeenCalled();
    const acquireCommand = commandAt(fixture.deliveries, 0);
    expect(acquireCommand.operation).toMatchObject({ operation: "acquire" });
    respond(fixture.broker, fixture.host.id, acquireCommand, {
      outcome: "success",
      operation: "acquire",
      result: {
        runtimeLeaseId: randomUUID(),
        sourceRevision: runtimeSourceRevision,
        graphFingerprint: runtimeContentTarget.graphFingerprint,
        acquiredAt: "2026-08-20T00:00:00.000Z",
        expiresAt: "2099-08-20T00:01:00.000Z"
      }
    });

    await expect(acquiring).resolves.toMatchObject({ runtime: expect.any(Object) });
    expect(localAcquire).not.toHaveBeenCalled();
    expect(decoy.deliveries).toHaveLength(0);
  });

  it.each([
    "authority-selecting",
    "local-first"
  ] as const)("%s routing fails closed when the explicit remote Host route is unavailable", async (kind) => {
    const fixture = await setup();
    const decoy = fixture.addHost("Decoy Runtime");
    const localAcquire = vi.fn(() => ({ runtime: {}, artifacts: {}, release: vi.fn() }));
    const localScopes = { hasRuntimeProject: () => true, hasRuntimeScope: () => true };
    const router =
      kind === "authority-selecting"
        ? new AuthoritySelectingCanvasRuntimeRouter(
            {
              readAvailability: async () => ({
                schemaVersion: "canvas-runtime-availability/v1",
                kind: "unavailable",
                reason: "runtime_not_attached"
              })
            },
            { acquire: localAcquire },
            localScopes
          )
        : new LocalFirstCanvasExecutionRuntimeRouter({ acquire: localAcquire }, localScopes);
    router.attachRemote(fixture.adapter);

    await expect(router.acquireForHost(scope, randomUUID())).rejects.toMatchObject({
      reason: "runtime_not_attached"
    });
    expect(localAcquire).not.toHaveBeenCalled();
    expect(fixture.deliveries).toHaveLength(0);
    expect(decoy.deliveries).toHaveLength(0);
  });

  it("acquires the attached local Runtime when it is the exact authority winner", async () => {
    const localLease = { runtime: {}, artifacts: {}, release: vi.fn() };
    const localAcquire = vi.fn(() => localLease);
    const router = new AuthoritySelectingCanvasRuntimeRouter(
      {
        readAvailability: async () => ({
          schemaVersion: "canvas-runtime-availability/v1",
          kind: "available",
          sourceRevision: runtimeSourceRevision,
          graphFingerprint: runtimeContentTarget.graphFingerprint,
          status: {
            schemaVersion: "canvas-runtime-status/v2",
            scope,
            packageFingerprint: runtimeContentTarget.graphFingerprint,
            capturedAt: "2026-08-20T00:00:00.000Z",
            tasks: [],
            blocks: []
          }
        })
      },
      { acquire: localAcquire },
      { hasRuntimeProject: () => true, hasRuntimeScope: () => true }
    );

    await expect(
      router.acquireAuthorityWinner(scope, {
        target: runtimeContentTarget,
        sourceRevision: runtimeSourceRevision
      })
    ).resolves.toBe(localLease);
    expect(localAcquire).toHaveBeenCalledOnce();
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
    const router = new AuthoritySelectingCanvasRuntimeRouter(
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
    const router = new AuthoritySelectingCanvasRuntimeRouter(
      { readAvailability: localRead },
      { acquire: localAcquire, reconcileReset: localReconcile },
      { hasRuntimeProject: () => true, hasRuntimeScope: () => true }
    );

    await expect(
      router.readAvailabilityForAuthority(scope, undefined, {
        target: runtimeContentTarget,
        sourceRevision: runtimeSourceRevision
      })
    ).resolves.toMatchObject({
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
