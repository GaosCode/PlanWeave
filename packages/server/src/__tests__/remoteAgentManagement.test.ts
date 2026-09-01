import { afterEach, describe, expect, it } from "vitest";
import { AgentHostRepository } from "../hosts.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { RemoteAgentAuthorizationError } from "../remoteAgent/errors.js";
import { HumanPrincipalIdentity } from "../identity/humanPrincipalIdentity.js";
import { HumanIdentityCredentialStore } from "../identity/humanIdentityCredentialStore.js";
import { RemoteAgentManagementService } from "../remoteAgent/management.js";
import { RemoteAgentRepository } from "../remoteAgent/repository.js";
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
  const repo = new RemoteAgentRepository(database, () => now);
  const management = new RemoteAgentManagementService(repo, new HumanPrincipalIdentity(database));
  return { database, host, hosts, repo, management, workspaceA, workspaceB };
}

describe("remote agent management service", () => {
  it("lists owned agents with active grants and repair-required rows", async () => {
    const { host, repo, management, workspaceA } = await fixture();
    const owned = repo.registerOrRestoreFromProfile({
      hostId: host.id,
      profileId: "profile-main",
      agentId: "codex",
      displayName: "Codex",
      now: now.toISOString(),
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "workspace_restricted"
    });
    management.grantWorkspace({
      endpointId: owned.endpointId,
      workspaceId: workspaceA,
      actorHumanPrincipalId: "owner-human-1"
    });
    const repair = repo.registerOrRestoreFromProfile({
      hostId: host.id,
      profileId: "profile-repair",
      agentId: "repair",
      displayName: "Repair",
      now: now.toISOString()
    });
    const listed = management.listManaged("owner-human-1");
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpointId: owned.endpointId,
          hostId: host.id,
          grants: [expect.objectContaining({ workspaceId: workspaceA })]
        }),
        expect.objectContaining({
          endpointId: repair.endpointId,
          ownershipRepairRequired: true
        })
      ])
    );
  });

  it("lists only the caller's owned agents and hides other owners", async () => {
    const { host, repo, management } = await fixture();
    const owned = repo.registerOrRestoreFromProfile({
      hostId: host.id,
      profileId: "profile-main",
      agentId: "codex",
      displayName: "Codex",
      now: now.toISOString(),
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "workspace_restricted"
    });
    repo.registerOrRestoreFromProfile({
      hostId: host.id,
      profileId: "profile-claude",
      agentId: "claude",
      displayName: "Claude",
      now: now.toISOString(),
      ownerHumanPrincipalId: "owner-human-2",
      accessMode: "unrestricted"
    });
    expect(management.listOwned("owner-human-1")).toEqual([owned]);
    expect(
      management.get({ endpointId: owned.endpointId, actorHumanPrincipalId: "owner-human-1" })
    ).toEqual(owned);
    expect(() =>
      management.get({ endpointId: owned.endpointId, actorHumanPrincipalId: "owner-human-2" })
    ).toThrow(new RemoteAgentAuthorizationError("remote_agent_not_found"));
    expect(() => management.get({ endpointId: owned.endpointId })).toThrow(
      new RemoteAgentAuthorizationError("remote_agent_not_found")
    );
  });

  it("lists only active endpoints without merging distinct Hosts that share a name", async () => {
    const { hosts, repo, management } = await fixture();
    const activeA = hosts.register("Shared device name").host;
    const activeB = hosts.register("Shared device name").host;
    const revokedHost = hosts.register("Revoked device").host;
    const activeAgentA = repo.registerOrRestoreFromProfile({
      hostId: activeA.id,
      profileId: "profile-active-a",
      agentId: "codex-a",
      displayName: "Codex A",
      now: now.toISOString(),
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "workspace_restricted"
    });
    const activeAgentB = repo.registerOrRestoreFromProfile({
      hostId: activeB.id,
      profileId: "profile-active-b",
      agentId: "codex-b",
      displayName: "Codex B",
      now: now.toISOString(),
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "workspace_restricted"
    });
    const revokedAgent = repo.registerOrRestoreFromProfile({
      hostId: activeA.id,
      profileId: "profile-revoked-agent",
      agentId: "revoked-agent",
      displayName: "Revoked Agent",
      now: now.toISOString(),
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "workspace_restricted"
    });
    repo.revokeAgent(revokedAgent.endpointId);
    const revokedHostAgent = repo.registerOrRestoreFromProfile({
      hostId: revokedHost.id,
      profileId: "profile-revoked-host",
      agentId: "revoked-host-agent",
      displayName: "Revoked Host Agent",
      now: now.toISOString(),
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "workspace_restricted"
    });
    const repairOnRevokedHost = repo.registerOrRestoreFromProfile({
      hostId: revokedHost.id,
      profileId: "profile-repair",
      agentId: "repair",
      displayName: "Repair",
      now: now.toISOString()
    });
    hosts.revoke(revokedHost.id);

    const firstGeneration = hosts.registerInstallationGeneration({
      installationId: "4b3ba96d-0f84-4cf4-aac5-87ef90f58ec2",
      displayName: "Re-enrolled device",
      token: `pw_host_${"a".repeat(43)}`,
      capabilities: [],
      capacity: 1,
      credentialExpiresAt: "2027-08-03T08:00:00.000Z",
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    }).host;
    const supersededAgent = repo.registerOrRestoreFromProfile({
      hostId: firstGeneration.id,
      profileId: "profile-superseded",
      agentId: "superseded-agent",
      displayName: "Superseded Agent",
      now: now.toISOString(),
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "workspace_restricted"
    });
    const currentGeneration = hosts.registerInstallationGeneration({
      installationId: "4b3ba96d-0f84-4cf4-aac5-87ef90f58ec2",
      supersedesHostId: firstGeneration.id,
      displayName: "Re-enrolled device",
      token: `pw_host_${"b".repeat(43)}`,
      capabilities: [],
      capacity: 1,
      credentialExpiresAt: "2027-08-03T08:00:00.000Z",
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    }).host;
    const currentGenerationAgent = repo.registerOrRestoreFromProfile({
      hostId: currentGeneration.id,
      profileId: "profile-current",
      agentId: "current-agent",
      displayName: "Current Agent",
      now: now.toISOString(),
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "workspace_restricted"
    });

    expect(management.listOwned("owner-human-1").map((agent) => agent.endpointId)).toEqual([
      activeAgentA.endpointId,
      activeAgentB.endpointId,
      currentGenerationAgent.endpointId
    ]);
    expect(management.listOwnershipRepairRequired()).toEqual([]);
    expect(management.listManaged("owner-human-1").map((agent) => agent.endpointId)).toEqual([
      activeAgentA.endpointId,
      activeAgentB.endpointId,
      currentGenerationAgent.endpointId
    ]);
    for (const historical of [
      revokedAgent,
      revokedHostAgent,
      repairOnRevokedHost,
      supersededAgent
    ]) {
      expect(repo.getByEndpointId(historical.endpointId)).toBeDefined();
    }
  });

  it("refuses setAccessMode and grant while ownership is repair-required", async () => {
    const { host, repo, management, workspaceA } = await fixture();
    const created = repo.registerOrRestoreFromProfile({
      hostId: host.id,
      profileId: "profile-main",
      agentId: "codex",
      displayName: "Codex",
      now: now.toISOString()
    });
    expect(management.listOwnershipRepairRequired()).toEqual([created]);
    expect(management.get({ endpointId: created.endpointId })).toMatchObject({
      ownershipRepairRequired: true,
      ownerHumanPrincipalId: null
    });
    expect(() =>
      management.setAccessMode({
        endpointId: created.endpointId,
        accessMode: "unrestricted",
        actorHumanPrincipalId: "owner-human-1"
      })
    ).toThrow(new RemoteAgentAuthorizationError("remote_agent_owner_required"));
    expect(() =>
      management.grantWorkspace({
        endpointId: created.endpointId,
        workspaceId: workspaceA,
        actorHumanPrincipalId: "owner-human-1"
      })
    ).toThrow(new RemoteAgentAuthorizationError("remote_agent_owner_required"));
  });

  it("repairs ownership then allows grants without guessing the owner", async () => {
    const { host, repo, management, workspaceA } = await fixture();
    const created = repo.registerOrRestoreFromProfile({
      hostId: host.id,
      profileId: "profile-main",
      agentId: "codex",
      displayName: "Codex",
      now: now.toISOString()
    });
    const repaired = management.repairOwnership({
      endpointId: created.endpointId,
      ownerHumanPrincipalId: "owner-human-1"
    });
    expect(repaired).toMatchObject({
      ownerHumanPrincipalId: "owner-human-1",
      ownershipRepairRequired: false,
      accessMode: "workspace_restricted"
    });
    const grant = management.grantWorkspace({
      endpointId: created.endpointId,
      workspaceId: workspaceA,
      actorHumanPrincipalId: "owner-human-1"
    });
    expect(grant).toMatchObject({
      endpointId: created.endpointId,
      workspaceId: workspaceA,
      revokedAt: null
    });
    expect(management.listOwnershipRepairRequired()).toEqual([]);
    expect(() =>
      management.repairOwnership({
        endpointId: created.endpointId,
        ownerHumanPrincipalId: "owner-human-2"
      })
    ).toThrow(new RemoteAgentAuthorizationError("remote_agent_not_found"));
  });

  it("grants two workspaces, revokes one, and keeps the agent", async () => {
    const { host, repo, management, workspaceA, workspaceB } = await fixture();
    const agent = repo.registerOrRestoreFromProfile({
      hostId: host.id,
      profileId: "profile-main",
      agentId: "codex",
      displayName: "Codex",
      now: now.toISOString(),
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "workspace_restricted"
    });
    management.grantWorkspace({
      endpointId: agent.endpointId,
      workspaceId: workspaceA,
      actorHumanPrincipalId: "owner-human-1"
    });
    management.grantWorkspace({
      endpointId: agent.endpointId,
      workspaceId: workspaceB,
      actorHumanPrincipalId: "owner-human-1"
    });
    expect(() =>
      management.grantWorkspace({
        endpointId: agent.endpointId,
        workspaceId: workspaceA,
        actorHumanPrincipalId: "owner-human-2"
      })
    ).toThrow(new RemoteAgentAuthorizationError("remote_agent_not_found"));
    const revoked = management.revokeGrant({
      endpointId: agent.endpointId,
      workspaceId: workspaceA,
      actorHumanPrincipalId: "owner-human-1"
    });
    expect(revoked.revokedAt).toBe(now.toISOString());
    expect(repo.listActiveGrantsForWorkspace(workspaceA)).toEqual([]);
    expect(repo.listActiveGrantsForWorkspace(workspaceB)).toHaveLength(1);
    expect(
      management.get({ endpointId: agent.endpointId, actorHumanPrincipalId: "owner-human-1" })
    ).toMatchObject({
      endpointId: agent.endpointId,
      revokedAt: null
    });
    const revokedAgent = management.revokeAgent({
      endpointId: agent.endpointId,
      actorHumanPrincipalId: "owner-human-1"
    });
    expect(revokedAgent.revokedAt).toBe(now.toISOString());
    expect(repo.getByEndpointId(agent.endpointId)?.endpointId).toBe(agent.endpointId);
  });

  it("lists and mutates an agent after dual-token principal merge", async () => {
    const { database, host, repo, management, workspaceA } = await fixture();
    insertHuman(database, "human-split-b", "Split B");
    const owned = repo.registerOrRestoreFromProfile({
      hostId: host.id,
      profileId: "profile-main",
      agentId: "codex",
      displayName: "Codex",
      now: now.toISOString(),
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "unrestricted"
    });
    const identities = new HumanIdentityCredentialStore(database, () => now);
    const tokenA = identities.issue("owner-human-1");
    const tokenB = identities.issue("human-split-b");
    identities.merge(tokenB.identityToken, tokenA.identityToken);
    expect(management.listOwned("human-split-b")).toEqual([owned]);
    expect(
      management.get({ endpointId: owned.endpointId, actorHumanPrincipalId: "human-split-b" })
    ).toEqual(owned);
    const updated = management.setAccessMode({
      endpointId: owned.endpointId,
      actorHumanPrincipalId: "human-split-b",
      accessMode: "workspace_restricted"
    });
    expect(updated.accessMode).toBe("workspace_restricted");
    const grant = management.grantWorkspace({
      endpointId: owned.endpointId,
      workspaceId: workspaceA,
      actorHumanPrincipalId: "human-split-b"
    });
    expect(grant.workspaceId).toBe(workspaceA);
    expect(
      management.revokeGrant({
        endpointId: owned.endpointId,
        workspaceId: workspaceA,
        actorHumanPrincipalId: "human-split-b"
      }).revokedAt
    ).toBe(now.toISOString());
    expect(
      management.revokeAgent({
        endpointId: owned.endpointId,
        actorHumanPrincipalId: "human-split-b"
      }).revokedAt
    ).toBe(now.toISOString());
  });

  it("lists and mutates an agent after an A→B→C principal merge", async () => {
    const { database, host, repo, management, workspaceA } = await fixture();
    insertHuman(database, "human-a", "Human A");
    insertHuman(database, "human-b", "Human B");
    insertHuman(database, "human-c", "Human C");
    const owned = repo.registerOrRestoreFromProfile({
      hostId: host.id,
      profileId: "profile-chain",
      agentId: "codex",
      displayName: "Codex Chain",
      now: now.toISOString(),
      ownerHumanPrincipalId: "human-a",
      accessMode: "unrestricted"
    });
    const identities = new HumanIdentityCredentialStore(database, () => now);
    const tokenA = identities.issue("human-a");
    const tokenB = identities.issue("human-b");
    const tokenC = identities.issue("human-c");
    identities.merge(tokenA.identityToken, tokenB.identityToken);
    identities.merge(tokenB.identityToken, tokenC.identityToken);
    const canonicalOwned = { ...owned, ownerHumanPrincipalId: "human-c" };
    expect(management.listOwned("human-c")).toEqual([canonicalOwned]);
    expect(management.listOwned("human-b")).toEqual([canonicalOwned]);
    expect(management.listOwned("human-a")).toEqual([canonicalOwned]);
    expect(
      management.get({ endpointId: owned.endpointId, actorHumanPrincipalId: "human-c" })
    ).toEqual(canonicalOwned);
    const updated = management.setAccessMode({
      endpointId: owned.endpointId,
      actorHumanPrincipalId: "human-c",
      accessMode: "workspace_restricted"
    });
    expect(updated.accessMode).toBe("workspace_restricted");
    const grant = management.grantWorkspace({
      endpointId: owned.endpointId,
      workspaceId: workspaceA,
      actorHumanPrincipalId: "human-a"
    });
    expect(grant.workspaceId).toBe(workspaceA);
  });
});
