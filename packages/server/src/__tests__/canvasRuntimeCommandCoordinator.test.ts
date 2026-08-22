import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  CANVAS_RUNTIME_CAPABILITY,
  agentHostProtocolVersion
} from "@planweave-ai/agent-host-protocol";
import type { RemoteBlockArtifactSource, RemoteBlockRuntimePort } from "@planweave-ai/runtime";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import {
  CanvasRuntimeCommandCoordinator,
  CanvasRuntimeResetReceiptRepository,
  CanvasRuntimeStatusRepository
} from "../canvas/index.js";
import {
  CanvasRuntimeUnavailableError,
  type CanvasExecutionRuntimeLeasePort,
  type CanvasRuntimeResetCommand
} from "../canvas/executionRuntimePort.js";
import { readStableCanvasContentFingerprint } from "../canvas/contentFingerprint.js";
import { CanvasRuntimeRpcError } from "../canvas/runtimeRpcBroker.js";
import { CanvasRuntimeRpcBroker } from "../canvas/runtimeRpcBroker.js";
import { CanvasRuntimeHostLocator } from "../canvas/runtimeHostLocator.js";
import {
  LocalFirstCanvasRuntimeRouter,
  RemoteHostCanvasRuntimeAdapter
} from "../canvas/remoteHostRuntimeAdapter.js";
import { RuntimeArtifactGrantRepository } from "../canvas/runtimeArtifactGrantRepository.js";
import { AgentHostRepository } from "../hosts.js";
import { DurableMailbox, type MailboxMessage } from "../mailbox.js";
import { ArtifactStore } from "../artifacts.js";
import { inWriteTransaction } from "../sqlite.js";
import {
  actor,
  canvasCommandServiceFixture as fixture,
  submitBody
} from "./support/canvasCommandServiceFixture.js";

const scope = { workspaceId: "w", projectId: "p", canvasId: "default" } as const;
const sourceRevision = `snapshot:${"b".repeat(64)}`;

const unusedRuntime: RemoteBlockRuntimePort = {
  inspect: vi.fn(),
  claim: vi.fn(),
  activate: vi.fn(),
  query: vi.fn(),
  reconcile: vi.fn(),
  markInterrupted: vi.fn(),
  resumeAttempt: vi.fn(),
  retryAttempt: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn()
};
const unusedArtifacts: RemoteBlockArtifactSource = { read: vi.fn() };

function testResetResult(operationId: string, fingerprint: string) {
  return {
    operationId,
    sourceRevision,
    graphFingerprint: fingerprint,
    status: {
      schemaVersion: "canvas-runtime-status/v2" as const,
      scope,
      packageFingerprint: fingerprint,
      capturedAt: "2026-08-22T00:00:01.000Z",
      tasks: [],
      blocks: []
    }
  };
}

async function setup(options?: {
  acquire?: CanvasExecutionRuntimeLeasePort["acquire"];
  activeLease?: boolean;
  persistFailure?: boolean;
  reconcileReset?: CanvasExecutionRuntimeLeasePort["reconcileReset"];
}) {
  const context = await fixture();
  const fingerprint = readStableCanvasContentFingerprint(context.contentVersions, scope);
  const head = context.contentVersions.head(scope);
  if (!fingerprint || !head) throw new Error("test_content_authority_missing");
  let resetCount = 0;
  const reset = vi.fn(async (command: CanvasRuntimeResetCommand) => {
    resetCount += 1;
    return {
      operationId: command.operationId,
      sourceRevision,
      graphFingerprint: command.expectedGraphFingerprint,
      status: {
        schemaVersion: "canvas-runtime-status/v2" as const,
        scope,
        packageFingerprint: command.expectedGraphFingerprint,
        capturedAt: `2026-08-22T00:00:0${resetCount}.000Z`,
        tasks: [],
        blocks: []
      }
    };
  });
  const acquire = vi.fn(
    options?.acquire ??
      (async () => ({
        runtime: unusedRuntime,
        artifacts: unusedArtifacts,
        reset,
        release: vi.fn()
      }))
  );
  const invalidated = vi.fn();
  const runtimeStatuses = new CanvasRuntimeStatusRepository(context.database);
  const receipts = new CanvasRuntimeResetReceiptRepository(context.database);
  const executionLeases: CanvasExecutionRuntimeLeasePort = {
    acquire,
    ...(options?.reconcileReset ? { reconcileReset: options.reconcileReset } : {})
  };
  const coordinator = new CanvasRuntimeCommandCoordinator({
    access: context.access,
    workspaceIdentity: new WorkspaceIdentityRepository(context.database),
    contentVersions: context.contentVersions,
    runtimeStatuses,
    receipts,
    executionLeases,
    hasConflictingLease: () => options?.activeLease ?? false,
    commitTransaction: (action) => {
      if (options?.persistFailure) throw new Error("simulated_persist_failure");
      return inWriteTransaction(context.database, action);
    },
    onRuntimeInvalidated: invalidated
  });
  const body = (operationId: string, overrides: Record<string, unknown> = {}) => ({
    operationId,
    expectedContentRevision: head.revision,
    expectedSourceRevision: sourceRevision,
    expectedGraphFingerprint: fingerprint,
    ...overrides
  });
  const restartCoordinator = (persistFailure = false) =>
    new CanvasRuntimeCommandCoordinator({
      access: context.access,
      workspaceIdentity: new WorkspaceIdentityRepository(context.database),
      contentVersions: context.contentVersions,
      runtimeStatuses,
      receipts,
      executionLeases,
      hasConflictingLease: () => options?.activeLease ?? false,
      commitTransaction: (action) => {
        if (persistFailure) throw new Error("simulated_persist_failure");
        return inWriteTransaction(context.database, action);
      },
      onRuntimeInvalidated: invalidated
    });
  return {
    ...context,
    acquire,
    body,
    coordinator,
    executionLeases,
    fingerprint,
    invalidated,
    receipts,
    reset,
    restartCoordinator,
    runtimeStatuses
  };
}

describe("CanvasRuntimeCommandCoordinator", () => {
  it("executes a completed operation once and returns its durable outcome on duplicate", async () => {
    const test = await setup();

    const first = await test.coordinator.reset(actor("owner"), {
      projectId: "p",
      canvasId: "default",
      body: test.body("reset-once")
    });
    const duplicate = await test.coordinator.reset(actor("owner"), {
      projectId: "p",
      canvasId: "default",
      body: test.body("reset-once")
    });

    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({ type: "canvas.runtime.reset.accepted", runtimeRevision: 1 });
    expect(test.reset).toHaveBeenCalledTimes(1);
    expect(test.invalidated).toHaveBeenCalledWith(scope, 1);
  });

  it("does not execute a concurrent duplicate while the first operation is applying", async () => {
    let releaseHost!: () => void;
    const hostGate = new Promise<void>((resolve) => {
      releaseHost = resolve;
    });
    const test = await setup({
      acquire: async () => ({
        runtime: unusedRuntime,
        artifacts: unusedArtifacts,
        reset: async (command) => {
          await hostGate;
          return {
            operationId: command.operationId,
            sourceRevision,
            graphFingerprint: test.fingerprint,
            status: {
              schemaVersion: "canvas-runtime-status/v2",
              scope,
              packageFingerprint: test.fingerprint,
              capturedAt: "2026-08-22T00:00:01.000Z",
              tasks: [],
              blocks: []
            }
          };
        },
        release: vi.fn()
      })
    });
    const first = test.coordinator.reset(actor("owner"), {
      projectId: "p",
      canvasId: "default",
      body: test.body("reset-concurrent")
    });
    await vi.waitFor(() => expect(test.acquire).toHaveBeenCalledTimes(1));
    const duplicate = test.coordinator.reset(actor("owner"), {
      projectId: "p",
      canvasId: "default",
      body: test.body("reset-concurrent")
    });
    expect(test.acquire).toHaveBeenCalledTimes(1);
    releaseHost();
    const [firstOutcome, duplicateOutcome] = await Promise.all([first, duplicate]);
    expect(firstOutcome).toEqual(duplicateOutcome);
    expect(firstOutcome).toMatchObject({ type: "canvas.runtime.reset.accepted" });
  });

  it("rejects ACL, leases, drift, Host offline, and timeout structurally", async () => {
    const denied = await setup();
    await expect(
      denied.coordinator.reset(actor("viewer"), {
        projectId: "p",
        canvasId: "default",
        body: denied.body("reset-forbidden")
      })
    ).resolves.toMatchObject({ code: "forbidden" });
    expect(denied.acquire).not.toHaveBeenCalled();

    const leased = await setup({ activeLease: true });
    await expect(
      leased.coordinator.reset(actor("owner"), {
        projectId: "p",
        canvasId: "default",
        body: leased.body("reset-leased")
      })
    ).resolves.toMatchObject({ code: "active_lease" });
    expect(leased.acquire).not.toHaveBeenCalled();

    const drifted = await setup();
    await expect(
      drifted.coordinator.reset(actor("owner"), {
        projectId: "p",
        canvasId: "default",
        body: drifted.body("reset-drifted", { expectedContentRevision: 999 })
      })
    ).resolves.toMatchObject({ code: "source_drift" });
    expect(drifted.acquire).not.toHaveBeenCalled();

    const fingerprintDrifted = await setup();
    await expect(
      fingerprintDrifted.coordinator.reset(actor("owner"), {
        projectId: "p",
        canvasId: "default",
        body: fingerprintDrifted.body("reset-fingerprint-drifted", {
          expectedGraphFingerprint: `pkg-${"f".repeat(64)}`
        })
      })
    ).resolves.toMatchObject({ code: "source_drift" });
    expect(fingerprintDrifted.acquire).not.toHaveBeenCalled();

    const offline = await setup({
      acquire: async () => {
        throw new CanvasRuntimeUnavailableError("host_offline");
      }
    });
    await expect(
      offline.coordinator.reset(actor("owner"), {
        projectId: "p",
        canvasId: "default",
        body: offline.body("reset-offline")
      })
    ).resolves.toMatchObject({ code: "host_offline" });

    const timedOut = await setup({
      acquire: async () => {
        throw new CanvasRuntimeRpcError("canvas_runtime_reconcile_required", true, true);
      }
    });
    await expect(
      timedOut.coordinator.reset(actor("owner"), {
        projectId: "p",
        canvasId: "default",
        body: timedOut.body("reset-timeout")
      })
    ).resolves.toMatchObject({ code: "reconcile_required" });
  });

  it("reconciles a known Host result after the final Server transaction fails", async () => {
    const test = await setup({ persistFailure: true });
    const input = {
      projectId: "p",
      canvasId: "default",
      body: test.body("reset-persist-failure")
    };
    const unknown = {
      type: "canvas.runtime.reset.rejected",
      operationId: "reset-persist-failure",
      code: "reconcile_required"
    } as const;
    await expect(test.coordinator.reset(actor("owner"), input)).resolves.toEqual(unknown);
    expect(test.runtimeStatuses.read(scope)).toBeNull();
    expect(test.invalidated).not.toHaveBeenCalled();
    const recovered = test.restartCoordinator();
    await expect(recovered.reset(actor("owner"), input)).resolves.toMatchObject({
      type: "canvas.runtime.reset.accepted",
      runtimeRevision: 1
    });
    expect(test.reset).toHaveBeenCalledTimes(1);
  });

  it("recovers a stale applying receipt after restart by querying the Host receipt", async () => {
    let hostResult: Awaited<
      ReturnType<NonNullable<CanvasExecutionRuntimeLeasePort["reconcileReset"]>>
    >;
    const test = await setup({
      reconcileReset: async (_scope, _command) => hostResult
    });
    hostResult = {
      kind: "succeeded",
      result: {
        operationId: "reset-restart",
        sourceRevision,
        graphFingerprint: test.fingerprint,
        status: {
          schemaVersion: "canvas-runtime-status/v2",
          scope,
          packageFingerprint: test.fingerprint,
          capturedAt: "2026-08-22T00:00:01.000Z",
          tasks: [],
          blocks: []
        }
      }
    };
    const request = test.body("reset-restart");
    test.receipts.begin(scope, request);

    await expect(
      test.restartCoordinator().reset(actor("owner"), {
        projectId: "p",
        canvasId: "default",
        body: request
      })
    ).resolves.toMatchObject({ type: "canvas.runtime.reset.accepted", runtimeRevision: 1 });
    expect(test.acquire).not.toHaveBeenCalled();
  });

  it("reaches a durable Host receipt through the production composition router after restart", async () => {
    const test = await setup();
    const hosts = new AgentHostRepository(test.database);
    const host = hosts.register("Runtime receipt Host").host;
    hosts.reportOnline(host.id, [CANVAS_RUNTIME_CAPABILITY], 1, {
      workspaceMappings: [{ workspaceId: scope.workspaceId, status: "ready" }],
      acpProfiles: [],
      runtimeProjects: [
        { workspaceId: scope.workspaceId, projectId: scope.projectId, status: "ready" }
      ]
    });
    const mailbox = new DurableMailbox(test.database);
    const broker = new CanvasRuntimeRpcBroker(test.database, hosts, mailbox, {
      requestTimeoutMs: 1_000
    });
    broker.attachSessionLookup({ isActive: (hostId) => hostId === host.id });
    const deliveries: MailboxMessage[] = [];
    mailbox.subscribe(host.id, (message) => deliveries.push(message));
    const locator = new CanvasRuntimeHostLocator(hosts.runtimeBindings, hosts, broker, test.access);
    const remote = new RemoteHostCanvasRuntimeAdapter(locator, broker, {
      grants: new RuntimeArtifactGrantRepository(test.database, {
        maxArtifactBytes: 1_024,
        leaseActive: () => true
      }),
      artifacts: new ArtifactStore(test.database, "/not-observed", 1_024)
    });
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
    router.attachRemote(remote);
    const receipts = new CanvasRuntimeResetReceiptRepository(test.database);
    const request = test.body("reset-production-router-recovery");
    receipts.begin(scope, request);
    const coordinator = new CanvasRuntimeCommandCoordinator({
      access: test.access,
      workspaceIdentity: new WorkspaceIdentityRepository(test.database),
      contentVersions: test.contentVersions,
      runtimeStatuses: test.runtimeStatuses,
      receipts,
      executionLeases: router,
      hasConflictingLease: () => false,
      commitTransaction: (action) => inWriteTransaction(test.database, action),
      onRuntimeInvalidated: vi.fn()
    });

    const recovering = coordinator.reset(actor("owner"), {
      projectId: scope.projectId,
      canvasId: scope.canvasId,
      body: request
    });
    await vi.waitFor(() => expect(deliveries).toHaveLength(1));
    const command = deliveries[0]?.command;
    if (command?.type !== "canvas_runtime.request") {
      throw new Error("reset_status_command_expected");
    }
    expect(command.operation).toEqual({
      operation: "reset_status",
      operationId: request.operationId
    });
    broker.handleResponse(host.id, {
      type: "canvas_runtime.response",
      protocolVersion: agentHostProtocolVersion,
      messageId: randomUUID(),
      requestId: command.requestId,
      response: {
        outcome: "success",
        operation: "reset_status",
        result: {
          kind: "succeeded",
          result: testResetResult(request.operationId, test.fingerprint)
        }
      }
    });

    await expect(recovering).resolves.toMatchObject({
      type: "canvas.runtime.reset.accepted",
      operationId: request.operationId,
      runtimeRevision: 1
    });
  });

  it("keeps a Host-committed response loss recoverable under the original operation ID", async () => {
    let committedResult!: ReturnType<typeof testResetResult>;
    const test = await setup({
      acquire: async () => ({
        runtime: unusedRuntime,
        artifacts: unusedArtifacts,
        reset: async (command) => {
          committedResult = testResetResult(command.operationId, test.fingerprint);
          throw new CanvasRuntimeRpcError("canvas_runtime_reconcile_required", true, true);
        },
        release: vi.fn()
      }),
      reconcileReset: async () => ({ kind: "succeeded", result: committedResult })
    });
    await expect(
      test.coordinator.reset(actor("owner"), {
        projectId: "p",
        canvasId: "default",
        body: test.body("reset-response-loss")
      })
    ).resolves.toMatchObject({
      type: "canvas.runtime.reset.accepted",
      operationId: "reset-response-loss"
    });
    expect(test.acquire).toHaveBeenCalledOnce();
  });

  it("persists the Host result even when Runtime lease release fails", async () => {
    const test = await setup({
      acquire: async () => ({
        runtime: unusedRuntime,
        artifacts: unusedArtifacts,
        reset: async (command) => testResetResult(command.operationId, test.fingerprint),
        release: async () => {
          throw new Error("release_failed");
        }
      })
    });
    await expect(
      test.coordinator.reset(actor("owner"), {
        projectId: "p",
        canvasId: "default",
        body: test.body("reset-release-failure")
      })
    ).resolves.toMatchObject({ type: "canvas.runtime.reset.accepted", runtimeRevision: 1 });
  });

  it.each([
    ["content", { kind: "update_task_prompt", taskId: "T-001", promptMarkdown: "# changed" }],
    [
      "layout-only",
      {
        kind: "update_layout",
        nodes: [{ nodeId: "T-001", x: 10, y: 20 }],
        updatedAt: "2026-08-22T00:00:00.000Z"
      }
    ]
  ] as const)("supersedes a Host-successful reset when %s revision advances", async (_kind, intent) => {
    let releaseHost!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseHost = resolve;
    });
    const routedReset = vi.fn(async (command: CanvasRuntimeResetCommand) => {
      await gate;
      return testResetResult(command.operationId, command.expectedGraphFingerprint);
    });
    const test = await setup({
      acquire: async () => ({
        runtime: unusedRuntime,
        artifacts: unusedArtifacts,
        reset: routedReset,
        release: vi.fn()
      })
    });
    const operation = test.coordinator.reset(actor("owner"), {
      projectId: "p",
      canvasId: "default",
      body: test.body(`reset-${_kind}-drift`)
    });
    await vi.waitFor(() => expect(test.acquire).toHaveBeenCalledOnce());
    await test.service.submit(actor("owner"), submitBody(`advance-${_kind}`, 0, intent));
    releaseHost();
    await expect(operation).resolves.toMatchObject({ code: "source_drift" });
    expect(test.runtimeStatuses.read(scope)).toBeNull();
    const oldRequest = test.body(`reset-${_kind}-drift`);
    await expect(
      test.restartCoordinator().reset(actor("owner"), {
        projectId: "p",
        canvasId: "default",
        body: oldRequest
      })
    ).resolves.toMatchObject({ code: "source_drift" });
    const latestHead = test.contentVersions.head(scope);
    const latestFingerprint = readStableCanvasContentFingerprint(test.contentVersions, scope);
    if (!latestHead || !latestFingerprint) throw new Error("latest_content_authority_missing");
    await expect(
      test.restartCoordinator().reset(actor("owner"), {
        projectId: "p",
        canvasId: "default",
        body: test.body(`reset-${_kind}-after-supersession`, {
          expectedContentRevision: latestHead.revision,
          expectedGraphFingerprint: latestFingerprint
        })
      })
    ).resolves.toMatchObject({
      type: "canvas.runtime.reset.accepted",
      operationId: `reset-${_kind}-after-supersession`,
      runtimeRevision: 1
    });
    expect(routedReset).toHaveBeenCalledTimes(2);
  });

  it("advances Runtime revision monotonically after each distinct successful reset", async () => {
    const test = await setup();
    const first = await test.coordinator.reset(actor("owner"), {
      projectId: "p",
      canvasId: "default",
      body: test.body("reset-revision-1")
    });
    const second = await test.coordinator.reset(actor("owner"), {
      projectId: "p",
      canvasId: "default",
      body: test.body("reset-revision-2")
    });
    expect(first).toMatchObject({ runtimeRevision: 1 });
    expect(second).toMatchObject({ runtimeRevision: 2 });
    expect(test.invalidated.mock.calls.map((call) => call[1])).toEqual([1, 2]);
  });
});
