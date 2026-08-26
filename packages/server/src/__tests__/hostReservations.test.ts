import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostReservationRepository } from "../hostReservations.js";
import { AgentHostRepository } from "../hosts.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { RemoteOperationRepository } from "../remoteOperations.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];
const executionProfile = { agentId: "codex", agentProfileId: "codex-acp" } as const;

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup(): Promise<PlanweaveServer> {
  const directory = await mkdtemp(join(tmpdir(), "planweave-host-reservation-"));
  directories.push(directory);
  const server = await startPlanweaveServer({
    dataDirectory: directory,
    databasePath: join(directory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  servers.push(server);
  new WorkspaceIdentityRepository(server.database).ensureWorkspaceForLegacyProject("project-a");
  return server;
}

function createOperation(
  repository: RemoteOperationRepository,
  workspaceId: string,
  suffix: string,
  capabilities = ["linux"],
  projectId = "project-a",
  controlPlane: "collaboration" | "owner" = "collaboration",
  ownerHostId = "host-owner"
) {
  const operation = repository.create({
    workspaceId,
    projectId,
    canvasId: "default",
    blockRef: `RC-002#${suffix}`,
    ownershipGeneration: "generation-1",
    idempotencyKey: `request-${suffix}`,
    sourceFingerprint: `fingerprint-${suffix}`,
    requiredCapabilities: capabilities,
    ...(controlPlane === "owner"
      ? {
          endpointSelection: {
            schemaVersion: "endpoint-selection/v1" as const,
            endpointId: `endpoint-${suffix}`,
            hostId: ownerHostId,
            profileId: executionProfile.agentProfileId,
            agentId: executionProfile.agentId,
            displayName: "Owner Agent",
            hostDisplayName: "Owner Host",
            capabilities,
            resolvedAt: "2030-01-01T00:00:00.000Z",
            authority: {
              schemaVersion: "endpoint-authority/v2" as const,
              kind: "owner_canvas" as const,
              responsibilityRevision: 0,
              reviewerRevision: 0
            }
          }
        }
      : {})
  });
  return repository.markClaimed(operation.id);
}

function reportReady(
  hosts: AgentHostRepository,
  hostId: string,
  workspaceId: string,
  capabilities: string[],
  capacity: number
) {
  hosts.reportOnline(hostId, capabilities, capacity, {
    workspaceMappings: [{ workspaceId, status: "ready" }],
    acpProfiles: [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Test Agent",
        status: "ready",
        capabilities
      }
    ]
  });
}

describe("HostReservationRepository", () => {
  it("does not let Owner Fleet leases consume collaboration Host capacity", async () => {
    const server = await setup();
    const workspaceId = new WorkspaceIdentityRepository(server.database).workspaceForLegacyProject(
      "project-a"
    );
    if (!workspaceId) throw new Error("workspace_mapping_missing");
    const hosts = new AgentHostRepository(server.database);
    const host = hosts.register("Owner Host").host;
    hosts.bindToWorkspace(host.id, workspaceId);
    reportReady(hosts, host.id, workspaceId, ["linux"], 1);
    server.database
      .prepare("UPDATE agent_hosts SET last_seen_at=? WHERE id=?")
      .run("2030-01-01T00:00:00.000Z", host.id);
    const operations = new RemoteOperationRepository(server.database);
    const reservations = new HostReservationRepository(server.database, {
      hostOfflineAfterMs: 60_000,
      leaseDurationMs: 60_000,
      clock: () => new Date("2030-01-01T00:00:00.000Z")
    });

    const owner = reservations.reserve(
      createOperation(
        operations,
        workspaceId,
        "owner-capacity",
        ["linux"],
        "project-a",
        "owner",
        host.id
      ).id,
      { ...executionProfile, preferredHostId: host.id }
    );
    const collaboration = reservations.reserve(
      createOperation(operations, workspaceId, "collaboration-capacity").id,
      { ...executionProfile, preferredHostId: host.id }
    );

    expect(owner.hostId).toBe(host.id);
    expect(collaboration.hostId).toBe(host.id);
    expect(reservations.activeCountsForHosts([host.id]).get(host.id)).toBe(1);
  });

  it("reserves an unrestricted owner host bound to another workspace for workspace-canvas writeback", async () => {
    const server = await setup();
    const identity = new WorkspaceIdentityRepository(server.database);
    const workspaceA = identity.workspaceForLegacyProject("project-a");
    const workspaceB = identity.ensureWorkspaceForLegacyProject("project-b");
    if (!workspaceA) throw new Error("workspace_mapping_missing");
    const hosts = new AgentHostRepository(server.database);
    const host = hosts.register("Owner Host").host;
    hosts.bindToWorkspace(host.id, workspaceA);
    reportReady(hosts, host.id, workspaceA, ["linux"], 1);
    server.database
      .prepare("UPDATE agent_hosts SET last_seen_at=? WHERE id=?")
      .run("2030-01-01T00:00:00.000Z", host.id);
    const operations = new RemoteOperationRepository(server.database);
    const reservations = new HostReservationRepository(server.database, {
      hostOfflineAfterMs: 60_000,
      leaseDurationMs: 60_000,
      clock: () => new Date("2030-01-01T00:00:00.000Z")
    });
    const claimed = operations.markClaimed(
      operations.create({
        workspaceId: workspaceB,
        projectId: "project-b",
        canvasId: "default",
        blockRef: "RC-002#cross-workspace-unrestricted",
        ownershipGeneration: "generation-1",
        idempotencyKey: "request-cross-workspace-unrestricted",
        sourceFingerprint: "fingerprint-cross-workspace-unrestricted",
        requiredCapabilities: ["linux"],
        endpointSelection: {
          schemaVersion: "endpoint-selection/v1",
          endpointId: "endpoint-cross-workspace-unrestricted",
          hostId: host.id,
          profileId: executionProfile.agentProfileId,
          agentId: executionProfile.agentId,
          displayName: "Owner Agent",
          hostDisplayName: "Owner Host",
          capabilities: ["linux"],
          resolvedAt: "2030-01-01T00:00:00.000Z",
          authority: {
            schemaVersion: "endpoint-authority/v2",
            kind: "workspace_canvas",
            workspaceId: workspaceB,
            responsibilityRevision: 0,
            reviewerRevision: 0
          }
        },
        agentAccess: {
          callerHumanPrincipalId: "owner-human-1",
          authorized: {
            remoteAgent: {
              endpointId: "endpoint-cross-workspace-unrestricted",
              hostId: host.id,
              profileId: executionProfile.agentProfileId,
              agentId: executionProfile.agentId
            },
            runtimeAuthority: { kind: "workspace_canvas", workspaceId: workspaceB },
            agentAccessAuthority: {
              kind: "agent_owner",
              ownerHumanPrincipalId: "owner-human-1",
              policyRevision: 1
            },
            resolvedAt: "2030-01-01T00:00:00.000Z"
          }
        }
      }).id
    );
    const reserved = reservations.reserve(claimed.id, {
      ...executionProfile,
      preferredHostId: host.id
    });
    expect(reserved.hostId).toBe(host.id);
  });

  it("counts unrestricted owner workspace-canvas reservations against Host capacity", async () => {
    const server = await setup();
    const identity = new WorkspaceIdentityRepository(server.database);
    const workspaceA = identity.workspaceForLegacyProject("project-a");
    const workspaceB = identity.ensureWorkspaceForLegacyProject("project-b");
    if (!workspaceA) throw new Error("workspace_mapping_missing");
    const hosts = new AgentHostRepository(server.database);
    const host = hosts.register("Owner Host").host;
    hosts.bindToWorkspace(host.id, workspaceA);
    reportReady(hosts, host.id, workspaceA, ["linux"], 1);
    server.database
      .prepare("UPDATE agent_hosts SET last_seen_at=? WHERE id=?")
      .run("2030-01-01T00:00:00.000Z", host.id);
    const operations = new RemoteOperationRepository(server.database);
    const reservations = new HostReservationRepository(server.database, {
      hostOfflineAfterMs: 60_000,
      leaseDurationMs: 60_000,
      clock: () => new Date("2030-01-01T00:00:00.000Z")
    });
    const first = operations.markClaimed(
      operations.create({
        workspaceId: workspaceB,
        projectId: "project-b",
        canvasId: "default",
        blockRef: "RC-002#unrestricted-capacity-a",
        ownershipGeneration: "generation-1",
        idempotencyKey: "request-unrestricted-capacity-a",
        sourceFingerprint: "fingerprint-unrestricted-capacity-a",
        requiredCapabilities: ["linux"],
        endpointSelection: {
          schemaVersion: "endpoint-selection/v1",
          endpointId: "endpoint-unrestricted-capacity-a",
          hostId: host.id,
          profileId: executionProfile.agentProfileId,
          agentId: executionProfile.agentId,
          displayName: "Owner Agent",
          hostDisplayName: "Owner Host",
          capabilities: ["linux"],
          resolvedAt: "2030-01-01T00:00:00.000Z",
          authority: {
            schemaVersion: "endpoint-authority/v2",
            kind: "workspace_canvas",
            workspaceId: workspaceB,
            responsibilityRevision: 0,
            reviewerRevision: 0
          }
        },
        agentAccess: {
          callerHumanPrincipalId: "owner-human-1",
          authorized: {
            remoteAgent: {
              endpointId: "endpoint-unrestricted-capacity-a",
              hostId: host.id,
              profileId: executionProfile.agentProfileId,
              agentId: executionProfile.agentId
            },
            runtimeAuthority: { kind: "workspace_canvas", workspaceId: workspaceB },
            agentAccessAuthority: {
              kind: "agent_owner",
              ownerHumanPrincipalId: "owner-human-1",
              policyRevision: 1
            },
            resolvedAt: "2030-01-01T00:00:00.000Z"
          }
        }
      }).id
    );
    const second = operations.markClaimed(
      operations.create({
        workspaceId: workspaceB,
        projectId: "project-b",
        canvasId: "default",
        blockRef: "RC-002#unrestricted-capacity-b",
        ownershipGeneration: "generation-1",
        idempotencyKey: "request-unrestricted-capacity-b",
        sourceFingerprint: "fingerprint-unrestricted-capacity-b",
        requiredCapabilities: ["linux"],
        endpointSelection: {
          schemaVersion: "endpoint-selection/v1",
          endpointId: "endpoint-unrestricted-capacity-b",
          hostId: host.id,
          profileId: executionProfile.agentProfileId,
          agentId: executionProfile.agentId,
          displayName: "Owner Agent",
          hostDisplayName: "Owner Host",
          capabilities: ["linux"],
          resolvedAt: "2030-01-01T00:00:00.000Z",
          authority: {
            schemaVersion: "endpoint-authority/v2",
            kind: "workspace_canvas",
            workspaceId: workspaceB,
            responsibilityRevision: 0,
            reviewerRevision: 0
          }
        },
        agentAccess: {
          callerHumanPrincipalId: "owner-human-1",
          authorized: {
            remoteAgent: {
              endpointId: "endpoint-unrestricted-capacity-b",
              hostId: host.id,
              profileId: executionProfile.agentProfileId,
              agentId: executionProfile.agentId
            },
            runtimeAuthority: { kind: "workspace_canvas", workspaceId: workspaceB },
            agentAccessAuthority: {
              kind: "agent_owner",
              ownerHumanPrincipalId: "owner-human-1",
              policyRevision: 1
            },
            resolvedAt: "2030-01-01T00:00:00.000Z"
          }
        }
      }).id
    );
    expect(
      reservations.reserve(first.id, { ...executionProfile, preferredHostId: host.id }).hostId
    ).toBe(host.id);
    expect(() =>
      reservations.reserve(second.id, { ...executionProfile, preferredHostId: host.id })
    ).toThrowError("no_compatible_agent_host");
    expect(reservations.activeCountsForHosts([host.id]).get(host.id)).toBe(1);
  });

  it("excludes in-flight v1 owner controlPlane JSON from collaboration Host capacity", async () => {
    const server = await setup();
    const workspaceId = new WorkspaceIdentityRepository(server.database).workspaceForLegacyProject(
      "project-a"
    );
    if (!workspaceId) throw new Error("workspace_mapping_missing");
    const hosts = new AgentHostRepository(server.database);
    const host = hosts.register("Owner Host").host;
    hosts.bindToWorkspace(host.id, workspaceId);
    reportReady(hosts, host.id, workspaceId, ["linux"], 1);
    server.database
      .prepare("UPDATE agent_hosts SET last_seen_at=? WHERE id=?")
      .run("2030-01-01T00:00:00.000Z", host.id);
    const operations = new RemoteOperationRepository(server.database);
    const reservations = new HostReservationRepository(server.database, {
      hostOfflineAfterMs: 60_000,
      leaseDurationMs: 60_000,
      clock: () => new Date("2030-01-01T00:00:00.000Z")
    });
    const claimed = createOperation(
      operations,
      workspaceId,
      "owner-v1-capacity",
      ["linux"],
      "project-a",
      "owner",
      host.id
    );
    const selection = operations.getRequired(claimed.id).endpointSelection;
    if (!selection) throw new Error("expected_owner_selection");
    server.database
      .prepare("UPDATE remote_operations SET endpoint_selection_json=? WHERE id=?")
      .run(
        JSON.stringify({
          ...selection,
          authority: {
            schemaVersion: "endpoint-authority/v1",
            controlPlane: "owner",
            responsibilityRevision: selection.authority.responsibilityRevision,
            reviewerRevision: selection.authority.reviewerRevision
          }
        }),
        claimed.id
      );

    reservations.reserve(claimed.id, { ...executionProfile, preferredHostId: host.id });
    reservations.reserve(createOperation(operations, workspaceId, "collaboration-v1-capacity").id, {
      ...executionProfile,
      preferredHostId: host.id
    });
    expect(reservations.activeCountsForHosts([host.id]).get(host.id)).toBe(1);
  });

  it("scopes automatic and exact reservations to the operation Workspace", async () => {
    const server = await setup();
    const identity = new WorkspaceIdentityRepository(server.database);
    const workspaceA = identity.workspaceForLegacyProject("project-a");
    const workspaceB = identity.ensureWorkspaceForLegacyProject("project-b");
    if (!workspaceA) throw new Error("workspace_mapping_missing");
    const hosts = new AgentHostRepository(server.database);
    const hostA = hosts.register("Workspace A").host;
    const hostB = hosts.register("Workspace B").host;
    hosts.bindToWorkspace(hostA.id, workspaceA);
    hosts.bindToWorkspace(hostB.id, workspaceB);
    reportReady(hosts, hostA.id, workspaceA, ["linux"], 1);
    reportReady(hosts, hostB.id, workspaceB, ["linux"], 1);
    const operations = new RemoteOperationRepository(server.database);
    const reservations = new HostReservationRepository(server.database, {
      hostOfflineAfterMs: 60_000,
      leaseDurationMs: 60_000
    });

    const automaticA = reservations.reserve(
      createOperation(operations, workspaceA, "scope-a").id,
      executionProfile
    );
    expect(automaticA.hostId).toBe(hostA.id);
    expect(() =>
      reservations.reserve(
        createOperation(operations, workspaceA, "scope-a-exact", ["linux"], "project-a").id,
        {
          ...executionProfile,
          preferredHostId: hostB.id
        }
      )
    ).toThrowError("no_compatible_agent_host");
    const automaticB = reservations.reserve(
      createOperation(operations, workspaceB, "scope-b", ["linux"], "project-b").id,
      executionProfile
    );
    expect(automaticB.hostId).toBe(hostB.id);
  });

  it("skips unready Hosts for automatic reservations and rejects an unready preferred Host", async () => {
    const server = await setup();
    const workspaceId = new WorkspaceIdentityRepository(server.database).workspaceForLegacyProject(
      "project-a"
    );
    if (!workspaceId) throw new Error("workspace_mapping_missing");
    const hosts = new AgentHostRepository(server.database);
    const missingWorkspace = hosts.register("Missing workspace readiness").host;
    const missingAcp = hosts.register("Missing ACP readiness").host;
    const wrongReadyProfile = hosts.register("Wrong ready ACP profile").host;
    const ready = hosts.register("Ready Host").host;
    for (const host of [missingWorkspace, missingAcp, wrongReadyProfile, ready]) {
      hosts.bindToWorkspace(host.id, workspaceId);
    }
    hosts.reportOnline(missingWorkspace.id, ["linux"], 1, {
      workspaceMappings: [],
      acpProfiles: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          status: "ready",
          capabilities: ["linux"]
        }
      ]
    });
    hosts.reportOnline(missingAcp.id, ["linux"], 1, {
      workspaceMappings: [{ workspaceId, status: "ready" }],
      acpProfiles: []
    });
    hosts.reportOnline(wrongReadyProfile.id, ["linux"], 1, {
      workspaceMappings: [{ workspaceId, status: "ready" }],
      acpProfiles: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Test Agent",
          status: "missing",
          capabilities: ["linux"]
        },
        {
          profileId: "opencode-acp",
          agentId: "opencode",
          displayName: "Test Agent",
          status: "ready",
          capabilities: ["linux"]
        }
      ]
    });
    hosts.reportOnline(ready.id, ["linux", "acp.codex"], 1, {
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
    server.database
      .prepare("UPDATE agent_hosts SET last_seen_at=? WHERE id=?")
      .run("2099-01-01T00:00:00.000Z", wrongReadyProfile.id);
    const operations = new RemoteOperationRepository(server.database);
    const reservations = new HostReservationRepository(server.database, {
      hostOfflineAfterMs: 60_000,
      leaseDurationMs: 60_000
    });

    const automatic = reservations.reserve(
      createOperation(operations, workspaceId, "readiness-automatic").id,
      executionProfile
    );
    expect(automatic.hostId).toBe(ready.id);
    expect(() =>
      reservations.reserve(createOperation(operations, workspaceId, "readiness-profile").id, {
        ...executionProfile,
        preferredHostId: wrongReadyProfile.id
      })
    ).toThrowError("no_compatible_agent_host");
    expect(() =>
      reservations.reserve(createOperation(operations, workspaceId, "readiness-preferred").id, {
        ...executionProfile,
        preferredHostId: missingWorkspace.id
      })
    ).toThrowError("no_compatible_agent_host");

    reservations.release({
      leaseId: automatic.leaseId,
      fencingToken: automatic.fencingToken,
      expectedVersion: automatic.version,
      reason: "expired"
    });
    hosts.reportOnline(ready.id, ["linux"], 1, {
      workspaceMappings: [{ workspaceId, status: "ready" }],
      acpProfiles: []
    });
    expect(() =>
      reservations.reserve(
        createOperation(operations, workspaceId, "readiness-none").id,
        executionProfile
      )
    ).toThrowError("no_compatible_agent_host");
  });

  it("selects deterministically under capacity and prevents a capacity race", async () => {
    const server = await setup();
    const hosts = new AgentHostRepository(server.database);
    const first = hosts.register("First").host;
    const second = hosts.register("Second").host;
    const workspaceId = new WorkspaceIdentityRepository(server.database).workspaceForLegacyProject(
      "project-a"
    );
    if (!workspaceId) throw new Error("workspace_mapping_missing");
    hosts.bindToWorkspace(first.id, workspaceId);
    hosts.bindToWorkspace(second.id, workspaceId);
    reportReady(hosts, first.id, workspaceId, ["linux"], 1);
    reportReady(hosts, second.id, workspaceId, ["linux"], 1);
    server.database
      .prepare("UPDATE agent_hosts SET last_seen_at=? WHERE id IN (?,?)")
      .run("2030-01-01T00:00:00.000Z", first.id, second.id);
    const operations = new RemoteOperationRepository(server.database);
    const reservations = new HostReservationRepository(server.database, {
      hostOfflineAfterMs: 60_000,
      leaseDurationMs: 60_000
    });

    const reservedA = reservations.reserve(
      createOperation(operations, workspaceId, "B-001").id,
      executionProfile
    );
    const reservedB = reservations.reserve(
      createOperation(operations, workspaceId, "B-002").id,
      executionProfile
    );
    expect([reservedA.hostId, reservedB.hostId]).toEqual([first.id, second.id].sort());
    expect(() =>
      reservations.reserve(createOperation(operations, workspaceId, "B-003").id, executionProfile)
    ).toThrowError("no_compatible_agent_host");
  });

  it("rejects offline, revoked, and incompatible Hosts", async () => {
    const server = await setup();
    let now = new Date("2030-01-01T00:00:00.000Z");
    const hosts = new AgentHostRepository(server.database, () => now);
    const workspaceId = new WorkspaceIdentityRepository(server.database).workspaceForLegacyProject(
      "project-a"
    );
    if (!workspaceId) throw new Error("workspace_mapping_missing");
    const offline = hosts.register("Offline").host;
    hosts.bindToWorkspace(offline.id, workspaceId);
    reportReady(hosts, offline.id, workspaceId, ["linux"], 1);
    now = new Date("2030-01-01T00:02:00.000Z");
    const revoked = hosts.register("Revoked").host;
    hosts.bindToWorkspace(revoked.id, workspaceId);
    reportReady(hosts, revoked.id, workspaceId, ["linux"], 1);
    hosts.revoke(revoked.id);
    const incompatible = hosts.register("Incompatible").host;
    hosts.bindToWorkspace(incompatible.id, workspaceId);
    reportReady(hosts, incompatible.id, workspaceId, ["macos"], 1);
    const operations = new RemoteOperationRepository(server.database, () => now);
    const reservations = new HostReservationRepository(server.database, {
      clock: () => now,
      hostOfflineAfterMs: 60_000,
      leaseDurationMs: 60_000
    });

    expect(() =>
      reservations.reserve(createOperation(operations, workspaceId, "B-004").id, executionProfile)
    ).toThrowError("no_compatible_agent_host");
  });

  it("releases capacity only with the current fence and preserves interrupted attempt uniqueness", async () => {
    const server = await setup();
    const hosts = new AgentHostRepository(server.database);
    const host = hosts.register("Only Host").host;
    const workspaceId = new WorkspaceIdentityRepository(server.database).workspaceForLegacyProject(
      "project-a"
    );
    if (!workspaceId) throw new Error("workspace_mapping_missing");
    hosts.bindToWorkspace(host.id, workspaceId);
    reportReady(hosts, host.id, workspaceId, ["linux"], 1);
    const operations = new RemoteOperationRepository(server.database);
    const reservations = new HostReservationRepository(server.database, {
      hostOfflineAfterMs: 60_000,
      leaseDurationMs: 60_000
    });
    const first = createOperation(operations, workspaceId, "B-005");
    const lease = reservations.reserve(first.id, executionProfile);
    const activated = reservations.transition({
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      expectedAttemptVersion: 1,
      status: "activated"
    });
    const running = reservations.transition({
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      expectedAttemptVersion: activated.attempt.stateVersion,
      status: "running"
    });
    expect(running.attempt.status).toBe("running");

    expect(() =>
      reservations.release({
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken + 1,
        expectedVersion: lease.version,
        reason: "expired"
      })
    ).toThrowError("reservation_fence_conflict");
    const released = reservations.release({
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      expectedVersion: lease.version,
      reason: "expired"
    });
    expect(released.status).toBe("expired");
    expect(operations.getRequired(first.id).attempt.status).toBe("interrupted");
    expect(
      server.database
        .prepare("SELECT type FROM remote_operation_events WHERE operation_id=? ORDER BY sequence")
        .all(first.id)
        .map((row) => row.type)
    ).toEqual([
      "remote.operation.created",
      "remote.operation.claimed",
      "remote.attempt.reserved",
      "remote.attempt.activated",
      "remote.attempt.running",
      "remote.attempt.interrupted",
      "remote.reservation.expired"
    ]);

    expect(() =>
      reservations.reserve(
        operations.create({
          workspaceId: first.workspaceId,
          projectId: first.projectId,
          canvasId: first.canvasId,
          blockRef: first.blockRef,
          ownershipGeneration: first.ownershipGeneration,
          idempotencyKey: "another-request",
          sourceFingerprint: first.sourceFingerprint,
          requiredCapabilities: first.requiredCapabilities
        }).id,
        executionProfile
      )
    ).toThrowError("remote_active_attempt_conflict");
  });

  it("expires without requeue and resumes the same attempt under a fresh fenced lease", async () => {
    const server = await setup();
    let now = new Date("2030-01-01T00:00:00.000Z");
    const clock = () => now;
    const hosts = new AgentHostRepository(server.database, clock);
    const host = hosts.register("Resumable Host").host;
    const workspaceId = new WorkspaceIdentityRepository(server.database).workspaceForLegacyProject(
      "project-a"
    );
    if (!workspaceId) throw new Error("workspace_mapping_missing");
    hosts.bindToWorkspace(host.id, workspaceId);
    reportReady(hosts, host.id, workspaceId, ["linux", "acp.session.load"], 1);
    const operations = new RemoteOperationRepository(server.database, clock);
    const reservations = new HostReservationRepository(server.database, {
      clock,
      hostOfflineAfterMs: 60_000,
      leaseDurationMs: 60_000
    });
    const operation = createOperation(operations, workspaceId, "B-006", ["linux"]);
    const original = reservations.reserve(operation.id, executionProfile);
    reservations.transition({
      leaseId: original.leaseId,
      fencingToken: original.fencingToken,
      expectedAttemptVersion: operations.getRequired(operation.id).attempt.stateVersion,
      status: "activated"
    });
    const running = reservations.transition({
      leaseId: original.leaseId,
      fencingToken: original.fencingToken,
      expectedAttemptVersion: operations.getRequired(operation.id).attempt.stateVersion,
      status: "running"
    });
    now = new Date("2030-01-01T00:01:00.000Z");
    expect(reservations.expireDue(now)).toMatchObject([
      { leaseId: original.leaseId, status: "expired" }
    ]);
    const interrupted = operations.getRequired(operation.id);
    expect(interrupted).toMatchObject({
      state: "interrupted",
      attempt: { status: "interrupted", executionAttemptId: running.executionAttemptId }
    });
    reportReady(hosts, host.id, workspaceId, ["linux", "acp.session.load"], 1);

    const resumed = reservations.resumeSameAttempt({
      priorLeaseId: original.leaseId,
      leaseId: "lease-resume-2",
      leaseExpiresAt: "2030-01-01T00:02:00.000Z",
      expectedAttemptVersion: interrupted.attempt.stateVersion
    });
    expect(resumed).toMatchObject({
      leaseId: "lease-resume-2",
      executionAttemptId: original.executionAttemptId,
      hostId: original.hostId,
      fencingToken: original.fencingToken + 1,
      status: "active"
    });
    expect(
      reservations.resumeSameAttempt({
        priorLeaseId: original.leaseId,
        leaseId: "lease-resume-2",
        leaseExpiresAt: "2030-01-01T00:02:00.000Z",
        expectedAttemptVersion: interrupted.attempt.stateVersion
      })
    ).toEqual(resumed);
    expect(operations.getRequired(operation.id)).toMatchObject({
      state: "activated",
      attempt: {
        status: "activated",
        executionAttemptId: original.executionAttemptId,
        leaseId: "lease-resume-2"
      }
    });
    expect(reservations.getRequired(original.leaseId).status).toBe("expired");
  });

  it("terminalizes an exact fenced attempt idempotently", async () => {
    const server = await setup();
    const hosts = new AgentHostRepository(server.database);
    const host = hosts.register("Fenced terminal Host").host;
    const workspaceId = new WorkspaceIdentityRepository(server.database).workspaceForLegacyProject(
      "project-a"
    );
    if (!workspaceId) throw new Error("workspace_mapping_missing");
    hosts.bindToWorkspace(host.id, workspaceId);
    reportReady(hosts, host.id, workspaceId, ["linux"], 1);
    const operations = new RemoteOperationRepository(server.database);
    const reservations = new HostReservationRepository(server.database, {
      hostOfflineAfterMs: 60_000,
      leaseDurationMs: 60_000
    });
    const operation = createOperation(operations, workspaceId, "B-008");
    const lease = reservations.reserve(operation.id, executionProfile);
    reservations.transition({
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      expectedAttemptVersion: operations.getRequired(operation.id).attempt.stateVersion,
      status: "activated"
    });
    reservations.release({
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      expectedVersion: lease.version,
      reason: "expired"
    });
    const input = {
      operationId: operation.id,
      executionAttemptId: operation.executionAttemptId,
      leaseId: lease.leaseId,
      status: "failed" as const
    };
    reservations.finalizeFencedAttempt(input);
    reservations.finalizeFencedAttempt(input);
    expect(operations.getRequired(operation.id)).toMatchObject({
      state: "failed",
      attempt: { status: "failed" }
    });
  });

  it("does not oversubscribe the original Host when resume capacity was reused", async () => {
    const server = await setup();
    let now = new Date("2030-01-01T00:00:00.000Z");
    const clock = () => now;
    const hosts = new AgentHostRepository(server.database, clock);
    const host = hosts.register("Capacity Host").host;
    const workspaceId = new WorkspaceIdentityRepository(server.database).workspaceForLegacyProject(
      "project-a"
    );
    if (!workspaceId) throw new Error("workspace_mapping_missing");
    hosts.bindToWorkspace(host.id, workspaceId);
    reportReady(hosts, host.id, workspaceId, ["linux", "acp.session.load"], 1);
    const operations = new RemoteOperationRepository(server.database, clock);
    const reservations = new HostReservationRepository(server.database, {
      clock,
      hostOfflineAfterMs: 60_000,
      leaseDurationMs: 60_000
    });
    const interruptedOperation = createOperation(operations, workspaceId, "B-007");
    const interruptedLease = reservations.reserve(interruptedOperation.id, executionProfile);
    reservations.transition({
      leaseId: interruptedLease.leaseId,
      fencingToken: interruptedLease.fencingToken,
      expectedAttemptVersion: operations.getRequired(interruptedOperation.id).attempt.stateVersion,
      status: "activated"
    });
    now = new Date("2030-01-01T00:01:00.000Z");
    reservations.expireDue(now);
    reportReady(hosts, host.id, workspaceId, ["linux", "acp.session.load"], 1);
    reservations.reserve(createOperation(operations, workspaceId, "B-008").id, executionProfile);
    const interrupted = operations.getRequired(interruptedOperation.id);

    expect(() =>
      reservations.resumeSameAttempt({
        priorLeaseId: interruptedLease.leaseId,
        leaseId: "lease-resume-capacity",
        leaseExpiresAt: "2030-01-01T00:02:00.000Z",
        expectedAttemptVersion: interrupted.attempt.stateVersion
      })
    ).toThrowError("remote_resume_host_capacity_exhausted");
    expect(operations.getRequired(interruptedOperation.id).attempt.status).toBe("interrupted");
  });
});
