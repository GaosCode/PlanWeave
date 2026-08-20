import { createHash } from "node:crypto";
import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createRemoteBlockArtifactSource,
  createRemoteBlockRuntimePort,
  type PlanPackageManifest,
  type RemoteBlockDispatchCandidate,
  type RemoteBlockRuntimePort
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestWorkspace,
  basicManifest
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ArtifactStore } from "../artifacts.js";
import { createRemoteBlockCoordination } from "../distributedCoordination.js";
import type { RemoteBlockCoordinationOptions } from "../distributedCoordination.js";
import type {
  RemoteCoordinatorCheckpoint,
  RemoteCoordinatorCheckpointPort
} from "../remoteBlockCoordinatorPorts.js";
import { RemoteRuntimePortRegistry } from "../remoteRuntimeLocator.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { canonicalRemoteRuntimePort } from "../canonicalRemoteRuntimePort.js";
import { WorkAssignmentRepository } from "../work/repository.js";
import {
  endpointDispatchRequest,
  registerEndpointDispatchAccess
} from "./support/endpointCoordinatorFixture.js";
import { seedLegacyRemoteOperation } from "./support/legacyRemoteOperationSeed.js";

type Coordination = ReturnType<typeof createRemoteBlockCoordination>;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function remoteManifest(includeSecondTask = false): PlanPackageManifest {
  const manifest = basicManifest({
    parallel: includeSecondTask,
    maxConcurrent: includeSecondTask ? 2 : 1,
    includeSecondTask
  });
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

class CrashOnce implements RemoteCoordinatorCheckpointPort {
  private crashed = false;

  constructor(readonly target: RemoteCoordinatorCheckpoint) {}

  reached(checkpoint: RemoteCoordinatorCheckpoint): void {
    if (checkpoint === this.target && !this.crashed) {
      this.crashed = true;
      throw new Error(`injected_crash:${checkpoint}`);
    }
  }
}

class CoordinatorHarness {
  private server?: PlanweaveServer;
  coordination?: Coordination;
  runtime?: RemoteBlockRuntimePort;
  artifacts?: ArtifactStore;
  private agentEndpointId?: string;

  private constructor(
    readonly workspace: Awaited<ReturnType<typeof createTestWorkspace>>,
    readonly dataDirectory: string,
    readonly databasePath: string,
    readonly locator: { workspaceId: string; projectId: string; canvasId: string }
  ) {}

  static async create(includeSecondTask = false): Promise<CoordinatorHarness> {
    const workspace = await createTestWorkspace(remoteManifest(includeSecondTask));
    const dataDirectory = join(workspace.root, "server-data");
    const harness = new CoordinatorHarness(
      workspace,
      dataDirectory,
      join(dataDirectory, "server.sqlite"),
      {
        workspaceId: "workspace-pending-crash",
        projectId: workspace.init.workspace.id,
        canvasId: "default"
      }
    );
    cleanups.push(async () => {
      harness.close();
      await Promise.all([
        rm(workspace.home, { recursive: true, force: true }),
        rm(workspace.root, { recursive: true, force: true })
      ]);
    });
    await harness.restart();
    return harness;
  }

  async restart(
    checkpoints?: RemoteCoordinatorCheckpointPort,
    decorateRuntime: (runtime: RemoteBlockRuntimePort) => RemoteBlockRuntimePort = (runtime) =>
      runtime,
    materialize: RemoteBlockCoordinationOptions["inputArtifacts"]["materialize"] = async () => {}
  ): Promise<Coordination> {
    this.close();
    this.server = await startPlanweaveServer({
      dataDirectory: this.dataDirectory,
      databasePath: this.databasePath,
      busyTimeoutMs: 5_000
    });
    this.runtime = decorateRuntime(
      createRemoteBlockRuntimePort({ projectRoot: this.workspace.root })
    );
    this.locator.workspaceId = new WorkspaceIdentityRepository(
      this.server.database
    ).ensureWorkspaceForLegacyProject(this.locator.projectId);
    const registry = new RemoteRuntimePortRegistry();
    registry.bind(
      this.locator,
      this.runtime,
      createRemoteBlockArtifactSource({ projectRoot: this.workspace.root })
    );
    this.artifacts = new ArtifactStore(this.server.database, this.dataDirectory, 1024 * 1024);
    const options: RemoteBlockCoordinationOptions = {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      runtimeLeases: registry,
      inputArtifacts: { materialize },
      artifactContent: { readReport: async (ref) => this.requireArtifacts().read(ref) },
      checkpoints
    };
    this.coordination = createRemoteBlockCoordination(this.server.database, options, {
      serverInstanceOwnerToken: this.server.serverInstanceOwnerToken
    });
    registerEndpointDispatchAccess({
      database: this.server.database,
      locator: this.locator,
      projectRoot: this.workspace.root,
      packageDir: this.workspace.init.workspace.packageDir
    });
    return this.coordination;
  }

  close(): void {
    if (this.server) {
      const activeAction = this.server.database
        .prepare(
          `SELECT 1 AS active FROM remote_execution_actions
           WHERE application_owner_token=? LIMIT 1`
        )
        .get(this.server.serverInstanceOwnerToken);
      if (activeAction) {
        this.server.database
          .prepare(
            `UPDATE server_instance_ownership SET process_id=2147483647
             WHERE singleton=1 AND owner_token=?`
          )
          .run(this.server.serverInstanceOwnerToken);
        this.server.database.close();
      } else {
        this.server.close();
      }
    }
    this.server = undefined;
    this.coordination = undefined;
    this.runtime = undefined;
    this.artifacts = undefined;
  }

  requireCoordination(): Coordination {
    if (!this.coordination) throw new Error("test_coordination_not_started");
    return this.coordination;
  }

  requireServer(): PlanweaveServer {
    if (!this.server) throw new Error("test_server_not_started");
    return this.server;
  }

  requireRuntime(): RemoteBlockRuntimePort {
    if (!this.runtime) throw new Error("test_runtime_not_started");
    return this.runtime;
  }

  requireArtifacts(): ArtifactStore {
    if (!this.artifacts) throw new Error("test_artifacts_not_started");
    return this.artifacts;
  }

  registerHost(capacity = 1): string {
    const coordination = this.requireCoordination();
    const host = coordination.hosts.register("Crash Matrix Host").host;
    const workspaceId = new WorkspaceIdentityRepository(
      this.requireServer().database
    ).ensureWorkspaceForLegacyProject(this.locator.projectId);
    coordination.hosts.bindToWorkspace(host.id, workspaceId);
    coordination.hosts.reportOnline(host.id, ["acp.codex"], capacity, {
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
    return host.id;
  }

  request(blockRef = "T-001#B-001", idempotencyKey = "crash-matrix-request") {
    const request = endpointDispatchRequest({
      agentEndpoints: this.requireCoordination().agentEndpoints,
      locator: this.locator,
      blockRef,
      idempotencyKey,
      agentEndpointId: this.agentEndpointId
    });
    this.agentEndpointId = request.agentEndpointId;
    return request;
  }
}

const dispatchCrashPoints = [
  "before_operation_commit",
  "after_operation_commit",
  "after_candidate_persistence",
  "after_runtime_claim",
  "after_envelope_persistence",
  "after_input_materialization",
  "after_host_reservation",
  "after_dispatch_persistence",
  "after_runtime_binding",
  "after_mailbox_enqueue",
  "after_mailbox_publish"
] as const satisfies readonly RemoteCoordinatorCheckpoint[];

function count(database: PlanweaveServer["database"], table: string): number {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
}

function diagnosticCode(database: PlanweaveServer["database"], operationId: string): unknown {
  return database
    .prepare("SELECT diagnostic_code AS code FROM remote_operations WHERE id=?")
    .get(operationId)?.code;
}

async function prepareInterruptedAction(harness: CoordinatorHarness, resumable: boolean) {
  const hostId = harness.registerHost();
  const coordination = harness.requireCoordination();
  if (resumable) {
    coordination.hosts.reportOnline(hostId, ["acp.codex", "acp.session.load"], 1, {
      workspaceMappings: [{ workspaceId: harness.locator.workspaceId, status: "ready" }],
      acpProfiles: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Test Agent",
          status: "ready",
          capabilities: ["acp.codex", "acp.session.load"]
        }
      ]
    });
  }
  const blockRef = "T-001#B-001";
  const candidate = await canonicalRemoteRuntimePort(
    harness.requireRuntime(),
    harness.locator.workspaceId
  ).inspect({ ref: blockRef });
  const operation = seedLegacyRemoteOperation({
    database: harness.requireServer().database,
    operations: coordination.operations,
    locator: harness.locator,
    candidate,
    idempotencyKey: `action-crash-${resumable}`,
    hostSelection: {
      workspaceId: harness.locator.workspaceId,
      assignmentRevision: 0,
      target: { kind: "automatic_host" },
      selection: "automatic",
      requiredCapabilities: candidate.requiredCapabilities
    }
  });
  const outcome = await coordination.coordinator.reenter(operation.id);
  const dispatch = coordination.dispatches.getRequired(outcome.operation.dispatchId);
  coordination.dispatches.accept(
    hostId,
    `action-accepted-${resumable}`,
    dispatch.id,
    dispatch.leaseId,
    dispatch.executionAttemptId
  );
  coordination.dispatches.interrupt(hostId, `action-interrupted-${resumable}`, {
    type: "dispatch.interrupted",
    protocolVersion: 1,
    messageId: `action-interrupted-${resumable}`,
    dispatchId: dispatch.id,
    leaseId: dispatch.leaseId,
    executionAttemptId: dispatch.executionAttemptId,
    reason: resumable ? "transport_lost" : "acp_session_lost",
    resumable,
    ...(resumable
      ? { recovery: { acpSessionId: "session-action-crash", recoveryId: "recovery-action-crash" } }
      : {})
  });
  const lease = coordination.reservations.getRequired(dispatch.leaseId);
  coordination.reservations.release({
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    expectedVersion: lease.version,
    reason: "expired"
  });
  await coordination.coordinator.reenter(outcome.operation.id);
  return { hostId, outcome, dispatch };
}

async function prepareInterruptedV3Action(harness: CoordinatorHarness) {
  const hostId = harness.registerHost();
  const coordination = harness.requireCoordination();
  const access = new ProjectAccessRepository(harness.requireServer().database);
  access.registerProjectInternal({
    workspaceId: harness.locator.workspaceId,
    projectId: harness.locator.projectId,
    projectRoot: harness.workspace.root
  });
  access.registerCanvasInternal({
    workspaceId: harness.locator.workspaceId,
    projectId: harness.locator.projectId,
    canvasId: harness.locator.canvasId,
    packageDir: harness.workspace.init.workspace.packageDir
  });
  const endpoint = coordination.agentEndpoints.listVisible(harness.locator.workspaceId).items[0];
  if (!endpoint) throw new Error("expected_test_endpoint");
  const outcome = await coordination.coordinator.dispatch({
    ...harness.request("T-001#B-001", "v3-action-crash"),
    agentEndpointId: endpoint.endpointId,
    expectedResponsibilityRevision: 0,
    expectedReviewerRevision: 0
  });
  const dispatch = coordination.dispatches.getRequired(outcome.operation.dispatchId);
  coordination.dispatches.accept(
    hostId,
    "v3-action-crash-accepted",
    dispatch.id,
    dispatch.leaseId,
    dispatch.executionAttemptId
  );
  coordination.dispatches.interrupt(hostId, "v3-action-crash-interrupted", {
    type: "dispatch.interrupted",
    protocolVersion: 1,
    messageId: "v3-action-crash-interrupted",
    dispatchId: dispatch.id,
    leaseId: dispatch.leaseId,
    executionAttemptId: dispatch.executionAttemptId,
    reason: "acp_session_lost",
    resumable: false
  });
  const lease = coordination.reservations.getRequired(dispatch.leaseId);
  coordination.reservations.release({
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    expectedVersion: lease.version,
    reason: "expired"
  });
  await coordination.coordinator.reenter(outcome.operation.id);
  return { hostId, outcome, dispatch, endpoint };
}

describe("RemoteBlockCoordinator crash reconciliation", () => {
  it.each([
    "block",
    "fail"
  ] as const)("recovers a %s action after its side effect but before action settlement", async (kind) => {
    const harness = await CoordinatorHarness.create();
    const prepared = await prepareInterruptedAction(harness, false);
    let coordination = await harness.restart(new CrashOnce("after_action_side_effect"));
    const interrupted = coordination.operations.getRequired(prepared.outcome.operation.id);
    const request = {
      actionId: `${kind}-action-crash`,
      operationId: interrupted.id,
      dispatchId: interrupted.dispatchId,
      executionAttemptId: interrupted.executionAttemptId,
      expectedAttemptVersion: interrupted.attempt.stateVersion,
      kind,
      leaseId: prepared.dispatch.leaseId,
      reason: `${kind} after interruption`,
      ...(kind === "fail"
        ? {
            failure: {
              code: "operator_failed",
              message: "Stopped manually.",
              retryable: false
            }
          }
        : {})
    };
    await expect(coordination.coordinator.executeAction(request)).rejects.toThrowError(
      "injected_crash:after_action_side_effect"
    );
    coordination = await harness.restart();
    await coordination.reconcile({
      serverInstanceOwnerToken: harness.requireServer().serverInstanceOwnerToken
    });
    expect(coordination.actions.getRequired(request.actionId).state).toBe("settled");
  });

  it("recovers a resume action after fresh-lease and mailbox side effects", async () => {
    const harness = await CoordinatorHarness.create();
    const prepared = await prepareInterruptedAction(harness, true);
    let coordination = await harness.restart(new CrashOnce("after_action_side_effect"));
    const interrupted = coordination.operations.getRequired(prepared.outcome.operation.id);
    const request = {
      actionId: "resume-action-crash",
      operationId: interrupted.id,
      dispatchId: interrupted.dispatchId,
      executionAttemptId: interrupted.executionAttemptId,
      expectedAttemptVersion: interrupted.attempt.stateVersion,
      kind: "resume_same_session",
      priorLeaseId: prepared.dispatch.leaseId,
      leaseId: "lease-resume-action-crash",
      leaseExpiresAt: new Date(Date.now() + 55_000).toISOString(),
      recovery: { acpSessionId: "session-action-crash", recoveryId: "recovery-action-crash" },
      reason: "resume after transport interruption"
    } as const;
    await expect(coordination.coordinator.executeAction(request)).rejects.toThrowError(
      "injected_crash:after_action_side_effect"
    );
    coordination = await harness.restart();
    await coordination.reconcile({
      serverInstanceOwnerToken: harness.requireServer().serverInstanceOwnerToken
    });
    expect(coordination.actions.getRequired(request.actionId).state).toBe("delivered");
    expect(
      harness
        .requireServer()
        .database.prepare("SELECT COUNT(*) AS count FROM mailbox_messages WHERE message_id=?")
        .get(request.actionId)?.count
    ).toBe(1);
  });

  it("recovers a retry crash after dispatching the new attempt but before settling the action", async () => {
    const harness = await CoordinatorHarness.create();
    const prepared = await prepareInterruptedAction(harness, false);
    let coordination = harness.requireCoordination();
    const { outcome, dispatch } = prepared;
    new WorkAssignmentRepository(harness.requireServer().database).applyCasUpdate({
      expectedRevision: 0,
      record: {
        workspaceId: harness.locator.workspaceId,
        projectId: harness.locator.projectId,
        workItem: {
          kind: "block",
          canvasId: harness.locator.canvasId,
          blockRef: outcome.operation.blockRef
        },
        target: { kind: "exact_host", hostId: prepared.hostId },
        revision: 1,
        updatedBy: { kind: "system", id: "retry-crash-test" },
        updatedAt: "2030-01-01T00:00:00.000Z"
      }
    });
    coordination = await harness.restart(new CrashOnce("after_action_side_effect"));
    const interrupted = coordination.operations.getRequired(outcome.operation.id);
    const request = {
      actionId: "retry-action-1",
      operationId: interrupted.id,
      dispatchId: interrupted.dispatchId,
      executionAttemptId: interrupted.executionAttemptId,
      expectedAttemptVersion: interrupted.attempt.stateVersion,
      kind: "retry_new_attempt",
      priorLeaseId: dispatch.leaseId,
      newDispatchId: "dispatch-retry-action-2",
      newExecutionAttemptId: "attempt-retry-action-2",
      reason: "retry with a fresh attempt"
    } as const;
    await expect(coordination.coordinator.executeAction(request)).rejects.toThrowError(
      "injected_crash:after_action_side_effect"
    );
    expect(coordination.actions.getRequired(request.actionId).state).toBe("recorded");

    coordination = await harness.restart();
    await coordination.reconcile({
      serverInstanceOwnerToken: harness.requireServer().serverInstanceOwnerToken
    });
    const action = coordination.actions.getRequired(request.actionId);

    expect(action.state).toBe("settled");
    expect(coordination.operations.getRequired(outcome.operation.id)).toMatchObject({
      state: "activated",
      dispatchId: "dispatch-retry-action-2",
      executionAttemptId: "attempt-retry-action-2"
    });
    expect(count(harness.requireServer().database, "dispatches")).toBe(2);
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(2);
  });

  it("fails v3 retry crash recovery when the durable Endpoint identity changes", async () => {
    const harness = await CoordinatorHarness.create();
    const prepared = await prepareInterruptedV3Action(harness);
    let coordination = await harness.restart(new CrashOnce("after_action_side_effect"));
    const interrupted = coordination.operations.getRequired(prepared.outcome.operation.id);
    const request = {
      actionId: "v3-retry-action-crash",
      operationId: interrupted.id,
      dispatchId: interrupted.dispatchId,
      executionAttemptId: interrupted.executionAttemptId,
      expectedAttemptVersion: interrupted.attempt.stateVersion,
      kind: "retry_new_attempt",
      priorLeaseId: prepared.dispatch.leaseId,
      newDispatchId: "dispatch-v3-retry-crash-2",
      newExecutionAttemptId: "attempt-v3-retry-crash-2",
      reason: "retry v3 before recovery identity drift"
    } as const;
    await expect(coordination.coordinator.executeAction(request)).rejects.toThrowError(
      "injected_crash:after_action_side_effect"
    );
    const mutated = coordination.operations.getRequired(interrupted.id);
    expect(mutated.endpointSelection).toEqual(interrupted.endpointSelection);

    coordination.hosts.reportOnline(prepared.hostId, ["acp.codex"], 1, {
      workspaceMappings: [{ workspaceId: harness.locator.workspaceId, status: "ready" }],
      acpProfiles: [
        {
          profileId: "replacement-profile",
          agentId: "replacement-agent",
          displayName: "Replacement",
          status: "ready",
          capabilities: ["acp.codex"]
        }
      ]
    });
    coordination = await harness.restart();
    await expect(
      coordination.reconcile({
        serverInstanceOwnerToken: harness.requireServer().serverInstanceOwnerToken
      })
    ).rejects.toThrow(/agent_endpoint_(unknown|incompatible)/);
    expect(coordination.operations.getRequired(interrupted.id)).toMatchObject({
      dispatchId: request.newDispatchId,
      executionAttemptId: request.newExecutionAttemptId,
      endpointSelection: interrupted.endpointSelection
    });
    expect(
      harness
        .requireServer()
        .database.prepare(
          "SELECT COUNT(*) AS count FROM remote_execution_attempts WHERE operation_id=?"
        )
        .get(interrupted.id)
    ).toEqual({ count: 2 });
  });

  it("rejects completion without durable terminal evidence", async () => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost();
    const coordination = harness.requireCoordination();
    const outcome = await coordination.coordinator.dispatch(harness.request());
    await expect(coordination.coordinator.complete(outcome.operation.id)).rejects.toThrowError(
      "remote_completion_evidence_missing"
    );
  });

  it("acknowledges replayed completion after the operation was already sealed failed", async () => {
    const harness = await CoordinatorHarness.create();
    const hostId = harness.registerHost();
    const coordination = harness.requireCoordination();
    const outcome = await coordination.coordinator.dispatch(
      harness.request("T-001#B-001", "terminal-operation-completion-replay")
    );
    const dispatch = coordination.dispatches.getRequired(outcome.operation.dispatchId);
    const report = Buffer.from("# Remote result\n\nCompleted before ownership was lost.\n");
    const artifact = await harness.requireArtifacts().put({
      expectedSha256: createHash("sha256").update(report).digest("hex"),
      expectedSizeBytes: report.byteLength,
      mediaType: "text/markdown",
      chunks: (async function* () {
        yield report;
      })()
    });
    const result = {
      summary: "Completion replay after local terminal recovery.",
      reportArtifactRef: artifact.ref,
      artifactRefs: []
    };
    const grant = coordination.artifactAuthorization.createOutputGrant({
      operationId: "terminal-operation-completion-replay-report",
      workspaceId: dispatch.workspaceId,
      projectId: dispatch.projectId,
      hostId,
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      permission: "report_write",
      expectedSha256: artifact.sha256,
      expectedSizeBytes: artifact.sizeBytes,
      expectedMediaType: artifact.mediaType
    });
    coordination.artifactAuthorization.acceptOutputUpload(
      {
        workspaceId: dispatch.workspaceId,
        projectId: dispatch.projectId,
        hostId,
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        grantId: grant.grantId
      },
      artifact
    );
    const now = new Date().toISOString();
    harness
      .requireServer()
      .database.prepare(
        "UPDATE dispatches SET status='awaiting_writeback',result_json=? WHERE id=?"
      )
      .run(JSON.stringify(result), dispatch.id);
    harness
      .requireServer()
      .database.prepare(
        `UPDATE remote_operations
         SET state='failed',diagnostic_code='remote_ownership_not_active',
           diagnostic_message='Remote ownership was already sealed.',updated_at=?,terminal_at=?
         WHERE id=?`
      )
      .run(now, now, outcome.operation.id);

    await expect(
      coordination.dispatches.complete(
        hostId,
        "terminal-operation-completion-replay-message",
        dispatch.id,
        dispatch.leaseId,
        dispatch.executionAttemptId,
        result
      )
    ).resolves.toMatchObject({ status: "failed" });
    expect(coordination.operations.getRequired(outcome.operation.id).state).toBe("failed");
    expect(coordination.dispatches.getRequired(dispatch.id).status).toBe("failed");
  });

  it.each(dispatchCrashPoints)("recovers the same operation after %s", async (checkpoint) => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost();
    await harness.restart(new CrashOnce(checkpoint));

    await expect(
      harness.requireCoordination().coordinator.dispatch(harness.request())
    ).rejects.toThrowError(`injected_crash:${checkpoint}`);

    const coordination = await harness.restart();
    const recovered = await coordination.coordinator.dispatch(harness.request());
    expect(recovered.status).toBe("activated");
    expect(recovered.operation.state).toBe("activated");
    const database = harness.requireServer().database;
    expect(count(database, "remote_operations")).toBe(1);
    expect(count(database, "remote_execution_attempts")).toBe(1);
    expect(count(database, "host_capacity_reservations")).toBe(1);
    expect(count(database, "dispatches")).toBe(1);
    expect(count(database, "dispatch_execution_envelopes")).toBe(1);
    expect(count(database, "mailbox_messages")).toBe(1);
    expect(
      database
        .prepare(
          `SELECT type,COUNT(*) AS count FROM remote_operation_events
           GROUP BY type HAVING COUNT(*)>1`
        )
        .all()
    ).toEqual([]);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM dispatch_events WHERE type='dispatch.leased'")
        .get()?.count
    ).toBe(1);
    await expect(
      harness.requireRuntime().query({
        ref: recovered.operation.blockRef,
        operationId: recovered.operation.id
      })
    ).resolves.toMatchObject({ ownership: { phase: "active" } });
  });

  it("does not reactivate or republish after Host acceptance", async () => {
    const harness = await CoordinatorHarness.create();
    const hostId = harness.registerHost();
    const outcome = await harness.requireCoordination().coordinator.dispatch(harness.request());
    const dispatch = harness
      .requireCoordination()
      .dispatches.getRequired(outcome.operation.dispatchId);
    harness
      .requireCoordination()
      .dispatches.accept(
        hostId,
        "accepted-before-restart",
        dispatch.id,
        dispatch.leaseId,
        dispatch.executionAttemptId
      );
    harness
      .requireCoordination()
      .dispatches.accept(
        hostId,
        "accepted-before-restart",
        dispatch.id,
        dispatch.leaseId,
        dispatch.executionAttemptId
      );

    const crashed = await harness.restart(new CrashOnce("after_host_acceptance_observed"));
    await expect(crashed.coordinator.reenterPending()).rejects.toThrowError(
      "injected_crash:after_host_acceptance_observed"
    );
    const restarted = await harness.restart();
    await expect(restarted.coordinator.reenterPending()).resolves.toMatchObject([
      { status: "active" }
    ]);
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(1);
    expect(
      harness
        .requireServer()
        .database.prepare(
          "SELECT COUNT(*) AS count FROM dispatch_events WHERE type='dispatch.accepted'"
        )
        .get()?.count
    ).toBe(1);
  });

  it("preserves one input grant and materialization across dispatch persistence restart", async () => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost();
    const bytes = Buffer.from("durable coordinator input");
    const artifact = await harness.requireArtifacts().put({
      expectedSha256: createHash("sha256").update(bytes).digest("hex"),
      expectedSizeBytes: bytes.byteLength,
      mediaType: "text/plain",
      chunks: (async function* () {
        yield bytes;
      })()
    });
    const materialized = new Set<string>();
    const decorateRuntime = (runtime: RemoteBlockRuntimePort): RemoteBlockRuntimePort => ({
      ...runtime,
      inspect: async (input) => {
        const candidate = await runtime.inspect(input);
        return {
          ...candidate,
          inputArtifacts: [
            { artifactRef: artifact.ref, logicalName: "coordinator-input", mediaType: "text/plain" }
          ]
        };
      }
    });
    const materialize = async (candidate: RemoteBlockDispatchCandidate) => {
      for (const input of candidate.inputArtifacts) {
        await harness.requireArtifacts().read(input.artifactRef);
        materialized.add(input.artifactRef);
      }
    };
    await harness.restart(
      new CrashOnce("after_dispatch_persistence"),
      decorateRuntime,
      materialize
    );
    await expect(
      harness.requireCoordination().coordinator.dispatch(harness.request())
    ).rejects.toThrowError("injected_crash:after_dispatch_persistence");

    const restarted = await harness.restart(undefined, decorateRuntime, materialize);
    await expect(restarted.coordinator.dispatch(harness.request())).resolves.toMatchObject({
      status: "activated"
    });
    expect(materialized).toEqual(new Set([artifact.ref]));
    expect(count(harness.requireServer().database, "artifact_grants")).toBe(1);
    expect(count(harness.requireServer().database, "dispatch_artifact_links")).toBe(1);
  });

  it("blocks a restarted legacy operation when its Runtime source has drifted", async () => {
    const harness = await CoordinatorHarness.create();
    const coordination = harness.requireCoordination();
    const candidate = await canonicalRemoteRuntimePort(
      harness.requireRuntime(),
      harness.locator.workspaceId
    ).inspect({ ref: "T-001#B-001" });
    const operation = seedLegacyRemoteOperation({
      database: harness.requireServer().database,
      operations: coordination.operations,
      locator: harness.locator,
      candidate,
      idempotencyKey: "source-drift-before-host",
      hostSelection: {
        workspaceId: harness.locator.workspaceId,
        assignmentRevision: 0,
        target: { kind: "automatic_host" },
        selection: "automatic",
        requiredCapabilities: candidate.requiredCapabilities
      }
    });
    const outcome = await coordination.coordinator.reenter(operation.id);
    expect(outcome.status).toBe("awaiting_host");
    await appendFile(
      join(harness.workspace.init.workspace.packageDir, "nodes/T-001/blocks/B-001.prompt.md"),
      "\nsource drift after durable preparation\n",
      "utf8"
    );

    await harness.restart();
    harness.registerHost();
    await expect(harness.requireCoordination().coordinator.reenterPending()).resolves.toMatchObject(
      [{ status: "terminal" }]
    );
    expect(harness.requireCoordination().operations.getRequired(outcome.operation.id).state).toBe(
      "cancelled"
    );
    expect(count(harness.requireServer().database, "host_capacity_reservations")).toBe(0);
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(0);
  });

  it("rejects foreign Runtime ownership before reserving a Host", async () => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost();
    const runtime = harness.requireRuntime();
    const candidate = await runtime.inspect({ ref: "T-001#B-001" });
    await runtime.claim({
      ref: candidate.blockRef,
      operationId: "foreign-operation",
      controlPlane: "collaboration",
      sourceRevision: candidate.sourceRevision,
      graphFingerprint: candidate.graphFingerprint
    });

    await expect(
      harness.requireCoordination().coordinator.dispatch(harness.request())
    ).rejects.toThrow();
    expect(count(harness.requireServer().database, "remote_operations")).toBe(0);
    expect(count(harness.requireServer().database, "host_capacity_reservations")).toBe(0);
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(0);
    await expect(
      runtime.query({ ref: candidate.blockRef, operationId: "foreign-operation" })
    ).resolves.toMatchObject({
      ownership: { operationId: "foreign-operation", phase: "preparing" }
    });
  });

  it("surfaces an orphaned dispatch envelope instead of creating a second attempt", async () => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost();
    const outcome = await harness.requireCoordination().coordinator.dispatch(harness.request());
    harness
      .requireServer()
      .database.prepare("DELETE FROM dispatch_execution_envelopes WHERE dispatch_id=?")
      .run(outcome.operation.dispatchId);

    await harness.restart();
    await expect(harness.requireCoordination().coordinator.reenterPending()).rejects.toThrowError(
      "remote_persistence_inconsistent"
    );
    expect(diagnosticCode(harness.requireServer().database, outcome.operation.id)).toBe(
      "remote_persistence_inconsistent"
    );
    expect(count(harness.requireServer().database, "remote_execution_attempts")).toBe(1);
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(1);
  });

  it("deduplicates cancel replay and rejects conflicting message identity", async () => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost();
    const outcome = await harness.requireCoordination().coordinator.dispatch(harness.request());
    const coordinator = harness.requireCoordination().coordinator;

    await coordinator.requestCancel(outcome.operation.id, "operator requested cancellation");
    await coordinator.requestCancel(outcome.operation.id, "operator requested cancellation");
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(2);
    await expect(
      coordinator.requestCancel(outcome.operation.id, "different reason")
    ).rejects.toThrowError("remote_action_idempotency_conflict");
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(2);
  });

  it.each([
    "after_terminal_event_persistence",
    "before_runtime_writeback",
    "after_runtime_writeback",
    "after_dispatch_terminal_persistence",
    "after_terminal_persistence"
  ] as const)("reconciles terminal failure after %s", async (checkpoint) => {
    const harness = await CoordinatorHarness.create();
    const hostId = harness.registerHost();
    const outcome = await harness.requireCoordination().coordinator.dispatch(harness.request());
    const dispatch = harness
      .requireCoordination()
      .dispatches.getRequired(outcome.operation.dispatchId);
    harness
      .requireCoordination()
      .dispatches.accept(
        hostId,
        `accepted-${checkpoint}`,
        dispatch.id,
        dispatch.leaseId,
        dispatch.executionAttemptId
      );
    await harness.restart(new CrashOnce(checkpoint));
    const current = harness.requireCoordination().dispatches.getRequired(dispatch.id);

    await expect(
      harness
        .requireCoordination()
        .dispatches.fail(
          hostId,
          `failed-${checkpoint}`,
          current.id,
          current.leaseId,
          current.executionAttemptId,
          { code: "remote_test_failure", message: "Injected terminal failure.", retryable: false }
        )
    ).rejects.toThrowError(`injected_crash:${checkpoint}`);

    const restarted = await harness.restart();
    await restarted.coordinator.reenterPending();
    expect(restarted.operations.getRequired(outcome.operation.id).state).toBe("failed");
    expect(restarted.dispatches.getRequired(dispatch.id).status).toBe("failed");
    expect(
      harness
        .requireServer()
        .database.prepare(
          "SELECT COUNT(*) AS count FROM remote_operation_events WHERE type='remote.attempt.failed'"
        )
        .get()?.count
    ).toBe(1);
    expect(
      harness
        .requireServer()
        .database.prepare(
          "SELECT COUNT(*) AS count FROM dispatch_events WHERE type='dispatch.failed'"
        )
        .get()?.count
    ).toBe(1);
  });
});

describe("RemoteBlockCoordinator concurrency reconciliation", () => {
  it("collapses concurrent identical requests to one logical execution", async () => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost(2);
    const coordination = harness.requireCoordination();
    const [first, second] = await Promise.all([
      coordination.coordinator.dispatch(harness.request()),
      coordination.coordinator.dispatch(harness.request())
    ]);
    expect(second.operation.id).toBe(first.operation.id);
    expect(second.operation.executionAttemptId).toBe(first.operation.executionAttemptId);
    expect(count(harness.requireServer().database, "host_capacity_reservations")).toBe(1);
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(1);
  });

  it("rejects foreign idempotency ownership without a second active attempt", async () => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost(2);
    const coordination = harness.requireCoordination();
    const settled = await Promise.allSettled([
      coordination.coordinator.dispatch(harness.request("T-001#B-001", "owner-a")),
      coordination.coordinator.dispatch(harness.request("T-001#B-001", "owner-b"))
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      harness
        .requireServer()
        .database.prepare(
          `SELECT COUNT(*) AS count FROM remote_execution_attempts
           WHERE status IN ('reserved','activated','running','interrupted','action_required','awaiting_writeback')`
        )
        .get()?.count
    ).toBe(1);
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(1);
  });

  it("re-enters a strict Endpoint operation when its Host becomes available", async () => {
    const harness = await CoordinatorHarness.create(true);
    harness.registerHost(1);
    const coordination = harness.requireCoordination();
    const outcomes = await Promise.allSettled([
      coordination.coordinator.dispatch(harness.request("T-001#B-001", "capacity-a")),
      coordination.coordinator.dispatch(harness.request("T-002#B-001", "capacity-b"))
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value.status).toBe("activated");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "agent_endpoint_unavailable" });
    expect(count(harness.requireServer().database, "host_capacity_reservations")).toBe(1);
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(1);

    const active = fulfilled[0]?.value.operation;
    if (!active?.attempt.leaseId) throw new Error("expected_active_test_lease");
    const reservation = coordination.reservations.getRequired(active.attempt.leaseId);
    coordination.reservations.release({
      leaseId: reservation.leaseId,
      fencingToken: reservation.fencingToken,
      expectedVersion: reservation.version,
      reason: "cancelled"
    });

    const resumed = await coordination.coordinator.reenterWaitingForHost(
      active.endpointSelection?.hostId ?? "missing-test-host"
    );
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ status: "activated" });
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(2);
  });
});
