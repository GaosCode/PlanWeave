import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDispatchCoordination } from "./support/testDispatchCoordination.js";
import { ArtifactStore } from "../artifacts.js";
import type { DispatchRecord } from "../dispatches.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { executionEnvelopeFor } from "./protocolTestFixtures.js";
import { createRemoteDispatchFixture } from "./support/remoteDispatchFixture.js";
import { ActivityRepository } from "../comments/activityRepository.js";
import { ActivityProjectionService } from "../comments/service.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { HostReservationRepository } from "../hostReservations.js";
import { HumanObserverJournal } from "../humanObserverJournal.js";
import { observerEventForDispatchProgress } from "../humanObserverActivity.js";
import { RemoteOperationRepository } from "../remoteOperations.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];
const reportBytes = Buffer.from("accepted dispatch report");
const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
const reportArtifactRef = `artifact:sha256:${reportSha256}`;

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function createServer(): Promise<PlanweaveServer> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-dispatch-"));
  directories.push(dataDirectory);
  const server = await startPlanweaveServer({
    dataDirectory,
    databasePath: join(dataDirectory, "server.sqlite"),
    busyTimeoutMs: 5000
  });
  servers.push(server);
  return server;
}

async function acceptReportArtifact(
  server: PlanweaveServer,
  coordination: ReturnType<typeof createTestDispatchCoordination>,
  dispatch: DispatchRecord,
  hostId: string
): Promise<void> {
  const grant = coordination.artifactAuthorization.createOutputGrant({
    operationId: `report:${dispatch.id}`,
    workspaceId: dispatch.workspaceId,
    projectId: dispatch.projectId,
    hostId,
    dispatchId: dispatch.id,
    leaseId: dispatch.leaseId,
    executionAttemptId: dispatch.executionAttemptId,
    permission: "report_write",
    expectedSha256: reportSha256,
    expectedSizeBytes: reportBytes.byteLength,
    expectedMediaType: "text/markdown"
  });
  const artifacts = new ArtifactStore(server.database, server.config.dataDirectory, 1024 * 1024);
  const artifact = await artifacts.put({
    expectedSha256: reportSha256,
    expectedSizeBytes: reportBytes.byteLength,
    mediaType: "text/markdown",
    chunks: (async function* () {
      yield reportBytes;
    })()
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
}

describe("DispatchService (test-only thin stack)", () => {
  it("rolls back a durable dispatch transition when activity projection fails", async () => {
    const server = await createServer();
    const activity = new ActivityRepository(server.database);
    const projection = new ActivityProjectionService({ activity });
    const coordination = createTestDispatchCoordination(server.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: { complete: async () => {}, fail: async () => {} },
      onActivityTransitionInTransaction: (input) => {
        projection.projectRemoteRunEventInCallerTransaction({
          projectId: input.dispatch.projectId,
          type: input.type,
          dispatchId: input.dispatch.id,
          hostId: input.dispatch.hostId,
          occurredAt: input.occurredAt
        });
        throw new Error("activity_projection_failed");
      }
    });
    const registration = coordination.hosts.register("Projection Failure Host");
    coordination.hosts.reportOnline(registration.host.id, ["linux"], 1);
    const dispatch = createRemoteDispatchFixture(
      server.database,
      coordination,
      executionEnvelopeFor("T-001#B-ROLLBACK", ["linux"])
    );

    expect(() =>
      coordination.dispatches.accept(
        registration.host.id,
        "accept-projection-failure",
        dispatch.id,
        dispatch.leaseId,
        dispatch.executionAttemptId
      )
    ).toThrow("activity_projection_failed");
    expect(coordination.dispatches.getRequired(dispatch.id).status).toBe("leased");
    expect(
      server.database
        .prepare("SELECT 1 FROM host_event_receipts WHERE message_id=?")
        .get("accept-projection-failure")
    ).toBeUndefined();
    expect(server.database.prepare("SELECT COUNT(*) AS count FROM activity_records").get()).toEqual(
      {
        count: 0
      }
    );
    expect(
      server.database.prepare("SELECT COUNT(*) AS count FROM activity_projection_outbox").get()
    ).toEqual({ count: 0 });
  });

  it("projects started, interrupted, succeeded, and failed durable transitions but not cancellation", async () => {
    const server = await createServer();
    const activity = new ActivityRepository(server.database);
    const projection = new ActivityProjectionService({ activity });
    const coordination = createTestDispatchCoordination(server.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: { complete: async () => {}, fail: async () => {} },
      onActivityTransitionInTransaction: (input) => {
        projection.projectRemoteRunEventInCallerTransaction({
          projectId: input.dispatch.projectId,
          type: input.type,
          dispatchId: input.dispatch.id,
          hostId: input.dispatch.hostId,
          occurredAt: input.occurredAt
        });
      }
    });
    const registration = coordination.hosts.register("Activity Host");
    coordination.hosts.reportOnline(registration.host.id, ["linux"], 4);

    const interrupted = createRemoteDispatchFixture(
      server.database,
      coordination,
      executionEnvelopeFor("T-001#B-INTERRUPTED", ["linux"])
    );
    coordination.dispatches.accept(
      registration.host.id,
      "activity-accept-interrupted",
      interrupted.id,
      interrupted.leaseId,
      interrupted.executionAttemptId
    );
    coordination.dispatches.interrupt(registration.host.id, "activity-interrupt", {
      type: "dispatch.interrupted",
      dispatchId: interrupted.id,
      leaseId: interrupted.leaseId,
      executionAttemptId: interrupted.executionAttemptId,
      reason: "host_restart",
      resumable: false
    });

    const succeeded = createRemoteDispatchFixture(
      server.database,
      coordination,
      executionEnvelopeFor("T-001#B-SUCCEEDED", ["linux"])
    );
    coordination.dispatches.accept(
      registration.host.id,
      "activity-accept-succeeded",
      succeeded.id,
      succeeded.leaseId,
      succeeded.executionAttemptId
    );
    await acceptReportArtifact(server, coordination, succeeded, registration.host.id);
    await coordination.dispatches.complete(
      registration.host.id,
      "activity-complete",
      succeeded.id,
      succeeded.leaseId,
      succeeded.executionAttemptId,
      { summary: "Done", reportArtifactRef, artifactRefs: [reportArtifactRef] }
    );

    const failed = createRemoteDispatchFixture(
      server.database,
      coordination,
      executionEnvelopeFor("T-001#B-FAILED", ["linux"])
    );
    coordination.dispatches.accept(
      registration.host.id,
      "activity-accept-failed",
      failed.id,
      failed.leaseId,
      failed.executionAttemptId
    );
    await coordination.dispatches.fail(
      registration.host.id,
      "activity-fail",
      failed.id,
      failed.leaseId,
      failed.executionAttemptId,
      { code: "agent_error", message: "Failed", retryable: false }
    );

    const cancelled = createRemoteDispatchFixture(
      server.database,
      coordination,
      executionEnvelopeFor("T-001#B-CANCELLED", ["linux"])
    );
    coordination.dispatches.accept(
      registration.host.id,
      "activity-accept-cancelled",
      cancelled.id,
      cancelled.leaseId,
      cancelled.executionAttemptId
    );
    await coordination.dispatches.fail(
      registration.host.id,
      "activity-cancel",
      cancelled.id,
      cancelled.leaseId,
      cancelled.executionAttemptId,
      { code: "execution_cancelled", message: "Cancelled", retryable: false }
    );

    const events = activity.list({ projectId: "project-a", limit: 20 });
    const byDispatch = (dispatchId: string) =>
      events.filter((event) => event.summary.dispatchId === dispatchId).map((event) => event.type);
    expect(byDispatch(interrupted.id)).toEqual(
      expect.arrayContaining(["remote_run_started", "remote_run_interrupted"])
    );
    expect(byDispatch(succeeded.id)).toEqual(
      expect.arrayContaining(["remote_run_started", "remote_run_succeeded"])
    );
    expect(byDispatch(failed.id)).toEqual(
      expect.arrayContaining(["remote_run_started", "remote_run_failed"])
    );
    expect(byDispatch(cancelled.id)).toEqual(["remote_run_started"]);
  });

  it("selects a compatible online host and writes a completed result back", async () => {
    const server = await createServer();
    const complete = vi.fn(async () => {});
    const fail = vi.fn(async () => {});
    const coordination = createTestDispatchCoordination(server.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: { complete, fail }
    });
    const registration = coordination.hosts.register("Linux Builder");
    const workspaceId = new WorkspaceIdentityRepository(
      server.database
    ).ensureWorkspaceForLegacyProject("project-a");
    coordination.hosts.bindToWorkspace(registration.host.id, workspaceId);

    expect(registration.token).toMatch(/^pw_host_/);
    expect(coordination.hosts.authenticate(registration.host.id, registration.token)?.id).toBe(
      registration.host.id
    );
    expect(
      server.database
        .prepare("SELECT credential_hash FROM agent_hosts WHERE id=?")
        .get(registration.host.id)?.credential_hash
    ).not.toBe(registration.token);

    coordination.hosts.reportOnline(registration.host.id, ["linux", "node-22"], 2);
    const dispatch = createRemoteDispatchFixture(
      server.database,
      coordination,
      executionEnvelopeFor("T-001#B-001", ["linux", "node-22"])
    );

    const messages = coordination.mailbox.listAfter(registration.host.id, 0);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.command).toMatchObject({
      type: "execute_block",
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId
    });
    expect(
      coordination.dispatches.accept(
        registration.host.id,
        "accept-1",
        dispatch.id,
        dispatch.leaseId,
        dispatch.executionAttemptId
      ).status
    ).toBe("running");
    expect(() =>
      coordination.dispatches.accept(
        registration.host.id,
        "accept-1",
        dispatch.id,
        "different-lease",
        dispatch.executionAttemptId
      )
    ).toThrowError("host_event_message_id_reused");

    await acceptReportArtifact(server, coordination, dispatch, registration.host.id);

    const previousExpiry = dispatch.leaseExpiresAt;
    const renewed = coordination.dispatches.heartbeat(registration.host.id, "heartbeat-1", [
      {
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId
      }
    ]);
    expect(renewed).toHaveLength(1);
    expect(renewed[0]?.leaseExpiresAt).toBe(previousExpiry);
    expect(
      server.database
        .prepare("SELECT COUNT(*) AS count FROM dispatch_events WHERE dispatch_id=? AND type=?")
        .get(dispatch.id, "lease.renewed")
    ).toEqual({ count: 0 });

    const renewalTime = new Date(new Date(previousExpiry).getTime() - 30_000);
    const attemptBeforeRenewal = server.database
      .prepare(
        "SELECT lease_expires_at AS leaseExpiry,state_version AS stateVersion FROM remote_execution_attempts WHERE execution_attempt_id=?"
      )
      .get(dispatch.executionAttemptId) as { leaseExpiry: string; stateVersion: number };
    const inconsistentAttemptExpiry = new Date(
      new Date(previousExpiry).getTime() + 1
    ).toISOString();
    server.database
      .prepare(
        "UPDATE remote_execution_attempts SET lease_expires_at=? WHERE execution_attempt_id=?"
      )
      .run(inconsistentAttemptExpiry, dispatch.executionAttemptId);
    expect(() =>
      coordination.dispatches.renewLeaseForActivity(
        registration.host.id,
        {
          dispatchId: dispatch.id,
          leaseId: dispatch.leaseId,
          executionAttemptId: dispatch.executionAttemptId
        },
        renewalTime
      )
    ).toThrowError("remote_lease_authority_inconsistent");
    expect(
      server.database
        .prepare(
          `SELECT
             d.lease_expires_at AS dispatch_expiry,
             r.lease_expires_at AS reservation_expiry,
             a.lease_expires_at AS attempt_expiry
           FROM dispatches d
           JOIN host_capacity_reservations r ON r.lease_id=d.lease_id
           JOIN remote_execution_attempts a
             ON a.execution_attempt_id=d.execution_attempt_id
           WHERE d.id=?`
        )
        .get(dispatch.id)
    ).toEqual({
      dispatch_expiry: previousExpiry,
      reservation_expiry: previousExpiry,
      attempt_expiry: inconsistentAttemptExpiry
    });
    expect(
      server.database
        .prepare("SELECT COUNT(*) AS count FROM dispatch_events WHERE dispatch_id=? AND type=?")
        .get(dispatch.id, "lease.renewed")
    ).toEqual({ count: 0 });
    server.database
      .prepare(
        "UPDATE remote_execution_attempts SET lease_expires_at=? WHERE execution_attempt_id=?"
      )
      .run(previousExpiry, dispatch.executionAttemptId);
    const activityRenewal = coordination.dispatches.renewLeaseForActivity(
      registration.host.id,
      {
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId
      },
      renewalTime
    );
    expect(activityRenewal?.leaseExpiresAt).toBe(
      new Date(renewalTime.getTime() + 60_000).toISOString()
    );
    expect(
      server.database
        .prepare(
          `SELECT
             d.lease_expires_at AS dispatch_expiry,
             r.lease_expires_at AS reservation_expiry,
             a.lease_expires_at AS attempt_expiry
           FROM dispatches d
           JOIN host_capacity_reservations r ON r.lease_id=d.lease_id
           JOIN remote_execution_attempts a
             ON a.execution_attempt_id=d.execution_attempt_id
           WHERE d.id=?`
        )
        .get(dispatch.id)
    ).toEqual({
      dispatch_expiry: activityRenewal?.leaseExpiresAt,
      reservation_expiry: activityRenewal?.leaseExpiresAt,
      attempt_expiry: activityRenewal?.leaseExpiresAt
    });
    const afterOriginalExpiry = new Date(new Date(previousExpiry).getTime() + 1);
    const reservations = new HostReservationRepository(server.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      clock: () => afterOriginalExpiry
    });
    expect(reservations.expireDue()).toEqual([]);
    expect(reservations.getRequired(dispatch.leaseId).status).toBe("active");
    expect(
      server.database
        .prepare(
          "SELECT state_version AS stateVersion FROM remote_execution_attempts WHERE execution_attempt_id=?"
        )
        .get(dispatch.executionAttemptId)
    ).toEqual({ stateVersion: attemptBeforeRenewal.stateVersion });
    expect(
      server.database
        .prepare("SELECT COUNT(*) AS count FROM dispatch_events WHERE dispatch_id=? AND type=?")
        .get(dispatch.id, "lease.renewed")
    ).toEqual({ count: 1 });

    const result = {
      summary: "Block completed.",
      reportArtifactRef,
      artifactRefs: [reportArtifactRef]
    };
    const completed = await coordination.dispatches.complete(
      registration.host.id,
      "complete-1",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId,
      result
    );
    expect(completed.status).toBe("completed");
    expect(complete).toHaveBeenCalledWith({
      dispatchId: dispatch.id,
      hostId: registration.host.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      projectId: "project-a",
      blockRef: "T-001#B-001",
      result
    });
    // Writeback identity is dispatch/lease/attempt/block — not residual packageRef.
    expect(complete.mock.calls[0]?.[0]).not.toHaveProperty("packageRef");
    expect(dispatch).not.toHaveProperty("packageRef");
    expect(fail).not.toHaveBeenCalled();

    coordination.mailbox.acknowledge(
      registration.host.id,
      "ack-direct-1",
      messages[0]?.sequence ?? 0
    );
    expect(coordination.hosts.getRequired(registration.host.id).lastAcknowledgedSequence).toBe(
      messages[0]?.sequence
    );
  });

  it("keeps a result pending when runtime writeback fails and retries it", async () => {
    const server = await createServer();
    let rejectWriteback = true;
    const coordination = createTestDispatchCoordination(server.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: {
        complete: async () => {
          if (rejectWriteback) throw new Error("runtime unavailable");
        },
        fail: async () => {}
      }
    });
    const registration = coordination.hosts.register("Recovery Host");
    coordination.hosts.reportOnline(registration.host.id, ["linux"], 1);
    const dispatch = createRemoteDispatchFixture(
      server.database,
      coordination,
      executionEnvelopeFor("T-001#B-002", ["linux"])
    );
    coordination.dispatches.accept(
      registration.host.id,
      "accept-2",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    await acceptReportArtifact(server, coordination, dispatch, registration.host.id);

    await expect(
      coordination.dispatches.complete(
        registration.host.id,
        "complete-2",
        dispatch.id,
        dispatch.leaseId,
        dispatch.executionAttemptId,
        { summary: "Done", reportArtifactRef, artifactRefs: [] }
      )
    ).rejects.toThrowError("runtime unavailable");
    expect(coordination.dispatches.getRequired(dispatch.id).status).toBe("awaiting_writeback");

    rejectWriteback = false;
    await expect(coordination.dispatches.retryPendingWritebacks()).resolves.toMatchObject([
      { id: dispatch.id, status: "completed" }
    ]);
  });

  it("rejects mismatched leases and hosts without required capabilities", async () => {
    const server = await createServer();
    const coordination = createTestDispatchCoordination(server.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: { complete: async () => {}, fail: async () => {} }
    });
    const registration = coordination.hosts.register("macOS Host");
    coordination.hosts.reportOnline(registration.host.id, ["macos"], 1);

    expect(() =>
      createRemoteDispatchFixture(
        server.database,
        coordination,
        executionEnvelopeFor("T-001#B-003", ["linux"])
      )
    ).toThrowError("no_compatible_agent_host");

    const dispatch = createRemoteDispatchFixture(
      server.database,
      coordination,
      executionEnvelopeFor("T-001#B-013", ["macos"])
    );
    // Stale lease/attempt identities soft-drop so Host reconnect races do not kill the WS.
    expect(
      coordination.dispatches.accept(
        registration.host.id,
        "accept-invalid",
        dispatch.id,
        "wrong-lease",
        dispatch.executionAttemptId
      )
    ).toMatchObject({ id: dispatch.id, status: "leased", leaseId: dispatch.leaseId });
    expect(
      coordination.dispatches.accept(
        registration.host.id,
        "accept-wrong-attempt",
        dispatch.id,
        dispatch.leaseId,
        "wrong-attempt"
      )
    ).toMatchObject({ id: dispatch.id, status: "leased" });
  });

  it("persists an interrupted dispatch across server reopen without making it pending", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-dispatch-interrupted-"));
    directories.push(dataDirectory);
    const databasePath = join(dataDirectory, "server.sqlite");
    const first = await startPlanweaveServer({
      dataDirectory,
      databasePath,
      busyTimeoutMs: 5000
    });
    servers.push(first);
    const coordination = createTestDispatchCoordination(first.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: { complete: async () => {}, fail: async () => {} }
    });
    const registration = coordination.hosts.register("Restarted Host");
    coordination.hosts.reportOnline(registration.host.id, ["linux"], 1);
    const dispatch = createRemoteDispatchFixture(
      first.database,
      coordination,
      executionEnvelopeFor("T-001#B-005", ["linux"])
    );
    coordination.dispatches.accept(
      registration.host.id,
      "accept-interrupted",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    first.close();
    servers.pop();

    const reopened = await startPlanweaveServer({
      dataDirectory,
      databasePath,
      busyTimeoutMs: 5000
    });
    servers.push(reopened);
    const reopenedCoordination = createTestDispatchCoordination(reopened.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: { complete: async () => {}, fail: async () => {} }
    });
    reopenedCoordination.dispatches.interrupt(registration.host.id, "interrupt-reopen", {
      type: "dispatch.interrupted",
      protocolVersion: 1,
      messageId: "interrupt-reopen",
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      reason: "host_restart",
      resumable: true,
      recovery: { acpSessionId: "session-reopen", recoveryId: "recovery-reopen" }
    });
    expect(reopened.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    reopened.close();
    servers.pop();

    const persisted = await startPlanweaveServer({
      dataDirectory,
      databasePath,
      busyTimeoutMs: 5000
    });
    servers.push(persisted);
    const persistedCoordination = createTestDispatchCoordination(persisted.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: { complete: async () => {}, fail: async () => {} }
    });
    expect(persistedCoordination.dispatches.getRequired(dispatch.id)).toMatchObject({
      status: "interrupted",
      interruption: {
        reason: "host_restart",
        resumable: true,
        recovery: { acpSessionId: "session-reopen", recoveryId: "recovery-reopen" }
      }
    });
    expect(
      persisted.database
        .prepare("SELECT COUNT(*) AS count FROM dispatch_events WHERE dispatch_id=?")
        .get(dispatch.id)?.count
    ).toBeGreaterThan(0);
    expect(persisted.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    await expect(
      persistedCoordination.dispatches.fail(
        registration.host.id,
        "unrequested-interrupted-cancel",
        dispatch.id,
        dispatch.leaseId,
        dispatch.executionAttemptId,
        {
          code: "execution_cancelled",
          message: "Cancellation was not requested.",
          retryable: false
        }
      )
    ).resolves.toMatchObject({ id: dispatch.id, status: "interrupted" });
    await expect(persistedCoordination.dispatches.recoverExpiredLeases()).resolves.toEqual([]);
  });

  it("interrupts expired work without automatic failure and still accepts late terminal results", async () => {
    const server = await createServer();
    const fail = vi.fn(async () => {});
    const complete = vi.fn(async () => {});
    const coordination = createTestDispatchCoordination(server.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: { complete, fail }
    });
    const registration = coordination.hosts.register("Expiring Host");
    coordination.hosts.reportOnline(registration.host.id, ["linux"], 1);
    const dispatch = createRemoteDispatchFixture(
      server.database,
      coordination,
      executionEnvelopeFor("T-001#B-004", ["linux"]),
      { leaseDurationMs: 1_000 }
    );
    coordination.dispatches.accept(
      registration.host.id,
      "accept-expiring",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    // Report grant must be accepted while the dispatch is still running.
    await acceptReportArtifact(server, coordination, dispatch, registration.host.id);
    server.database
      .prepare("UPDATE dispatches SET lease_expires_at=? WHERE id=?")
      .run("2020-01-01T00:00:00.000Z", dispatch.id);

    await expect(
      coordination.dispatches.recoverExpiredLeases(new Date("2020-01-01T00:00:01.000Z"))
    ).resolves.toMatchObject([
      {
        id: dispatch.id,
        status: "interrupted",
        interruption: { reason: "lease_lost", resumable: false }
      }
    ]);
    expect(fail).not.toHaveBeenCalled();
    // Host may still finish after Server-side lease recovery — accept late complete so UI
    // does not stick on a false transport_failed / lease_lost materialization.
    await expect(
      coordination.dispatches.complete(
        registration.host.id,
        "late-result",
        dispatch.id,
        dispatch.leaseId,
        dispatch.executionAttemptId,
        {
          summary: "Finished after lease recovery",
          reportArtifactRef,
          artifactRefs: [reportArtifactRef]
        }
      )
    ).resolves.toMatchObject({
      id: dispatch.id,
      status: "completed"
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(fail).not.toHaveBeenCalled();
  });

  it("projects dispatch progress onto the human observer journal", async () => {
    const server = await createServer();
    const journal = new HumanObserverJournal(server.database, 100);
    const operations = new RemoteOperationRepository(server.database);
    const projected: Array<Record<string, unknown>> = [];
    const coordination = createTestDispatchCoordination(server.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: { complete: async () => {}, fail: async () => {} },
      onProgressInTransaction: (input) => {
        const operation = operations.getByDispatchId(input.dispatch.id);
        if (!operation) throw new Error("remote_operation_missing_for_progress");
        projected.push(
          journal.appendInCallerTransaction(
            {
              workspaceId: input.dispatch.workspaceId,
              projectId: input.dispatch.projectId
            },
            observerEventForDispatchProgress({
              dispatchId: input.dispatch.id,
              canvasId: operation.canvasId,
              blockRef: input.dispatch.blockRef
            }),
            input.occurredAt
          )
        );
      }
    });
    const registration = coordination.hosts.register("Progress Host");
    coordination.hosts.reportOnline(registration.host.id, ["linux"], 1);
    const dispatch = createRemoteDispatchFixture(
      server.database,
      coordination,
      executionEnvelopeFor("T-001#B-PROGRESS", ["linux"])
    );
    coordination.dispatches.accept(
      registration.host.id,
      "progress-accept",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );

    coordination.dispatches.recordProgress(registration.host.id, "progress-1", {
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      percent: 40,
      message: "running"
    });

    expect(projected).toEqual([
      expect.objectContaining({
        kind: "remote_run",
        remoteRunStatus: "progress",
        dispatchId: dispatch.id,
        workItem: {
          kind: "block",
          canvasId: "default",
          blockRef: "T-001#B-PROGRESS"
        }
      })
    ]);
  });
});
