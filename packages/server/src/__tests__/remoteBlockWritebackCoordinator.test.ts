import { createHash } from "node:crypto";
import {
  createRemoteBlockArtifactSource,
  getTaskWorkspaceRunDetail,
  RemoteBlockRuntimeError,
  type RemoteBlockArtifactSource,
  type RemoteBlockRuntimePort
} from "@planweave-ai/runtime";
import { describe, expect, it, vi } from "vitest";
import { AgentEndpointCatalogError } from "../agentEndpointCatalog.js";
import { canonicalRemoteRuntimePort } from "../canonicalRemoteRuntimePort.js";
import { endpointDispatchRequest } from "./support/endpointCoordinatorFixture.js";
import { seedLegacyRemoteOperation } from "./support/legacyRemoteOperationSeed.js";
import { remoteManifest, setup } from "./support/remoteBlockCoordinatorFixture.js";

function useTargetAndDecoyAttemptRuntimeRoute(
  fixture: Awaited<ReturnType<typeof setup>>,
  targetHostId: string | undefined
) {
  // biome-ignore lint/complexity/useLiteralKeys: the strict test route replaces a private injected dependency.
  const route = fixture.coordinator["options"].runtimeLeases;
  const acquire = vi.spyOn(route, "acquire").mockImplementation(() => {
    throw new Error("generic_runtime_acquire_forbidden");
  });
  const decoyHostId = fixture.hosts.register("Decoy Runtime Host").host.id;
  const decoyTransport = vi.fn();
  const decoyMaterialize = vi.fn();
  const decoyRuntime = {
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
  } satisfies RemoteBlockRuntimePort;
  const decoyArtifacts = { read: vi.fn() } satisfies RemoteBlockArtifactSource;
  const acquireForHost = vi.spyOn(route, "acquireForHost").mockImplementation((scope, hostId) => {
    if (targetHostId && hostId === targetHostId) return fixture.registry.acquire(scope);
    if (hostId !== decoyHostId) throw new Error("unexpected_runtime_host");
    decoyTransport(scope, hostId);
    decoyMaterialize(scope, hostId);
    return {
      runtime: decoyRuntime,
      artifacts: decoyArtifacts,
      release: vi.fn()
    };
  });
  return {
    acquire,
    acquireForHost,
    decoyHostId,
    decoyTransport,
    decoyMaterialize,
    decoyRuntime
  };
}

function expectDecoyRuntimeUnused(
  route: ReturnType<typeof useTargetAndDecoyAttemptRuntimeRoute>
): void {
  expect(route.decoyTransport).not.toHaveBeenCalled();
  expect(route.decoyMaterialize).not.toHaveBeenCalled();
  expect(route.decoyRuntime.query).not.toHaveBeenCalled();
  expect(route.decoyRuntime.complete).not.toHaveBeenCalled();
  expect(route.decoyRuntime.fail).not.toHaveBeenCalled();
}

describe("RemoteBlockCoordinator Runtime lease and terminal writeback", () => {
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
        readInitializationEvidence: fixture.runtimeInitializationEvidenceFor(fixture.locator),
        release: vi.fn()
      };
      bindings.push(binding);
      return binding;
    });

    await fixture.coordinator.dispatch(
      endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: fixture.dispatchLocator,
        blockRef: "T-001#B-001",
        idempotencyKey: "lease-artifact-binding"
      })
    );

    expect(bindings).toHaveLength(1);
    expect(fixture.materialize).toHaveBeenCalledWith(
      expect.objectContaining({ blockRef: "T-001#B-001" }),
      bindings[0]!.artifacts
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
        readInitializationEvidence: failureFixture.runtimeInitializationEvidenceFor(
          failureFixture.locator
        ),
        release
      };
    });
    failureFixture.materialize.mockRejectedValueOnce(new Error("injected_materialize_failure"));
    await expect(
      failureFixture.coordinator.dispatch(
        endpointDispatchRequest({
          agentEndpoints: failureFixture.agentEndpoints,
          locator: failureFixture.dispatchLocator,
          blockRef: "T-001#B-001",
          idempotencyKey: "lease-artifact-release-failure"
        })
      )
    ).rejects.toThrow("injected_materialize_failure");
    expect(failedReleases).toHaveLength(1);
    for (const release of failedReleases) expect(release).toHaveBeenCalledOnce();
  });

  it("classifies a Runtime acquire failure and continues reentering later operations", async () => {
    const fixture = await setup(true, remoteManifest(true), 2);
    await fixture.coordinator.dispatch(
      endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: fixture.dispatchLocator,
        blockRef: "T-001#B-001",
        idempotencyKey: "acquire-failure-first"
      })
    );
    await fixture.coordinator.dispatch(
      endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: fixture.dispatchLocator,
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
        readInitializationEvidence: fixture.runtimeInitializationEvidenceFor(fixture.locator),
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

  it("does not consult Host inspect after Server candidate acceptance", async () => {
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
          locator: fixture.dispatchLocator,
          blockRef: "T-001#B-001",
          idempotencyKey: "dispatch-source-change-reinspect"
        })
      )
    ).resolves.toMatchObject({ status: "activated" });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("does not let a Host inspect failure replace Server candidate authority", async () => {
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
          locator: fixture.dispatchLocator,
          blockRef: "T-001#B-001",
          idempotencyKey: "dispatch-repeated-source-change"
        })
      )
    ).resolves.toMatchObject({ status: "activated" });
    expect(inspect).not.toHaveBeenCalled();
    expect(
      fixture.server.database.prepare("SELECT COUNT(*) AS count FROM remote_operations").get()
    ).toEqual({ count: 1 });
  });

  it("re-enters terminal completion through the Runtime authority", async () => {
    const fixture = await setup(true);
    const outcome = await fixture.coordinator.dispatch(
      endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: fixture.dispatchLocator,
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
      eventProtocolVersion: 2,
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      acpSessionId: "remote-session-001",
      afterCursor: 0,
      cursor: 1,
      events: [
        {
          eventVersion: 2,
          cursor: 1,
          sourceSequence: 1,
          timestamp: "2030-01-01T00:00:01.000Z",
          fragment: {
            kind: "runner_body",
            body: {
              kind: "message",
              role: "assistant",
              messageId: "remote-message-1",
              chunk: false,
              content: "Created the requested file on the remote Host.",
              redaction: { classes: [], replaced: 0 }
            }
          }
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
    const runtimeRoute = useTargetAndDecoyAttemptRuntimeRoute(fixture, dispatch.hostId);
    await expect(fixture.coordinator.query(outcome.operation.id)).resolves.toMatchObject({
      ownership: { phase: "active" }
    });
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
    await fixture.coordinator.complete(outcome.operation.id);
    await expect(
      fixture.runtime.query({ ref: "T-001#B-001", operationId: outcome.operation.id })
    ).resolves.toMatchObject({ status: "completed" });
    expect(runtimeRoute.acquire).not.toHaveBeenCalled();
    expect(runtimeRoute.acquireForHost.mock.calls).toEqual([
      [fixture.locator, dispatch.hostId],
      [fixture.locator, dispatch.hostId],
      [fixture.locator, dispatch.hostId]
    ]);
    expectDecoyRuntimeUnused(runtimeRoute);
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
    expect(fixture.acpEvents.replay(dispatch.executionAttemptId, 0).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventVersion: 2,
          fragment: expect.objectContaining({
            body: expect.objectContaining({
              kind: "message",
              content: "Created the requested file on the remote Host."
            })
          })
        })
      ])
    );
    expect(detail.record.runnerReadModel).toBeNull();
  });

  it("writes terminal failure through the durable attempt Host route", async () => {
    const fixture = await setup(true);
    const outcome = await fixture.coordinator.dispatch(
      endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: fixture.dispatchLocator,
        blockRef: "T-001#B-001",
        idempotencyKey: "dispatch-request-fail-exact-host"
      })
    );
    const dispatch = fixture.dispatches.getRequired(outcome.operation.dispatchId);
    fixture.dispatches.accept(
      dispatch.hostId,
      "accept-failure-exact-host",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    const runtimeRoute = useTargetAndDecoyAttemptRuntimeRoute(fixture, dispatch.hostId);

    await fixture.dispatches.fail(
      dispatch.hostId,
      "fail-coordinator-exact-host",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId,
      { code: "remote_test_failure", message: "Failed on the remote Host.", retryable: false }
    );

    expect(runtimeRoute.acquire).not.toHaveBeenCalled();
    expect(runtimeRoute.acquireForHost).toHaveBeenCalledOnce();
    expect(runtimeRoute.acquireForHost).toHaveBeenCalledWith(fixture.locator, dispatch.hostId);
    expectDecoyRuntimeUnused(runtimeRoute);
    expect(fixture.operations.getRequired(outcome.operation.id).state).toBe("failed");
    await expect(
      fixture.runtime.query({ ref: "T-001#B-001", operationId: outcome.operation.id })
    ).resolves.toMatchObject({ status: "blocked" });
  });

  it("fails query closed before a durable attempt Host is selected", async () => {
    const fixture = await setup(false);
    const candidate = await fixture.registry.resolve(fixture.locator).inspect({
      ref: "T-001#B-001"
    });
    const operation = seedLegacyRemoteOperation({
      database: fixture.server.database,
      operations: fixture.operations,
      locator: fixture.locator,
      candidate,
      idempotencyKey: "query-without-attempt-host",
      hostSelection: {
        workspaceId: fixture.locator.workspaceId,
        assignmentRevision: 0,
        target: { kind: "automatic_host" },
        selection: "automatic",
        requiredCapabilities: candidate.requiredCapabilities
      }
    });
    const runtimeRoute = useTargetAndDecoyAttemptRuntimeRoute(fixture, undefined);

    await expect(fixture.coordinator.query(operation.id)).rejects.toMatchObject({
      message: "canvas_runtime_unavailable",
      reason: "runtime_not_attached"
    });
    expect(runtimeRoute.acquire).not.toHaveBeenCalled();
    expect(runtimeRoute.acquireForHost).not.toHaveBeenCalled();
    expectDecoyRuntimeUnused(runtimeRoute);
  });

  it("seals awaiting_writeback after the host reservation expires and the endpoint goes away", async () => {
    const fixture = await setup(true);
    if (!fixture.host) throw new Error("expected_test_host");
    const outcome = await fixture.coordinator.dispatch(
      endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: fixture.dispatchLocator,
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
    const runtimeRoute = useTargetAndDecoyAttemptRuntimeRoute(fixture, dispatch.hostId);

    await expect(fixture.coordinator.reenter(outcome.operation.id)).resolves.toMatchObject({
      status: "terminal"
    });
    expect(runtimeRoute.acquire).not.toHaveBeenCalled();
    expect(runtimeRoute.acquireForHost).toHaveBeenCalledOnce();
    expect(runtimeRoute.acquireForHost).toHaveBeenCalledWith(fixture.locator, dispatch.hostId);
    expectDecoyRuntimeUnused(runtimeRoute);
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
        locator: fixture.dispatchLocator,
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
    const runtimeRoute = useTargetAndDecoyAttemptRuntimeRoute(fixture, dispatch.hostId);

    await expect(fixture.coordinator.reenter(outcome.operation.id)).resolves.toMatchObject({
      status: "terminal"
    });
    expect(runtimeRoute.acquire).not.toHaveBeenCalled();
    expect(runtimeRoute.acquireForHost).toHaveBeenCalledOnce();
    expect(runtimeRoute.acquireForHost).toHaveBeenCalledWith(fixture.locator, dispatch.hostId);
    expectDecoyRuntimeUnused(runtimeRoute);
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
        locator: fixture.dispatchLocator,
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
    const runtimeRoute = useTargetAndDecoyAttemptRuntimeRoute(fixture, dispatch.hostId);

    await expect(fixture.coordinator.reenterPending()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "terminal" })])
    );
    expect(runtimeRoute.acquire).not.toHaveBeenCalled();
    expect(runtimeRoute.acquireForHost.mock.calls).toEqual([
      [fixture.locator, dispatch.hostId],
      [fixture.locator, dispatch.hostId]
    ]);
    expectDecoyRuntimeUnused(runtimeRoute);
    expect(fixture.operations.getRequired(first.operation.id).state).toBe("failed");
    expect(fixture.dispatches.getRequired(dispatch.id).status).toBe("failed");
    expect(
      fixture.server.database
        .prepare("SELECT diagnostic_code FROM remote_operations WHERE id=?")
        .get(first.operation.id)
    ).toEqual({ diagnostic_code: "remote_block_source_changed" });
  });
});
