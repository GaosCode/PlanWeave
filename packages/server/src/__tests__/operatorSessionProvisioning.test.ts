import { describe, expect, it } from "vitest";
import { applyMigrations } from "../migrations.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { provisionConfiguredOperatorSessions } from "../identity/operatorSessionProvisioning.js";
import { OperatorSessionStore } from "../identity/operatorSessionStore.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const tokenA = `pw_operator_${"A".repeat(43)}`;
const tokenB = `pw_operator_${"B".repeat(43)}`;
const firstIssuedAt = new Date("2030-01-01T00:00:00.000Z");

async function openDatabase(): Promise<SqliteDatabase> {
  const database = await openServerDatabase(":memory:", 5_000);
  applyMigrations(database);
  return database;
}

function credential(token: string, projectIds: string[], serverAdmin = false) {
  return {
    operatorId: "operator-a",
    tokenSha256: hashOperatorToken(token),
    projectIds,
    serverAdmin
  };
}

function provision(
  database: SqliteDatabase,
  credentials: ReturnType<typeof credential>[],
  trustedProjectIds: string[],
  clock: () => Date = () => firstIssuedAt
) {
  const identity = new WorkspaceIdentityRepository(database);
  return provisionConfiguredOperatorSessions({
    database,
    credentials,
    trustedProjectIds,
    workspaceForProject: (projectId) => identity.workspaceForLegacyProject(projectId),
    operatorSessionTtlMs: 30 * 24 * 60 * 60 * 1_000,
    clock
  });
}

describe("configured operator session provisioning", () => {
  it("is digest-idempotent without extending expiry and permits token rotation", async () => {
    const database = await openDatabase();
    try {
      const identity = new WorkspaceIdentityRepository(database);
      const workspaceId = identity.ensureWorkspaceForLegacyProject("project-a");
      const first = provision(database, [credential(tokenA, ["project-a"])], ["project-a"])[0];
      const second = provision(
        database,
        [credential(tokenA, ["project-a"])],
        ["project-a"],
        () => new Date("2030-02-01T00:00:00.000Z")
      )[0];
      expect(second).toEqual(first);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM workspace_operator_sessions").get()?.count
      ).toBe(1);

      const rotated = provision(database, [credential(tokenB, ["project-a"])], ["project-a"])[0];
      expect(rotated.operatorSessionId).not.toBe(first.operatorSessionId);
      expect(rotated.workspaceId).toBe(workspaceId);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM workspace_operator_sessions").get()?.count
      ).toBe(2);
      expect(
        new OperatorSessionStore(database).findByCredentialDigest(hashOperatorToken(tokenA))
      ).toEqual(first);
    } finally {
      database.close();
    }
  });

  it("rejects missing, untrusted, and cross-workspace scoped projects", async () => {
    const database = await openDatabase();
    try {
      const identity = new WorkspaceIdentityRepository(database);
      identity.ensureWorkspaceForLegacyProject("project-a");
      identity.ensureWorkspaceForLegacyProject("project-b");
      expect(() => provision(database, [credential(tokenA, [], false)], ["project-a"])).toThrow(
        "operator_project_scope_required"
      );
      expect(() => provision(database, [credential(tokenA, ["project-x"])], ["project-a"])).toThrow(
        "operator_project_not_trusted"
      );
      expect(() =>
        provision(
          database,
          [credential(tokenA, ["project-a", "project-b"])],
          ["project-a", "project-b"]
        )
      ).toThrow("operator_scope_workspace_ambiguous");
      expect(() =>
        provision(database, [credential(tokenA, ["project-a"], true)], ["project-a"])
      ).toThrow("operator_server_admin_scope_invalid");
    } finally {
      database.close();
    }
  });

  it("anchors server admins by trusted-project order and never revives revoked or expired sessions", async () => {
    const database = await openDatabase();
    try {
      const identity = new WorkspaceIdentityRepository(database);
      identity.ensureWorkspaceForLegacyProject("project-a");
      identity.ensureWorkspaceForLegacyProject("project-b");
      const admin = provision(
        database,
        [credential(tokenA, [], true)],
        ["project-b", "project-a"]
      )[0];
      expect(admin.workspaceId).toBe(identity.workspaceForLegacyProject("project-b"));
      const store = new OperatorSessionStore(database, () => new Date("2030-01-02T00:00:00.000Z"));
      store.revoke(admin.workspaceId, admin.operatorSessionId);
      const revoked = provision(
        database,
        [credential(tokenA, [], true)],
        ["project-b", "project-a"],
        () => new Date("2030-02-01T00:00:00.000Z")
      )[0];
      expect(revoked.revokedAt).not.toBeNull();
      expect(revoked.expiresAt).toBe(admin.expiresAt);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM workspace_operator_sessions").get()?.count
      ).toBe(1);
      expect(new OperatorSessionStore(database).authenticate(tokenA)).toBeUndefined();

      const expired = provision(
        database,
        [credential(tokenB, [], true)],
        ["project-b"],
        () => new Date("2030-01-01T00:00:00.000Z")
      )[0];
      const afterExpiry = provision(
        database,
        [credential(tokenB, [], true)],
        ["project-b"],
        () => new Date(expired.expiresAt)
      )[0];
      expect(afterExpiry.expiresAt).toBe(expired.expiresAt);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM workspace_operator_sessions").get()?.count
      ).toBe(2);
      expect(
        new OperatorSessionStore(database, () => new Date(expired.expiresAt)).authenticate(tokenB)
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("preserves an existing server admin anchor when trusted project order changes", async () => {
    const database = await openDatabase();
    try {
      const identity = new WorkspaceIdentityRepository(database);
      identity.ensureWorkspaceForLegacyProject("project-a");
      identity.ensureWorkspaceForLegacyProject("project-b");
      const first = provision(
        database,
        [credential(tokenA, [], true)],
        ["project-b", "project-a"]
      )[0];

      const restarted = provision(
        database,
        [credential(tokenA, [], true)],
        ["project-a", "project-b"]
      )[0];

      expect(restarted).toEqual(first);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM workspace_operator_sessions").get()?.count
      ).toBe(1);
      expect(() =>
        provision(
          database,
          [{ ...credential(tokenA, [], true), operatorId: "operator-b" }],
          ["project-a", "project-b"]
        )
      ).toThrow("operator_session_credential_conflict");
    } finally {
      database.close();
    }
  });

  it("allows an explicitly anchored server admin when no collaboration project is trusted", async () => {
    const database = await openDatabase();
    try {
      const identity = new WorkspaceIdentityRepository(database);
      const ownerWorkspaceId = identity.ensureConfiguredWorkspace("workspace-owner-runtime");
      const sessions = provisionConfiguredOperatorSessions({
        database,
        credentials: [credential(tokenA, [], true)],
        trustedProjectIds: [],
        serverAdminAnchorWorkspaceId: ownerWorkspaceId,
        workspaceForProject: () => undefined,
        operatorSessionTtlMs: 30 * 24 * 60 * 60 * 1_000,
        clock: () => firstIssuedAt
      });

      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.workspaceId).toBe(ownerWorkspaceId);
      expect(() =>
        provisionConfiguredOperatorSessions({
          database,
          credentials: [credential(tokenB, ["project-a"], false)],
          trustedProjectIds: [],
          serverAdminAnchorWorkspaceId: ownerWorkspaceId,
          workspaceForProject: () => undefined,
          operatorSessionTtlMs: 30 * 24 * 60 * 60 * 1_000,
          clock: () => firstIssuedAt
        })
      ).toThrow("operator_project_not_trusted");
    } finally {
      database.close();
    }
  });

  it("fails closed when a configured digest is bound to another workspace", async () => {
    const database = await openDatabase();
    try {
      const identity = new WorkspaceIdentityRepository(database);
      identity.ensureWorkspaceForLegacyProject("project-a");
      identity.ensureWorkspaceForLegacyProject("project-b");
      provision(database, [credential(tokenA, ["project-a"])], ["project-a"]);
      expect(() => provision(database, [credential(tokenA, ["project-b"])], ["project-b"])).toThrow(
        "operator_session_credential_conflict"
      );
    } finally {
      database.close();
    }
  });
});
