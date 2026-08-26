import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../migrations.js";
import { HumanIdentityCredentialStore } from "../identity/humanIdentityCredentialStore.js";
import { MembershipStore } from "../identity/membershipStore.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { AuthorityRepository } from "../work/authorityRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function openDatabase(): Promise<SqliteDatabase> {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  return database;
}

function seedWorkspaceMembers(
  database: SqliteDatabase,
  members: ReadonlyArray<{ id: string; name: string; role: "owner" | "member" }>
): void {
  const now = "2030-01-01T00:00:00.000Z";
  const principals = new MembershipStore(database, () => new Date(now));
  database
    .prepare(
      "INSERT INTO workspaces(workspace_id,display_name,created_at) VALUES ('w','Workspace',?)"
    )
    .run(now);
  for (const member of members) {
    principals.insertPrincipal(member.id, member.name);
    database
      .prepare(
        `INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at)
         VALUES('w',?,?,?,NULL)`
      )
      .run(member.id, member.name, now);
    database
      .prepare(
        `INSERT INTO workspace_memberships(
          workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at
        ) VALUES('w',?,?,?,1,?,?,NULL)`
      )
      .run(`m-${member.id}`, member.id, member.role, now, now);
  }
}

function activeMemberships(database: SqliteDatabase): Array<{
  human_principal_id: string;
  role: string;
  revoked_at: string | null;
}> {
  return database
    .prepare(
      `SELECT human_principal_id, role, revoked_at FROM workspace_memberships
       WHERE workspace_id='w' ORDER BY human_principal_id`
    )
    .all() as Array<{ human_principal_id: string; role: string; revoked_at: string | null }>;
}

describe("human principal authorization merge", () => {
  it("keeps owner over member and one active membership on the canonical principal", async () => {
    const database = await openDatabase();
    const now = new Date("2030-01-01T00:00:00.000Z");
    seedWorkspaceMembers(database, [
      { id: "human-a", name: "Alice A", role: "owner" },
      { id: "human-c", name: "Alice C", role: "member" }
    ]);
    const store = new HumanIdentityCredentialStore(database, () => now);
    const tokenA = store.issue("human-a");
    const tokenC = store.issue("human-c");
    store.merge(tokenA.identityToken, tokenC.identityToken);
    const rows = activeMemberships(database);
    expect(rows.filter((row) => row.revoked_at === null)).toEqual([
      { human_principal_id: "human-c", role: "owner", revoked_at: null }
    ]);
    expect(rows.find((row) => row.human_principal_id === "human-a")?.revoked_at).toBe(
      now.toISOString()
    );
    const identity = new WorkspaceIdentityRepository(database);
    expect(identity.findActiveMembership("w", "human-a")).toMatchObject({
      humanPrincipalId: "human-c",
      role: "owner"
    });
    expect(identity.findActiveMembership("w", "human-c")?.role).toBe("owner");
    expect(identity.activeWorkspaceIdsForHumanPrincipal("human-a")).toEqual(["w"]);
    expect(identity.activeWorkspaceIdsForHumanPrincipal("human-c")).toEqual(["w"]);
  });

  it("rewrites private Project/Canvas owners onto the canonical principal", async () => {
    const database = await openDatabase();
    const now = new Date("2030-01-01T00:00:00.000Z");
    seedWorkspaceMembers(database, [
      { id: "human-a", name: "Alice A", role: "owner" },
      { id: "human-c", name: "Alice C", role: "member" }
    ]);
    const access = new ProjectAccessRepository(database, () => now);
    access.registerProjectInternal({
      workspaceId: "w",
      projectId: "p",
      projectRoot: "/tmp/planweave-merge-project",
      ownerHumanPrincipalId: "human-a"
    });
    access.registerCanvasInternal({
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      packageDir: "/tmp/planweave-merge-canvas",
      ownerHumanPrincipalId: "human-a"
    });
    const store = new HumanIdentityCredentialStore(database, () => now);
    store.merge(store.issue("human-a").identityToken, store.issue("human-c").identityToken);
    expect(access.registry.projectInternal("w", "p")?.ownerHumanPrincipalId).toBe("human-c");
    expect(access.registry.canvasInternal("w", "p", "c")?.ownerHumanPrincipalId).toBe("human-c");
    const actorC = { kind: "human" as const, id: "human-c" };
    expect(
      access
        .listAuthorizedProjects({ workspaceId: "w", actor: actorC })
        .map((row) => row.registry.projectId)
    ).toEqual(["p"]);
    expect(access.listAuthorizedProjects({ workspaceId: "w", actor: actorC })[0]?.owner).toBe(
      "human-c"
    );
    expect(
      access
        .listAuthorizedCanvases({ workspaceId: "w", projectId: "p", actor: actorC })
        .map((row) => row.registry.canvasId)
    ).toEqual(["c"]);
  });

  it("keeps the more permissive ACL grant when both principals already have grants", async () => {
    const database = await openDatabase();
    const now = new Date("2030-01-01T00:00:00.000Z");
    seedWorkspaceMembers(database, [
      { id: "human-owner", name: "Owner", role: "owner" },
      { id: "human-a", name: "Alice A", role: "member" },
      { id: "human-c", name: "Alice C", role: "member" }
    ]);
    const access = new ProjectAccessRepository(database, () => now);
    access.registerProjectInternal({
      workspaceId: "w",
      projectId: "p",
      projectRoot: "/tmp/planweave-merge-grants",
      ownerHumanPrincipalId: "human-owner"
    });
    access.registerCanvasInternal({
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      packageDir: "/tmp/planweave-merge-grants-canvas",
      ownerHumanPrincipalId: "human-owner"
    });
    const owner = { kind: "human" as const, id: "human-owner" };
    access.grant({
      workspaceId: "w",
      projectId: "p",
      humanPrincipalId: "human-a",
      role: "editor",
      grantedBy: owner
    });
    access.grant({
      workspaceId: "w",
      projectId: "p",
      humanPrincipalId: "human-c",
      role: "viewer",
      grantedBy: owner
    });
    const store = new HumanIdentityCredentialStore(database, () => now);
    store.merge(store.issue("human-a").identityToken, store.issue("human-c").identityToken);
    expect(
      access.listActiveCanvasPersonGrants({
        workspaceId: "w",
        projectId: "p",
        canvasId: "c",
        humanPrincipalId: "human-c"
      })
    ).toEqual([{ grantId: expect.any(String), scopeKind: "project", role: "editor" }]);
    const grants = database
      .prepare(
        `SELECT human_principal_id, role, revoked_at FROM project_access_grants
         WHERE workspace_id='w' AND scope_kind='project' ORDER BY human_principal_id`
      )
      .all() as Array<{ human_principal_id: string; role: string; revoked_at: string | null }>;
    expect(grants.filter((row) => row.revoked_at === null)).toEqual([
      { human_principal_id: "human-c", role: "editor", revoked_at: null }
    ]);
  });

  it("canonicalizes later grant writes onto the merged principal", async () => {
    const database = await openDatabase();
    const now = new Date("2030-01-01T00:00:00.000Z");
    seedWorkspaceMembers(database, [
      { id: "human-owner", name: "Owner", role: "owner" },
      { id: "human-a", name: "Alice A", role: "member" },
      { id: "human-c", name: "Alice C", role: "member" }
    ]);
    const access = new ProjectAccessRepository(database, () => now);
    access.registerProjectInternal({
      workspaceId: "w",
      projectId: "p",
      projectRoot: "/tmp/planweave-grant-canonical",
      ownerHumanPrincipalId: "human-owner"
    });
    access.registerCanvasInternal({
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      packageDir: "/tmp/planweave-grant-canonical-canvas",
      ownerHumanPrincipalId: "human-owner"
    });
    const store = new HumanIdentityCredentialStore(database, () => now);
    const tokenA = store.issue("human-a");
    const tokenC = store.issue("human-c");
    store.merge(tokenA.identityToken, tokenC.identityToken);
    const grant = access.grant({
      workspaceId: "w",
      projectId: "p",
      humanPrincipalId: "human-a",
      role: "editor",
      grantedBy: { kind: "human", id: "human-owner" }
    });
    expect(grant.humanPrincipalId).toBe("human-c");
    expect(grant.grantedBy).toEqual({ kind: "human", id: "human-owner" });
    const repeat = store.merge(tokenA.identityToken, tokenC.identityToken);
    expect(repeat).toEqual({ alreadyEquivalent: true, canonicalHumanPrincipalId: "human-c" });
    const grants = database
      .prepare(
        `SELECT human_principal_id, role, revoked_at FROM project_access_grants
         WHERE workspace_id='w' AND scope_kind='project' ORDER BY human_principal_id`
      )
      .all() as Array<{ human_principal_id: string; role: string; revoked_at: string | null }>;
    expect(grants.filter((row) => row.revoked_at === null)).toEqual([
      { human_principal_id: "human-c", role: "editor", revoked_at: null }
    ]);
    expect(
      grants.some((row) => row.human_principal_id === "human-a" && row.revoked_at === null)
    ).toBe(false);
  });

  it("rewrites existing Responsibility onto the canonical principal and increments revision", async () => {
    const database = await openDatabase();
    const now = new Date("2030-01-01T00:00:00.000Z");
    seedWorkspaceMembers(database, [
      { id: "human-owner", name: "Owner", role: "owner" },
      { id: "human-a", name: "Alice A", role: "member" },
      { id: "human-c", name: "Alice C", role: "member" }
    ]);
    const scope = {
      kind: "task" as const,
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      taskId: "T-001"
    };
    const authority = new AuthorityRepository(database, { clock: () => now });
    const assigned = authority.applyResponsibility({
      mutation: {
        schemaVersion: "responsibility/v1",
        scope,
        principal: { kind: "human", humanPrincipalId: "human-a" },
        expectedRevision: 0
      },
      actor: { kind: "human", id: "human-owner" }
    });
    expect(assigned).toMatchObject({
      principal: { kind: "human", humanPrincipalId: "human-a" },
      revision: 1
    });
    const store = new HumanIdentityCredentialStore(database, () => now);
    store.merge(store.issue("human-a").identityToken, store.issue("human-c").identityToken);
    expect(authority.getResponsibility(scope)).toMatchObject({
      principal: { kind: "human", humanPrincipalId: "human-c" },
      revision: 2,
      updatedAt: now.toISOString()
    });
  });

  it("rewrites existing Reviewer onto the canonical principal and increments revision", async () => {
    const database = await openDatabase();
    const now = new Date("2030-01-01T00:00:00.000Z");
    seedWorkspaceMembers(database, [
      { id: "human-owner", name: "Owner", role: "owner" },
      { id: "human-a", name: "Alice A", role: "member" },
      { id: "human-c", name: "Alice C", role: "member" }
    ]);
    const scope = {
      kind: "task" as const,
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      taskId: "T-001"
    };
    const authority = new AuthorityRepository(database, { clock: () => now });
    const assigned = authority.applyReviewer({
      mutation: {
        schemaVersion: "review-assignment/v1",
        scope,
        principal: { kind: "human", humanPrincipalId: "human-a" },
        expectedRevision: 0
      },
      actor: { kind: "human", id: "human-owner" }
    });
    expect(assigned).toMatchObject({
      principal: { kind: "human", humanPrincipalId: "human-a" },
      revision: 1
    });
    const store = new HumanIdentityCredentialStore(database, () => now);
    store.merge(store.issue("human-a").identityToken, store.issue("human-c").identityToken);
    expect(authority.getReviewer(scope)).toMatchObject({
      principal: { kind: "human", humanPrincipalId: "human-c" },
      revision: 2,
      updatedAt: now.toISOString()
    });
  });
});
