import { createHash } from "node:crypto";
import {
  createRemoteBlockArtifactSource,
  getTaskWorkspaceRunDetail,
  RemoteBlockRuntimeError
} from "@planweave-ai/runtime";
import { describe, expect, it, vi } from "vitest";
import { AgentEndpointCatalogError } from "../agentEndpointCatalog.js";
import { canonicalRemoteRuntimePort } from "../canonicalRemoteRuntimePort.js";
import { endpointDispatchRequest } from "./support/endpointCoordinatorFixture.js";
import { remoteManifest, setup } from "./support/remoteBlockCoordinatorFixture.js";

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
});
