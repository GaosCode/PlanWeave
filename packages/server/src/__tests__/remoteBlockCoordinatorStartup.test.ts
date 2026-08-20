import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createRemoteBlockArtifactSource,
  createRemoteBlockRuntimePort,
  resetRuntimeState,
  type RemoteBlockRuntimePort
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ArtifactStore } from "../artifacts.js";
import {
  startRemoteBlockCoordinationServer,
  type RemoteBlockCoordinationOptions
} from "../distributedCoordination.js";
import type { PlanweaveServer } from "../lifecycle.js";
import { centralSchemaVersion, latestCentralSchemaVersion } from "../migrations.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import type {
  RemoteCoordinatorCheckpoint,
  RemoteCoordinatorCheckpointPort
} from "../remoteBlockCoordinatorPorts.js";
import { RemoteRuntimePortRegistry } from "../remoteRuntimeLocator.js";
import { WorkAssignmentRepository } from "../work/repository.js";
import type { AssignmentTarget } from "../work/schemas.js";
import { canonicalRemoteRuntimePort } from "../canonicalRemoteRuntimePort.js";
import type { DispatchHostSelectionSnapshot } from "../work/dispatchIntegration.js";
import { endpointDispatchRequest } from "./support/endpointCoordinatorFixture.js";
import { seedLegacyRemoteOperation } from "./support/legacyRemoteOperationSeed.js";

type StartedCoordination = Awaited<ReturnType<typeof startRemoteBlockCoordinationServer>>;
type Coordination = StartedCoordination["coordination"];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

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

class CrashEveryTime implements RemoteCoordinatorCheckpointPort {
  constructor(readonly target: RemoteCoordinatorCheckpoint) {}

  reached(checkpoint: RemoteCoordinatorCheckpoint): void {
    if (checkpoint === this.target) throw new Error(`injected_crash:${checkpoint}`);
  }
}

class StartupHarness {
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

  static async create(options: { includeSecondTask?: boolean } = {}): Promise<StartupHarness> {
    const manifest = basicManifest({
      includeSecondTask: options.includeSecondTask,
      parallel: options.includeSecondTask,
      maxConcurrent: options.includeSecondTask ? 2 : undefined
    });
    manifest.execution.defaultExecutor = "codex-acp";
    manifest.executors = {
      "codex-acp": {
        adapter: "agent",
        agent: "codex",
        runner: { transport: "acp" }
      }
    };
    const workspace = await createTestWorkspace(manifest);
    const dataDirectory = join(workspace.root, "server-data");
    const harness = new StartupHarness(
      workspace,
      dataDirectory,
      join(dataDirectory, "server.sqlite"),
      {
        workspaceId: "workspace-pending-startup",
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
    await harness.start();
    return harness;
  }

  async start(
    checkpoints?: RemoteCoordinatorCheckpointPort,
    decorateRuntime: (runtime: RemoteBlockRuntimePort) => RemoteBlockRuntimePort = (runtime) =>
      runtime
  ): Promise<Coordination> {
    this.close();
    this.runtime = decorateRuntime(
      createRemoteBlockRuntimePort({ projectRoot: this.workspace.root })
    );
    const runtime = this.runtime;
    const registry = new RemoteRuntimePortRegistry();
    const started = await startRemoteBlockCoordinationServer(
      {
        dataDirectory: this.dataDirectory,
        databasePath: this.databasePath,
        busyTimeoutMs: 5_000
      },
      (database): RemoteBlockCoordinationOptions => {
        const workspaceId = new WorkspaceIdentityRepository(
          database
        ).ensureWorkspaceForLegacyProject(this.locator.projectId);
        this.locator.workspaceId = workspaceId;
        registry.bind(
          { ...this.locator, workspaceId },
          runtime,
          createRemoteBlockArtifactSource({ projectRoot: this.workspace.root })
        );
        const access = new ProjectAccessRepository(database);
        const existingProject = access.registry.projectInternal(
          workspaceId,
          this.locator.projectId
        );
        if (existingProject?.projectRoot === null) {
          access.bindProjectPath(workspaceId, this.locator.projectId, this.workspace.root);
        }
        access.registerProjectInternal({
          workspaceId,
          projectId: this.locator.projectId,
          projectRoot: this.workspace.root
        });
        access.registerCanvasInternal({
          workspaceId,
          projectId: this.locator.projectId,
          canvasId: this.locator.canvasId,
          packageDir: this.workspace.init.workspace.packageDir
        });
        this.artifacts = new ArtifactStore(database, this.dataDirectory, 1024 * 1024);
        return {
          leaseDurationMs: 60_000,
          hostOfflineAfterMs: 60_000,
          runtimeLeases: registry,
          inputArtifacts: { materialize: async () => {} },
          artifactContent: { readReport: async (ref) => this.requireArtifacts().read(ref) },
          checkpoints
        };
      }
    );
    this.server = started.server;
    this.coordination = started.coordination;
    return started.coordination;
  }

  close(): void {
    this.server?.close();
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

  requireArtifacts(): ArtifactStore {
    if (!this.artifacts) throw new Error("test_artifacts_not_started");
    return this.artifacts;
  }

  registerHost(): string {
    const host = this.requireCoordination().hosts.register("Startup Reconciliation Host").host;
    const workspaceId = new WorkspaceIdentityRepository(
      this.requireServer().database
    ).ensureWorkspaceForLegacyProject(this.locator.projectId);
    this.requireCoordination().hosts.bindToWorkspace(host.id, workspaceId);
    this.requireCoordination().hosts.reportOnline(host.id, ["acp.codex"], 1, {
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

  request(idempotencyKey: string) {
    const request = endpointDispatchRequest({
      agentEndpoints: this.requireCoordination().agentEndpoints,
      locator: this.locator,
      blockRef: "T-001#B-001",
      idempotencyKey,
      agentEndpointId: this.agentEndpointId
    });
    this.agentEndpointId = request.agentEndpointId;
    return request;
  }

  async seedLegacy(
    blockRef: string,
    idempotencyKey: string,
    hostSelection?: DispatchHostSelectionSnapshot
  ) {
    if (!this.runtime) throw new Error("test_runtime_not_started");
    const candidate = await canonicalRemoteRuntimePort(
      this.runtime,
      this.locator.workspaceId
    ).inspect({ ref: blockRef });
    return seedLegacyRemoteOperation({
      database: this.requireServer().database,
      operations: this.requireCoordination().operations,
      locator: this.locator,
      candidate,
      idempotencyKey,
      ...(hostSelection === undefined ? {} : { hostSelection })
    });
  }

  assign(blockRef: string, target: AssignmentTarget, expectedRevision = 0): void {
    new WorkAssignmentRepository(this.requireServer().database).applyCasUpdate({
      expectedRevision,
      record: {
        workspaceId: this.locator.workspaceId,
        projectId: this.locator.projectId,
        workItem: { kind: "block", canvasId: this.locator.canvasId, blockRef },
        target,
        revision: expectedRevision + 1,
        updatedBy: { kind: "system", id: "startup-test" },
        updatedAt: "2030-01-01T00:00:00.000Z"
      }
    });
  }

  restoreV17Schema(): void {
    const database = this.requireServer().database;
    database.exec(`
      DROP TABLE human_observer_events;
      DROP TABLE activity_projection_outbox;
      DROP TABLE activity_records;
      DROP TABLE comments;
      DROP TABLE comment_attachment_bindings;
      DROP TABLE comment_pending_uploads;
      DROP TABLE comment_attachment_blobs;
      DROP TABLE work_assignments_unscoped_legacy;
      DROP TABLE human_observer_events_unscoped_legacy;
      DROP TABLE comment_pending_uploads_unscoped_legacy;
      DROP TABLE comment_attachment_bindings_unscoped_legacy;
      DROP TABLE remote_operations_unscoped_legacy;
      DROP TABLE dispatches_unscoped_legacy;
      DROP TABLE server_exposure_leases;
      DELETE FROM project_access_grants;
      DELETE FROM canvas_registry;
      DELETE FROM project_registry;
      DELETE FROM acl_registry_migrations;
      DELETE FROM execution_target_records;
      DELETE FROM responsibility_records;
      DELETE FROM review_assignment_records;
      DELETE FROM assignment_authority_migrations;
      ALTER TABLE dispatches ADD COLUMN package_ref TEXT NOT NULL DEFAULT '';
      ALTER TABLE remote_operations DROP COLUMN endpoint_selection_json;
      ALTER TABLE remote_operations DROP COLUMN host_selection_json;
      DELETE FROM schema_migrations WHERE version >= 18;
    `);
    expect(centralSchemaVersion(database)).toBe(17);
    expect(
      database
        .prepare(
          "SELECT 1 AS present FROM pragma_table_info('remote_operations') WHERE name='host_selection_json'"
        )
        .get()
    ).toBeUndefined();
  }
}

function eventCount(database: PlanweaveServer["database"], table: string, type: string): number {
  return Number(
    database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE type=?`).get(type)?.count ?? 0
  );
}

describe("RemoteBlockCoordinator startup reconciliation", () => {
  it("cancels a pre-dispatch claim after Runtime reset and continues startup", async () => {
    const harness = await StartupHarness.create();
    await harness.start(new CrashOnce("after_envelope_persistence"));
    harness.registerHost();
    const coordination = harness.requireCoordination();

    await expect(
      coordination.coordinator.dispatch(harness.request("runtime-reset-before-dispatch"))
    ).rejects.toThrowError("injected_crash:after_envelope_persistence");
    const claimed = coordination.operations.findByCallerIdentity({
      ...harness.locator,
      blockRef: "T-001#B-001",
      idempotencyKey: "runtime-reset-before-dispatch"
    });
    expect(claimed).toMatchObject({
      state: "claimed",
      attempt: { status: "prepared", hostId: undefined, leaseId: undefined }
    });
    expect(
      harness
        .requireServer()
        .database.prepare("SELECT COUNT(*) AS count FROM dispatches WHERE id=?")
        .get(claimed!.dispatchId)?.count
    ).toBe(0);

    await resetRuntimeState({ projectRoot: harness.workspace.root, force: true });

    const restarted = await harness.start();
    expect(restarted.operations.getRequired(claimed!.id)).toMatchObject({
      state: "cancelled",
      attempt: { status: "cancelled" }
    });
    expect(
      harness
        .requireServer()
        .database.prepare(
          "SELECT diagnostic_code,diagnostic_message FROM remote_operations WHERE id=?"
        )
        .get(claimed!.id)
    ).toEqual({
      diagnostic_code: "runtime_binding_reset",
      diagnostic_message: "Runtime reset removed remote ownership before Host dispatch."
    });
    expect(restarted.operations.listNonTerminal()).toEqual([]);
    expect(
      eventCount(
        harness.requireServer().database,
        "remote_operation_events",
        "remote.attempt.cancelled"
      )
    ).toBe(1);
  });

  it("does not replay a rejected retry and still reconciles other pending work", async () => {
    const harness = await StartupHarness.create({ includeSecondTask: true });
    const coordination = harness.requireCoordination();
    const legalOperation = await harness.seedLegacy(
      "T-002#B-001",
      "pending-beside-rejected-retry",
      {
        workspaceId: harness.locator.workspaceId,
        assignmentRevision: 0,
        target: { kind: "automatic_host" },
        selection: "automatic",
        requiredCapabilities: ["acp.codex"]
      }
    );
    const legalPending = await coordination.coordinator.reenter(legalOperation.id);
    expect(legalPending.status).toBe("awaiting_host");

    const hostId = harness.registerHost();
    harness.assign("T-001#B-001", { kind: "exact_host", hostId });
    const deniedOperation = await harness.seedLegacy(
      "T-001#B-001",
      "retry-rejected-before-startup",
      {
        workspaceId: harness.locator.workspaceId,
        assignmentRevision: 1,
        target: { kind: "exact_host", hostId },
        selection: "exact",
        preferredHostId: hostId,
        requiredCapabilities: ["acp.codex"]
      }
    );
    const denied = await coordination.coordinator.reenter(deniedOperation.id);
    const dispatch = coordination.dispatches.getRequired(denied.operation.dispatchId);
    coordination.dispatches.accept(
      hostId,
      "retry-rejected-accepted",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    coordination.dispatches.interrupt(hostId, "retry-rejected-interrupted", {
      type: "dispatch.interrupted",
      protocolVersion: 1,
      messageId: "retry-rejected-interrupted",
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
    await coordination.coordinator.reenter(denied.operation.id);

    harness.assign("T-001#B-001", { kind: "unassigned" }, 1);
    const interrupted = coordination.operations.getRequired(denied.operation.id);
    const action = {
      actionId: "retry-rejected-startup-action",
      operationId: interrupted.id,
      dispatchId: interrupted.dispatchId,
      executionAttemptId: interrupted.executionAttemptId,
      expectedAttemptVersion: interrupted.attempt.stateVersion,
      kind: "retry_new_attempt",
      priorLeaseId: dispatch.leaseId,
      newDispatchId: "dispatch-rejected-must-not-replay",
      newExecutionAttemptId: "attempt-rejected-must-not-replay",
      reason: "retry denied before server restart"
    } as const;
    await expect(coordination.coordinator.executeAction(action)).rejects.toMatchObject({
      code: "work_not_agent_assigned"
    });
    expect(coordination.actions.getRequired(action.actionId)).toMatchObject({
      state: "rejected",
      rejectionCode: "work_not_agent_assigned"
    });

    harness.assign("T-001#B-001", { kind: "exact_host", hostId }, 2);
    const restarted = await harness.start();

    expect(restarted.actions.getRequired(action.actionId)).toMatchObject({
      state: "rejected",
      rejectionCode: "work_not_agent_assigned"
    });
    expect(restarted.actions.listUnsettled()).not.toContainEqual(
      expect.objectContaining({ request: expect.objectContaining({ actionId: action.actionId }) })
    );
    expect(restarted.operations.getRequired(denied.operation.id)).toMatchObject({
      dispatchId: interrupted.dispatchId,
      executionAttemptId: interrupted.executionAttemptId
    });
    expect(
      harness
        .requireServer()
        .database.prepare(
          "SELECT COUNT(*) AS count FROM remote_execution_attempts WHERE execution_attempt_id=?"
        )
        .get(action.newExecutionAttemptId)?.count
    ).toBe(0);
    expect(restarted.operations.getRequired(legalPending.operation.id)).toMatchObject({
      state: "activated",
      attempt: { hostId }
    });
  });

  it.each([
    "human",
    "unassigned"
  ] as const)("upgrades a v17 database and denies %s NULL snapshot recovery without blocking legal work", async (deniedTargetKind) => {
    const harness = await StartupHarness.create({ includeSecondTask: true });
    const hostId = harness.registerHost();
    await harness.start(new CrashEveryTime("after_input_materialization"));
    const coordination = harness.requireCoordination();

    const deniedSeed = await harness.seedLegacy("T-001#B-001", `v17-denied-${deniedTargetKind}`);
    const legalSeed = await harness.seedLegacy("T-002#B-001", `v17-legal-${deniedTargetKind}`);
    await expect(coordination.coordinator.reenter(deniedSeed.id)).rejects.toThrowError(
      "injected_crash:after_input_materialization"
    );
    await expect(coordination.coordinator.reenter(legalSeed.id)).rejects.toThrowError(
      "injected_crash:after_input_materialization"
    );

    const denied = coordination.operations.findByCallerIdentity({
      ...harness.locator,
      blockRef: "T-001#B-001",
      idempotencyKey: `v17-denied-${deniedTargetKind}`
    })!;
    const legal = coordination.operations.findByCallerIdentity({
      ...harness.locator,
      blockRef: "T-002#B-001",
      idempotencyKey: `v17-legal-${deniedTargetKind}`
    })!;
    harness.assign(
      denied.blockRef,
      deniedTargetKind === "human"
        ? { kind: "human", humanPrincipalId: "human-startup" }
        : { kind: "unassigned" }
    );
    harness.assign(legal.blockRef, { kind: "exact_host", hostId });
    harness.restoreV17Schema();

    const restarted = await harness.start();
    expect(harness.requireServer().readiness().schemaVersion).toBe(latestCentralSchemaVersion);

    const deniedAfterStartup = restarted.operations.getRequired(denied.id);
    expect(deniedAfterStartup).toMatchObject({
      state: "claimed",
      dispatchId: denied.dispatchId,
      executionAttemptId: denied.executionAttemptId
    });
    expect(deniedAfterStartup.hostSelection).toBeUndefined();
    expect(deniedAfterStartup.attempt.hostId).toBeUndefined();
    expect(deniedAfterStartup.attempt.leaseId).toBeUndefined();
    expect(
      harness
        .requireServer()
        .database.prepare("SELECT host_selection_json FROM remote_operations WHERE id=?")
        .get(denied.id)?.host_selection_json
    ).toBeNull();
    expect(
      harness
        .requireServer()
        .database.prepare(
          "SELECT COUNT(*) AS count FROM host_capacity_reservations WHERE execution_attempt_id=?"
        )
        .get(denied.executionAttemptId)?.count
    ).toBe(0);
    expect(
      harness
        .requireServer()
        .database.prepare("SELECT COUNT(*) AS count FROM dispatches WHERE id=?")
        .get(denied.dispatchId)?.count
    ).toBe(0);
    expect(
      harness
        .requireServer()
        .database.prepare("SELECT diagnostic_code FROM remote_operations WHERE id=?")
        .get(denied.id)?.diagnostic_code
    ).toBe("work_not_agent_assigned");

    expect(restarted.operations.getRequired(legal.id)).toMatchObject({
      state: "activated",
      hostSelection: {
        selection: "exact",
        preferredHostId: hostId,
        assignmentRevision: 1
      },
      attempt: { hostId }
    });
    expect(
      harness
        .requireServer()
        .database.prepare(
          "SELECT host_id,status FROM host_capacity_reservations WHERE execution_attempt_id=?"
        )
        .get(legal.executionAttemptId)
    ).toEqual({ host_id: hostId, status: "active" });
    expect(restarted.dispatches.getRequired(legal.dispatchId).status).toBe("leased");
  });

  it.each([
    ["complete", "after_terminal_event_persistence"],
    ["complete", "after_dispatch_terminal_persistence"],
    ["fail", "after_terminal_event_persistence"],
    ["fail", "after_dispatch_terminal_persistence"],
    ["cancel", "after_terminal_event_persistence"],
    ["cancel", "after_dispatch_terminal_persistence"]
  ] as const)("converges %s after %s", async (action, checkpoint) => {
    const harness = await StartupHarness.create();
    const hostId = harness.registerHost();
    const writebacks = { complete: 0, fail: 0 };
    const decorateRuntime = (runtime: RemoteBlockRuntimePort): RemoteBlockRuntimePort => ({
      ...runtime,
      complete: async (input) => {
        writebacks.complete += 1;
        return runtime.complete(input);
      },
      fail: async (input) => {
        writebacks.fail += 1;
        return runtime.fail(input);
      }
    });
    await harness.start(new CrashOnce(checkpoint), decorateRuntime);
    const coordination = harness.requireCoordination();
    const outcome = await coordination.coordinator.dispatch(harness.request(`terminal-${action}`));
    const dispatch = coordination.dispatches.getRequired(outcome.operation.dispatchId);
    coordination.dispatches.accept(
      hostId,
      `accepted-${action}`,
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );

    if (action === "complete") {
      const report = Buffer.from("# Complete after restart\n");
      const artifact = await harness.requireArtifacts().put({
        expectedSha256: createHash("sha256").update(report).digest("hex"),
        expectedSizeBytes: report.byteLength,
        mediaType: "text/markdown",
        chunks: (async function* () {
          yield report;
        })()
      });
      const grant = coordination.artifactAuthorization.createOutputGrant({
        operationId: `terminal-${action}-grant`,
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
      await expect(
        coordination.dispatches.complete(
          hostId,
          `terminal-${action}`,
          dispatch.id,
          dispatch.leaseId,
          dispatch.executionAttemptId,
          {
            summary: "Completed remotely.",
            reportArtifactRef: artifact.ref,
            artifactRefs: []
          }
        )
      ).rejects.toThrowError(`injected_crash:${checkpoint}`);
    } else {
      const failure =
        action === "cancel"
          ? { code: "execution_cancelled", message: "Cancelled.", retryable: false }
          : { code: "remote_test_failure", message: "Failed.", retryable: false };
      await expect(
        coordination.dispatches.fail(
          hostId,
          `terminal-${action}`,
          dispatch.id,
          dispatch.leaseId,
          dispatch.executionAttemptId,
          failure
        )
      ).rejects.toThrowError(`injected_crash:${checkpoint}`);
    }

    const expectedStatus =
      action === "complete" ? "completed" : action === "cancel" ? "cancelled" : "failed";
    expect(coordination.dispatches.getRequired(dispatch.id).status).toBe(
      checkpoint === "after_terminal_event_persistence" ? "awaiting_writeback" : expectedStatus
    );
    expect(coordination.operations.getRequired(outcome.operation.id).state).toBe("activated");
    expect(coordination.reservations.getRequired(dispatch.leaseId).status).toBe("active");
    expect(writebacks).toEqual({
      complete:
        checkpoint === "after_dispatch_terminal_persistence" && action === "complete" ? 1 : 0,
      fail: checkpoint === "after_dispatch_terminal_persistence" && action !== "complete" ? 1 : 0
    });

    const restarted = await harness.start(undefined, decorateRuntime);
    expect(restarted.operations.getRequired(outcome.operation.id).state).toBe(expectedStatus);
    expect(restarted.dispatches.getRequired(dispatch.id).status).toBe(expectedStatus);
    expect(restarted.reservations.getRequired(dispatch.leaseId).status).toBe(
      action === "cancel" ? "cancelled" : "released"
    );
    expect(writebacks).toEqual({
      complete: action === "complete" ? 1 : 0,
      fail: action === "complete" ? 0 : 1
    });
    expect(
      eventCount(harness.requireServer().database, "dispatch_events", `dispatch.${expectedStatus}`)
    ).toBe(1);
    expect(
      eventCount(
        harness.requireServer().database,
        "remote_operation_events",
        `remote.attempt.${expectedStatus}`
      )
    ).toBe(1);
  });

  it("fails legacy-operation startup visibly, closes the database, and succeeds next restart", async () => {
    const harness = await StartupHarness.create();
    const operation = await harness.seedLegacy("T-001#B-001", "startup-visible-failure", {
      workspaceId: harness.locator.workspaceId,
      assignmentRevision: 0,
      target: { kind: "automatic_host" },
      selection: "automatic",
      requiredCapabilities: ["acp.codex"]
    });
    const pending = await harness.requireCoordination().coordinator.reenter(operation.id);
    expect(pending.status).toBe("awaiting_host");

    await expect(harness.start(new CrashOnce("after_input_materialization"))).rejects.toThrowError(
      "injected_crash:after_input_materialization"
    );
    const restarted = await harness.start();
    expect(restarted.operations.getRequired(pending.operation.id).state).toBe("claimed");
  });

  it("fences expired leases and restores the Runtime interruption before reentry", async () => {
    const harness = await StartupHarness.create();
    harness.registerHost();
    const outcome = await harness
      .requireCoordination()
      .coordinator.dispatch(harness.request("startup-expired-lease"));
    const database = harness.requireServer().database;
    const expiredAt = "2020-01-01T00:00:00.000Z";
    database
      .prepare("UPDATE dispatches SET lease_expires_at=? WHERE id=?")
      .run(expiredAt, outcome.operation.dispatchId);
    database
      .prepare("UPDATE host_capacity_reservations SET lease_expires_at=? WHERE lease_id=?")
      .run(expiredAt, outcome.operation.attempt.leaseId);

    const restarted = await harness.start();

    expect(restarted.dispatches.getRequired(outcome.operation.dispatchId)).toMatchObject({
      status: "interrupted",
      interruption: { reason: "lease_lost", resumable: false }
    });
    expect(restarted.operations.getRequired(outcome.operation.id)).toMatchObject({
      state: "interrupted",
      attempt: { status: "interrupted" }
    });
    await expect(restarted.coordinator.query(outcome.operation.id)).resolves.toMatchObject({
      status: "diverged",
      interruption: { reason: "lease_lost", resumable: false }
    });
  });

  it("cancels a fenced interrupted dispatch after Runtime reset and continues startup", async () => {
    const harness = await StartupHarness.create();
    const hostId = harness.registerHost();
    const coordination = harness.requireCoordination();
    const outcome = await coordination.coordinator.dispatch(
      harness.request("runtime-reset-after-interruption")
    );
    const dispatch = coordination.dispatches.getRequired(outcome.operation.dispatchId);
    coordination.dispatches.accept(
      hostId,
      "runtime-reset-accepted",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    coordination.dispatches.interrupt(hostId, "runtime-reset-interrupted", {
      type: "dispatch.interrupted",
      protocolVersion: 1,
      messageId: "runtime-reset-interrupted",
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
    await resetRuntimeState({ projectRoot: harness.workspace.root, force: true });

    const restarted = await harness.start();

    expect(restarted.dispatches.getRequired(dispatch.id)).toMatchObject({
      status: "cancelled",
      failure: { code: "execution_cancelled", retryable: false }
    });
    expect(restarted.operations.getRequired(outcome.operation.id)).toMatchObject({
      state: "cancelled",
      attempt: { status: "cancelled" }
    });
    expect(restarted.operations.listNonTerminal()).toEqual([]);
    expect(
      harness
        .requireServer()
        .database.prepare("SELECT diagnostic_code FROM remote_operations WHERE id=?")
        .get(outcome.operation.id)
    ).toEqual({ diagnostic_code: "runtime_binding_reset" });
  });

  it("keeps an interrupted dispatch fail-closed while its Host lease is active", async () => {
    const harness = await StartupHarness.create();
    const hostId = harness.registerHost();
    const coordination = harness.requireCoordination();
    const outcome = await coordination.coordinator.dispatch(
      harness.request("runtime-reset-with-active-lease")
    );
    const dispatch = coordination.dispatches.getRequired(outcome.operation.dispatchId);
    coordination.dispatches.accept(
      hostId,
      "active-lease-accepted",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    coordination.dispatches.interrupt(hostId, "active-lease-interrupted", {
      type: "dispatch.interrupted",
      protocolVersion: 1,
      messageId: "active-lease-interrupted",
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      reason: "acp_session_lost",
      resumable: false
    });
    await coordination.coordinator.reenter(outcome.operation.id);
    expect(coordination.reservations.getRequired(dispatch.leaseId).status).toBe("active");
    await resetRuntimeState({ projectRoot: harness.workspace.root, force: true });

    const restarted = await harness.start();
    expect(restarted.operations.getRequired(outcome.operation.id)).toMatchObject({
      state: "failed",
      attempt: { status: "failed" }
    });
    expect(restarted.operations.listNonTerminal()).toEqual([]);
    expect(
      harness
        .requireServer()
        .database.prepare("SELECT diagnostic_code FROM remote_operations WHERE id=?")
        .get(outcome.operation.id)
    ).toEqual({ diagnostic_code: "remote_ownership_not_active" });
  });
});
