import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostReservationRepository } from "../../hostReservations.js";
import { AgentHostRepository } from "../../hosts.js";
import { WorkspaceIdentityRepository } from "../../identity/workspaceRepository.js";
import { startPlanweaveServer } from "../../lifecycle.js";
import { RemoteOperationRepository } from "../../remoteOperations.js";

export async function createRemoteAcpEventV2Fixture() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-remote-acp-v2-"));
  const clock = () => new Date("2030-01-01T00:00:00.000Z");
  const server = await startPlanweaveServer({
    dataDirectory: directory,
    databasePath: join(directory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  const hosts = new AgentHostRepository(server.database, clock);
  const host = hosts.register("Remote ACP v2 Host").host;
  const workspaceId = new WorkspaceIdentityRepository(
    server.database
  ).ensureWorkspaceForLegacyProject("project-remote-acp-v2");
  hosts.bindToWorkspace(host.id, workspaceId);
  hosts.reportOnline(host.id, ["linux", "acp.codex"], 2, {
    workspaceMappings: [{ workspaceId, status: "ready" }],
    acpProfiles: [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        status: "ready",
        capabilities: ["linux", "acp.codex"]
      }
    ]
  });
  const operations = new RemoteOperationRepository(server.database, clock);
  let operation = operations.markClaimed(
    operations.create({
      workspaceId,
      projectId: "project-remote-acp-v2",
      canvasId: "default",
      blockRef: "T-002#B-003",
      ownershipGeneration: "generation-v2",
      idempotencyKey: `remote-acp-v2-${directory}`,
      sourceFingerprint: "fingerprint-v2",
      requiredCapabilities: ["acp.codex"]
    }).id
  );
  const reservations = new HostReservationRepository(server.database, {
    leaseDurationMs: 60_000,
    hostOfflineAfterMs: 60_000,
    clock
  });
  const reservation = reservations.reserve(operation.id, {
    agentId: "codex",
    agentProfileId: "codex-acp"
  });
  operation = operations.getRequired(operation.id);
  server.database
    .prepare(
      `INSERT INTO dispatches(
        id,workspace_id,project_id,block_ref,host_id,required_capabilities_json,status,
        lease_id,execution_attempt_id,lease_expires_at,created_at
      ) VALUES (?,?,?,?,?,?,'running',?,?,?,?)`
    )
    .run(
      operation.dispatchId,
      operation.workspaceId,
      operation.projectId,
      operation.blockRef,
      host.id,
      JSON.stringify(operation.requiredCapabilities),
      reservation.leaseId,
      operation.executionAttemptId,
      reservation.leaseExpiresAt,
      operation.createdAt
    );
  const attempt = reservations.transition({
    leaseId: reservation.leaseId,
    fencingToken: reservation.fencingToken,
    expectedAttemptVersion: operation.attempt.stateVersion,
    status: "activated"
  });
  reservations.transition({
    leaseId: reservation.leaseId,
    fencingToken: reservation.fencingToken,
    expectedAttemptVersion: attempt.attempt.stateVersion,
    status: "running"
  });
  operation = operations.getRequired(operation.id);
  return { directory, server, host, operation, reservation, clock };
}

export function remoteAcpV2Batch(
  fixture: Awaited<ReturnType<typeof createRemoteAcpEventV2Fixture>>,
  events: unknown[],
  afterCursor = 0
) {
  return {
    type: "acp.events" as const,
    eventProtocolVersion: 2 as const,
    dispatchId: fixture.operation.dispatchId,
    leaseId: fixture.reservation.leaseId,
    executionAttemptId: fixture.operation.executionAttemptId,
    acpSessionId: "session-v2",
    afterCursor,
    cursor: afterCursor + events.length,
    events
  };
}
