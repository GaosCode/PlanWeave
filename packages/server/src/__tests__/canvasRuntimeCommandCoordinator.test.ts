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
  type CanvasRuntimeAuthorityWinnerLeasePort,
  type CanvasRuntimeResetCommand
} from "../canvas/executionRuntimePort.js";
import {
  readStableCanvasContentFingerprint,
  readStableCanvasRuntimeEvidence
} from "../canvas/contentFingerprint.js";
import { CanvasRuntimeRpcError } from "../canvas/runtimeRpcBroker.js";
import { CanvasRuntimeRpcBroker } from "../canvas/runtimeRpcBroker.js";
import { CanvasRuntimeHostLocator } from "../canvas/runtimeHostLocator.js";
import {
  AuthoritySelectingCanvasRuntimeRouter,
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

function testResetResult(operationId: string, sourceRevision: string, fingerprint: string) {
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
  acquireAuthorityWinner?: CanvasRuntimeAuthorityWinnerLeasePort["acquireAuthorityWinner"];
  activeLease?: boolean;
  persistFailure?: boolean;
  reconcileReset?: CanvasExecutionRuntimeLeasePort["reconcileReset"];
  cleanupDiagnosticSink?: ReturnType<typeof vi.fn>;
}) {
  const context = await fixture();
  const fingerprint = readStableCanvasContentFingerprint(context.contentVersions, scope);
  const evidence = readStableCanvasRuntimeEvidence(context.contentVersions, scope);
  const head = context.contentVersions.head(scope);
  if (!fingerprint || !evidence || !head) throw new Error("test_content_authority_missing");
  const sourceRevision = evidence.sourceRevision;
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
  const runtimeStatuses = new CanvasRuntimeStatusRepository(
    context.database,
    undefined,
    (value) => {
      invalidated(value.status.scope, value.runtimeRevision);
    }
  );
  const receipts = new CanvasRuntimeResetReceiptRepository(context.database);
  const acquireAuthorityWinner = vi.fn(
    options?.acquireAuthorityWinner ?? ((runtimeScope) => acquire(runtimeScope))
  );
  const executionLeases: CanvasRuntimeAuthorityWinnerLeasePort = {
    acquire,
    acquireAuthorityWinner,
    ...(options?.reconcileReset ? { reconcileReset: options.reconcileReset } : {})
  };
  const cleanupDiagnosticSink = options?.cleanupDiagnosticSink ?? vi.fn();
  const coordinator = new CanvasRuntimeCommandCoordinator({
    access: context.access,
    workspaceIdentity: new WorkspaceIdentityRepository(context.database),
    contentVersions: context.contentVersions,
    runtimeStatuses,
    receipts,
    executionLeases,
    hasConflictingLease: () => options?.activeLease ?? false,
    cleanupDiagnosticSink,
    commitTransaction: (action) => {
      if (options?.persistFailure) throw new Error("simulated_persist_failure");
      return inWriteTransaction(context.database, action);
    }
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
      cleanupDiagnosticSink,
      commitTransaction: (action) => {
        if (persistFailure) throw new Error("simulated_persist_failure");
        return inWriteTransaction(context.database, action);
      }
    });
  return {
    ...context,
    acquire,
    acquireAuthorityWinner,
    body,
    coordinator,
    cleanupDiagnosticSink,
    executionLeases,
    fingerprint,
    invalidated,
    receipts,
    reset,
    restartCoordinator,
    runtimeStatuses,
    sourceRevision
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
    await vi.waitFor(() => {
      expect(test.reset).toHaveBeenCalledTimes(1);
      expect(test.acquire).toHaveBeenCalledTimes(1);
    });
    expect(test.acquireAuthorityWinner).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        sourceRevision: test.sourceRevision,
        target: expect.objectContaining({ graphFingerprint: test.fingerprint })
      })
    );
    expect(test.invalidated).toHaveBeenCalledWith(scope, 1);
    expect(test.receipts.latestAcceptedBaseline(scope)).toMatchObject({
      runtimeRevision: 1,
      command: {
        operationId: "reset-once",
        expectedSourceRevision: test.sourceRevision,
        expectedGraphFingerprint: test.fingerprint
      },
      status: { packageFingerprint: test.fingerprint }
    });
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
            sourceRevision: test.sourceRevision,
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
    const [firstOutcome, duplicateOutcome] = await Promise.all([first, duplicate]);
    expect(firstOutcome).toEqual(duplicateOutcome);
    expect(firstOutcome).toMatchObject({ type: "canvas.runtime.reset.accepted" });
    releaseHost();
  });

  it("rejects ACL, leases, and drift structurally", async () => {
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
  });

  it("commits Server authority before best-effort Host cleanup completes", async () => {
    let releaseHost!: () => void;
    const hostGate = new Promise<void>((resolve) => {
      releaseHost = resolve;
    });
    const release = vi.fn();
    const test = await setup({
      acquire: async () => ({
        runtime: unusedRuntime,
        artifacts: unusedArtifacts,
        reset: async (command) => {
          await hostGate;
          return testResetResult(
            command.operationId,
            command.expectedSourceRevision,
            command.expectedGraphFingerprint
          );
        },
        release
      })
    });

    const operation = test.coordinator.reset(actor("owner"), {
      projectId: "p",
      canvasId: "default",
      body: test.body("reset-server-first")
    });
    await expect(operation).resolves.toMatchObject({
      type: "canvas.runtime.reset.accepted",
      operationId: "reset-server-first",
      runtimeRevision: 1
    });
    expect(release).not.toHaveBeenCalled();
    expect(test.runtimeStatuses.read(scope)).toMatchObject({ runtimeRevision: 1 });
    expect(test.receipts.latestAcceptedBaseline(scope)).toMatchObject({
      runtimeRevision: 1,
      command: { operationId: "reset-server-first" }
    });

    releaseHost();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  });

  it.each([
    ["offline", new CanvasRuntimeUnavailableError("host_offline")],
    ["timeout", new CanvasRuntimeRpcError("canvas_runtime_reconcile_required", true, true)]
  ])("keeps an accepted Server reset when Host cleanup is %s", async (failure, error) => {
    const test = await setup({
      acquire: async () => {
        throw error;
      }
    });

    await expect(
      test.coordinator.reset(actor("owner"), {
        projectId: "p",
        canvasId: "default",
        body: test.body(`reset-${failure}`)
      })
    ).resolves.toMatchObject({
      type: "canvas.runtime.reset.accepted",
      operationId: `reset-${failure}`,
      runtimeRevision: 1
    });
    expect(test.runtimeStatuses.read(scope)).toMatchObject({ runtimeRevision: 1 });
    await vi.waitFor(() => {
      expect(test.cleanupDiagnosticSink).toHaveBeenCalledWith({
        operationId: `reset-${failure}`,
        scope,
        stage: "acquire",
        code: "runtime_cleanup_acquire_failed"
      });
    });
  });

  it("records a safe reset diagnostic and releases exactly once after a reset RPC timeout", async () => {
    const release = vi.fn();
    const cleanupDiagnosticSink = vi.fn(() => {
      throw new Error("diagnostic_sink_failed");
    });
    const test = await setup({
      cleanupDiagnosticSink,
      acquire: async () => ({
        runtime: unusedRuntime,
        artifacts: unusedArtifacts,
        reset: async () => {
          throw new CanvasRuntimeRpcError("canvas_runtime_reconcile_required", true, true);
        },
        release
      })
    });

    await expect(
      test.coordinator.reset(actor("owner"), {
        projectId: "p",
        canvasId: "default",
        body: test.body("reset-rpc-timeout")
      })
    ).resolves.toMatchObject({
      type: "canvas.runtime.reset.accepted",
      operationId: "reset-rpc-timeout",
      runtimeRevision: 1
    });
    expect(test.runtimeStatuses.read(scope)).toMatchObject({ runtimeRevision: 1 });
    expect(test.receipts.latestAcceptedBaseline(scope)).toMatchObject({
      command: { operationId: "reset-rpc-timeout" },
      runtimeRevision: 1
    });
    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledOnce();
      expect(test.cleanupDiagnosticSink).toHaveBeenCalledWith({
        operationId: "reset-rpc-timeout",
        scope,
        stage: "reset",
        code: "runtime_cleanup_reset_failed"
      });
    });
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

  it("recovers a stale receipt with legacy Host evidence from Server authority", async () => {
    const test = await setup();
    const request = test.body("reset-restart");
    test.receipts.begin(scope, request);
    test.receipts.recordHostResult(
      scope,
      request.operationId,
      testResetResult(request.operationId, test.sourceRevision, test.fingerprint)
    );

    await expect(
      test.restartCoordinator().reset(actor("owner"), {
        projectId: "p",
        canvasId: "default",
        body: request
      })
    ).resolves.toMatchObject({ type: "canvas.runtime.reset.accepted", runtimeRevision: 1 });
    expect(test.acquire).toHaveBeenCalledOnce();
    expect(test.reset).toHaveBeenCalledOnce();
  });

  it("clears the exact remote authority winner when the attached local Runtime is stale", async () => {
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
    const decoyHost = hosts.register("Decoy Runtime receipt Host").host;
    hosts.reportOnline(decoyHost.id, [CANVAS_RUNTIME_CAPABILITY], 1, {
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
    broker.attachSessionLookup({
      isActive: (hostId) => hostId === host.id || hostId === decoyHost.id
    });
    const deliveries: MailboxMessage[] = [];
    const decoyDeliveries: MailboxMessage[] = [];
    mailbox.subscribe(host.id, (message) => deliveries.push(message));
    mailbox.subscribe(decoyHost.id, (message) => decoyDeliveries.push(message));
    const locator = new CanvasRuntimeHostLocator(hosts.runtimeBindings, hosts, broker, test.access);
    const remote = new RemoteHostCanvasRuntimeAdapter(
      locator,
      broker,
      {
        read: () => ({
          revision: 1,
          content: {
            versionId: `version-${"c".repeat(64)}`,
            canonicalDigest: "c".repeat(64),
            verification: "complete"
          },
          graphFingerprint: test.fingerprint
        })
      },
      {
        grants: new RuntimeArtifactGrantRepository(test.database, {
          maxArtifactBytes: 1_024,
          leaseActive: () => true
        }),
        artifacts: new ArtifactStore(test.database, "/not-observed", 1_024)
      }
    );
    const localAcquire = vi.fn(async () => {
      throw new Error("stale_local_should_not_be_acquired");
    });
    const localReadAvailability = vi.fn(async () => ({
      schemaVersion: "canvas-runtime-availability/v1" as const,
      kind: "available" as const,
      sourceRevision: `snapshot:${"d".repeat(64)}`,
      graphFingerprint: test.fingerprint,
      status: {
        schemaVersion: "canvas-runtime-status/v2" as const,
        scope,
        packageFingerprint: test.fingerprint,
        capturedAt: "2026-08-22T00:00:00.000Z",
        tasks: [],
        blocks: []
      }
    }));
    const router = new AuthoritySelectingCanvasRuntimeRouter(
      { readAvailability: localReadAvailability },
      { acquire: localAcquire },
      { hasRuntimeProject: () => true, hasRuntimeScope: () => true }
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
      commitTransaction: (action) => inWriteTransaction(test.database, action)
    });

    const recovering = coordinator.reset(actor("owner"), {
      projectId: scope.projectId,
      canvasId: scope.canvasId,
      body: request
    });
    await vi.waitFor(() => expect(deliveries).toHaveLength(1));
    await vi.waitFor(() => expect(decoyDeliveries).toHaveLength(1));
    const availabilityCommand = deliveries[0]?.command;
    if (availabilityCommand?.type !== "canvas_runtime.request") {
      throw new Error("runtime_availability_command_expected");
    }
    await expect(recovering).resolves.toMatchObject({
      type: "canvas.runtime.reset.accepted",
      operationId: request.operationId,
      runtimeRevision: 1
    });
    expect(availabilityCommand.operation.operation).toBe("availability");
    broker.handleResponse(host.id, {
      type: "canvas_runtime.response",
      protocolVersion: agentHostProtocolVersion,
      messageId: randomUUID(),
      requestId: availabilityCommand.requestId,
      response: {
        outcome: "success",
        operation: "availability",
        result: {
          kind: "available",
          sourceRevision: test.sourceRevision,
          graphFingerprint: test.fingerprint,
          status: {
            schemaVersion: "canvas-runtime-status/v2",
            scope,
            packageFingerprint: test.fingerprint,
            capturedAt: "2026-08-22T00:00:00.000Z",
            tasks: [],
            blocks: []
          }
        }
      }
    });
    await vi.waitFor(() => expect(deliveries).toHaveLength(2));
    const acquireCommand = deliveries[1]?.command;
    if (acquireCommand?.type !== "canvas_runtime.request") {
      throw new Error("runtime_acquire_command_expected");
    }
    expect(acquireCommand.operation.operation).toBe("acquire");
    const runtimeLeaseId = randomUUID();
    broker.handleResponse(host.id, {
      type: "canvas_runtime.response",
      protocolVersion: agentHostProtocolVersion,
      messageId: randomUUID(),
      requestId: acquireCommand.requestId,
      response: {
        outcome: "success",
        operation: "acquire",
        result: {
          runtimeLeaseId,
          sourceRevision: test.sourceRevision,
          graphFingerprint: test.fingerprint,
          acquiredAt: "2026-08-22T00:00:00.000Z",
          expiresAt: "2099-08-22T00:01:00.000Z"
        }
      }
    });
    await vi.waitFor(() => expect(deliveries).toHaveLength(3));
    const statusCommand = deliveries[2]?.command;
    if (statusCommand?.type !== "canvas_runtime.request") {
      throw new Error("reset_status_command_expected");
    }
    expect(statusCommand.operation).toEqual({
      operation: "reset_status",
      operationId: request.operationId
    });
    broker.handleResponse(host.id, {
      type: "canvas_runtime.response",
      protocolVersion: agentHostProtocolVersion,
      messageId: randomUUID(),
      requestId: statusCommand.requestId,
      response: {
        outcome: "success",
        operation: "reset_status",
        result: { kind: "not_found" }
      }
    });
    await vi.waitFor(() => expect(deliveries).toHaveLength(4));
    const resetCommand = deliveries[3]?.command;
    if (resetCommand?.type !== "canvas_runtime.request") {
      throw new Error("runtime_reset_command_expected");
    }
    expect(resetCommand.operation).toMatchObject({
      operation: "reset",
      runtimeLeaseId,
      evidence: { operationId: request.operationId }
    });
    broker.handleResponse(host.id, {
      type: "canvas_runtime.response",
      protocolVersion: agentHostProtocolVersion,
      messageId: randomUUID(),
      requestId: resetCommand.requestId,
      response: {
        outcome: "success",
        operation: "reset",
        result: testResetResult(request.operationId, test.sourceRevision, test.fingerprint)
      }
    });
    await vi.waitFor(() => expect(deliveries).toHaveLength(5));
    const releaseCommand = deliveries[4]?.command;
    if (releaseCommand?.type !== "canvas_runtime.request") {
      throw new Error("runtime_release_command_expected");
    }
    expect(releaseCommand.operation).toEqual({ operation: "release", runtimeLeaseId });
    broker.handleResponse(host.id, {
      type: "canvas_runtime.response",
      protocolVersion: agentHostProtocolVersion,
      messageId: randomUUID(),
      requestId: releaseCommand.requestId,
      response: {
        outcome: "success",
        operation: "release",
        result: { released: true }
      }
    });

    expect(localReadAvailability).toHaveBeenCalledOnce();
    expect(localAcquire).not.toHaveBeenCalled();
    expect(
      decoyDeliveries.flatMap((delivery) =>
        delivery.command.type === "canvas_runtime.request"
          ? [delivery.command.operation.operation]
          : []
      )
    ).toEqual(["availability"]);
  });

  it("keeps a Host-committed response loss recoverable under the original operation ID", async () => {
    let committedResult!: ReturnType<typeof testResetResult>;
    const test = await setup({
      acquire: async () => ({
        runtime: unusedRuntime,
        artifacts: unusedArtifacts,
        reset: async (command) => {
          committedResult = testResetResult(
            command.operationId,
            command.expectedSourceRevision,
            test.fingerprint
          );
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
        reset: async (command) =>
          testResetResult(command.operationId, command.expectedSourceRevision, test.fingerprint),
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
    await vi.waitFor(() => {
      expect(test.cleanupDiagnosticSink).toHaveBeenCalledWith({
        operationId: "reset-release-failure",
        scope,
        stage: "release",
        code: "runtime_cleanup_release_failed"
      });
    });
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
  ] as const)("keeps a committed reset accepted when %s revision advances during Host cleanup", async (_kind, intent) => {
    let releaseHost!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseHost = resolve;
    });
    const routedReset = vi.fn(async (command: CanvasRuntimeResetCommand) => {
      await gate;
      return testResetResult(
        command.operationId,
        command.expectedSourceRevision,
        command.expectedGraphFingerprint
      );
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
    await expect(operation).resolves.toMatchObject({
      type: "canvas.runtime.reset.accepted",
      runtimeRevision: 1
    });
    expect(test.runtimeStatuses.read(scope)).toMatchObject({ runtimeRevision: 1 });
    const oldRequest = test.body(`reset-${_kind}-drift`);
    await expect(
      test.restartCoordinator().reset(actor("owner"), {
        projectId: "p",
        canvasId: "default",
        body: oldRequest
      })
    ).resolves.toMatchObject({
      type: "canvas.runtime.reset.accepted",
      runtimeRevision: 1
    });
    const latestHead = test.contentVersions.head(scope);
    const latestEvidence = readStableCanvasRuntimeEvidence(test.contentVersions, scope);
    if (!latestHead || !latestEvidence) throw new Error("latest_content_authority_missing");
    await expect(
      test.restartCoordinator().reset(actor("owner"), {
        projectId: "p",
        canvasId: "default",
        body: test.body(`reset-${_kind}-after-supersession`, {
          expectedContentRevision: latestHead.revision,
          expectedSourceRevision: latestEvidence.sourceRevision,
          expectedGraphFingerprint: latestEvidence.target.graphFingerprint
        })
      })
    ).resolves.toMatchObject({
      type: "canvas.runtime.reset.accepted",
      operationId: `reset-${_kind}-after-supersession`,
      runtimeRevision: 2
    });
    await vi.waitFor(() => expect(routedReset).toHaveBeenCalledTimes(2));
  });

  it("advances Runtime revision for distinct successful resets", async () => {
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
    await vi.waitFor(() => expect(test.reset).toHaveBeenCalledTimes(2));
  });
});
