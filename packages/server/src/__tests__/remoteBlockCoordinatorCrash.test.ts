import { agentHostProtocolVersion } from "@planweave-ai/agent-host-protocol";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  captureAuthorizedCanvasContent,
  createRemoteBlockArtifactSource,
  createRemoteBlockRuntimePort,
  remoteBlockDispatchCandidateSchema,
  type PlanPackageManifest,
  type RemoteBlockDispatchCandidate,
  type RemoteBlockRuntimePort
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE_CANVAS_EXECUTION_CAPABILITY } from "@planweave-ai/agent-host-protocol";
import { RemoteAgentAuthorizationError } from "../remoteAgent/errors.js";
import {
  createTestWorkspace,
  basicManifest
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ArtifactStore } from "../artifacts.js";
import { createRemoteBlockCoordination } from "../distributedCoordination.js";
import type { RemoteBlockCoordinationOptions } from "../distributedCoordination.js";
import {
  RemoteCoordinatorCheckpointCrash,
  type RemoteCoordinatorCheckpoint,
  type RemoteCoordinatorCheckpointPort
} from "../remoteBlockCoordinatorPorts.js";
import { RemoteRuntimePortRegistry } from "../remoteRuntimeLocator.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { canonicalRemoteRuntimePort } from "../canonicalRemoteRuntimePort.js";
import {
  endpointDispatchRequest,
  registerEndpointDispatchAccess,
  workspaceEndpointSelection,
  workspaceExecutionCandidate
} from "./support/endpointCoordinatorFixture.js";
import { seedLegacyRemoteOperation } from "./support/legacyRemoteOperationSeed.js";
import {
  ownHostRemoteAgents,
  TEST_REMOTE_AGENT_OWNER_ID
} from "./support/remoteAgentOwnerFixture.js";
import { exactHostRuntimeRouteFixture } from "./support/exactHostRuntimeRoute.js";
import { CanvasRuntimeUnavailableError } from "../canvas/executionRuntimePort.js";
import { CanvasRuntimeRpcError } from "../canvas/runtimeRpcBroker.js";
import { ContentVersionRepository } from "../canvas/contentVersionRepository.js";
import { readStableCanvasRuntimeEvidence } from "../canvas/contentFingerprint.js";
import { AuthorityRepository } from "../work/authorityRepository.js";
import type { RemoteOperation } from "../remoteOperations.js";

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
      throw new RemoteCoordinatorCheckpointCrash(checkpoint);
    }
  }
}

class CoordinatorHarness {
  private server?: PlanweaveServer;
  coordination?: Coordination;
  runtime?: RemoteBlockRuntimePort;
  artifacts?: ArtifactStore;
  private agentEndpointId?: string;
  private contentRevision = 1;
  private bindingContentRevision = `snapshot:${"0".repeat(64)}`;
  private bindingGraphFingerprint = `pkg-${"0".repeat(64)}`;
  private contentTargetFailure?: Error;
  runtimeAcquireCount = 0;
  runtimeInspectCount = 0;
  materializeCount = 0;
  clockOffsetMs = 0;

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
    const contentVersions = new ContentVersionRepository(this.server.database);
    if (!contentVersions.head(this.locator)) {
      const captured = await captureAuthorizedCanvasContent({
        projectRoot: this.workspace.root,
        canvasId: this.locator.canvasId,
        expectedPackageDir: this.workspace.init.workspace.packageDir,
        authorityProjectId: this.locator.projectId
      });
      contentVersions.publishInitial({
        scope: this.locator,
        content: captured.content,
        createdBy: { kind: "human", id: "test-owner" }
      });
    }
    const contentEvidence = readStableCanvasRuntimeEvidence(contentVersions, this.locator);
    if (!contentEvidence) throw new Error("test_content_evidence_missing");
    this.bindingContentRevision = contentEvidence.sourceRevision;
    this.bindingGraphFingerprint = contentEvidence.target.graphFingerprint;
    const runtime = this.runtime;
    const routedRuntime: RemoteBlockRuntimePort = {
      ...runtime,
      inspect: async (input) => {
        this.runtimeInspectCount += 1;
        return runtime.inspect(input);
      }
    };
    const registry = new RemoteRuntimePortRegistry();
    registry.bind(
      this.locator,
      routedRuntime,
      createRemoteBlockArtifactSource({ projectRoot: this.workspace.root }),
      async () => ({
        sourceRevision: `snapshot:${"a".repeat(64)}`,
        graphFingerprint: `pkg-${"b".repeat(64)}`,
        status: {
          schemaVersion: "canvas-runtime-status/v2",
          scope: this.locator,
          packageFingerprint: `pkg-${"b".repeat(64)}`,
          capturedAt: "2026-08-27T00:00:00.000Z",
          tasks: [],
          blocks: []
        }
      })
    );
    this.artifacts = new ArtifactStore(this.server.database, this.dataDirectory, 1024 * 1024);
    const options: RemoteBlockCoordinationOptions = {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      clock: () => new Date(Date.now() + this.clockOffsetMs),
      runtimeLeases: exactHostRuntimeRouteFixture(registry, () => {
        this.runtimeAcquireCount += 1;
      }),
      runtimeContentTargets: {
        read: (scope) => {
          if (this.contentTargetFailure) throw this.contentTargetFailure;
          const row = this.requireServer()
            .database.prepare(
              `SELECT c.candidate_json
               FROM remote_operation_candidates c
               JOIN remote_operations o ON o.id=c.operation_id
               WHERE o.workspace_id=? AND o.project_id=? AND o.canvas_id=?
               ORDER BY o.created_at DESC,o.id DESC LIMIT 1`
            )
            .get(scope.workspaceId, scope.projectId, scope.canvasId);
          if (!row || typeof row.candidate_json !== "string") {
            throw new Error("test_runtime_content_target_missing");
          }
          const candidate = remoteBlockDispatchCandidateSchema.parse(
            JSON.parse(row.candidate_json)
          );
          return { revision: this.contentRevision, graphFingerprint: candidate.graphFingerprint };
        }
      },
      inputArtifacts: {
        materialize: async (candidate) => {
          this.materializeCount += 1;
          await materialize(candidate);
        }
      },
      artifactContent: {
        readReport: async (ref) => this.requireArtifacts().read(ref),
        readReportMediaType: async (ref) => this.requireArtifacts().getRequired(ref).mediaType
      },
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
    ownHostRemoteAgents({
      database: this.requireServer().database,
      hostId: host.id,
      grantWorkspaceId: workspaceId
    });
    coordination.hosts.bindToWorkspace(host.id, workspaceId);
    coordination.hosts.reportOnline(
      host.id,
      ["acp.codex", WORKSPACE_CANVAS_EXECUTION_CAPABILITY],
      capacity,
      {
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
      }
    );
    return host.id;
  }

  advanceContentRevision(): void {
    this.contentRevision += 1;
  }

  async prepareAuthoritativeContentHeadAdvance(): Promise<() => void> {
    await appendFile(
      join(this.workspace.init.workspace.packageDir, "nodes", "T-001", "prompt.md"),
      "\nAuthoritative content race.\n"
    );
    const repository = new ContentVersionRepository(this.requireServer().database);
    const captured = await captureAuthorizedCanvasContent({
      projectRoot: this.workspace.root,
      canvasId: this.locator.canvasId,
      expectedPackageDir: this.workspace.init.workspace.packageDir,
      authorityProjectId: this.locator.projectId
    });
    const persisted = repository.persistImmutable({
      scope: this.locator,
      content: captured.content,
      createdBy: { kind: "human", id: "content-race-test-owner" }
    });
    const current = repository.head(this.locator);
    if (!current) throw new Error("test_content_head_missing");
    return () => {
      new ContentVersionRepository(this.requireServer().database).advanceHeadForSqliteCommit({
        scope: this.locator,
        expectedRevision: current.revision,
        content: persisted.completed
      });
    };
  }

  failContentTargetReads(error?: Error): void {
    this.contentTargetFailure = error;
  }

  request(blockRef = "T-001#B-001", idempotencyKey = "crash-matrix-request") {
    const request = endpointDispatchRequest({
      agentEndpoints: this.requireCoordination().agentEndpoints,
      locator: {
        ...this.locator,
        contentRevision: this.bindingContentRevision,
        graphFingerprint: this.bindingGraphFingerprint
      },
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
  "after_host_reservation",
  "after_runtime_attachment",
  "after_runtime_claim",
  "after_envelope_persistence",
  "after_input_materialization",
  "after_dispatch_persistence",
  "after_runtime_binding",
  "after_mailbox_enqueue",
  "after_mailbox_publish"
] as const satisfies readonly RemoteCoordinatorCheckpoint[];

function count(database: PlanweaveServer["database"], table: string): number {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
}

function cancelAction(operation: RemoteOperation, actionId: string) {
  return {
    actionId,
    kind: "cancel",
    operationId: operation.id,
    dispatchId: operation.dispatchId,
    executionAttemptId: operation.executionAttemptId,
    expectedAttemptVersion: operation.attempt.stateVersion,
    leaseId: operation.attempt.leaseId,
    reason: "Cancel the observed attempt."
  } as const;
}

function mailboxContains(harness: CoordinatorHarness, actionId: string): boolean {
  return Boolean(
    harness
      .requireServer()
      .database.prepare("SELECT 1 FROM mailbox_messages WHERE message_id=?")
      .get(actionId)
  );
}

function diagnosticCode(database: PlanweaveServer["database"], operationId: string): unknown {
  return database
    .prepare("SELECT diagnostic_code AS code FROM remote_operations WHERE id=?")
    .get(operationId)?.code;
}

async function prepareInterruptedAction(
  harness: CoordinatorHarness,
  resumable: boolean,
  blockRef = "T-001#B-001"
) {
  const hostId = harness.registerHost();
  const coordination = harness.requireCoordination();
  if (resumable) {
    coordination.hosts.reportOnline(
      hostId,
      ["acp.codex", "acp.session.load", WORKSPACE_CANVAS_EXECUTION_CAPABILITY],
      1,
      {
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
      }
    );
  }
  const candidate = workspaceExecutionCandidate(
    await canonicalRemoteRuntimePort(harness.requireRuntime(), harness.locator.workspaceId).inspect(
      { ref: blockRef }
    )
  );
  const operation = seedLegacyRemoteOperation({
    database: harness.requireServer().database,
    operations: coordination.operations,
    locator: harness.locator,
    candidate,
    idempotencyKey: `action-crash-${blockRef}-${resumable}`,
    endpointSelection: workspaceEndpointSelection({
      agentEndpoints: coordination.agentEndpoints,
      candidate,
      hostId,
      workspaceId: harness.locator.workspaceId,
      database: harness.requireServer().database
    }),
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
    protocolVersion: agentHostProtocolVersion,
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
  await coordination.coordinator.reenter(outcome.operation.id);
  const lease = coordination.reservations.getRequired(dispatch.leaseId);
  coordination.reservations.release({
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    expectedVersion: lease.version,
    reason: "expired"
  });
  return { hostId, outcome, dispatch };
}

async function prepareInterruptedV3Action(harness: CoordinatorHarness, resumable = false) {
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
  const endpoint = coordination.agentEndpoints.listVisibleFleet().items[0];
  if (!endpoint) throw new Error("expected_test_endpoint");
  const outcome = await coordination.coordinator.dispatch({
    ...harness.request("T-001#B-001", "v3-action-crash"),
    agentEndpointId: endpoint.endpointId,
    expectedResponsibilityRevision: 0,
    expectedReviewerRevision: 0,
    executionTargetRevision: 0
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
    protocolVersion: agentHostProtocolVersion,
    messageId: "v3-action-crash-interrupted",
    dispatchId: dispatch.id,
    leaseId: dispatch.leaseId,
    executionAttemptId: dispatch.executionAttemptId,
    reason: resumable ? "host_restart" : "acp_session_lost",
    resumable,
    ...(resumable
      ? { recovery: { acpSessionId: "session-action-crash", recoveryId: "recovery-action-crash" } }
      : {})
  });
  await coordination.coordinator.reenter(outcome.operation.id);
  const lease = coordination.reservations.getRequired(dispatch.leaseId);
  coordination.reservations.release({
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    expectedVersion: lease.version,
    reason: "expired"
  });
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
    await expect(coordination.coordinator.executeAction(request)).rejects.toThrow(
      "remote_action_in_progress"
    );
    await coordination.reconcile();
    expect(coordination.actions.getRequired(request.actionId).state).toBe("recorded");
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

  it.each([
    { retry: "execute", committed: false },
    { retry: "maintenance", committed: false },
    { retry: "concurrent", committed: true }
  ] as const)("resumes on the same Server after apply and recovery fail ($retry, committed=$committed)", async ({
    retry,
    committed
  }) => {
    const harness = await CoordinatorHarness.create(true);
    const { outcome, hostId } = await prepareInterruptedAction(harness, true);
    const later = await prepareInterruptedAction(harness, false, "T-002#B-001");
    const thirdStarted = Promise.withResolvers<void>();
    const releaseThird = Promise.withResolvers<void>();
    let calls = 0;
    const coordination = await harness.restart(undefined, (runtime) => ({
      ...runtime,
      resumeAttempt: async (input) => {
        calls += 1;
        if (calls <= 2 && committed) {
          await runtime.resumeAttempt(input);
          throw new CanvasRuntimeRpcError("canvas_runtime_reconcile_required", true, true);
        }
        if (calls <= 2) throw new CanvasRuntimeUnavailableError("host_offline");
        if (retry !== "execute") {
          thirdStarted.resolve();
          await releaseThird.promise;
        }
        return runtime.resumeAttempt(input);
      }
    }));
    const interrupted = coordination.operations.getRequired(outcome.operation.id);
    const { capability } = coordination.coordinator.readResume(interrupted);
    if (!capability.available) throw new Error(capability.reason);
    const action = {
      ...capability.target,
      actionId: "resume-online",
      kind: "resume_same_session",
      reason: "Resume the original session."
    } as const;
    await expect(coordination.coordinator.executeHumanAction(action)).rejects.toThrow(
      committed ? "canvas_runtime_reconcile_required" : CanvasRuntimeUnavailableError
    );
    const recorded = coordination.actions.getRequired(action.actionId);
    if (recorded.request.kind !== "resume_same_session") throw new Error("resume_request_required");
    expect(recorded.state).toBe("recorded");
    await expect(coordination.coordinator.executeHumanAction(action)).rejects.toThrow(
      committed ? "canvas_runtime_reconcile_required" : CanvasRuntimeUnavailableError
    );
    expect(mailboxContains(harness, action.actionId)).toBe(false);
    const laterOperation = coordination.operations.getRequired(later.outcome.operation.id);
    const laterAction = coordination.actions.record({
      ...cancelAction(laterOperation, "z-later-block"),
      kind: "block"
    });
    const checkMaintenance = async () => {
      const outcomes = await coordination.reconcile();
      expect(outcomes).toContainEqual(
        expect.objectContaining({
          operation: expect.objectContaining({
            id: laterOperation.id,
            attempt: expect.objectContaining({ status: "action_required" })
          })
        })
      );
      expect(coordination.actions.getRequired(laterAction.request.actionId).state).toBe("settled");
    };
    if (retry === "concurrent") {
      const execution = coordination.coordinator.executeHumanAction(action);
      try {
        await Promise.race([thirdStarted.promise, execution]);
        const duplicate = coordination.coordinator.executeHumanAction(action);
        const both = Promise.all([execution, duplicate]);
        void both.catch(() => undefined);
        await checkMaintenance();
        expect(mailboxContains(harness, action.actionId)).toBe(false);
        releaseThird.resolve();
        await expect(both).resolves.toMatchObject([{ state: "delivered" }, { state: "delivered" }]);
      } finally {
        releaseThird.resolve();
      }
    } else if (retry === "maintenance") {
      const maintenance = checkMaintenance();
      try {
        await Promise.race([thirdStarted.promise, maintenance]);
        await expect(
          coordination.coordinator.executeAction(laterAction.request)
        ).resolves.toMatchObject({
          state: "settled"
        });
      } finally {
        releaseThird.resolve();
      }
      await maintenance;
    } else {
      await expect(coordination.coordinator.executeHumanAction(action)).resolves.toMatchObject({
        state: "delivered"
      });
      await checkMaintenance();
    }
    expect(calls).toBe(3);
    const deliveredAction = coordination.actions.getRequired(action.actionId);
    expect(deliveredAction).toMatchObject({ state: "delivered", request: recorded.request });
    const resumeCommand = coordination.mailbox
      .listAfter(hostId, 0)
      .filter((message) => message.command.type === "resume_execution");
    expect(resumeCommand).toMatchObject([
      {
        messageId: action.actionId,
        command: {
          type: "resume_execution",
          dispatchId: interrupted.dispatchId,
          executionAttemptId: interrupted.executionAttemptId,
          leaseId: recorded.request.leaseId,
          priorRecovery: {
            acpSessionId: "session-action-crash",
            recoveryId: "recovery-action-crash"
          }
        }
      }
    ]);
    expect(coordination.operations.getRequired(interrupted.id).attempt).toMatchObject({
      executionAttemptId: interrupted.executionAttemptId,
      leaseId: recorded.request.leaseId,
      stateVersion: interrupted.attempt.stateVersion + 1
    });
    await expect(
      harness.requireRuntime().query({ ref: interrupted.blockRef, operationId: interrupted.id })
    ).resolves.toMatchObject({ status: "in_progress" });
    const database = harness.requireServer().database;
    expect(count(database, "remote_operations")).toBe(2);
    expect(count(database, "remote_execution_attempts")).toBe(2);
    expect(count(database, "remote_execution_actions")).toBe(2);
    expect(count(database, "host_capacity_reservations")).toBe(3);
  });

  it("leaves a late Runtime response for the Server owner that took over the resume claim", async () => {
    const harness = await CoordinatorHarness.create();
    const { outcome } = await prepareInterruptedAction(harness, true);
    const runtimeCommitted = Promise.withResolvers<void>();
    const returnResponse = Promise.withResolvers<void>();
    let coordination = await harness.restart(undefined, (runtime) => ({
      ...runtime,
      resumeAttempt: async (input) => {
        const result = await runtime.resumeAttempt(input);
        runtimeCommitted.resolve();
        await returnResponse.promise;
        return result;
      }
    }));
    const operation = coordination.operations.getRequired(outcome.operation.id);
    const { capability } = coordination.coordinator.readResume(operation);
    if (!capability.available) throw new Error(capability.reason);
    const action = {
      ...capability.target,
      actionId: "resume-after-ownership-loss",
      kind: "resume_same_session",
      reason: "Resume the original session."
    } as const;
    const { database, serverInstanceOwnerToken } = harness.requireServer();
    const replaceOwner = database.prepare(
      "UPDATE server_instance_ownership SET owner_token=? WHERE singleton=1 AND owner_token=?"
    );
    const replacement = randomUUID();
    const execution = coordination.coordinator.executeHumanAction(action);
    try {
      await Promise.race([runtimeCommitted.promise, execution]);
      replaceOwner.run(replacement, serverInstanceOwnerToken);
      coordination.actions.claimApplication(action.actionId, replacement, {
        takeoverExistingClaim: true
      });
      returnResponse.resolve();
      await expect(execution).rejects.toThrow("server_instance_ownership_lost");
      expect(mailboxContains(harness, action.actionId)).toBe(false);
      expect(coordination.actions.getRequired(action.actionId).state).toBe("recorded");
    } finally {
      returnResponse.resolve();
      replaceOwner.run(serverInstanceOwnerToken, replacement);
    }

    coordination = await harness.restart();
    await coordination.reconcile({
      serverInstanceOwnerToken: harness.requireServer().serverInstanceOwnerToken
    });
    expect(coordination.actions.getRequired(action.actionId).state).toBe("delivered");
    expect(mailboxContains(harness, action.actionId)).toBe(true);
  });

  it.each([
    "before",
    "after"
  ] as const)("replays a winning resume after losing the Runtime response %s its write", async (when) => {
    const harness = await CoordinatorHarness.create();
    const { hostId, outcome } = await prepareInterruptedAction(harness, true);
    let coordination = await harness.restart(undefined, (runtime) => ({
      ...runtime,
      resumeAttempt: async (input) => {
        if (when === "after") await runtime.resumeAttempt(input);
        throw new Error("fixture_runtime_response_lost");
      }
    }));
    const interrupted = coordination.operations.getRequired(outcome.operation.id);
    const { capability } = coordination.coordinator.readResume(interrupted);
    if (!capability.available) throw new Error(capability.reason);
    const action = {
      ...capability.target,
      actionId: "resume-runtime-cut",
      kind: "resume_same_session",
      reason: "Recover the original session across the Runtime RPC."
    } as const;
    const identity = { ref: interrupted.blockRef, operationId: interrupted.id };
    await expect(coordination.coordinator.executeHumanAction(action)).rejects.toThrow(
      "fixture_runtime_response_lost"
    );
    const recorded = coordination.actions.getRequired(action.actionId);
    if (recorded.request.kind !== "resume_same_session") throw new Error("resume_request_required");
    expect(recorded.state).toBe("recorded");
    const reserved = coordination.operations.getRequired(interrupted.id);
    expect(reserved.attempt.leaseId).toBe(recorded.request.leaseId);
    const database = harness.requireServer().database;
    expect(
      database.prepare("SELECT 1 FROM mailbox_messages WHERE message_id=?").get(action.actionId)
    ).toBeUndefined();
    expect((await harness.runtime?.query(identity))?.status).toBe(
      when === "before" ? "diverged" : "in_progress"
    );

    const host = coordination.hosts.getRequired(hostId);
    harness.clockOffsetMs = 61_000;
    let offline = true;
    coordination = await harness.restart(undefined, (runtime) => ({
      ...runtime,
      resumeAttempt: (input) => {
        if (offline) throw new CanvasRuntimeUnavailableError("host_offline");
        return runtime.resumeAttempt(input);
      }
    }));
    coordination.hosts.reportProtocolIncompatible(hostId);
    await coordination.reconcile({
      serverInstanceOwnerToken: harness.requireServer().serverInstanceOwnerToken
    });
    expect(coordination.actions.getRequired(action.actionId).state).toBe("recorded");
    expect((await harness.runtime?.query(identity))?.status).toBe(
      when === "before" ? "diverged" : "in_progress"
    );
    offline = false;
    coordination.hosts.reportOnline(
      hostId,
      host.capabilities,
      host.capacity,
      host.readinessObservation
    );
    await coordination.reconcile({
      serverInstanceOwnerToken: harness.requireServer().serverInstanceOwnerToken
    });
    const delivered = await coordination.coordinator.executeHumanAction(action);
    expect(delivered).toMatchObject({
      state: "delivered",
      request: { leaseId: recorded.request.leaseId }
    });
    expect((await harness.runtime?.query(identity))?.status).toBe("in_progress");
    const restartedDatabase = harness.requireServer().database;
    expect(count(restartedDatabase, "remote_execution_attempts")).toBe(1);
    expect(
      restartedDatabase
        .prepare("SELECT COUNT(*) AS count FROM mailbox_messages WHERE message_id=?")
        .get(action.actionId)?.count
    ).toBe(1);
    const attempt = coordination.operations.getRequired(interrupted.id).attempt;
    expect(attempt.leaseId).toBe(reserved.attempt.leaseId);
    expect(Date.parse(attempt.leaseExpiresAt ?? "")).toBeGreaterThan(Date.now() + 61_000);
  });

  it("applies the same recorded human resume after its Host returns past the lease duration", async () => {
    const harness = await CoordinatorHarness.create();
    const { hostId, outcome } = await prepareInterruptedAction(harness, true);
    let coordination = await harness.restart(undefined, (runtime) => ({
      ...runtime,
      query: async () => {
        throw new Error("fixture_runtime_temporarily_unavailable");
      }
    }));
    const interrupted = coordination.operations.getRequired(outcome.operation.id);
    const { capability } = coordination.coordinator.readResume(interrupted);
    if (!capability.available) throw new Error(capability.reason);
    const command = {
      ...capability.target,
      actionId: "recorded-human-resume",
      kind: "resume_same_session",
      reason: "Resume the original ACP session."
    } as const;
    await expect(coordination.coordinator.executeHumanAction(command)).rejects.toThrow(
      "fixture_runtime_temporarily_unavailable"
    );
    const recorded = coordination.actions.getRequired(command.actionId);
    expect(recorded.state).toBe("recorded");
    expect(coordination.operations.getRequired(outcome.operation.id).attempt.leaseId).toBe(
      command.priorLeaseId
    );

    harness.clockOffsetMs = 61_000;
    coordination = await harness.restart();
    coordination.hosts.reportOnline(hostId, ["acp.codex", "acp.session.load"], 1);
    const applied = await coordination.coordinator.executeHumanAction(command);
    const replayed = await coordination.coordinator.executeHumanAction(command);
    expect(replayed).toEqual(applied);
    expect(applied.state).toBe("delivered");
    const database = harness.requireServer().database;
    expect(count(database, "remote_execution_attempts")).toBe(1);
    expect(count(database, "dispatches")).toBe(1);
    expect(count(database, "remote_execution_actions")).toBe(1);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM mailbox_messages WHERE message_id=?")
        .get(command.actionId)?.count
    ).toBe(1);
    const attempt = coordination.operations.getRequired(outcome.operation.id).attempt;
    expect(attempt.leaseId).not.toBe(command.priorLeaseId);
    expect(Date.parse(attempt.leaseExpiresAt ?? "")).toBeGreaterThan(Date.now() + 61_000);
  });

  it.each([
    "before",
    "during"
  ] as const)("rejects an Operator resume whose fixed deadline expires %s Runtime preparation after restart", async (when) => {
    const harness = await CoordinatorHarness.create(true);
    const { hostId, outcome, dispatch } = await prepareInterruptedAction(harness, true);
    let coordination = harness.requireCoordination();
    const identity = { ref: outcome.operation.blockRef, operationId: outcome.operation.id };
    const runtimeBefore = await harness.requireRuntime().query(identity);
    const dispatchBefore = coordination.dispatches.getRequired(dispatch.id);
    const leaseBefore = coordination.reservations.getRequired(dispatch.leaseId);
    const later = await coordination.coordinator.dispatch(
      harness.request("T-002#B-001", "after-expired-resume")
    );
    const nextAction = cancelAction(later.operation, "z-later-cancel");
    const host = coordination.hosts.getRequired(hostId);
    coordination = await harness.restart(undefined, (runtime) => ({
      ...runtime,
      query: async () => {
        throw new CanvasRuntimeUnavailableError("host_offline");
      }
    }));
    const interrupted = coordination.operations.getRequired(outcome.operation.id);
    const request = {
      actionId: "operator-resume-expires-before-reservation",
      operationId: interrupted.id,
      dispatchId: interrupted.dispatchId,
      executionAttemptId: interrupted.executionAttemptId,
      expectedAttemptVersion: interrupted.attempt.stateVersion,
      kind: "resume_same_session",
      priorLeaseId: interrupted.attempt.leaseId,
      leaseId: "lease-operator-resume-expires",
      leaseExpiresAt: new Date(Date.now() + 10_000).toISOString(),
      recovery: { acpSessionId: "session-action-crash", recoveryId: "recovery-action-crash" },
      reason: "Resume before the fixed deadline."
    } as const;
    await expect(coordination.coordinator.executeAction(request)).rejects.toThrow(
      CanvasRuntimeUnavailableError
    );
    expect(coordination.actions.getRequired(request.actionId)).toMatchObject({
      state: "recorded",
      request
    });
    expect(coordination.operations.getRequired(interrupted.id).attempt).toEqual(
      interrupted.attempt
    );
    coordination.actions.record(nextAction);

    if (when === "before") harness.clockOffsetMs = 30_000;
    coordination = await harness.restart(undefined, (runtime) => ({
      ...runtime,
      query: async (input) => {
        const binding = await runtime.query(input);
        if (when === "during") harness.clockOffsetMs = 30_000;
        return binding;
      }
    }));
    coordination.hosts.reportOnline(
      hostId,
      host.capabilities,
      host.capacity,
      host.readinessObservation
    );
    await coordination.reconcile({
      serverInstanceOwnerToken: harness.requireServer().serverInstanceOwnerToken
    });

    expect(coordination.actions.getRequired(request.actionId)).toMatchObject({
      state: "rejected",
      rejectionCode: "remote_resume_attempt_conflict",
      request
    });
    await expect(coordination.coordinator.executeAction(request)).rejects.toMatchObject({
      code: "remote_resume_attempt_conflict"
    });
    expect(coordination.operations.getRequired(interrupted.id).attempt).toEqual(
      interrupted.attempt
    );
    expect(runtimeBefore).toMatchObject({ status: "diverged", interruption: { resumable: true } });
    expect(await harness.requireRuntime().query(identity)).toEqual(runtimeBefore);
    expect(coordination.dispatches.getRequired(dispatch.id)).toEqual(dispatchBefore);
    expect(coordination.reservations.getRequired(dispatch.leaseId)).toEqual(leaseBefore);
    expect(coordination.reservations.get(request.leaseId)).toBeUndefined();
    expect(mailboxContains(harness, request.actionId)).toBe(false);
    expect(coordination.actions.getRequired(nextAction.actionId).state).toBe("delivered");
    expect(mailboxContains(harness, nextAction.actionId)).toBe(true);
  });

  it.each([
    "saved plan",
    "row only"
  ] as const)("rejects a stale persisted cancel with %s after resume compensation and reconciles a later cancel", async (legacyState) => {
    const harness = await CoordinatorHarness.create(true);
    const { hostId, outcome, endpoint } = await prepareInterruptedV3Action(harness, true);
    let coordination = harness.requireCoordination();
    const host = coordination.hosts.getRequired(hostId);
    coordination.hosts.reportOnline(hostId, host.capabilities, 2, host.readinessObservation);
    const later = await coordination.coordinator.dispatch(
      harness.request("T-002#B-001", "after-stale-cancel")
    );
    const nextAction = cancelAction(later.operation, "z-later-cancel");
    const staleActionId = "v82-recorded-cancel";
    let staleCancel: ReturnType<typeof cancelAction> | undefined;
    coordination = await harness.restart(undefined, (runtime) => ({
      ...runtime,
      resumeAttempt: async (input) => {
        const binding = await runtime.resumeAttempt(input);
        const current = coordination.operations.getRequired(outcome.operation.id);
        const newCancel = cancelAction(current, "operator-cancel-during-resume");
        await expect(coordination.coordinator.executeAction(newCancel)).rejects.toThrow(
          "remote_cancel_resume_pending"
        );
        expect(coordination.actions.get(newCancel.actionId)).toBeUndefined();
        staleCancel = cancelAction(current, staleActionId);
        coordination.actions.record(staleCancel);
        if (legacyState === "saved plan") {
          const token = harness.requireServer().serverInstanceOwnerToken;
          coordination.actions.claimApplication(staleActionId, token);
          coordination.actions.recordApplicationPlan(staleActionId, token, {
            transition: "cancel",
            sendsCommand: true
          });
          coordination.actions.releaseApplicationPreservingPlan(staleActionId, token);
        }
        coordination.remoteAgents.revokeAgent(endpoint.endpointId);
        return binding;
      }
    }));
    const interrupted = coordination.operations.getRequired(outcome.operation.id);
    const { capability } = coordination.coordinator.readResume(interrupted);
    if (!capability.available) throw new Error(capability.reason);
    const resume = {
      ...capability.target,
      actionId: "resume-before-cancel-compensation",
      kind: "resume_same_session",
      reason: "Resume the interrupted session."
    } as const;
    const identity = { ref: interrupted.blockRef, operationId: interrupted.id };
    const runtimeBefore = await harness.requireRuntime().query(identity);
    await expect(coordination.coordinator.executeHumanAction(resume)).rejects.toThrow(
      RemoteAgentAuthorizationError
    );
    if (!staleCancel?.leaseId) throw new Error("expected_recorded_cancel");
    expect(coordination.actions.getRequired(staleActionId).state).toBe("recorded");
    expect(coordination.actions.getRequired(resume.actionId).state).toBe("rejected");
    coordination.actions.record(nextAction);

    coordination = await harness.restart();
    await coordination.reconcile({
      serverInstanceOwnerToken: harness.requireServer().serverInstanceOwnerToken
    });

    expect(coordination.actions.getRequired(staleActionId)).toMatchObject({
      state: "rejected",
      rejectionCode: "remote_resume_attempt_conflict",
      request: staleCancel
    });
    await expect(coordination.coordinator.executeHumanAction(staleCancel)).rejects.toMatchObject({
      code: "remote_resume_attempt_conflict"
    });
    expect(coordination.operations.getRequired(interrupted.id).attempt).toMatchObject({
      status: "interrupted",
      leaseId: resume.priorLeaseId
    });
    expect(coordination.reservations.getRequired(staleCancel.leaseId).status).toBe("expired");
    expect(await harness.requireRuntime().query(identity)).toEqual(runtimeBefore);
    expect(mailboxContains(harness, resume.actionId)).toBe(false);
    expect(mailboxContains(harness, staleActionId)).toBe(false);
    expect(coordination.actions.getRequired(nextAction.actionId).state).toBe("delivered");
    expect(mailboxContains(harness, nextAction.actionId)).toBe(true);
  });

  it("does not issue a resume lease or command when Agent access is revoked during Runtime preparation", async () => {
    const harness = await CoordinatorHarness.create();
    const { outcome, endpoint } = await prepareInterruptedV3Action(harness, true);
    const coordination = await harness.restart(undefined, (runtime) => ({
      ...runtime,
      query: async (input) => {
        const binding = await runtime.query(input);
        harness.requireCoordination().remoteAgents.revokeAgent(endpoint.endpointId);
        return binding;
      }
    }));
    const interrupted = coordination.operations.getRequired(outcome.operation.id);
    const { capability } = coordination.coordinator.readResume(interrupted);
    if (!capability.available) throw new Error(capability.reason);
    const command = {
      ...capability.target,
      actionId: "resume-access-revoked",
      kind: "resume_same_session",
      reason: "Resume the original ACP session."
    } as const;

    const identity = { ref: interrupted.blockRef, operationId: interrupted.id };
    await expect(coordination.coordinator.executeHumanAction(command)).rejects.toThrow(
      RemoteAgentAuthorizationError
    );
    expect(coordination.operations.getRequired(interrupted.id).attempt).toEqual(
      interrupted.attempt
    );
    const database = harness.requireServer().database;
    expect(count(database, "host_capacity_reservations")).toBe(1);
    expect(
      database.prepare("SELECT 1 FROM mailbox_messages WHERE message_id=?").get(command.actionId)
    ).toBeUndefined();
    expect(await harness.runtime?.query(identity)).toMatchObject({
      status: "diverged",
      interruption: { resumable: true }
    });
  });

  it("restores the original interruption when the Agent is revoked after the Runtime write", async () => {
    const harness = await CoordinatorHarness.create();
    const { outcome, endpoint } = await prepareInterruptedV3Action(harness, true);
    const coordination = await harness.restart(undefined, (runtime) => ({
      ...runtime,
      resumeAttempt: async (input) => {
        const binding = await runtime.resumeAttempt(input);
        harness.requireCoordination().remoteAgents.revokeAgent(endpoint.endpointId);
        return binding;
      }
    }));
    const interrupted = coordination.operations.getRequired(outcome.operation.id);
    const { capability } = coordination.coordinator.readResume(interrupted);
    if (!capability.available) throw new Error(capability.reason);
    const command = {
      ...capability.target,
      actionId: "resume-revoked-after-runtime-write",
      kind: "resume_same_session",
      reason: "Resume the original ACP session."
    } as const;
    const identity = { ref: interrupted.blockRef, operationId: interrupted.id };
    const prior = await harness.runtime?.query(identity);
    await expect(coordination.coordinator.executeHumanAction(command)).rejects.toThrow(
      RemoteAgentAuthorizationError
    );

    const database = harness.requireServer().database;
    expect(
      database.prepare("SELECT 1 FROM mailbox_messages WHERE message_id=?").get(command.actionId)
    ).toBeUndefined();
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM host_capacity_reservations WHERE status='active'")
        .get()?.count
    ).toBe(0);
    expect(coordination.operations.getRequired(interrupted.id).attempt).toMatchObject({
      status: "interrupted",
      leaseId: command.priorLeaseId
    });
    expect(await harness.runtime?.query(identity)).toEqual(prior);
    expect(coordination.actions.getRequired(command.actionId)).toMatchObject({
      state: "rejected",
      rejectionCode: "remote_resume_authorization_changed"
    });
  });

  it.each([
    "live",
    "after restart"
  ] as const)("rejects a recorded resume %s after a competing block wins and reconciles subsequent actions", async (when) => {
    const harness = await CoordinatorHarness.create();
    const { outcome } = await prepareInterruptedV3Action(harness, true);
    let compete = true;
    let coordination = await harness.restart(undefined, (runtime) => ({
      ...runtime,
      query: async (input) => {
        const binding = await runtime.query(input);
        if (compete) {
          compete = false;
          const current = coordination.operations.getRequired(outcome.operation.id);
          await coordination.coordinator.executeAction({
            actionId: "winning-block",
            kind: "block",
            operationId: current.id,
            dispatchId: current.dispatchId,
            executionAttemptId: current.executionAttemptId,
            expectedAttemptVersion: current.attempt.stateVersion,
            leaseId: current.attempt.leaseId,
            reason: "Block the interrupted attempt during resume validation."
          });
          if (when === "after restart") throw new CanvasRuntimeUnavailableError("host_offline");
        }
        return binding;
      }
    }));
    const interrupted = coordination.operations.getRequired(outcome.operation.id);
    const { capability } = coordination.coordinator.readResume(interrupted);
    if (!capability.available) throw new Error(capability.reason);
    const command = {
      ...capability.target,
      actionId: "stale-resume",
      kind: "resume_same_session",
      reason: "Resume the original ACP session."
    } as const;

    await expect(coordination.coordinator.executeHumanAction(command)).rejects.toThrow(
      when === "live" ? "remote_resume_attempt_conflict" : CanvasRuntimeUnavailableError
    );
    expect(coordination.operations.getRequired(interrupted.id).attempt.status).toBe(
      "action_required"
    );
    expect(coordination.actions.getRequired(command.actionId).state).toBe(
      when === "live" ? "rejected" : "recorded"
    );
    expect(
      await harness.runtime?.query({ ref: interrupted.blockRef, operationId: interrupted.id })
    ).toMatchObject({ status: "diverged", interruption: { resumable: true } });
    const later = {
      actionId: "pending-fail",
      kind: "fail",
      operationId: interrupted.id,
      dispatchId: interrupted.dispatchId,
      executionAttemptId: interrupted.executionAttemptId,
      expectedAttemptVersion: interrupted.attempt.stateVersion + 1,
      leaseId: interrupted.attempt.leaseId,
      reason: "Finish the interrupted attempt.",
      failure: { code: "operator_failed", message: "Stopped manually.", retryable: false }
    };
    coordination.actions.record(later);
    coordination = await harness.restart();
    await coordination.reconcile({
      serverInstanceOwnerToken: harness.requireServer().serverInstanceOwnerToken
    });
    expect(coordination.actions.getRequired(command.actionId)).toMatchObject({
      state: "rejected",
      rejectionCode: "remote_resume_attempt_conflict"
    });
    expect(coordination.actions.getRequired(later.actionId).state).toBe("settled");
    const database = harness.requireServer().database;
    expect(count(database, "host_capacity_reservations")).toBe(1);
    expect(
      database.prepare("SELECT 1 FROM mailbox_messages WHERE message_id=?").get(command.actionId)
    ).toBeUndefined();
  });

  it("fails closed when retrying a legacy operation without agent access snapshot", async () => {
    const harness = await CoordinatorHarness.create();
    const prepared = await prepareInterruptedAction(harness, false);
    const coordination = harness.requireCoordination();
    const interrupted = coordination.operations.getRequired(prepared.outcome.operation.id);
    await expect(
      coordination.coordinator.executeAction({
        actionId: "retry-action-1",
        operationId: interrupted.id,
        dispatchId: interrupted.dispatchId,
        executionAttemptId: interrupted.executionAttemptId,
        expectedAttemptVersion: interrupted.attempt.stateVersion,
        kind: "retry_new_attempt",
        priorLeaseId: prepared.dispatch.leaseId,
        newDispatchId: "dispatch-retry-action-2",
        newExecutionAttemptId: "attempt-retry-action-2",
        reason: "retry with a fresh attempt"
      })
    ).rejects.toThrow(new RemoteAgentAuthorizationError("remote_agent_access_snapshot_missing"));
  });

  it("recovers a v3 retry after after_action_side_effect when the Endpoint identity is unchanged", async () => {
    const harness = await CoordinatorHarness.create();
    const prepared = await prepareInterruptedV3Action(harness);
    let coordination = await harness.restart(new CrashOnce("after_action_side_effect"));
    const interrupted = coordination.operations.getRequired(prepared.outcome.operation.id);
    const request = {
      actionId: "v3-retry-action-crash-success",
      operationId: interrupted.id,
      dispatchId: interrupted.dispatchId,
      executionAttemptId: interrupted.executionAttemptId,
      expectedAttemptVersion: interrupted.attempt.stateVersion,
      kind: "retry_new_attempt",
      priorLeaseId: prepared.dispatch.leaseId,
      newDispatchId: "dispatch-v3-retry-crash-success-2",
      newExecutionAttemptId: "attempt-v3-retry-crash-success-2",
      reason: "retry v3 after side effect with unchanged endpoint"
    } as const;
    await expect(coordination.coordinator.executeAction(request)).rejects.toThrowError(
      "injected_crash:after_action_side_effect"
    );
    const snapshotAfterSideEffect = harness
      .requireServer()
      .database.prepare("SELECT agent_access_json FROM remote_operations WHERE id=?")
      .get(interrupted.id) as { agent_access_json: string | null };
    expect(snapshotAfterSideEffect.agent_access_json).toEqual(expect.any(String));

    coordination.hosts.reportOnline(
      prepared.hostId,
      ["acp.codex", WORKSPACE_CANVAS_EXECUTION_CAPABILITY],
      1,
      {
        workspaceMappings: [{ workspaceId: harness.locator.workspaceId, status: "ready" }],
        acpProfiles: [
          {
            profileId: "codex-acp",
            agentId: "codex",
            displayName: "Test Agent",
            status: "ready",
            capabilities: ["acp.codex"]
          }
        ]
      }
    );
    coordination = await harness.restart();
    await coordination.reconcile({
      serverInstanceOwnerToken: harness.requireServer().serverInstanceOwnerToken
    });
    expect(coordination.actions.getRequired(request.actionId).state).toBe("settled");
    expect(coordination.operations.getRequired(interrupted.id)).toMatchObject({
      dispatchId: request.newDispatchId,
      executionAttemptId: request.newExecutionAttemptId,
      endpointSelection: interrupted.endpointSelection
    });
    const database = harness.requireServer().database;
    const snapshotAfterRecover = database
      .prepare("SELECT agent_access_json FROM remote_operations WHERE id=?")
      .get(interrupted.id) as { agent_access_json: string | null };
    expect(snapshotAfterRecover.agent_access_json).toBe(snapshotAfterSideEffect.agent_access_json);
    expect(snapshotAfterRecover.agent_access_json).toEqual(expect.any(String));
    expect(JSON.parse(snapshotAfterRecover.agent_access_json as string)).toMatchObject({
      callerHumanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID,
      authorized: {
        agentAccessAuthority: {
          kind: "agent_owner",
          ownerHumanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID
        }
      }
    });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM remote_execution_attempts WHERE operation_id=?")
        .get(interrupted.id)
    ).toEqual({ count: 2 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM dispatches WHERE id=?")
        .get(request.newDispatchId)
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM mailbox_messages WHERE json_extract(command_json, '$.dispatchId')=?"
        )
        .get(request.newDispatchId)
    ).toEqual({ count: 1 });
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

    coordination.hosts.reportOnline(
      prepared.hostId,
      ["acp.codex", WORKSPACE_CANVAS_EXECUTION_CAPABILITY],
      1,
      {
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
      }
    );
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

    const crashedDatabase = harness.requireServer().database;
    if (checkpoint === "before_operation_commit") {
      expect(harness.runtimeAcquireCount).toBe(0);
      expect(harness.runtimeInspectCount).toBe(0);
      expect(harness.materializeCount).toBe(0);
      expect(count(crashedDatabase, "remote_operations")).toBe(0);
      expect(count(crashedDatabase, "dispatches")).toBe(0);
      expect(count(crashedDatabase, "mailbox_messages")).toBe(0);
      expect(count(crashedDatabase, "host_capacity_reservations")).toBe(0);
      expect(count(crashedDatabase, "canvas_runtime_operation_attachments")).toBe(0);
    }
    if (checkpoint === "after_host_reservation" || checkpoint === "after_runtime_attachment") {
      expect(count(crashedDatabase, "host_capacity_reservations")).toBe(1);
      expect(count(crashedDatabase, "dispatches")).toBe(0);
      expect(count(crashedDatabase, "mailbox_messages")).toBe(0);
      expect(
        crashedDatabase
          .prepare(
            `SELECT COUNT(*) AS count FROM remote_operation_events
             WHERE type='remote.operation.claimed'`
          )
          .get()?.count
      ).toBe(0);
      expect(count(crashedDatabase, "canvas_runtime_operation_attachments")).toBe(
        checkpoint === "after_runtime_attachment" ? 1 : 0
      );
      expect(count(crashedDatabase, "canvas_runtime_host_bindings")).toBe(0);
    }

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

  it("commits a Runtime package snapshot source revision", async () => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost();
    const request = harness.request("T-001#B-001", "snapshot-source-revision");

    expect(request.contentRevision).toMatch(/^snapshot:[a-f0-9]{64}$/);
    await expect(
      harness.requireCoordination().coordinator.dispatch(request)
    ).resolves.toMatchObject({
      status: "activated",
      operation: { state: "activated", ownershipGeneration: request.contentRevision }
    });
    expect(count(harness.requireServer().database, "remote_operations")).toBe(1);
  });

  it("rejects authority mismatch before Host acquire or inspect", async () => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost();
    new AuthorityRepository(harness.requireServer().database).applyExecutionTarget({
      mutation: {
        schemaVersion: "execution-target/v1",
        scope: {
          kind: "block",
          ...harness.locator,
          blockRef: "T-001#B-001"
        },
        target: { kind: "unassigned" },
        expectedRevision: 0
      },
      actor: { kind: "system", id: "authority-mismatch-test" }
    });

    await expect(
      harness.requireCoordination().coordinator.dispatch(harness.request())
    ).rejects.toMatchObject({ code: "work_revision_conflict" });
    expect(harness.runtimeAcquireCount).toBe(0);
    expect(harness.runtimeInspectCount).toBe(0);
    expect(harness.materializeCount).toBe(0);
    const database = harness.requireServer().database;
    expect(count(database, "remote_operations")).toBe(0);
    expect(count(database, "dispatches")).toBe(0);
    expect(count(database, "mailbox_messages")).toBe(0);
    expect(count(database, "canvas_runtime_operation_attachments")).toBe(0);
  });

  it("rejects a content-head race from Server authority before Host access", async () => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost();
    let advanced = false;
    const advanceAuthoritativeContentHead = await harness.prepareAuthoritativeContentHeadAdvance();
    await harness.restart({
      reached(checkpoint) {
        if (checkpoint === "before_operation_commit" && !advanced) {
          advanced = true;
          advanceAuthoritativeContentHead();
        }
      }
    });
    const request = harness.request("T-001#B-001", "content-head-race");

    await expect(harness.requireCoordination().coordinator.dispatch(request)).rejects.toThrow(
      "canvas_content_revision_conflict"
    );
    expect(advanced).toBe(true);
    expect(harness.runtimeAcquireCount).toBe(0);
    expect(harness.runtimeInspectCount).toBe(0);
    expect(harness.materializeCount).toBe(0);
    const database = harness.requireServer().database;
    expect(count(database, "remote_operations")).toBe(0);
    expect(count(database, "dispatches")).toBe(0);
    expect(count(database, "mailbox_messages")).toBe(0);
    expect(count(database, "canvas_runtime_operation_attachments")).toBe(0);
  });

  it("fails closed when a persisted legacy endpoint selection reenters current dispatch", async () => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost();
    await harness.restart(new CrashOnce("after_operation_commit"));
    const request = harness.request("T-001#B-001", "legacy-endpoint-recovery");
    await expect(harness.requireCoordination().coordinator.dispatch(request)).rejects.toThrow(
      "injected_crash:after_operation_commit"
    );
    const database = harness.requireServer().database;
    const operation = database
      .prepare("SELECT id,endpoint_selection_json FROM remote_operations WHERE idempotency_key=?")
      .get(request.idempotencyKey) as { id: string; endpoint_selection_json: string };
    const selection = JSON.parse(operation.endpoint_selection_json) as {
      authority: { responsibilityRevision: number; reviewerRevision: number };
    };
    database.prepare("UPDATE remote_operations SET endpoint_selection_json=? WHERE id=?").run(
      JSON.stringify({
        ...selection,
        authority: {
          schemaVersion: "endpoint-authority/v1",
          controlPlane: "collaboration",
          responsibilityRevision: selection.authority.responsibilityRevision,
          reviewerRevision: selection.authority.reviewerRevision
        }
      }),
      operation.id
    );

    await harness.restart();
    await expect(harness.requireCoordination().coordinator.dispatch(request)).rejects.toThrow(
      "remote_operation_row_invalid"
    );
    expect(harness.runtimeAcquireCount).toBe(0);
    expect(harness.runtimeInspectCount).toBe(0);
    expect(count(harness.requireServer().database, "remote_operations")).toBe(1);
    expect(count(harness.requireServer().database, "dispatches")).toBe(0);
  });

  it("fails closed when the Server content head advances after attachment", async () => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost();
    await harness.restart(new CrashOnce("after_runtime_attachment"));
    await expect(
      harness.requireCoordination().coordinator.dispatch(harness.request())
    ).rejects.toThrowError("injected_crash:after_runtime_attachment");

    harness.advanceContentRevision();
    const coordination = await harness.restart();
    await expect(coordination.coordinator.dispatch(harness.request())).rejects.toThrowError(
      "runtime_attachment_content_target_changed"
    );
    const database = harness.requireServer().database;
    expect(count(database, "canvas_runtime_operation_attachments")).toBe(1);
    expect(count(database, "dispatches")).toBe(0);
    expect(count(database, "mailbox_messages")).toBe(0);
    expect(
      database
        .prepare(`SELECT status,COUNT(*) AS count FROM host_capacity_reservations GROUP BY status`)
        .all()
    ).toEqual([{ status: "expired", count: 1 }]);

    const interrupted = coordination.operations.findByCallerIdentity(harness.request())!;
    const priorAttemptId = interrupted.executionAttemptId;
    const priorLeaseId = interrupted.attempt.leaseId!;
    await expect(
      coordination.coordinator.executeAction({
        actionId: "retry-after-content-target-fence",
        operationId: interrupted.id,
        dispatchId: interrupted.dispatchId,
        executionAttemptId: interrupted.executionAttemptId,
        expectedAttemptVersion: interrupted.attempt.stateVersion,
        kind: "retry_new_attempt",
        priorLeaseId,
        newDispatchId: "dispatch-after-content-target-fence",
        newExecutionAttemptId: "attempt-after-content-target-fence",
        reason: "retry against the new Server content head"
      })
    ).resolves.toMatchObject({ state: "settled" });
    const retried = coordination.operations.getRequired(interrupted.id);
    expect(retried).toMatchObject({
      dispatchId: "dispatch-after-content-target-fence",
      executionAttemptId: "attempt-after-content-target-fence",
      state: "activated",
      attempt: { hostId: interrupted.attempt.hostId }
    });
    expect(count(database, "remote_execution_attempts")).toBe(2);
    expect(count(database, "canvas_runtime_operation_attachments")).toBe(2);
    expect(count(database, "dispatches")).toBe(1);
    expect(count(database, "mailbox_messages")).toBe(1);
    expect(
      database
        .prepare(
          `SELECT execution_attempt_id,reservation_lease_id,content_revision
           FROM canvas_runtime_operation_attachments
           WHERE operation_id=? ORDER BY content_revision`
        )
        .all(interrupted.id)
    ).toEqual([
      {
        execution_attempt_id: priorAttemptId,
        reservation_lease_id: priorLeaseId,
        content_revision: 1
      },
      {
        execution_attempt_id: "attempt-after-content-target-fence",
        reservation_lease_id: retried.attempt.leaseId,
        content_revision: 2
      }
    ]);
  });

  it("preserves the exact reservation when an unknown content target port failure occurs", async () => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost();
    await harness.restart(new CrashOnce("after_runtime_attachment"));
    await expect(
      harness.requireCoordination().coordinator.dispatch(harness.request())
    ).rejects.toThrowError("injected_crash:after_runtime_attachment");
    const beforeFailure = harness
      .requireCoordination()
      .operations.findByCallerIdentity(harness.request())!;
    const leaseId = beforeFailure.attempt.leaseId!;

    harness.failContentTargetReads(new Error("unknown_content_target_port_failure"));
    let coordination = await harness.restart();
    await expect(coordination.coordinator.dispatch(harness.request())).rejects.toThrowError(
      "unknown_content_target_port_failure"
    );
    expect(coordination.reservations.getRequired(leaseId).status).toBe("active");
    expect(coordination.operations.getRequired(beforeFailure.id)).toMatchObject({
      executionAttemptId: beforeFailure.executionAttemptId,
      attempt: { leaseId, hostId: beforeFailure.attempt.hostId }
    });
    expect(count(harness.requireServer().database, "dispatches")).toBe(0);
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(0);

    harness.failContentTargetReads();
    coordination = await harness.restart();
    const recovered = await coordination.coordinator.dispatch(harness.request());
    expect(recovered).toMatchObject({
      status: "activated",
      operation: {
        executionAttemptId: beforeFailure.executionAttemptId,
        attempt: { leaseId, hostId: beforeFailure.attempt.hostId }
      }
    });
    const database = harness.requireServer().database;
    expect(count(database, "host_capacity_reservations")).toBe(1);
    expect(count(database, "canvas_runtime_operation_attachments")).toBe(1);
    expect(count(database, "dispatches")).toBe(1);
    expect(count(database, "mailbox_messages")).toBe(1);
  });

  it("rejects non-retry and non-cancel actions for fenced preparation without partial mutation", async () => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost();
    await harness.restart(new CrashOnce("after_runtime_attachment"));
    await expect(
      harness.requireCoordination().coordinator.dispatch(harness.request())
    ).rejects.toThrowError("injected_crash:after_runtime_attachment");
    harness.advanceContentRevision();
    const coordination = await harness.restart();
    await expect(coordination.coordinator.dispatch(harness.request())).rejects.toThrowError(
      "runtime_attachment_content_target_changed"
    );
    const operation = coordination.operations.findByCallerIdentity(harness.request())!;
    const leaseId = operation.attempt.leaseId!;
    const identity = {
      operationId: operation.id,
      dispatchId: operation.dispatchId,
      executionAttemptId: operation.executionAttemptId,
      expectedAttemptVersion: operation.attempt.stateVersion
    };
    const actions = [
      {
        ...identity,
        actionId: "preparation-block-rejected",
        kind: "block",
        leaseId,
        reason: "block must not apply during preparation"
      },
      {
        ...identity,
        actionId: "preparation-fail-rejected",
        kind: "fail",
        leaseId,
        failure: { code: "manual_failure", message: "Stopped.", retryable: false },
        reason: "fail must not apply during preparation"
      },
      {
        ...identity,
        actionId: "preparation-resume-rejected",
        kind: "resume_same_session",
        priorLeaseId: leaseId,
        leaseId: "lease-preparation-resume-rejected",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        recovery: {
          acpSessionId: "session-preparation-rejected",
          recoveryId: "recovery-preparation-rejected"
        },
        reason: "resume must not apply during preparation"
      }
    ] as const;

    for (const action of actions) {
      await expect(coordination.coordinator.executeAction(action)).rejects.toThrowError(
        "remote_preparation_action_requires_retry"
      );
    }

    expect(coordination.operations.getRequired(operation.id)).toEqual(operation);
    expect(coordination.reservations.getRequired(leaseId).status).toBe("expired");
    expect(count(harness.requireServer().database, "dispatches")).toBe(0);
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(0);
    expect(
      harness
        .requireServer()
        .database.prepare(
          `SELECT action_id,state,application_owner_token,application_claimed_at,
                  application_decision_json
           FROM remote_execution_actions ORDER BY action_id`
        )
        .all()
    ).toEqual(
      actions
        .map((action) => ({
          action_id: action.actionId,
          state: action.kind === "resume_same_session" ? "rejected" : "recorded",
          application_owner_token: null,
          application_claimed_at: null,
          application_decision_json: null
        }))
        .sort((left, right) => left.action_id.localeCompare(right.action_id))
    );
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
    const hostId = harness.registerHost();
    const bytes = Buffer.from("# Durable coordinator input\n");
    const artifact = await harness.requireArtifacts().put({
      expectedSha256: createHash("sha256").update(bytes).digest("hex"),
      expectedSizeBytes: bytes.byteLength,
      mediaType: "text/markdown",
      chunks: (async function* () {
        yield bytes;
      })()
    });
    const coordination = harness.requireCoordination();
    const upstream = await coordination.coordinator.dispatch(
      harness.request("T-001#B-001", "input-dependency-upstream")
    );
    const upstreamDispatch = coordination.dispatches.getRequired(upstream.operation.dispatchId);
    coordination.dispatches.accept(
      hostId,
      "input-dependency-upstream-accepted",
      upstreamDispatch.id,
      upstreamDispatch.leaseId,
      upstreamDispatch.executionAttemptId
    );
    const result = {
      summary: "Authoritative upstream implementation result.",
      reportArtifactRef: artifact.ref,
      artifactRefs: []
    };
    const outputGrant = coordination.artifactAuthorization.createOutputGrant({
      operationId: upstream.operation.id,
      workspaceId: upstreamDispatch.workspaceId,
      projectId: upstreamDispatch.projectId,
      hostId,
      dispatchId: upstreamDispatch.id,
      leaseId: upstreamDispatch.leaseId,
      executionAttemptId: upstreamDispatch.executionAttemptId,
      permission: "report_write",
      expectedSha256: artifact.sha256,
      expectedSizeBytes: artifact.sizeBytes,
      expectedMediaType: artifact.mediaType
    });
    coordination.artifactAuthorization.acceptOutputUpload(
      {
        workspaceId: upstreamDispatch.workspaceId,
        projectId: upstreamDispatch.projectId,
        hostId,
        dispatchId: upstreamDispatch.id,
        leaseId: upstreamDispatch.leaseId,
        executionAttemptId: upstreamDispatch.executionAttemptId,
        grantId: outputGrant.grantId
      },
      artifact
    );
    harness
      .requireServer()
      .database.prepare(
        "UPDATE dispatches SET status='awaiting_writeback',result_json=? WHERE id=?"
      )
      .run(JSON.stringify(result), upstreamDispatch.id);
    await coordination.dispatches.complete(
      hostId,
      "input-dependency-upstream-completed",
      upstreamDispatch.id,
      upstreamDispatch.leaseId,
      upstreamDispatch.executionAttemptId,
      result
    );
    expect(coordination.operations.getRequired(upstream.operation.id).state).toBe("completed");

    const materialized = new Set<string>();
    const materialize = async (candidate: RemoteBlockDispatchCandidate) => {
      for (const input of candidate.inputArtifacts) {
        await harness.requireArtifacts().read(input.artifactRef);
        materialized.add(input.artifactRef);
      }
    };
    const downstreamRequest = harness.request("T-001#R-001", "input-dependency-downstream");
    await harness.restart(new CrashOnce("after_dispatch_persistence"), undefined, materialize);
    await expect(
      harness.requireCoordination().coordinator.dispatch(downstreamRequest)
    ).rejects.toThrowError("injected_crash:after_dispatch_persistence");

    const restarted = await harness.restart(undefined, undefined, materialize);
    const recovered = await restarted.coordinator.dispatch(downstreamRequest);
    await expect(Promise.resolve(recovered)).resolves.toMatchObject({
      status: "activated"
    });
    expect(materialized).toEqual(new Set([artifact.ref]));
    const database = harness.requireServer().database;
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM artifact_grants WHERE dispatch_id=? AND permission='input_read'"
        )
        .get(recovered.operation.dispatchId)?.count
    ).toBe(1);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM dispatch_artifact_links WHERE dispatch_id=? AND purpose='input'"
        )
        .get(recovered.operation.dispatchId)?.count
    ).toBe(1);
  });

  it("blocks a restarted legacy operation when its Runtime source has drifted", async () => {
    const harness = await CoordinatorHarness.create();
    const coordination = harness.requireCoordination();
    const hostId = harness.registerHost();
    const candidate = workspaceExecutionCandidate(
      await canonicalRemoteRuntimePort(
        harness.requireRuntime(),
        harness.locator.workspaceId
      ).inspect({ ref: "T-001#B-001" })
    );
    const operation = seedLegacyRemoteOperation({
      database: harness.requireServer().database,
      operations: coordination.operations,
      locator: harness.locator,
      candidate,
      idempotencyKey: "source-drift-before-host",
      endpointSelection: workspaceEndpointSelection({
        agentEndpoints: coordination.agentEndpoints,
        candidate,
        hostId,
        workspaceId: harness.locator.workspaceId,
        database: harness.requireServer().database
      }),
      hostSelection: {
        workspaceId: harness.locator.workspaceId,
        assignmentRevision: 0,
        target: { kind: "automatic_host" },
        selection: "automatic",
        requiredCapabilities: candidate.requiredCapabilities
      }
    });
    harness
      .requireServer()
      .database.prepare("UPDATE agent_hosts SET last_seen_at=? WHERE id=?")
      .run("1970-01-01T00:00:00.000Z", hostId);
    await expect(coordination.coordinator.reenter(operation.id)).rejects.toMatchObject({
      code: "agent_endpoint_unavailable"
    });
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
    expect(harness.requireCoordination().operations.getRequired(operation.id).state).toBe(
      "cancelled"
    );
    expect(count(harness.requireServer().database, "host_capacity_reservations")).toBe(0);
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(0);
  });

  it("rejects foreign Runtime ownership only after durable preparation", async () => {
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
    expect(count(harness.requireServer().database, "remote_operations")).toBe(1);
    expect(count(harness.requireServer().database, "host_capacity_reservations")).toBe(1);
    expect(count(harness.requireServer().database, "canvas_runtime_operation_attachments")).toBe(1);
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

  it("fails waiting-host reentry when the durable Endpoint identity changes", async () => {
    const harness = await CoordinatorHarness.create(true);
    const hostId = harness.registerHost(1);
    const coordination = harness.requireCoordination();
    const outcomes = await Promise.allSettled([
      coordination.coordinator.dispatch(harness.request("T-001#B-001", "waiting-drift-a")),
      coordination.coordinator.dispatch(harness.request("T-002#B-001", "waiting-drift-b"))
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const waiting = coordination.operations
      .listNonTerminal()
      .find(
        (operation) => operation.state === "preparing" && operation.attempt.status === "prepared"
      );
    expect(waiting?.endpointSelection?.hostId).toBe(hostId);

    coordination.hosts.reportOnline(
      hostId,
      ["acp.codex", WORKSPACE_CANVAS_EXECUTION_CAPABILITY],
      1,
      {
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
      }
    );

    await expect(coordination.coordinator.reenterWaitingForHost(hostId)).rejects.toThrow(
      /agent_endpoint_(unknown|incompatible)/
    );
    expect(coordination.operations.getRequired(waiting!.id)).toMatchObject({
      state: "preparing",
      attempt: { status: "prepared" },
      endpointSelection: waiting!.endpointSelection
    });
  });
});
