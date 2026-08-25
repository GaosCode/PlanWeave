import { afterEach, describe, expect, it } from "vitest";
import { createRemoteBlockCoordination } from "../distributedCoordination.js";
import { AgentHostRepository } from "../hosts.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { writeHostRemoteAgentDefaults } from "../remoteAgent/hostDefaults.js";
import { RemoteAgentRepository } from "../remoteAgent/index.js";
import { syncRemoteAgentsFromHost } from "../remoteAgent/sync.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const now = new Date("2026-08-03T08:00:00.000Z");

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function insertHuman(database: SqliteDatabase, humanPrincipalId: string, displayName: string) {
  database
    .prepare(
      "INSERT INTO human_principals(human_principal_id,display_name,created_at) VALUES(?,?,?)"
    )
    .run(humanPrincipalId, displayName, now.toISOString());
}

function acpProfile(
  overrides: Partial<{ profileId: string; agentId: string; displayName: string }> = {}
) {
  return {
    profileId: "profile-main",
    agentId: "codex",
    displayName: "Codex",
    status: "ready" as const,
    capabilities: ["acp.codex"],
    ...overrides
  };
}

async function openDatabase() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  insertHuman(database, "owner-human-1", "Owner One");
  return database;
}

describe("remote agent host readiness sync", () => {
  it("does not create agents from a standalone host repository without the callback", async () => {
    const database = await openDatabase();
    const hosts = new AgentHostRepository(database, () => now);
    const host = hosts.register("Standalone Host").host;
    hosts.reportOnline(host.id, ["acp.codex"], 1, {
      workspaceMappings: [],
      acpProfiles: [acpProfile()]
    });
    hosts.touch(host.id, now, {
      workspaceMappings: [],
      acpProfiles: [acpProfile({ displayName: "Renamed" })]
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM remote_agents").get()).toEqual({
      count: 0
    });
  });

  it("keeps agents when later readiness omits the profile or the host goes offline", async () => {
    const database = await openDatabase();
    const coordination = createRemoteBlockCoordination(
      database,
      {
        leaseDurationMs: 60_000,
        hostOfflineAfterMs: 60_000,
        clock: () => now,
        runtimeLeases: {
          acquire: () => {
            throw new Error("runtime_not_configured");
          }
        },
        inputArtifacts: { materialize: async () => undefined },
        artifactContent: { readReport: async () => new Uint8Array() }
      },
      { serverInstanceOwnerToken: "remote-agent-sync-test" }
    );
    const host = coordination.hosts.register("Sync Host").host;
    coordination.hosts.reportOnline(host.id, ["acp.codex"], 2, {
      workspaceMappings: [],
      acpProfiles: [
        acpProfile(),
        acpProfile({ profileId: "profile-claude", agentId: "claude", displayName: "Claude" })
      ]
    });
    const repo = new RemoteAgentRepository(database, () => now);
    expect(repo.listByHostId(host.id)).toHaveLength(2);
    const endpointIds = repo.listByHostId(host.id).map((agent) => agent.endpointId);

    coordination.hosts.reportOnline(host.id, ["acp.codex"], 2, {
      workspaceMappings: [],
      acpProfiles: []
    });
    expect(repo.listByHostId(host.id).map((agent) => agent.endpointId)).toEqual(endpointIds);

    database
      .prepare("UPDATE agent_hosts SET last_seen_at=? WHERE id=?")
      .run("2020-01-01T00:00:00.000Z", host.id);
    expect(repo.listByHostId(host.id)).toHaveLength(2);
    expect(repo.listByHostId(host.id).every((agent) => agent.revokedAt === null)).toBe(true);
  });

  it("is safe to call on every heartbeat and does not recreate revoked grants", async () => {
    const database = await openDatabase();
    const identity = new WorkspaceIdentityRepository(database);
    const workspaceA = identity.ensureWorkspaceForLegacyProject("project-a");
    const hosts = new AgentHostRepository(database, () => now);
    const host = hosts.register("Heartbeat Host").host;
    writeHostRemoteAgentDefaults(database, {
      hostId: host.id,
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "workspace_restricted",
      createWorkspaceGrant: true,
      grantWorkspaceId: workspaceA,
      updatedAt: now.toISOString()
    });
    const reported = hosts.reportOnline(host.id, ["acp.codex"], 1, {
      workspaceMappings: [],
      acpProfiles: [acpProfile(), acpProfile()]
    });
    syncRemoteAgentsFromHost({ database, host: reported, clock: () => now });
    syncRemoteAgentsFromHost({ database, host: reported, clock: () => now });
    const repo = new RemoteAgentRepository(database, () => now);
    const agents = repo.listByHostId(host.id);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      ownerHumanPrincipalId: "owner-human-1",
      ownershipRepairRequired: false
    });
    expect(repo.listGrants(agents[0]?.endpointId ?? "")).toHaveLength(1);
    expect(repo.listGrants(agents[0]?.endpointId ?? "")[0]?.grantRevision).toBe(1);

    repo.revokeGrant({
      endpointId: agents[0]?.endpointId ?? "",
      workspaceId: workspaceA
    });
    syncRemoteAgentsFromHost({
      database,
      host: hosts.getRequired(host.id),
      clock: () => now
    });
    expect(repo.listActiveGrantsForWorkspace(workspaceA)).toEqual([]);
    expect(repo.getByEndpointId(agents[0]?.endpointId ?? "")?.revokedAt).toBeNull();
  });
});
