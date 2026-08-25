import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { endpointIdFor } from "../agentEndpointCatalog.js";
import { createRemoteBlockCoordination } from "../distributedCoordination.js";
import { HostEnrollmentService } from "../hostEnrollment.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { readHostRemoteAgentDefaults } from "../remoteAgent/hostDefaults.js";
import { RemoteAgentRepository } from "../remoteAgent/index.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const now = new Date("2026-08-03T08:00:00.000Z");

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function token() {
  return `pw_host_${randomBytes(32).toString("base64url")}`;
}

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

function enrollmentRequest(
  enrollmentCode: string,
  credentialToken = token(),
  enrollmentAttemptId = "attempt-remote-agent-001"
) {
  return {
    type: "host.enrollment.request" as const,
    protocolVersion: 1 as const,
    enrollmentCode,
    enrollmentAttemptId,
    installationId: randomUUID(),
    credentialToken,
    displayName: "Linux Build Host",
    capabilities: ["acp.codex"],
    capacity: 2
  };
}

async function fixture() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  insertHuman(database, "owner-human-1", "Owner One");
  const identity = new WorkspaceIdentityRepository(database);
  const workspaceA = identity.ensureWorkspaceForLegacyProject("project-a");
  const workspaceB = identity.ensureWorkspaceForLegacyProject("project-b");
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
    { serverInstanceOwnerToken: "remote-agent-enrollment-test" }
  );
  const enrollments = new HostEnrollmentService(database, () => now);
  const repo = new RemoteAgentRepository(database, () => now);
  return { database, workspaceA, workspaceB, coordination, enrollments, repo };
}

function reportReady(
  coordination: ReturnType<typeof createRemoteBlockCoordination>,
  hostId: string,
  profiles = [acpProfile()]
) {
  return coordination.hosts.reportOnline(hostId, ["acp.codex"], 2, {
    workspaceMappings: [],
    acpProfiles: profiles
  });
}

describe("remote agent enrollment", () => {
  it("rejects owner without accessMode and does not infer owner from operatorId", async () => {
    const { enrollments, database, workspaceA } = await fixture();
    expect(() =>
      enrollments.createGrant({
        expiresAt: new Date(now.getTime() + 60_000),
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
        ownerHumanPrincipalId: "owner-human-1"
      })
    ).toThrow("host_enrollment_owner_access_mode_required");
    expect(() =>
      enrollments.createGrant({
        expiresAt: new Date(now.getTime() + 60_000),
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
        accessMode: "unrestricted"
      })
    ).toThrow("host_enrollment_access_mode_requires_owner");
    expect(() =>
      enrollments.createGrant({
        expiresAt: new Date(now.getTime() + 60_000),
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
        ownerHumanPrincipalId: "operator-admin",
        accessMode: "unrestricted"
      })
    ).toThrow("host_enrollment_owner_not_found");
    expect(() =>
      enrollments.createGrant({
        expiresAt: new Date(now.getTime() + 60_000),
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
        createWorkspaceGrant: true
      })
    ).toThrow("host_enrollment_workspace_grant_requires_workspace");
    expect(() =>
      enrollments.createGrant({
        workspaceId: workspaceA,
        expiresAt: new Date(now.getTime() + 60_000),
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
        createWorkspaceGrant: true
      })
    ).toThrow("host_enrollment_workspace_grant_requires_owner");
    enrollments.createGrant({
      expiresAt: new Date(now.getTime() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    });
    expect(
      database
        .prepare(
          `SELECT owner_human_principal_id, access_mode, create_workspace_grant
           FROM agent_host_enrollment_grants`
        )
        .get()
    ).toEqual({
      owner_human_principal_id: null,
      access_mode: null,
      create_workspace_grant: 0
    });
  });

  it("creates repair-required agents from readiness when enrollment omits owner", async () => {
    const { database, enrollments, coordination, repo, workspaceA } = await fixture();
    const grant = enrollments.createGrant({
      workspaceId: workspaceA,
      expiresAt: new Date(now.getTime() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    });
    const completed = enrollments.exchange(enrollmentRequest(grant.enrollmentCode));
    reportReady(coordination, completed.hostId);
    const agents = repo.listByHostId(completed.hostId);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      hostId: completed.hostId,
      profileId: "profile-main",
      agentId: "codex",
      ownerHumanPrincipalId: null,
      ownershipRepairRequired: true,
      accessMode: "workspace_restricted"
    });
    expect(agents[0]?.endpointId).toBe(
      endpointIdFor({
        hostId: completed.hostId,
        profileId: "profile-main",
        agentId: "codex"
      })
    );
    expect(agents[0]?.endpointId).not.toContain(workspaceA);
    expect(repo.listGrants(agents[0]?.endpointId ?? "")).toEqual([]);
    expect(repo.listByOwnerHumanPrincipalId("server-admin")).toEqual([]);
    expect(readHostRemoteAgentDefaults(database, completed.hostId)).toBeUndefined();
  });

  it("creates owned unrestricted agents with a stable endpointId that omits workspaceId", async () => {
    const { database, enrollments, coordination, repo, workspaceA } = await fixture();
    const grant = enrollments.createGrant({
      workspaceId: workspaceA,
      expiresAt: new Date(now.getTime() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "unrestricted"
    });
    const completed = enrollments.exchange(enrollmentRequest(grant.enrollmentCode));
    const first = reportReady(coordination, completed.hostId);
    const endpointId = endpointIdFor({
      hostId: completed.hostId,
      profileId: "profile-main",
      agentId: "codex"
    });
    const agent = repo.getByEndpointId(endpointId);
    expect(agent).toMatchObject({
      endpointId,
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "unrestricted",
      ownershipRepairRequired: false
    });
    expect(endpointId).not.toContain(workspaceA);
    expect(repo.listGrants(endpointId)).toEqual([]);
    expect(readHostRemoteAgentDefaults(database, completed.hostId)).toMatchObject({
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "unrestricted",
      createWorkspaceGrant: false,
      grantWorkspaceId: null
    });
    reportReady(coordination, completed.hostId);
    expect(repo.getByEndpointId(endpointId)?.endpointId).toBe(endpointId);
    expect(repo.listByHostId(completed.hostId)).toHaveLength(1);
    expect(first.id).toBe(completed.hostId);
  });

  it("does not create a workspace grant when workspaceId is present without createWorkspaceGrant", async () => {
    const { enrollments, coordination, repo, workspaceA } = await fixture();
    const grant = enrollments.createGrant({
      workspaceId: workspaceA,
      expiresAt: new Date(now.getTime() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "workspace_restricted"
    });
    const completed = enrollments.exchange(enrollmentRequest(grant.enrollmentCode));
    reportReady(coordination, completed.hostId);
    const agents = repo.listByHostId(completed.hostId);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "workspace_restricted",
      ownershipRepairRequired: false
    });
    expect(repo.listGrants(agents[0]?.endpointId ?? "")).toEqual([]);
    expect(repo.listActiveGrantsForWorkspace(workspaceA)).toEqual([]);
  });

  it("creates one workspace grant only when createWorkspaceGrant is explicit", async () => {
    const { enrollments, coordination, repo, workspaceA, workspaceB } = await fixture();
    const grant = enrollments.createGrant({
      workspaceId: workspaceA,
      expiresAt: new Date(now.getTime() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "workspace_restricted",
      createWorkspaceGrant: true
    });
    const completed = enrollments.exchange(enrollmentRequest(grant.enrollmentCode));
    const endpointId = endpointIdFor({
      hostId: completed.hostId,
      profileId: "profile-main",
      agentId: "codex"
    });
    reportReady(coordination, completed.hostId);
    reportReady(coordination, completed.hostId, [
      acpProfile(),
      acpProfile({ profileId: "profile-claude", agentId: "claude", displayName: "Claude" })
    ]);
    const agent = repo.getByEndpointId(endpointId);
    expect(agent).toMatchObject({
      endpointId,
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "workspace_restricted"
    });
    const grants = repo.listGrants(endpointId);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      workspaceId: workspaceA,
      grantRevision: 1,
      grantedByHumanPrincipalId: "owner-human-1",
      revokedAt: null
    });
    expect(repo.listActiveGrantsForWorkspace(workspaceB)).toEqual([]);
    const claude = repo.listByHostId(completed.hostId).find((item) => item.agentId === "claude");
    expect(claude?.endpointId).not.toBe(endpointId);
    expect(repo.listGrants(claude?.endpointId ?? "")).toHaveLength(1);
  });

  it("copies declared owner defaults onto a superseded host generation", async () => {
    const { database, enrollments, coordination, repo } = await fixture();
    const installationId = randomUUID();
    const firstGrant = enrollments.createGrant({
      expiresAt: new Date(now.getTime() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "unrestricted"
    });
    const first = enrollments.exchange({
      ...enrollmentRequest(firstGrant.enrollmentCode, token(), "attempt-generation-one"),
      installationId
    });
    const secondGrant = enrollments.createGrant({
      expiresAt: new Date(now.getTime() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    });
    const second = enrollments.exchange({
      ...enrollmentRequest(secondGrant.enrollmentCode, token(), "attempt-generation-two"),
      installationId,
      supersedesHostId: first.hostId
    });
    expect(readHostRemoteAgentDefaults(database, second.hostId)).toMatchObject({
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "unrestricted"
    });
    reportReady(coordination, second.hostId);
    const agents = repo.listByHostId(second.hostId);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      ownerHumanPrincipalId: "owner-human-1",
      accessMode: "unrestricted",
      ownershipRepairRequired: false
    });
    expect(agents[0]?.hostId).toBe(second.hostId);
    expect(agents[0]?.hostId).not.toBe(first.hostId);
  });
});
