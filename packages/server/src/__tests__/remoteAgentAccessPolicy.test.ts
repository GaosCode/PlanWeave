import { afterEach, describe, expect, it } from "vitest";
import { endpointIdFor } from "../agentEndpointCatalog.js";
import { AgentEndpointCatalogError } from "../agentEndpointCatalog.js";
import { createRemoteBlockCoordination } from "../distributedCoordination.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { RemoteAgentAuthorizationError } from "../remoteAgent/errors.js";
import {
  listAuthorizedRemoteAgentEndpoints,
  RemoteAgentAccessPolicy,
  RemoteAgentRepository,
  authorizedRemoteAgentUseSchema,
  type RemoteAgentUseTarget
} from "../remoteAgent/index.js";
import { workspaceMembershipIdFor } from "../identity/workspaceMembershipProjection.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import type { RemoteAgentAuthorizationErrorCode } from "../remoteAgent/schema.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { ownHostRemoteAgents } from "./support/remoteAgentOwnerFixture.js";

const now = new Date("2026-08-03T08:00:00.000Z");
const databases: SqliteDatabase[] = [];

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

function addWorkspaceMember(
  database: SqliteDatabase,
  workspaceId: string,
  humanPrincipalId: string,
  role: "owner" | "member"
) {
  const issuedAt = now.toISOString();
  database
    .prepare(
      "INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES(?,?,?,?,NULL)"
    )
    .run(workspaceId, humanPrincipalId, humanPrincipalId, issuedAt);
  database
    .prepare(
      `INSERT INTO workspace_memberships(
        workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at
      ) VALUES(?,?,?,?,1,?,?,NULL)`
    )
    .run(
      workspaceId,
      workspaceMembershipIdFor(workspaceId, humanPrincipalId),
      humanPrincipalId,
      role,
      issuedAt,
      issuedAt
    );
}

function expectAuthorizationCode(run: () => unknown, code: RemoteAgentAuthorizationErrorCode) {
  expect(run).toThrow(RemoteAgentAuthorizationError);
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteAgentAuthorizationError);
    expect((error as RemoteAgentAuthorizationError).code).toBe(code);
    expect([
      "agent_endpoint_unavailable",
      "agent_endpoint_incompatible",
      "agent_endpoint_unknown"
    ]).not.toContain((error as RemoteAgentAuthorizationError).code);
    return;
  }
  expect.unreachable("expected RemoteAgentAuthorizationError");
}

async function fixture() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  insertHuman(database, "owner-human-1", "Owner One");
  insertHuman(database, "member-a", "Member A");
  insertHuman(database, "member-b", "Member B");
  insertHuman(database, "stranger", "Stranger");
  const identity = new WorkspaceIdentityRepository(database);
  const workspaceA = identity.ensureWorkspaceForLegacyProject("project-a");
  const workspaceB = identity.ensureWorkspaceForLegacyProject("project-b");
  addWorkspaceMember(database, workspaceA, "owner-human-1", "owner");
  addWorkspaceMember(database, workspaceA, "member-a", "member");
  addWorkspaceMember(database, workspaceB, "member-b", "member");
  const access = new ProjectAccessRepository(database);
  for (const workspaceId of [workspaceA, workspaceB]) {
    const projectId = workspaceId === workspaceA ? "project-a" : "project-b";
    access.registerProjectInternal({
      workspaceId,
      projectId,
      projectRoot: `/tmp/${projectId}`
    });
    access.registerCanvasInternal({
      workspaceId,
      projectId,
      canvasId: "default",
      packageDir: `/tmp/${projectId}/package`
    });
  }
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
      artifactContent: { readReport: async () => new Uint8Array() },
      enableAssignmentDispatchGate: false,
      ownerEndpointScopeAuthorized: () => true
    },
    { serverInstanceOwnerToken: "remote-agent-access-policy-test" }
  );
  const host = coordination.hosts.register("Build Mac").host;
  ownHostRemoteAgents({
    database,
    hostId: host.id,
    ownerHumanPrincipalId: "owner-human-1",
    accessMode: "unrestricted"
  });
  coordination.hosts.reportOnline(host.id, ["acp.codex", "host-only"], 2, {
    workspaceMappings: [{ workspaceId: workspaceA, status: "ready" }],
    acpProfiles: [
      {
        profileId: "profile-main",
        agentId: "codex",
        displayName: "Codex",
        status: "ready",
        capabilities: ["acp.codex"]
      }
    ]
  });
  const endpointId = endpointIdFor({
    hostId: host.id,
    profileId: "profile-main",
    agentId: "codex"
  });
  const repo = new RemoteAgentRepository(database, () => now);
  const policy = coordination.remoteAgentAccess;
  return {
    database,
    hosts: coordination.hosts,
    host,
    repo,
    policy,
    catalog: coordination.agentEndpoints,
    coordination,
    workspaceA,
    workspaceB,
    endpointId
  };
}

function ownerCanvas(): RemoteAgentUseTarget {
  return { kind: "owner_canvas", projectId: "project-a", canvasId: "default" };
}

function workspaceCanvas(workspaceId: string, projectId: string): RemoteAgentUseTarget {
  return { kind: "workspace_canvas", workspaceId, projectId, canvasId: "default" };
}

function authorize(
  policy: RemoteAgentAccessPolicy,
  humanPrincipalId: string,
  endpointId: string,
  target: RemoteAgentUseTarget,
  workspaceId: string,
  capabilities: readonly string[] = ["acp.codex"]
) {
  return policy.authorizeRemoteAgentUse({
    principal: { humanPrincipalId },
    endpointId,
    target,
    requiredCapabilities: capabilities,
    runtimeWorkspaceId: workspaceId,
    blockRef: "T-001#B-001",
    expectedResponsibilityRevision: 0,
    expectedReviewerRevision: 0
  });
}

describe("authorizeRemoteAgentUse", () => {
  it("1. owner + unrestricted Agent + owner canvas allows with agent_owner authority", async () => {
    const state = await fixture();
    const authorized = authorize(
      state.policy,
      "owner-human-1",
      state.endpointId,
      ownerCanvas(),
      state.workspaceA
    );
    expect(authorizedRemoteAgentUseSchema.parse(authorized)).toMatchObject({
      remoteAgent: {
        endpointId: state.endpointId,
        hostId: state.host.id,
        profileId: "profile-main",
        agentId: "codex"
      },
      runtimeAuthority: { kind: "owner_canvas" },
      agentAccessAuthority: {
        kind: "agent_owner",
        ownerHumanPrincipalId: "owner-human-1",
        policyRevision: expect.any(Number)
      }
    });
  });

  it("2. owner + unrestricted Agent + workspace canvas allows without a grant", async () => {
    const state = await fixture();
    const authorized = authorize(
      state.policy,
      "owner-human-1",
      state.endpointId,
      workspaceCanvas(state.workspaceA, "project-a"),
      state.workspaceA
    );
    expect(authorizedRemoteAgentUseSchema.parse(authorized)).toMatchObject({
      runtimeAuthority: { kind: "workspace_canvas", workspaceId: state.workspaceA },
      agentAccessAuthority: { kind: "agent_owner", policyRevision: expect.any(Number) }
    });
  });

  it("3. owner + workspace_restricted Agent + workspace without grant rejects scope forbidden", async () => {
    const state = await fixture();
    state.repo.setAccessMode({
      endpointId: state.endpointId,
      accessMode: "workspace_restricted"
    });
    expectAuthorizationCode(
      () =>
        authorize(
          state.policy,
          "owner-human-1",
          state.endpointId,
          workspaceCanvas(state.workspaceA, "project-a"),
          state.workspaceA
        ),
      "remote_agent_workspace_scope_forbidden"
    );
  });

  it("3b. owner + workspace_restricted Agent + valid grant on current workspace allows", async () => {
    const state = await fixture();
    state.repo.setAccessMode({
      endpointId: state.endpointId,
      accessMode: "workspace_restricted"
    });
    state.repo.grantWorkspace({
      endpointId: state.endpointId,
      workspaceId: state.workspaceA,
      grantedByHumanPrincipalId: "owner-human-1"
    });
    const authorized = authorize(
      state.policy,
      "owner-human-1",
      state.endpointId,
      workspaceCanvas(state.workspaceA, "project-a"),
      state.workspaceA
    );
    expect(authorizedRemoteAgentUseSchema.parse(authorized)).toMatchObject({
      runtimeAuthority: { kind: "workspace_canvas", workspaceId: state.workspaceA },
      agentAccessAuthority: { kind: "agent_owner", policyRevision: expect.any(Number) }
    });
  });

  it("3c. owner + workspace_restricted Agent + owner canvas rejects scope forbidden", async () => {
    const state = await fixture();
    state.repo.setAccessMode({
      endpointId: state.endpointId,
      accessMode: "workspace_restricted"
    });
    expectAuthorizationCode(
      () =>
        authorize(state.policy, "owner-human-1", state.endpointId, ownerCanvas(), state.workspaceA),
      "remote_agent_workspace_scope_forbidden"
    );
  });

  it("4. workspace member + valid grant on the current workspace allows with workspace_grant authority", async () => {
    const state = await fixture();
    state.repo.grantWorkspace({
      endpointId: state.endpointId,
      workspaceId: state.workspaceA,
      grantedByHumanPrincipalId: "owner-human-1"
    });
    const authorized = authorize(
      state.policy,
      "member-a",
      state.endpointId,
      workspaceCanvas(state.workspaceA, "project-a"),
      state.workspaceA
    );
    expect(authorizedRemoteAgentUseSchema.parse(authorized)).toMatchObject({
      runtimeAuthority: { kind: "workspace_canvas", workspaceId: state.workspaceA },
      agentAccessAuthority: {
        kind: "workspace_grant",
        workspaceId: state.workspaceA,
        grantRevision: expect.any(Number),
        policyRevision: expect.any(Number)
      }
    });
  });

  it("5. workspace B member calling an Agent granted only to A is rejected even with endpointId", async () => {
    const state = await fixture();
    state.repo.grantWorkspace({
      endpointId: state.endpointId,
      workspaceId: state.workspaceA,
      grantedByHumanPrincipalId: "owner-human-1"
    });
    expectAuthorizationCode(
      () =>
        authorize(
          state.policy,
          "member-b",
          state.endpointId,
          workspaceCanvas(state.workspaceB, "project-b"),
          state.workspaceB
        ),
      "remote_agent_workspace_grant_missing"
    );
  });

  it("6. known endpointId without grant cannot bypass via fleet fallback", async () => {
    const state = await fixture();
    expect(
      listAuthorizedRemoteAgentEndpoints({
        policy: state.policy,
        catalog: state.catalog,
        principal: { humanPrincipalId: "member-a" },
        target: workspaceCanvas(state.workspaceA, "project-a")
      }).items
    ).toEqual([]);
    expectAuthorizationCode(
      () =>
        authorize(
          state.policy,
          "member-a",
          state.endpointId,
          workspaceCanvas(state.workspaceA, "project-a"),
          state.workspaceA
        ),
      "remote_agent_workspace_grant_missing"
    );
  });

  it("7. Agent granted to A and B allows both workspaces", async () => {
    const state = await fixture();
    state.repo.grantWorkspace({
      endpointId: state.endpointId,
      workspaceId: state.workspaceA,
      grantedByHumanPrincipalId: "owner-human-1"
    });
    state.repo.grantWorkspace({
      endpointId: state.endpointId,
      workspaceId: state.workspaceB,
      grantedByHumanPrincipalId: "owner-human-1"
    });
    addWorkspaceMember(state.database, state.workspaceB, "member-a", "member");
    expect(
      listAuthorizedRemoteAgentEndpoints({
        policy: state.policy,
        catalog: state.catalog,
        principal: { humanPrincipalId: "member-a" },
        target: workspaceCanvas(state.workspaceA, "project-a")
      }).items
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ endpointId: state.endpointId, status: "available" })
      ])
    );
    expect(
      listAuthorizedRemoteAgentEndpoints({
        policy: state.policy,
        catalog: state.catalog,
        principal: { humanPrincipalId: "member-a" },
        target: workspaceCanvas(state.workspaceB, "project-b")
      }).items
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ endpointId: state.endpointId, status: "available" })
      ])
    );
    expect(
      authorizedRemoteAgentUseSchema.parse(
        authorize(
          state.policy,
          "member-a",
          state.endpointId,
          workspaceCanvas(state.workspaceA, "project-a"),
          state.workspaceA
        )
      )
    ).toMatchObject({
      agentAccessAuthority: {
        kind: "workspace_grant",
        workspaceId: state.workspaceA,
        grantRevision: expect.any(Number),
        policyRevision: expect.any(Number)
      }
    });
    expect(
      authorizedRemoteAgentUseSchema.parse(
        authorize(
          state.policy,
          "member-a",
          state.endpointId,
          workspaceCanvas(state.workspaceB, "project-b"),
          state.workspaceB
        )
      )
    ).toMatchObject({
      agentAccessAuthority: {
        kind: "workspace_grant",
        workspaceId: state.workspaceB,
        grantRevision: expect.any(Number),
        policyRevision: expect.any(Number)
      }
    });
  });

  it("8. after grant revoke, new dispatch on A rejects and endpointId stays stable", async () => {
    const state = await fixture();
    state.repo.grantWorkspace({
      endpointId: state.endpointId,
      workspaceId: state.workspaceA,
      grantedByHumanPrincipalId: "owner-human-1"
    });
    state.repo.revokeGrant({ endpointId: state.endpointId, workspaceId: state.workspaceA });
    expectAuthorizationCode(
      () =>
        authorize(
          state.policy,
          "member-a",
          state.endpointId,
          workspaceCanvas(state.workspaceA, "project-a"),
          state.workspaceA
        ),
      "remote_agent_workspace_grant_missing"
    );
    expect(
      endpointIdFor({ hostId: state.host.id, profileId: "profile-main", agentId: "codex" })
    ).toBe(state.endpointId);
  });

  it("9. authorization failures stay distinct from offline and incompatible", async () => {
    const state = await fixture();
    expectAuthorizationCode(
      () =>
        authorize(
          state.policy,
          "member-a",
          state.endpointId,
          workspaceCanvas(state.workspaceA, "project-a"),
          state.workspaceA
        ),
      "remote_agent_workspace_grant_missing"
    );
    expect(() =>
      authorize(state.policy, "owner-human-1", state.endpointId, ownerCanvas(), state.workspaceA, [
        "host-only"
      ])
    ).toThrowError(new AgentEndpointCatalogError("agent_endpoint_incompatible"));
  });

  it("rejects revoked agents, missing agents, and repair-required agents with access codes", async () => {
    const state = await fixture();
    state.repo.revokeAgent(state.endpointId);
    expectAuthorizationCode(
      () =>
        authorize(state.policy, "owner-human-1", state.endpointId, ownerCanvas(), state.workspaceA),
      "remote_agent_revoked"
    );
    expectAuthorizationCode(
      () =>
        authorize(
          state.policy,
          "owner-human-1",
          "aep_missingmissingmissingmissingmissingmissingmiss",
          ownerCanvas(),
          state.workspaceA
        ),
      "remote_agent_not_found"
    );

    const repairHost = state.coordination.hosts.register("Repair Host").host;
    state.coordination.hosts.reportOnline(repairHost.id, ["acp.codex"], 1, {
      workspaceMappings: [],
      acpProfiles: [
        {
          profileId: "profile-repair",
          agentId: "codex",
          displayName: "Repair Codex",
          status: "ready",
          capabilities: ["acp.codex"]
        }
      ]
    });
    const repairEndpointId = endpointIdFor({
      hostId: repairHost.id,
      profileId: "profile-repair",
      agentId: "codex"
    });
    expect(state.repo.getByEndpointId(repairEndpointId)?.ownershipRepairRequired).toBe(true);
    expectAuthorizationCode(
      () =>
        authorize(state.policy, "owner-human-1", repairEndpointId, ownerCanvas(), state.workspaceA),
      "remote_agent_ownership_repair_required"
    );
    expect(
      listAuthorizedRemoteAgentEndpoints({
        policy: state.policy,
        catalog: state.catalog,
        principal: { humanPrincipalId: "owner-human-1" },
        target: ownerCanvas()
      }).items.map((item) => item.endpointId)
    ).not.toContain(repairEndpointId);
  });

  it("does not treat operatorId as a human principal", async () => {
    const state = await fixture();
    expectAuthorizationCode(
      () =>
        authorize(
          state.policy,
          "operator-admin",
          state.endpointId,
          ownerCanvas(),
          state.workspaceA
        ),
      "remote_agent_not_found"
    );
  });

  it("omits unauthorized agents from the execution selector while keeping offline ones", async () => {
    const state = await fixture();
    state.database
      .prepare("UPDATE agent_hosts SET last_seen_at=? WHERE id=?")
      .run("2000-01-01T00:00:00.000Z", state.host.id);
    const listed = listAuthorizedRemoteAgentEndpoints({
      policy: state.policy,
      catalog: state.catalog,
      principal: { humanPrincipalId: "owner-human-1" },
      target: ownerCanvas()
    });
    expect(listed.items).toEqual([
      expect.objectContaining({
        endpointId: state.endpointId,
        status: "unavailable",
        unavailableReason: "host_offline"
      })
    ]);
    const memberListed = listAuthorizedRemoteAgentEndpoints({
      policy: state.policy,
      catalog: state.catalog,
      principal: { humanPrincipalId: "member-a" },
      target: workspaceCanvas(state.workspaceA, "project-a")
    });
    expect(memberListed.items).toEqual([]);
  });
});
