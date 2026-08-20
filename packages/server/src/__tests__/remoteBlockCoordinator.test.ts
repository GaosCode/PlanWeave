import { createHash } from "node:crypto";
import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createRemoteBlockArtifactSource,
  createRemoteBlockRuntimePort,
  getTaskWorkspaceRunDetail,
  RemoteBlockRuntimeError,
  type PlanPackageManifest
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ownerPackageLocatorForRun } from "@planweave-ai/agent-host-protocol";
import {
  createTestWorkspace,
  basicManifest
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ArtifactStore } from "../artifacts.js";
import { AgentEndpointCatalogError } from "../agentEndpointCatalog.js";
import { canonicalRemoteRuntimePort } from "../canonicalRemoteRuntimePort.js";
import { createRemoteBlockCoordination } from "../distributedCoordination.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { RemoteRuntimePortRegistry } from "../remoteRuntimeLocator.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { AuthorityRepository } from "../work/authorityRepository.js";
import {
  endpointDispatchRequest,
  registerEndpointDispatchAccess
} from "./support/endpointCoordinatorFixture.js";
import { seedLegacyRemoteOperation } from "./support/legacyRemoteOperationSeed.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function remoteManifest(includeSecondTask = false): PlanPackageManifest {
  const manifest = basicManifest(
    includeSecondTask ? { parallel: true, maxConcurrent: 2, includeSecondTask: true } : undefined
  );
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

async function setup(
  withHost: boolean,
  manifest: PlanPackageManifest = remoteManifest(),
  hostCapacity = 1
) {
  const workspace = await createTestWorkspace(manifest);
  directories.push(workspace.home, workspace.root);
  const dataDirectory = join(workspace.root, "server-data");
  const server = await startPlanweaveServer({
    dataDirectory,
    databasePath: join(dataDirectory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  servers.push(server);
  const workspaceId = new WorkspaceIdentityRepository(
    server.database
  ).ensureWorkspaceForLegacyProject(workspace.init.workspace.id);
  const locator = {
    workspaceId,
    projectId: workspace.init.workspace.id,
    canvasId: "default"
  };
  const runtime = createRemoteBlockRuntimePort({ projectRoot: workspace.root });
  const registry = new RemoteRuntimePortRegistry();
  registry.bind(locator, runtime, createRemoteBlockArtifactSource({ projectRoot: workspace.root }));
  const artifacts = new ArtifactStore(server.database, dataDirectory, 1024 * 1024);
  const materialize = vi.fn(async (candidate: Awaited<ReturnType<typeof runtime.inspect>>) => {
    if (candidate.inputArtifacts.length !== 0) throw new Error("unexpected_test_artifact");
  });
  const coordination = createRemoteBlockCoordination(
    server.database,
    {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      runtimeLeases: registry,
      inputArtifacts: { materialize },
      artifactContent: { readReport: async (ref) => artifacts.read(ref) },
      ownerEndpointScopeAuthorized: (scope) =>
        scope.workspaceId === locator.workspaceId &&
        scope.projectId === locator.projectId &&
        scope.canvasId === locator.canvasId
    },
    { serverInstanceOwnerToken: server.serverInstanceOwnerToken }
  );
  registerEndpointDispatchAccess({
    database: server.database,
    locator,
    projectRoot: workspace.root,
    packageDir: workspace.init.workspace.packageDir
  });
  const host = withHost ? coordination.hosts.register("Coordinator Host").host : undefined;
  if (host) {
    coordination.hosts.bindToWorkspace(host.id, workspaceId);
    coordination.hosts.reportOnline(host.id, ["acp.codex"], hostCapacity, {
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
  }
  return {
    workspace,
    server,
    locator,
    runtime,
    registry,
    hosts: coordination.hosts,
    host,
    mailbox: coordination.mailbox,
    acpEvents: coordination.acpEvents,
    artifacts,
    materialize,
    operations: coordination.operations,
    coordinator: coordination.coordinator,
    dispatches: coordination.dispatches,
    reservations: coordination.reservations,
    agentEndpoints: coordination.agentEndpoints,
    artifactAuthorization: coordination.artifactAuthorization
  };
}

async function setupFleetUnboundHost(manifest: PlanPackageManifest = remoteManifest()) {
  const fixture = await setup(false, manifest);
  const host = fixture.hosts.register("Fleet Unbound Host").host;
  fixture.hosts.reportOnline(host.id, ["acp.codex"], 1, {
    workspaceMappings: [],
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
  const access = new ProjectAccessRepository(fixture.server.database);
  access.registerProjectInternal({
    workspaceId: fixture.locator.workspaceId,
    projectId: fixture.locator.projectId,
    projectRoot: fixture.workspace.root
  });
  access.registerCanvasInternal({
    workspaceId: fixture.locator.workspaceId,
    projectId: fixture.locator.projectId,
    canvasId: fixture.locator.canvasId,
    packageDir: fixture.workspace.init.workspace.packageDir
  });
  return { ...fixture, host };
}

async function completeDispatchToTerminal(
  fixture: Awaited<ReturnType<typeof setupFleetUnboundHost>>,
  outcome: Awaited<ReturnType<typeof fixture.coordinator.dispatch>>
) {
  const report = Buffer.from("# Remote result\n\nCompleted by the remote host.\n");
  const artifact = await fixture.artifacts.put({
    expectedSha256: createHash("sha256").update(report).digest("hex"),
    expectedSizeBytes: report.byteLength,
    mediaType: "text/markdown",
    chunks: (async function* () {
      yield report;
    })()
  });
  const dispatch = fixture.dispatches.getRequired(outcome.operation.dispatchId);
  fixture.dispatches.accept(
    fixture.host?.id ?? "",
    "accept-fleet-unbound",
    dispatch.id,
    dispatch.leaseId,
    dispatch.executionAttemptId
  );
  const grant = fixture.artifactAuthorization.createOutputGrant({
    operationId: "fleet-unbound-completion-report",
    workspaceId: dispatch.workspaceId,
    projectId: dispatch.projectId,
    hostId: dispatch.hostId,
    dispatchId: dispatch.id,
    leaseId: dispatch.leaseId,
    executionAttemptId: dispatch.executionAttemptId,
    permission: "report_write",
    expectedSha256: artifact.sha256,
    expectedSizeBytes: artifact.sizeBytes,
    expectedMediaType: artifact.mediaType
  });
  fixture.artifactAuthorization.acceptOutputUpload(
    {
      workspaceId: dispatch.workspaceId,
      projectId: dispatch.projectId,
      hostId: dispatch.hostId,
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      grantId: grant.grantId
    },
    artifact
  );
  await fixture.dispatches.complete(
    dispatch.hostId,
    "complete-fleet-unbound",
    dispatch.id,
    dispatch.leaseId,
    dispatch.executionAttemptId,
    {
      summary: "Remote completion.",
      reportArtifactRef: artifact.ref,
      artifactRefs: []
    }
  );
}

async function setupInterruptedV3EndpointOperation(idempotencyKey: string) {
  const fixture = await setup(true);
  if (!fixture.host) throw new Error("expected_test_host");
  const access = new ProjectAccessRepository(fixture.server.database);
  access.registerProjectInternal({
    workspaceId: fixture.locator.workspaceId,
    projectId: fixture.locator.projectId,
    projectRoot: fixture.workspace.root
  });
  access.registerCanvasInternal({
    workspaceId: fixture.locator.workspaceId,
    projectId: fixture.locator.projectId,
    canvasId: fixture.locator.canvasId,
    packageDir: fixture.workspace.init.workspace.packageDir
  });
  const endpoint = fixture.agentEndpoints.listVisible(fixture.locator.workspaceId).items[0];
  if (!endpoint) throw new Error("expected_test_endpoint");
  const dispatched = await fixture.coordinator.dispatch({
    ...fixture.locator,
    blockRef: "T-001#B-001",
    idempotencyKey,
    agentEndpointId: endpoint.endpointId,
    expectedResponsibilityRevision: 0,
    expectedReviewerRevision: 0
  });
  const dispatch = fixture.dispatches.getRequired(dispatched.operation.dispatchId);
  fixture.dispatches.accept(
    fixture.host.id,
    `${idempotencyKey}-accepted`,
    dispatch.id,
    dispatch.leaseId,
    dispatch.executionAttemptId
  );
  fixture.dispatches.interrupt(fixture.host.id, `${idempotencyKey}-interrupted`, {
    type: "dispatch.interrupted",
    protocolVersion: 1,
    messageId: `${idempotencyKey}-interrupted`,
    dispatchId: dispatch.id,
    leaseId: dispatch.leaseId,
    executionAttemptId: dispatch.executionAttemptId,
    reason: "acp_session_lost",
    resumable: false
  });
  const lease = fixture.reservations.getRequired(dispatch.leaseId);
  fixture.reservations.release({
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    expectedVersion: lease.version,
    reason: "expired"
  });
  await fixture.coordinator.reenter(dispatched.operation.id);
  return { fixture, operation: fixture.operations.getRequired(dispatched.operation.id), endpoint };
}

async function setupActiveV3EndpointOperation(idempotencyKey: string) {
  const fixture = await setup(true);
  if (!fixture.host) throw new Error("expected_test_host");
  const access = new ProjectAccessRepository(fixture.server.database);
  access.registerProjectInternal({
    workspaceId: fixture.locator.workspaceId,
    projectId: fixture.locator.projectId,
    projectRoot: fixture.workspace.root
  });
  access.registerCanvasInternal({
    workspaceId: fixture.locator.workspaceId,
    projectId: fixture.locator.projectId,
    canvasId: fixture.locator.canvasId,
    packageDir: fixture.workspace.init.workspace.packageDir
  });
  const endpoint = fixture.agentEndpoints.listVisible(fixture.locator.workspaceId).items[0];
  if (!endpoint) throw new Error("expected_test_endpoint");
  const outcome = await fixture.coordinator.dispatch({
    ...fixture.locator,
    blockRef: "T-001#B-001",
    idempotencyKey,
    agentEndpointId: endpoint.endpointId,
    expectedResponsibilityRevision: 0,
    expectedReviewerRevision: 0
  });
  return { fixture, operation: outcome.operation };
}

describe("RemoteBlockCoordinator", () => {
  it("uses one acquired Runtime binding for execution and artifacts and releases every lease once", async () => {
    const fixture = await setup(true);
    const bindings: Array<{
      artifacts: ReturnType<typeof createRemoteBlockArtifactSource>;
      release: ReturnType<typeof vi.fn>;
    }> = [];
    fixture.registry.setScopedResolver(() => {
      const binding = {
        runtime: canonicalRemoteRuntimePort(fixture.runtime, fixture.locator.workspaceId),
        artifacts: createRemoteBlockArtifactSource({ projectRoot: fixture.workspace.root }),
        release: vi.fn()
      };
      bindings.push(binding);
      return binding;
    });

    await fixture.coordinator.dispatch(
      endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: fixture.locator,
        blockRef: "T-001#B-001",
        idempotencyKey: "lease-artifact-binding"
      })
    );

    expect(bindings).toHaveLength(2);
    expect(fixture.materialize).toHaveBeenCalledWith(
      expect.objectContaining({ blockRef: "T-001#B-001" }),
      bindings[1]!.artifacts
    );
    for (const binding of bindings) expect(binding.release).toHaveBeenCalledOnce();

    const failureFixture = await setup(true);
    const failedReleases: Array<ReturnType<typeof vi.fn>> = [];
    failureFixture.registry.setScopedResolver(() => {
      const release = vi.fn();
      failedReleases.push(release);
      return {
        runtime: canonicalRemoteRuntimePort(
          failureFixture.runtime,
          failureFixture.locator.workspaceId
        ),
        artifacts: createRemoteBlockArtifactSource({ projectRoot: failureFixture.workspace.root }),
        release
      };
    });
    failureFixture.materialize.mockRejectedValueOnce(new Error("injected_materialize_failure"));
    await expect(
      failureFixture.coordinator.dispatch(
        endpointDispatchRequest({
          agentEndpoints: failureFixture.agentEndpoints,
          locator: failureFixture.locator,
          blockRef: "T-001#B-001",
          idempotencyKey: "lease-artifact-release-failure"
        })
      )
    ).rejects.toThrow("injected_materialize_failure");
    expect(failedReleases).toHaveLength(2);
    for (const release of failedReleases) expect(release).toHaveBeenCalledOnce();
  });

  it("classifies a Runtime acquire failure and continues reentering later operations", async () => {
    const fixture = await setup(true, remoteManifest(true), 2);
    await fixture.coordinator.dispatch(
      endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: fixture.locator,
        blockRef: "T-001#B-001",
        idempotencyKey: "acquire-failure-first"
      })
    );
    await fixture.coordinator.dispatch(
      endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: fixture.locator,
        blockRef: "T-002#B-001",
        idempotencyKey: "acquire-failure-second"
      })
    );

    let acquireCount = 0;
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    fixture.registry.setScopedResolver(() => {
      acquireCount += 1;
      if (acquireCount === 1) {
        throw new AgentEndpointCatalogError("agent_endpoint_unavailable");
      }
      const release = vi.fn();
      releases.push(release);
      return {
        runtime: canonicalRemoteRuntimePort(fixture.runtime, fixture.locator.workspaceId),
        artifacts: createRemoteBlockArtifactSource({ projectRoot: fixture.workspace.root }),
        release
      };
    });

    const outcomes = await fixture.coordinator.reenterPending();

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({ status: "awaiting_host" });
    expect(acquireCount).toBe(2);
    expect(releases).toHaveLength(1);
    expect(releases[0]).toHaveBeenCalledOnce();
    expect(
      fixture.server.database
        .prepare("SELECT diagnostic_code FROM remote_operations WHERE id=?")
        .get(outcomes[0]!.operation.id)
    ).toEqual({ diagnostic_code: "agent_endpoint_unavailable" });
  });

  it("re-inspects once when the pre-dispatch source snapshot changes", async () => {
    const fixture = await setup(true);
    const inspect = vi.spyOn(fixture.runtime, "inspect");
    inspect.mockRejectedValueOnce(
      new RemoteBlockRuntimeError(
        "remote_block_source_changed",
        "Remote source changed while inspecting; inspect again."
      )
    );

    await expect(
      fixture.coordinator.dispatch(
        endpointDispatchRequest({
          agentEndpoints: fixture.agentEndpoints,
          locator: fixture.locator,
          blockRef: "T-001#B-001",
          idempotencyKey: "dispatch-source-change-reinspect"
        })
      )
    ).resolves.toMatchObject({ status: "activated" });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("preserves a repeated pre-dispatch source conflict without creating an operation", async () => {
    const fixture = await setup(true);
    const inspect = vi
      .spyOn(fixture.runtime, "inspect")
      .mockRejectedValue(
        new RemoteBlockRuntimeError(
          "remote_block_source_changed",
          "Remote source keeps changing while inspecting."
        )
      );

    await expect(
      fixture.coordinator.dispatch(
        endpointDispatchRequest({
          agentEndpoints: fixture.agentEndpoints,
          locator: fixture.locator,
          blockRef: "T-001#B-001",
          idempotencyKey: "dispatch-repeated-source-change"
        })
      )
    ).rejects.toMatchObject({ code: "remote_block_source_changed" });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(
      fixture.server.database.prepare("SELECT COUNT(*) AS count FROM remote_operations").get()
    ).toEqual({ count: 0 });
  });

  it("routes a built-in logical executor through the selected Host ACP profile", async () => {
    const manifest = basicManifest();
    manifest.execution.defaultExecutor = "codex";
    const fixture = await setup(true, manifest);
    const endpoint = fixture.agentEndpoints.listVisible(fixture.locator.workspaceId).items[0];
    if (!endpoint) throw new Error("expected_test_endpoint");

    const outcome = await fixture.coordinator.dispatch({
      ...fixture.locator,
      blockRef: "T-001#B-001",
      idempotencyKey: "built-in-codex-selected-endpoint",
      agentEndpointId: endpoint.endpointId,
      expectedResponsibilityRevision: 0,
      expectedReviewerRevision: 0
    });

    expect(outcome).toMatchObject({
      status: "activated",
      operation: {
        endpointSelection: {
          agentId: "codex",
          profileId: "codex-acp"
        }
      }
    });
    expect(fixture.mailbox.listAfter(fixture.host?.id ?? "", 0)[0]?.command).toMatchObject({
      envelope: {
        agentId: "codex",
        agentProfileId: "codex-acp"
      }
    });
  });

  it("uses one stable identity and replays claim, grants, mailbox enqueue, and publish", async () => {
    const fixture = await setup(true);
    const publish = vi.fn();
    const unsubscribe = fixture.mailbox.subscribe(fixture.host?.id ?? "", publish);
    const request = endpointDispatchRequest({
      agentEndpoints: fixture.agentEndpoints,
      locator: fixture.locator,
      blockRef: "T-001#B-001",
      idempotencyKey: "dispatch-request-1"
    });

    const first = await fixture.coordinator.dispatch(request);
    const replay = await fixture.coordinator.dispatch(request);
    unsubscribe();

    expect(first.status).toBe("activated");
    expect(replay.operation.id).toBe(first.operation.id);
    expect(replay.operation.dispatchId).toBe(first.operation.dispatchId);
    expect(replay.operation.executionAttemptId).toBe(first.operation.executionAttemptId);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(fixture.mailbox.listAfter(fixture.host?.id ?? "", 0)).toHaveLength(1);
    const command = fixture.mailbox.listAfter(fixture.host?.id ?? "", 0)[0]?.command;
    expect(command).toMatchObject({
      type: "execute_block",
      dispatchId: first.operation.dispatchId,
      executionAttemptId: first.operation.executionAttemptId,
      envelope: {
        execution: {
          dispatchId: first.operation.dispatchId,
          attemptId: first.operation.executionAttemptId
        }
      }
    });
    expect(JSON.stringify(command)).not.toContain(fixture.workspace.root);
    await expect(
      fixture.runtime.query({ ref: request.blockRef, operationId: first.operation.id })
    ).resolves.toMatchObject({ ownership: { phase: "active" } });
  });

  it("keeps an existing legacy automatic operation actionable until capacity appears", async () => {
    const fixture = await setup(false);
    const request = {
      blockRef: "T-001#B-001",
      idempotencyKey: "dispatch-request-no-host"
    };
    const candidate = await fixture.registry.resolve(fixture.locator).inspect({
      ref: request.blockRef
    });
    const operation = seedLegacyRemoteOperation({
      database: fixture.server.database,
      operations: fixture.operations,
      locator: fixture.locator,
      candidate,
      idempotencyKey: request.idempotencyKey,
      hostSelection: {
        workspaceId: fixture.locator.workspaceId,
        assignmentRevision: 0,
        target: { kind: "automatic_host" },
        selection: "automatic",
        requiredCapabilities: candidate.requiredCapabilities
      }
    });
    const pending = await fixture.coordinator.reenter(operation.id);
    expect(pending.status).toBe("awaiting_host");
    expect(pending.operation.state).toBe("claimed");
    expect(
      fixture.server.database
        .prepare("SELECT diagnostic_code FROM remote_operations WHERE id=?")
        .get(pending.operation.id)?.diagnostic_code
    ).toBe("no_compatible_agent_host");

    const host = fixture.hosts.register("Late Host").host;
    const workspaceId = new WorkspaceIdentityRepository(
      fixture.server.database
    ).workspaceForLegacyProject(fixture.locator.projectId);
    if (!workspaceId) throw new Error("workspace_mapping_missing");
    fixture.hosts.bindToWorkspace(host.id, workspaceId);
    fixture.hosts.reportOnline(host.id, ["acp.codex"], 1, {
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
    await expect(fixture.coordinator.reenter(pending.operation.id)).resolves.toMatchObject({
      status: "activated"
    });
  });

  it("dispatches the selected catalog Endpoint only to its ready workspace ACP Host", async () => {
    const fixture = await setup(false);
    const missingWorkspace = fixture.hosts.register("Missing workspace readiness").host;
    const missingAcp = fixture.hosts.register("Missing ACP readiness").host;
    const ready = fixture.hosts.register("Ready automatic Host").host;
    for (const host of [missingWorkspace, missingAcp, ready]) {
      fixture.hosts.bindToWorkspace(host.id, fixture.locator.workspaceId);
    }
    fixture.hosts.reportOnline(missingWorkspace.id, ["acp.codex"], 1, {
      workspaceMappings: [],
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
    fixture.hosts.reportOnline(missingAcp.id, ["acp.codex"], 1, {
      workspaceMappings: [{ workspaceId: fixture.locator.workspaceId, status: "ready" }],
      acpProfiles: []
    });
    fixture.hosts.reportOnline(ready.id, ["acp.codex"], 1, {
      workspaceMappings: [{ workspaceId: fixture.locator.workspaceId, status: "ready" }],
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

    const outcome = await fixture.coordinator.dispatch(
      endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: fixture.locator,
        blockRef: "T-001#B-001",
        idempotencyKey: "selected-ready-endpoint"
      })
    );
    expect(outcome).toMatchObject({
      status: "activated",
      operation: { attempt: { hostId: ready.id } }
    });
  });

  it("rechecks separated authority revisions before reentering an active Host attempt", async () => {
    const fixture = await setup(true);
    if (!fixture.host) throw new Error("expected_test_host");
    const workspaceId = new WorkspaceIdentityRepository(
      fixture.server.database
    ).workspaceForLegacyProject(fixture.locator.projectId);
    if (!workspaceId) throw new Error("workspace_mapping_missing");
    const access = new ProjectAccessRepository(fixture.server.database);
    access.registerProjectInternal({
      workspaceId,
      projectId: fixture.locator.projectId,
      projectRoot: fixture.workspace.root
    });
    access.registerCanvasInternal({
      workspaceId,
      projectId: fixture.locator.projectId,
      canvasId: fixture.locator.canvasId,
      packageDir: fixture.workspace.init.workspace.packageDir
    });
    const authority = new AuthorityRepository(fixture.server.database);
    const scope = {
      kind: "block" as const,
      workspaceId,
      ...fixture.locator,
      blockRef: "T-001#B-001"
    };
    authority.applyExecutionTarget({
      mutation: {
        schemaVersion: "execution-target/v1",
        scope,
        target: { kind: "exact_host", hostId: fixture.host.id },
        expectedRevision: 0
      },
      actor: { kind: "system", id: "test-system" }
    });
    const outcome = await fixture.coordinator.dispatch(
      endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: fixture.locator,
        blockRef: scope.blockRef,
        idempotencyKey: "strict-authority-recheck",
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0
      })
    );
    authority.applyReviewer({
      mutation: {
        schemaVersion: "review-assignment/v1",
        scope,
        principal: null,
        expectedRevision: 0
      },
      actor: { kind: "system", id: "test-system" }
    });

    await expect(fixture.coordinator.reenter(outcome.operation.id)).rejects.toMatchObject({
      code: "work_revision_conflict"
    });
    expect(
      fixture.server.database
        .prepare("SELECT status FROM host_capacity_reservations WHERE lease_id=?")
        .get(outcome.operation.attempt.leaseId)
    ).toEqual({ status: "expired" });
  });

  it("keeps an exact workspace Host authorized through reservation and final reentry", async () => {
    const fixture = await setup(true);
    const secondWorkspaceId = "workspace-2";
    const secondLocator = { ...fixture.locator, workspaceId: secondWorkspaceId };
    new WorkspaceIdentityRepository(fixture.server.database).ensureConfiguredWorkspace(
      secondWorkspaceId
    );
    fixture.registry.bind(
      secondLocator,
      fixture.runtime,
      createRemoteBlockArtifactSource({ projectRoot: fixture.workspace.root })
    );

    const access = new ProjectAccessRepository(fixture.server.database);
    access.registerProjectInternal({
      workspaceId: secondWorkspaceId,
      projectId: secondLocator.projectId,
      projectRoot: fixture.workspace.root
    });
    access.registerCanvasInternal({
      workspaceId: secondWorkspaceId,
      projectId: secondLocator.projectId,
      canvasId: secondLocator.canvasId,
      packageDir: fixture.workspace.init.workspace.packageDir
    });
    const host = fixture.hosts.register("Second Workspace Host").host;
    fixture.hosts.bindToWorkspace(host.id, secondWorkspaceId);
    fixture.hosts.reportOnline(host.id, ["acp.codex"], 1, {
      workspaceMappings: [{ workspaceId: secondWorkspaceId, status: "ready" }],
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
    const scope = {
      kind: "block" as const,
      ...secondLocator,
      blockRef: "T-001#B-001"
    };
    new AuthorityRepository(fixture.server.database).applyExecutionTarget({
      mutation: {
        schemaVersion: "execution-target/v1",
        scope,
        target: { kind: "exact_host", hostId: host.id },
        expectedRevision: 0
      },
      actor: { kind: "system", id: "test-system" }
    });

    fixture.server.database
      .prepare("DELETE FROM legacy_project_workspace_mappings WHERE legacy_project_id=?")
      .run(secondLocator.projectId);
    expect(
      new WorkspaceIdentityRepository(fixture.server.database).workspaceForLegacyProject(
        secondLocator.projectId
      )
    ).toBeUndefined();

    const outcome = await fixture.coordinator.dispatch(
      endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: secondLocator,
        blockRef: scope.blockRef,
        idempotencyKey: "strict-authority-exact-workspace"
      })
    );
    expect(outcome).toMatchObject({
      status: "activated",
      operation: {
        workspaceId: secondWorkspaceId,
        attempt: { hostId: host.id }
      }
    });
    const leaseId = outcome.operation.attempt.leaseId;
    if (!leaseId) throw new Error("expected_reservation_lease");
    expect(fixture.reservations.getRequired(leaseId)).toMatchObject({
      hostId: host.id,
      status: "active"
    });
    expect(fixture.dispatches.getRequired(outcome.operation.dispatchId)).toMatchObject({
      workspaceId: secondWorkspaceId,
      hostId: host.id,
      status: "leased"
    });
    await expect(fixture.coordinator.reenter(outcome.operation.id)).resolves.toMatchObject({
      status: "activated"
    });
  });

  it("recovers a legacy retry from authority tables after execution target change", async () => {
    const fixture = await setup(true);
    if (!fixture.host) throw new Error("expected_test_host");
    const workspaceId = new WorkspaceIdentityRepository(
      fixture.server.database
    ).workspaceForLegacyProject(fixture.locator.projectId);
    if (!workspaceId) throw new Error("workspace_mapping_missing");
    const access = new ProjectAccessRepository(fixture.server.database);
    access.registerProjectInternal({
      workspaceId,
      projectId: fixture.locator.projectId,
      projectRoot: fixture.workspace.root
    });
    access.registerCanvasInternal({
      workspaceId,
      projectId: fixture.locator.projectId,
      canvasId: fixture.locator.canvasId,
      packageDir: fixture.workspace.init.workspace.packageDir
    });

    const hostA = fixture.host;
    const hostB = fixture.hosts.register("Authority Host B").host;
    fixture.hosts.bindToWorkspace(hostB.id, workspaceId);
    fixture.hosts.reportOnline(hostB.id, ["acp.codex"], 1, {
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

    const authority = new AuthorityRepository(fixture.server.database);
    const scope = {
      kind: "block" as const,
      workspaceId,
      ...fixture.locator,
      blockRef: "T-001#B-001"
    };
    // Authority-only: no work_assignments dual-write.
    authority.applyExecutionTarget({
      mutation: {
        schemaVersion: "execution-target/v1",
        scope,
        target: { kind: "exact_host", hostId: hostA.id },
        expectedRevision: 0
      },
      actor: { kind: "system", id: "test-system" }
    });
    expect(
      fixture.server.database.prepare("SELECT COUNT(*) AS count FROM work_assignments").get() as {
        count: number;
      }
    ).toEqual({ count: 0 });

    const candidate = await fixture.registry.resolve(fixture.locator).inspect({
      ref: scope.blockRef
    });
    const legacyOperation = seedLegacyRemoteOperation({
      database: fixture.server.database,
      operations: fixture.operations,
      locator: fixture.locator,
      candidate,
      idempotencyKey: "retry-authority-only",
      hostSelection: {
        workspaceId,
        assignmentRevision: 1,
        authorityRevisions: {
          responsibilityRevision: 0,
          reviewerRevision: 0,
          executionTargetRevision: 1
        },
        target: { kind: "exact_host", hostId: hostA.id },
        selection: "exact",
        preferredHostId: hostA.id,
        requiredCapabilities: candidate.requiredCapabilities
      }
    });
    const dispatched = await fixture.coordinator.reenter(legacyOperation.id);
    expect(dispatched.operation.attempt.hostId).toBe(hostA.id);
    expect(dispatched.operation.hostSelection?.authorityRevisions).toEqual({
      responsibilityRevision: 0,
      reviewerRevision: 0,
      executionTargetRevision: 1
    });

    const dispatch = fixture.dispatches.getRequired(dispatched.operation.dispatchId);
    fixture.dispatches.accept(
      hostA.id,
      "retry-authority-accepted",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    fixture.dispatches.interrupt(hostA.id, "retry-authority-interrupted", {
      type: "dispatch.interrupted",
      protocolVersion: 1,
      messageId: "retry-authority-interrupted",
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      reason: "acp_session_lost",
      resumable: false
    });
    const lease = fixture.reservations.getRequired(dispatch.leaseId);
    fixture.reservations.release({
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      expectedVersion: lease.version,
      reason: "expired"
    });
    await fixture.coordinator.reenter(dispatched.operation.id);

    // Change execution target to Host B via authority tables only (no legacy dual-write).
    authority.applyExecutionTarget({
      mutation: {
        schemaVersion: "execution-target/v1",
        scope,
        target: { kind: "exact_host", hostId: hostB.id },
        expectedRevision: 1
      },
      actor: { kind: "system", id: "test-system" }
    });

    const interrupted = fixture.operations.getRequired(dispatched.operation.id);
    await fixture.coordinator.executeAction({
      actionId: "retry-authority-only-action",
      operationId: interrupted.id,
      dispatchId: interrupted.dispatchId,
      executionAttemptId: interrupted.executionAttemptId,
      expectedAttemptVersion: interrupted.attempt.stateVersion,
      kind: "retry_new_attempt",
      priorLeaseId: dispatch.leaseId,
      newDispatchId: "dispatch-retry-authority-2",
      newExecutionAttemptId: "attempt-retry-authority-2",
      reason: "retry after authority execution target moved to Host B"
    });

    const retried = fixture.operations.getRequired(dispatched.operation.id);
    expect(retried).toMatchObject({
      state: "activated",
      dispatchId: "dispatch-retry-authority-2",
      executionAttemptId: "attempt-retry-authority-2",
      attempt: { hostId: hostB.id },
      hostSelection: {
        selection: "exact",
        preferredHostId: hostB.id,
        authorityRevisions: {
          responsibilityRevision: 0,
          reviewerRevision: 0,
          executionTargetRevision: 2
        }
      }
    });
    expect(retried.hostSelection?.preferredHostId).not.toBe(hostA.id);
    expect(
      fixture.server.database.prepare("SELECT COUNT(*) AS count FROM work_assignments").get() as {
        count: number;
      }
    ).toEqual({ count: 0 });
  });

  it.each([
    "revoked",
    "offline",
    "profile_identity_changed"
  ] as const)("rejects v3 retry before attempt mutation when the durable Endpoint is %s", async (failure) => {
    const { fixture, operation } = await setupInterruptedV3EndpointOperation(
      `v3-retry-freshness-${failure}`
    );
    if (!fixture.host) throw new Error("expected_test_host");
    if (failure === "revoked") {
      fixture.hosts.revoke(fixture.host.id);
    } else if (failure === "offline") {
      fixture.server.database
        .prepare("UPDATE agent_hosts SET last_seen_at=? WHERE id=?")
        .run("2000-01-01T00:00:00.000Z", fixture.host.id);
    } else {
      fixture.hosts.reportOnline(fixture.host.id, ["acp.codex"], 1, {
        workspaceMappings: [{ workspaceId: fixture.locator.workspaceId, status: "ready" }],
        acpProfiles: [
          {
            profileId: "other-profile",
            agentId: "other-agent",
            displayName: "Other Agent",
            status: "ready",
            capabilities: ["acp.codex"]
          }
        ]
      });
    }

    await expect(
      fixture.coordinator.executeAction({
        actionId: `v3-retry-${failure}`,
        operationId: operation.id,
        dispatchId: operation.dispatchId,
        executionAttemptId: operation.executionAttemptId,
        expectedAttemptVersion: operation.attempt.stateVersion,
        kind: "retry_new_attempt",
        priorLeaseId: operation.attempt.leaseId,
        newDispatchId: `dispatch-v3-retry-${failure}`,
        newExecutionAttemptId: `attempt-v3-retry-${failure}`,
        reason: "fresh Endpoint authorization must precede retry mutation"
      })
    ).rejects.toThrow(/agent_endpoint_(unavailable|unknown|incompatible)/);

    expect(fixture.operations.getRequired(operation.id)).toMatchObject({
      dispatchId: operation.dispatchId,
      executionAttemptId: operation.executionAttemptId,
      attempt: { stateVersion: operation.attempt.stateVersion }
    });
    expect(
      fixture.server.database
        .prepare("SELECT COUNT(*) AS count FROM remote_execution_attempts WHERE operation_id=?")
        .get(operation.id)
    ).toEqual({ count: 1 });
  });

  it("retries a v3 operation on the exact durable Endpoint", async () => {
    const { fixture, operation, endpoint } =
      await setupInterruptedV3EndpointOperation("v3-retry-same-endpoint");
    await fixture.coordinator.executeAction({
      actionId: "v3-retry-same-endpoint-action",
      operationId: operation.id,
      dispatchId: operation.dispatchId,
      executionAttemptId: operation.executionAttemptId,
      expectedAttemptVersion: operation.attempt.stateVersion,
      kind: "retry_new_attempt",
      priorLeaseId: operation.attempt.leaseId,
      newDispatchId: "dispatch-v3-retry-same-endpoint",
      newExecutionAttemptId: "attempt-v3-retry-same-endpoint",
      reason: "retry exact durable Endpoint"
    });
    const retried = fixture.operations.getRequired(operation.id);
    expect(retried.endpointSelection).toEqual(operation.endpointSelection);
    expect(retried.endpointSelection?.endpointId).toBe(endpoint.endpointId);
    expect(retried.attempt.hostId).toBe(operation.endpointSelection?.hostId);
  });

  it("rejects v3 reentry on a stale Endpoint without changing the durable attempt", async () => {
    const { fixture, operation } = await setupActiveV3EndpointOperation(
      "v3-reentry-stale-endpoint"
    );
    if (!fixture.host) throw new Error("expected_test_host");
    fixture.hosts.revoke(fixture.host.id);
    await expect(fixture.coordinator.reenter(operation.id)).rejects.toThrow(
      /agent_endpoint_(unavailable|unknown)/
    );
    expect(fixture.operations.getRequired(operation.id)).toMatchObject({
      dispatchId: operation.dispatchId,
      executionAttemptId: operation.executionAttemptId,
      endpointSelection: operation.endpointSelection
    });
  });

  it("fails closed on source drift and on a missing restart locator", async () => {
    const fixture = await setup(true);
    const acquireScoped = vi.fn(() => ({
      runtime: canonicalRemoteRuntimePort(fixture.runtime, fixture.locator.workspaceId),
      artifacts: createRemoteBlockArtifactSource({ projectRoot: fixture.workspace.root }),
      release: vi.fn()
    }));
    fixture.registry.setScopedResolver(acquireScoped);
    const pending = await fixture.coordinator.dispatch({
      ...endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: fixture.locator,
        blockRef: "T-001#B-001",
        idempotencyKey: "dispatch-request-drift"
      })
    });
    await appendFile(
      join(fixture.workspace.init.workspace.packageDir, "nodes/T-001/blocks/B-001.prompt.md"),
      "\nchanged after claim\n",
      "utf8"
    );
    const host = fixture.hosts.register("Drift Host").host;
    fixture.hosts.reportOnline(host.id, ["acp.codex"], 1);
    await expect(fixture.coordinator.reenter(pending.operation.id)).rejects.toThrowError(
      "remote_source_changed"
    );
    expect(acquireScoped).toHaveBeenCalled();
    for (const binding of acquireScoped.mock.results) {
      expect(binding.value.release).toHaveBeenCalledOnce();
    }
    expect(
      fixture.server.database
        .prepare("SELECT diagnostic_code FROM remote_operations WHERE id=?")
        .get(pending.operation.id)?.diagnostic_code
    ).toBe("runtime_reconciliation_conflict");

    const unbindable = new RemoteRuntimePortRegistry();
    expect(() => unbindable.resolve(fixture.locator)).toThrowError(
      "remote_runtime_locator_unresolved"
    );
  });

  it("re-enters terminal completion through the Runtime authority", async () => {
    const fixture = await setup(true);
    const outcome = await fixture.coordinator.dispatch(
      endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: fixture.locator,
        blockRef: "T-001#B-001",
        idempotencyKey: "dispatch-request-complete"
      })
    );
    const report = Buffer.from("# Remote result\n\nCompleted by the remote host.\n");
    const artifact = await fixture.artifacts.put({
      expectedSha256: createHash("sha256").update(report).digest("hex"),
      expectedSizeBytes: report.byteLength,
      mediaType: "text/markdown",
      chunks: (async function* () {
        yield report;
      })()
    });
    const dispatch = fixture.dispatches.getRequired(outcome.operation.dispatchId);
    fixture.dispatches.accept(
      fixture.host?.id ?? "",
      "accept-completion",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    fixture.acpEvents.ingest(dispatch.hostId, "remote-acp-message-1", {
      type: "acp.events",
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      acpSessionId: "remote-session-001",
      afterCursor: 0,
      cursor: 1,
      events: [
        {
          cursor: 1,
          kind: "agent_message",
          text: "Created the requested file on the remote Host."
        }
      ]
    });
    const grant = fixture.artifactAuthorization.createOutputGrant({
      operationId: "coordinator-completion-report",
      workspaceId: dispatch.workspaceId,
      projectId: dispatch.projectId,
      hostId: dispatch.hostId,
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      permission: "report_write",
      expectedSha256: artifact.sha256,
      expectedSizeBytes: artifact.sizeBytes,
      expectedMediaType: artifact.mediaType
    });
    fixture.artifactAuthorization.acceptOutputUpload(
      {
        workspaceId: dispatch.workspaceId,
        projectId: dispatch.projectId,
        hostId: dispatch.hostId,
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        grantId: grant.grantId
      },
      artifact
    );
    await fixture.dispatches.complete(
      dispatch.hostId,
      "complete-coordinator",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId,
      {
        summary: "Remote completion.",
        reportArtifactRef: artifact.ref,
        artifactRefs: []
      }
    );
    await expect(
      fixture.runtime.query({ ref: "T-001#B-001", operationId: outcome.operation.id })
    ).resolves.toMatchObject({ status: "completed" });
    expect(fixture.operations.getRequired(outcome.operation.id).state).toBe("completed");
    const binding = await fixture.runtime.query({
      ref: "T-001#B-001",
      operationId: outcome.operation.id
    });
    const runId = binding.terminalReceipt?.runId;
    if (!runId) throw new Error("expected_remote_completion_run");
    const detail = await getTaskWorkspaceRunDetail({
      projectRoot: fixture.workspace.root,
      canvasId: "default",
      taskId: "T-001",
      recordId: `T-001#B-001::${runId}`
    });
    expect(detail.record.runnerReadModel?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: expect.objectContaining({
            kind: "message",
            content: "Created the requested file on the remote Host."
          })
        })
      ])
    );
  });

  it("seals awaiting_writeback after the host reservation expires and the endpoint goes away", async () => {
    const fixture = await setup(true);
    if (!fixture.host) throw new Error("expected_test_host");
    const outcome = await fixture.coordinator.dispatch(
      endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: fixture.locator,
        blockRef: "T-001#B-001",
        idempotencyKey: "dispatch-writeback-after-lease-expiry"
      })
    );
    const report = Buffer.from("# Remote result\n\nCompleted before lease expiry.\n");
    const artifact = await fixture.artifacts.put({
      expectedSha256: createHash("sha256").update(report).digest("hex"),
      expectedSizeBytes: report.byteLength,
      mediaType: "text/markdown",
      chunks: (async function* () {
        yield report;
      })()
    });
    const dispatch = fixture.dispatches.getRequired(outcome.operation.dispatchId);
    fixture.dispatches.accept(
      fixture.host.id,
      "accept-writeback-expiry",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    const grant = fixture.artifactAuthorization.createOutputGrant({
      operationId: "writeback-after-expiry-report",
      workspaceId: dispatch.workspaceId,
      projectId: dispatch.projectId,
      hostId: dispatch.hostId,
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      permission: "report_write",
      expectedSha256: artifact.sha256,
      expectedSizeBytes: artifact.sizeBytes,
      expectedMediaType: artifact.mediaType
    });
    fixture.artifactAuthorization.acceptOutputUpload(
      {
        workspaceId: dispatch.workspaceId,
        projectId: dispatch.projectId,
        hostId: dispatch.hostId,
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        grantId: grant.grantId
      },
      artifact
    );

    // Inject a one-shot writeback failure so the Host result stays on the dispatch.
    const completeSpy = vi
      .spyOn(fixture.coordinator, "complete")
      .mockRejectedValueOnce(new Error("injected_writeback_delay"));
    await expect(
      fixture.dispatches.complete(
        dispatch.hostId,
        "complete-writeback-expiry",
        dispatch.id,
        dispatch.leaseId,
        dispatch.executionAttemptId,
        {
          summary: "Remote completion before expiry.",
          reportArtifactRef: artifact.ref,
          artifactRefs: []
        }
      )
    ).rejects.toThrowError("injected_writeback_delay");
    completeSpy.mockRestore();
    expect(fixture.dispatches.getRequired(dispatch.id).status).toBe("awaiting_writeback");

    const lease = fixture.reservations.getRequired(dispatch.leaseId);
    fixture.reservations.release({
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      expectedVersion: lease.version,
      reason: "expired"
    });
    // Host offline: any live authorize path would throw agent_endpoint_unavailable.
    fixture.server.database
      .prepare("UPDATE agent_hosts SET last_seen_at=? WHERE id=?")
      .run("2020-01-01T00:00:00.000Z", fixture.host.id);

    await expect(fixture.coordinator.reenter(outcome.operation.id)).resolves.toMatchObject({
      status: "terminal"
    });
    expect(fixture.operations.getRequired(outcome.operation.id).state).toBe("completed");
    expect(fixture.dispatches.getRequired(dispatch.id).status).toBe("completed");
    await expect(
      fixture.runtime.query({ ref: "T-001#B-001", operationId: outcome.operation.id })
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("seals awaiting_writeback as failed when package writeback rejects the report", async () => {
    const fixture = await setup(true);
    if (!fixture.host) throw new Error("expected_test_host");
    const { RemoteBlockRuntimeError } = await import("@planweave-ai/runtime");
    const outcome = await fixture.coordinator.dispatch(
      endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: fixture.locator,
        blockRef: "T-001#B-001",
        idempotencyKey: "dispatch-writeback-result-conflict"
      })
    );
    const report = Buffer.from("# Remote result\n\nNot a valid sealed report for writeback.\n");
    const artifact = await fixture.artifacts.put({
      expectedSha256: createHash("sha256").update(report).digest("hex"),
      expectedSizeBytes: report.byteLength,
      mediaType: "text/markdown",
      chunks: (async function* () {
        yield report;
      })()
    });
    const dispatch = fixture.dispatches.getRequired(outcome.operation.dispatchId);
    fixture.dispatches.accept(
      fixture.host.id,
      "accept-writeback-conflict",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    const grant = fixture.artifactAuthorization.createOutputGrant({
      operationId: "writeback-conflict-report",
      workspaceId: dispatch.workspaceId,
      projectId: dispatch.projectId,
      hostId: dispatch.hostId,
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      permission: "report_write",
      expectedSha256: artifact.sha256,
      expectedSizeBytes: artifact.sizeBytes,
      expectedMediaType: artifact.mediaType
    });
    fixture.artifactAuthorization.acceptOutputUpload(
      {
        workspaceId: dispatch.workspaceId,
        projectId: dispatch.projectId,
        hostId: dispatch.hostId,
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        grantId: grant.grantId
      },
      artifact
    );

    // Park durable complete evidence without finishing writeback yet.
    const parkSpy = vi
      .spyOn(fixture.coordinator, "complete")
      .mockRejectedValueOnce(new Error("injected_writeback_delay"));
    await expect(
      fixture.dispatches.complete(
        dispatch.hostId,
        "park-writeback-conflict",
        dispatch.id,
        dispatch.leaseId,
        dispatch.executionAttemptId,
        {
          summary: "Host claimed completion with an unusable report.",
          reportArtifactRef: artifact.ref,
          artifactRefs: []
        }
      )
    ).rejects.toThrowError("injected_writeback_delay");
    parkSpy.mockRestore();
    expect(fixture.dispatches.getRequired(dispatch.id).status).toBe("awaiting_writeback");

    vi.spyOn(fixture.runtime, "complete").mockRejectedValueOnce(
      new RemoteBlockRuntimeError(
        "remote_block_result_conflict",
        "Remote review result for 'T-001#R-001' is not valid review-result JSON."
      )
    );

    await expect(fixture.coordinator.reenter(outcome.operation.id)).resolves.toMatchObject({
      status: "terminal"
    });
    expect(fixture.operations.getRequired(outcome.operation.id).state).toBe("failed");
    expect(fixture.dispatches.getRequired(dispatch.id).status).toBe("failed");
    expect(
      fixture.server.database
        .prepare("SELECT diagnostic_code FROM remote_operations WHERE id=?")
        .get(outcome.operation.id)
    ).toEqual({ diagnostic_code: "remote_block_result_conflict" });
  });

  it("reenterPending seals one writeback domain failure without aborting the batch", async () => {
    const fixture = await setup(true);
    if (!fixture.host) throw new Error("expected_test_host");
    const { RemoteBlockRuntimeError } = await import("@planweave-ai/runtime");
    const first = await fixture.coordinator.dispatch(
      endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: fixture.locator,
        blockRef: "T-001#B-001",
        idempotencyKey: "dispatch-reenter-pending-isolate-a"
      })
    );
    const report = Buffer.from("# Remote result\n\nBatch isolation report.\n");
    const artifact = await fixture.artifacts.put({
      expectedSha256: createHash("sha256").update(report).digest("hex"),
      expectedSizeBytes: report.byteLength,
      mediaType: "text/markdown",
      chunks: (async function* () {
        yield report;
      })()
    });
    const dispatch = fixture.dispatches.getRequired(first.operation.dispatchId);
    fixture.dispatches.accept(
      fixture.host.id,
      "accept-reenter-pending-isolate",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    const grant = fixture.artifactAuthorization.createOutputGrant({
      operationId: "reenter-pending-isolate-report",
      workspaceId: dispatch.workspaceId,
      projectId: dispatch.projectId,
      hostId: dispatch.hostId,
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      permission: "report_write",
      expectedSha256: artifact.sha256,
      expectedSizeBytes: artifact.sizeBytes,
      expectedMediaType: artifact.mediaType
    });
    fixture.artifactAuthorization.acceptOutputUpload(
      {
        workspaceId: dispatch.workspaceId,
        projectId: dispatch.projectId,
        hostId: dispatch.hostId,
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        grantId: grant.grantId
      },
      artifact
    );
    const parkSpy = vi
      .spyOn(fixture.coordinator, "complete")
      .mockRejectedValueOnce(new Error("injected_writeback_delay"));
    await expect(
      fixture.dispatches.complete(
        dispatch.hostId,
        "park-reenter-pending-isolate",
        dispatch.id,
        dispatch.leaseId,
        dispatch.executionAttemptId,
        {
          summary: "Parked for batch isolation.",
          reportArtifactRef: artifact.ref,
          artifactRefs: []
        }
      )
    ).rejects.toThrowError("injected_writeback_delay");
    parkSpy.mockRestore();

    // Force reenter's early writeback to throw a domain failure so reenterPending
    // must classify + seal without aborting the batch.
    vi.spyOn(fixture.coordinator, "complete").mockRejectedValueOnce(
      new RemoteBlockRuntimeError(
        "remote_block_source_changed",
        "Remote source changed before writeback."
      )
    );

    await expect(fixture.coordinator.reenterPending()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "terminal" })])
    );
    expect(fixture.operations.getRequired(first.operation.id).state).toBe("failed");
    expect(fixture.dispatches.getRequired(dispatch.id).status).toBe("failed");
    expect(
      fixture.server.database
        .prepare("SELECT diagnostic_code FROM remote_operations WHERE id=?")
        .get(first.operation.id)
    ).toEqual({ diagnostic_code: "remote_block_source_changed" });
  });

  it("D2: dispatches an unbound fleet host to completion with ownerPackageLocator in the envelope", async () => {
    const fixture = await setupFleetUnboundHost();
    const endpoint = fixture.agentEndpoints.listVisibleFleet().items[0];
    if (!endpoint) throw new Error("expected_fleet_endpoint");
    expect(endpoint.status).toBe("available");

    const outcome = await fixture.coordinator.dispatch({
      ...fixture.locator,
      blockRef: "T-001#B-001",
      idempotencyKey: "fleet-unbound-dispatch",
      agentEndpointId: endpoint.endpointId,
      controlPlane: "owner",
      expectedResponsibilityRevision: 0,
      expectedReviewerRevision: 0
    });
    expect(outcome.status).toBe("activated");

    const expectedLocator = ownerPackageLocatorForRun({
      projectId: fixture.locator.projectId,
      canvasId: fixture.locator.canvasId
    });
    expect(fixture.mailbox.listAfter(fixture.host?.id ?? "", 0)[0]?.command).toMatchObject({
      envelope: {
        ownerPackageLocator: expectedLocator
      }
    });

    await completeDispatchToTerminal(fixture, outcome);
    expect(fixture.operations.getRequired(outcome.operation.id).state).toBe("completed");
    await expect(
      fixture.runtime.query({ ref: "T-001#B-001", operationId: outcome.operation.id })
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("lets canvas concurrency admit multiple Owner Fleet operations beyond collaboration Host capacity", async () => {
    const manifest = remoteManifest();
    const secondTask = basicManifest({ includeSecondTask: true }).nodes.find(
      (node) => node.id === "T-002"
    );
    if (!secondTask) throw new Error("expected_second_task");
    manifest.nodes.push(secondTask);
    manifest.execution.parallel = { enabled: true, maxConcurrent: 2 };
    const fixture = await setupFleetUnboundHost(manifest);
    const endpoint = fixture.agentEndpoints.listVisibleFleet().items[0];
    if (!endpoint) throw new Error("expected_fleet_endpoint");

    const dispatchOwner = (blockRef: string, idempotencyKey: string) =>
      fixture.coordinator.dispatch({
        ...fixture.locator,
        blockRef,
        idempotencyKey,
        agentEndpointId: endpoint.endpointId,
        controlPlane: "owner",
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0
      });

    const first = await dispatchOwner("T-001#B-001", "owner-capacity-first");
    const second = await dispatchOwner("T-002#B-001", "owner-capacity-second");

    expect(first.status).toBe("activated");
    expect(second.status).toBe("activated");
    expect(fixture.mailbox.listAfter(fixture.host.id, 0)).toHaveLength(2);
    expect(fixture.reservations.activeCountsForHosts([fixture.host.id]).get(fixture.host.id)).toBe(
      0
    );
    expect(
      fixture.server.database
        .prepare(
          "SELECT COUNT(*) AS active FROM host_capacity_reservations WHERE host_id=? AND status='active'"
        )
        .get(fixture.host.id)
    ).toEqual({ active: 2 });
  });
});
