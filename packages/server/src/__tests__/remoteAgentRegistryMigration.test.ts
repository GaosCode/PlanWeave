import { afterEach, describe, expect, it } from "vitest";
import { endpointIdFor } from "../agentEndpointCatalog.js";
import { AgentHostRepository } from "../hosts.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import {
  applyMigrations,
  centralSchemaVersion,
  latestCentralSchemaVersion
} from "../migrations.js";
import { migrations } from "../migrations/registry.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const now = new Date("2026-08-03T08:00:00.000Z");

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function applyThrough(database: SqliteDatabase, throughVersion: number): void {
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  for (const migration of migrations) {
    if (migration.version > throughVersion) break;
    if (migration.disableForeignKeys) database.exec("PRAGMA foreign_keys = OFF");
    try {
      database.exec("BEGIN IMMEDIATE");
      migration.before?.(database);
      database.exec(migration.sql);
      migration.after?.(database);
      database
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(migration.version, "2020-01-01T00:00:00.000Z");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      if (migration.disableForeignKeys) database.exec("PRAGMA foreign_keys = ON");
    }
  }
}

async function openDatabase(): Promise<SqliteDatabase> {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  return database;
}

function tableExists(database: SqliteDatabase, table: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
  );
}

function acpProfile(
  overrides: Partial<{
    profileId: string;
    agentId: string;
    displayName: string;
    status: "ready" | "missing" | "invalid";
  }> = {}
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

describe("remote agent registry migration v57", () => {
  it("registers as latest schema version", () => {
    expect(latestCentralSchemaVersion).toBe(57);
  });

  it("creates both tables and the active-grant index on an empty database", async () => {
    const database = await openDatabase();
    applyMigrations(database);
    expect(centralSchemaVersion(database)).toBe(57);
    expect(tableExists(database, "remote_agents")).toBe(true);
    expect(tableExists(database, "remote_agent_workspace_grants")).toBe(true);
    expect(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_remote_agent_workspace_grants_workspace_active'"
        )
        .get()
    ).toBeDefined();
    expect(database.prepare("SELECT COUNT(*) AS count FROM remote_agents").get()).toEqual({
      count: 0
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM remote_agent_workspace_grants").get()
    ).toEqual({ count: 0 });
  });

  it("is a no-op when applyMigrations is re-run", async () => {
    const database = await openDatabase();
    applyMigrations(database);
    const applied = database
      .prepare("SELECT version, applied_at FROM schema_migrations WHERE version=57")
      .get();
    expect(() => applyMigrations(database)).not.toThrow();
    expect(centralSchemaVersion(database)).toBe(57);
    expect(
      database.prepare("SELECT version, applied_at FROM schema_migrations WHERE version=57").get()
    ).toEqual(applied);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=57").get()
    ).toEqual({ count: 1 });
  });

  it("backfills repair-required agents from readiness profiles without grants or unrestricted mode", async () => {
    const database = await openDatabase();
    applyThrough(database, 56);
    const identity = new WorkspaceIdentityRepository(database);
    const workspaceA = identity.ensureWorkspaceForLegacyProject("project-a");
    const workspaceB = identity.ensureWorkspaceForLegacyProject("project-b");
    const hosts = new AgentHostRepository(database, () => now);
    const host = hosts.register("Build Mac").host;
    hosts.bindToWorkspace(host.id, workspaceA);
    hosts.bindToWorkspace(host.id, workspaceB);
    hosts.reportOnline(host.id, ["acp.codex"], 2, {
      workspaceMappings: [
        { workspaceId: workspaceA, status: "ready" },
        { workspaceId: workspaceB, status: "ready" }
      ],
      acpProfiles: [
        acpProfile(),
        acpProfile({ profileId: "profile-claude", agentId: "claude", displayName: "Claude" })
      ]
    });
    database
      .prepare("UPDATE agent_hosts SET last_seen_at=? WHERE id=?")
      .run("2020-01-01T00:00:00.000Z", host.id);
    const hostCount = database.prepare("SELECT COUNT(*) AS count FROM agent_hosts").get();
    expect(tableExists(database, "remote_operations")).toBe(true);
    expect(tableExists(database, "remote_agents")).toBe(false);

    applyMigrations(database);
    expect(centralSchemaVersion(database)).toBe(57);
    const agents = database
      .prepare(
        `SELECT endpoint_id, host_id, profile_id, agent_id, owner_human_principal_id,
                display_name, access_mode, policy_revision, ownership_repair_required, revoked_at
         FROM remote_agents ORDER BY profile_id`
      )
      .all();
    expect(agents).toEqual([
      {
        endpoint_id: endpointIdFor({
          hostId: host.id,
          profileId: "profile-claude",
          agentId: "claude"
        }),
        host_id: host.id,
        profile_id: "profile-claude",
        agent_id: "claude",
        owner_human_principal_id: null,
        display_name: "Claude",
        access_mode: "workspace_restricted",
        policy_revision: 1,
        ownership_repair_required: 1,
        revoked_at: null
      },
      {
        endpoint_id: endpointIdFor({
          hostId: host.id,
          profileId: "profile-main",
          agentId: "codex"
        }),
        host_id: host.id,
        profile_id: "profile-main",
        agent_id: "codex",
        owner_human_principal_id: null,
        display_name: "Codex",
        access_mode: "workspace_restricted",
        policy_revision: 1,
        ownership_repair_required: 1,
        revoked_at: null
      }
    ]);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM remote_agent_workspace_grants").get()
    ).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM agent_hosts").get()).toEqual(hostCount);
    expect(tableExists(database, "remote_operations")).toBe(true);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM workspace_agent_hosts WHERE host_id=?")
        .get(host.id)
    ).toEqual({ count: 2 });

    applyMigrations(database);
    expect(database.prepare("SELECT COUNT(*) AS count FROM remote_agents").get()).toEqual({
      count: 2
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM remote_agent_workspace_grants").get()
    ).toEqual({ count: 0 });
  });

  it("does not invent agents when readiness JSON is invalid or profiles are absent", async () => {
    const database = await openDatabase();
    applyThrough(database, 56);
    const hosts = new AgentHostRepository(database, () => now);
    const invalidHost = hosts.register("Invalid Readiness").host;
    const emptyHost = hosts.register("Empty Profiles").host;
    const superseded = hosts.register("Superseded Host").host;
    hosts.reportOnline(emptyHost.id, ["acp.codex"], 1, {
      workspaceMappings: [],
      acpProfiles: []
    });
    hosts.reportOnline(superseded.id, ["acp.codex"], 1, {
      workspaceMappings: [],
      acpProfiles: [acpProfile()]
    });
    database
      .prepare("UPDATE agent_hosts SET readiness_json=? WHERE id=?")
      .run("{not-json", invalidHost.id);
    database
      .prepare("UPDATE agent_hosts SET superseded_at=? WHERE id=?")
      .run(now.toISOString(), superseded.id);

    applyMigrations(database);
    expect(database.prepare("SELECT COUNT(*) AS count FROM remote_agents").get()).toEqual({
      count: 0
    });
    expect(tableExists(database, "agent_hosts")).toBe(true);
  });

  it("keeps CHECK: repaired agents require an owner, repair-required agents may omit one", async () => {
    const database = await openDatabase();
    applyMigrations(database);
    const hosts = new AgentHostRepository(database, () => now);
    const host = hosts.register("Check Host").host;
    const endpointId = endpointIdFor({
      hostId: host.id,
      profileId: "profile-main",
      agentId: "codex"
    });
    const at = now.toISOString();
    expect(() =>
      database
        .prepare(
          `INSERT INTO remote_agents(
             endpoint_id, host_id, profile_id, agent_id, owner_human_principal_id,
             display_name, access_mode, policy_revision, ownership_repair_required,
             created_at, updated_at, revoked_at
           ) VALUES (?,?,?,?,NULL,'Codex','workspace_restricted',1,0,?,?,NULL)`
        )
        .run(endpointId, host.id, "profile-main", "codex", at, at)
    ).toThrow(/CHECK/i);
    expect(() =>
      database
        .prepare(
          `INSERT INTO remote_agents(
             endpoint_id, host_id, profile_id, agent_id, owner_human_principal_id,
             display_name, access_mode, policy_revision, ownership_repair_required,
             created_at, updated_at, revoked_at
           ) VALUES (?,?,?,?,NULL,'Codex','workspace_restricted',1,1,?,?,NULL)`
        )
        .run(endpointId, host.id, "profile-main", "codex", at, at)
    ).not.toThrow();
  });
});
