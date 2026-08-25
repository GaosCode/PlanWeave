import { afterEach, describe, expect, it } from "vitest";
import { endpointIdFor } from "../agentEndpointCatalog.js";
import { AgentHostRepository } from "../hosts.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import {
  RemoteAgentAuthorizationError,
  RemoteAgentRepository,
  RemoteAgentRepositoryError
} from "../remoteAgent/index.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const now = new Date("2026-08-03T08:00:00.000Z");
const later = new Date("2026-08-03T09:00:00.000Z");

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

async function fixture() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  insertHuman(database, "owner-human-1", "Owner One");
  insertHuman(database, "owner-human-2", "Owner Two");
  const identity = new WorkspaceIdentityRepository(database);
  const workspaceA = identity.ensureWorkspaceForLegacyProject("project-a");
  const workspaceB = identity.ensureWorkspaceForLegacyProject("project-b");
  const hosts = new AgentHostRepository(database, () => now);
  const host = hosts.register("Build Mac").host;
  hosts.reportOnline(host.id, ["acp.codex"], 2, {
    workspaceMappings: [],
    acpProfiles: [acpProfile()]
  });
  const repo = new RemoteAgentRepository(database, () => later);
  return { database, hosts, host, repo, workspaceA, workspaceB };
}

describe("remote agent repository", () => {
  it("registers with an explicit owner and derives endpointId from host/profile/agent", async () => {
    const { host, repo } = await fixture();
    const record = repo.registerOrRestoreFromProfile({
      hostId: host.id,
      profileId: "profile-main",
      agentId: "codex",
      displayName: "Codex",
      now: now.toISOString(),
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "workspace_restricted"
    });
    const endpointId = endpointIdFor({
      hostId: host.id,
      profileId: "profile-main",
      agentId: "codex"
    });
    expect(record).toMatchObject({
      endpointId,
      hostId: host.id,
      profileId: "profile-main",
      agentId: "codex",
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "workspace_restricted",
      ownershipRepairRequired: false,
      policyRevision: 1,
      revokedAt: null
    });
    expect(repo.getByEndpointId(endpointId)).toEqual(record);
    expect(repo.listByOwnerHumanPrincipalId("owner-human-1")).toEqual([record]);
    expect(repo.listByOwnerHumanPrincipalId("owner-human-2")).toEqual([]);
    expect(repo.listByOwnerHumanPrincipalId("server-admin")).toEqual([]);
  });

  it("registers without an owner as repair-required and refuses grant or access-mode changes", async () => {
    const { host, repo, workspaceA } = await fixture();
    const record = repo.registerOrRestoreFromProfile({
      hostId: host.id,
      profileId: "profile-main",
      agentId: "codex",
      displayName: "Codex",
      now: now.toISOString()
    });
    expect(record).toMatchObject({
      ownerHumanPrincipalId: null,
      ownershipRepairRequired: true,
      accessMode: "workspace_restricted",
      policyRevision: 1
    });
    expect(repo.listByOwnerHumanPrincipalId("owner-human-1")).toEqual([]);
    expect(repo.listByHostId(host.id)).toEqual([record]);
    expect(() =>
      repo.registerOrRestoreFromProfile({
        hostId: host.id,
        profileId: "profile-other",
        agentId: "other",
        displayName: "Other",
        now: now.toISOString(),
        accessMode: "unrestricted"
      })
    ).toThrow(RemoteAgentRepositoryError);
    expect(() =>
      repo.grantWorkspace({
        endpointId: record.endpointId,
        workspaceId: workspaceA,
        grantedByHumanPrincipalId: "owner-human-1"
      })
    ).toThrow(new RemoteAgentAuthorizationError("remote_agent_owner_required"));
    expect(() =>
      repo.setAccessMode({ endpointId: record.endpointId, accessMode: "unrestricted" })
    ).toThrow(new RemoteAgentAuthorizationError("remote_agent_owner_required"));
  });

  it("repairs ownership then allows grants without auto-setting unrestricted", async () => {
    const { host, repo, workspaceA } = await fixture();
    const created = repo.registerOrRestoreFromProfile({
      hostId: host.id,
      profileId: "profile-main",
      agentId: "codex",
      displayName: "Codex",
      now: now.toISOString()
    });
    const repaired = repo.repairOwnership({
      endpointId: created.endpointId,
      ownerHumanPrincipalId: "owner-human-1"
    });
    expect(repaired).toMatchObject({
      ownerHumanPrincipalId: "owner-human-1",
      ownershipRepairRequired: false,
      accessMode: "workspace_restricted",
      policyRevision: 2
    });
    const grant = repo.grantWorkspace({
      endpointId: created.endpointId,
      workspaceId: workspaceA,
      grantedByHumanPrincipalId: "owner-human-1"
    });
    expect(grant).toMatchObject({
      endpointId: created.endpointId,
      workspaceId: workspaceA,
      grantRevision: 1,
      revokedAt: null
    });
    expect(repo.getByEndpointId(created.endpointId)?.accessMode).toBe("workspace_restricted");
    expect(repo.listByOwnerHumanPrincipalId("owner-human-1")).toEqual([
      repo.getByEndpointId(created.endpointId)
    ]);
  });

  it("grants the same agent to multiple workspaces without changing endpointId", async () => {
    const { host, repo, workspaceA, workspaceB } = await fixture();
    const agent = repo.registerOrRestoreFromProfile({
      hostId: host.id,
      profileId: "profile-main",
      agentId: "codex",
      displayName: "Codex",
      now: now.toISOString(),
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "workspace_restricted"
    });
    const grantA = repo.grantWorkspace({
      endpointId: agent.endpointId,
      workspaceId: workspaceA,
      grantedByHumanPrincipalId: "owner-human-1"
    });
    const grantB = repo.grantWorkspace({
      endpointId: agent.endpointId,
      workspaceId: workspaceB,
      grantedByHumanPrincipalId: "owner-human-1"
    });
    expect(grantA.endpointId).toBe(agent.endpointId);
    expect(grantB.endpointId).toBe(agent.endpointId);
    expect(repo.listGrants(agent.endpointId)).toEqual(
      [grantA, grantB].sort((left, right) => left.workspaceId.localeCompare(right.workspaceId))
    );
    expect(repo.listActiveGrantsForWorkspace(workspaceA)).toEqual([grantA]);
    expect(repo.listActiveGrantsForWorkspace(workspaceB)).toEqual([grantB]);

    const revokedA = repo.revokeGrant({
      endpointId: agent.endpointId,
      workspaceId: workspaceA
    });
    expect(revokedA.revokedAt).toEqual(later.toISOString());
    expect(repo.listActiveGrantsForWorkspace(workspaceA)).toEqual([]);
    expect(repo.listActiveGrantsForWorkspace(workspaceB).map((grant) => grant.workspaceId)).toEqual(
      [workspaceB]
    );
    expect(repo.getByEndpointId(agent.endpointId)?.endpointId).toBe(agent.endpointId);
    expect(repo.getByEndpointId(agent.endpointId)?.revokedAt).toBeNull();
  });

  it("keeps grant history after agent revoke and rejects new grants", async () => {
    const { host, repo, workspaceA, workspaceB } = await fixture();
    const agent = repo.registerOrRestoreFromProfile({
      hostId: host.id,
      profileId: "profile-main",
      agentId: "codex",
      displayName: "Codex",
      now: now.toISOString(),
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "workspace_restricted"
    });
    repo.grantWorkspace({
      endpointId: agent.endpointId,
      workspaceId: workspaceA,
      grantedByHumanPrincipalId: "owner-human-1"
    });
    const revoked = repo.revokeAgent(agent.endpointId);
    expect(revoked.revokedAt).toEqual(later.toISOString());
    expect(repo.listGrants(agent.endpointId)).toHaveLength(1);
    expect(repo.listGrants(agent.endpointId)[0]?.revokedAt).toBeNull();
    expect(() =>
      repo.grantWorkspace({
        endpointId: agent.endpointId,
        workspaceId: workspaceB,
        grantedByHumanPrincipalId: "owner-human-1"
      })
    ).toThrow(new RemoteAgentAuthorizationError("remote_agent_revoked"));
    expect(() =>
      repo.setAccessMode({ endpointId: agent.endpointId, accessMode: "unrestricted" })
    ).toThrow(new RemoteAgentAuthorizationError("remote_agent_revoked"));
    expect(repo.getByEndpointId(agent.endpointId)?.endpointId).toBe(agent.endpointId);
  });

  it("restores an existing agent without deleting it or dropping grants", async () => {
    const { hosts, host, repo, workspaceA } = await fixture();
    const created = repo.registerOrRestoreFromProfile({
      hostId: host.id,
      profileId: "profile-main",
      agentId: "codex",
      displayName: "Codex",
      now: now.toISOString(),
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "unrestricted"
    });
    repo.grantWorkspace({
      endpointId: created.endpointId,
      workspaceId: workspaceA,
      grantedByHumanPrincipalId: "owner-human-1"
    });
    hosts.reportOnline(host.id, ["acp.codex"], 2, {
      workspaceMappings: [],
      acpProfiles: [acpProfile({ displayName: "Renamed Codex" })]
    });
    const restored = repo.registerOrRestoreFromProfile({
      hostId: host.id,
      profileId: "profile-main",
      agentId: "codex",
      displayName: "Renamed Codex",
      now: later.toISOString()
    });
    expect(restored.endpointId).toBe(created.endpointId);
    expect(restored.displayName).toBe("Renamed Codex");
    expect(restored.ownerHumanPrincipalId).toBe("owner-human-1");
    expect(restored.accessMode).toBe("unrestricted");
    expect(restored.ownershipRepairRequired).toBe(false);
    expect(repo.listGrants(created.endpointId)).toHaveLength(1);
    expect(repo.listByHostId(host.id)).toHaveLength(1);

    hosts.reportOnline(host.id, ["acp.codex"], 2, {
      workspaceMappings: [],
      acpProfiles: []
    });
    expect(repo.getByEndpointId(created.endpointId)?.endpointId).toBe(created.endpointId);
    expect(
      repo.registerOrRestoreFromProfile({
        hostId: host.id,
        profileId: "profile-main",
        agentId: "codex",
        displayName: "Renamed Codex",
        now: later.toISOString()
      }).endpointId
    ).toBe(created.endpointId);
    expect(repo.listByHostId(host.id)).toHaveLength(1);
  });

  it("increments grant_revision on the same PK and detects policy revision conflicts", async () => {
    const { host, repo, workspaceA } = await fixture();
    const agent = repo.registerOrRestoreFromProfile({
      hostId: host.id,
      profileId: "profile-main",
      agentId: "codex",
      displayName: "Codex",
      now: now.toISOString(),
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "workspace_restricted"
    });
    const first = repo.grantWorkspace({
      endpointId: agent.endpointId,
      workspaceId: workspaceA,
      grantedByHumanPrincipalId: "owner-human-1"
    });
    expect(first.grantRevision).toBe(1);
    const second = repo.grantWorkspace({
      endpointId: agent.endpointId,
      workspaceId: workspaceA,
      grantedByHumanPrincipalId: "owner-human-2",
      expectedGrantRevision: 1
    });
    expect(second).toMatchObject({
      endpointId: agent.endpointId,
      workspaceId: workspaceA,
      grantRevision: 2,
      grantedByHumanPrincipalId: "owner-human-2",
      createdAt: first.createdAt,
      revokedAt: null
    });
    expect(repo.listGrants(agent.endpointId)).toHaveLength(1);
    expect(() =>
      repo.grantWorkspace({
        endpointId: agent.endpointId,
        workspaceId: workspaceA,
        grantedByHumanPrincipalId: "owner-human-1",
        expectedGrantRevision: 1
      })
    ).toThrow(new RemoteAgentAuthorizationError("remote_agent_grant_revision_conflict"));

    const updated = repo.setAccessMode({
      endpointId: agent.endpointId,
      accessMode: "unrestricted",
      expectedPolicyRevision: 1
    });
    expect(updated).toMatchObject({
      accessMode: "unrestricted",
      policyRevision: 2
    });
    expect(() =>
      repo.setAccessMode({
        endpointId: agent.endpointId,
        accessMode: "workspace_restricted",
        expectedPolicyRevision: 1
      })
    ).toThrow(new RemoteAgentAuthorizationError("remote_agent_policy_revision_conflict"));
  });

  it("does not use server-admin as owner", async () => {
    const { database, host, repo } = await fixture();
    const record = repo.registerOrRestoreFromProfile({
      hostId: host.id,
      profileId: "profile-main",
      agentId: "codex",
      displayName: "Codex",
      now: now.toISOString()
    });
    expect(record.ownerHumanPrincipalId).toBeNull();
    expect(record.ownershipRepairRequired).toBe(true);
    expect(
      database
        .prepare("SELECT owner_human_principal_id FROM remote_agents WHERE endpoint_id=?")
        .get(record.endpointId)
    ).toEqual({ owner_human_principal_id: null });
    expect(repo.listByOwnerHumanPrincipalId("server-admin")).toEqual([]);
    expect(repo.listByOwnerHumanPrincipalId("operator-server-admin")).toEqual([]);
  });
});
