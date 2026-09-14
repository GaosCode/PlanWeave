import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostReservationRepository } from "../../hostReservations.js";
import { AgentHostRepository } from "../../hosts.js";
import { WorkspaceIdentityRepository } from "../../identity/workspaceRepository.js";
import { startPlanweaveServer, type PlanweaveServer } from "../../lifecycle.js";
import { RemoteOperationRepository } from "../../remoteOperations.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];

export async function cleanupRemoteObservationsFixture() {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
}

export async function setupRemoteObservationsFixture() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-remote-observation-"));
  directories.push(directory);
  let now = new Date("2030-01-01T00:00:00.000Z");
  const clock = () => now;
  const server = await startPlanweaveServer({
    dataDirectory: directory,
    databasePath: join(directory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  servers.push(server);
  const hosts = new AgentHostRepository(server.database, clock);
  const host = hosts.register("Observation Host").host;
  const workspaceId = new WorkspaceIdentityRepository(
    server.database
  ).ensureWorkspaceForLegacyProject("project-observation");
  hosts.bindToWorkspace(host.id, workspaceId);
  hosts.reportOnline(host.id, ["linux", "acp.codex", "acp.session.load"], 2, {
    workspaceMappings: [{ workspaceId, status: "ready" }],
    acpProfiles: [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Test Agent",
        status: "ready",
        capabilities: ["linux", "acp.codex", "acp.session.load"]
      }
    ]
  });
  const operations = new RemoteOperationRepository(server.database, clock);
  let operation = operations.markClaimed(
    operations.create({
      workspaceId: workspaceIdSchema.parse(workspaceId),
      projectId: "project-observation",
      canvasId: "default",
      blockRef: "RC-003#B-002",
      ownershipGeneration: "generation-1",
      idempotencyKey: "observation-1",
      sourceFingerprint: "fingerprint-1",
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
  let attempt = reservations.transition({
    leaseId: reservation.leaseId,
    fencingToken: reservation.fencingToken,
    expectedAttemptVersion: operation.attempt.stateVersion,
    status: "activated"
  });
  attempt = reservations.transition({
    leaseId: reservation.leaseId,
    fencingToken: reservation.fencingToken,
    expectedAttemptVersion: attempt.attempt.stateVersion,
    status: "running"
  });
  operation = operations.getRequired(operation.id);
  return {
    server,
    directory,
    host,
    operations,
    reservations,
    reservation,
    operation,
    clock,
    setNow: (value: string) => {
      now = new Date(value);
    }
  };
}
