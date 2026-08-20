import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHostRepository } from "../hosts.js";
import { HostEnrollmentService } from "../hostEnrollment.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import {
  applyMigrations,
  centralSchemaVersion,
  latestCentralSchemaVersion
} from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function token() {
  return `pw_host_${randomBytes(32).toString("base64url")}`;
}

async function openMigratedDatabase(): Promise<SqliteDatabase> {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  return database;
}

async function openDatabaseBeforeStockHostFleetMigration(): Promise<SqliteDatabase> {
  const database = await openMigratedDatabase();
  database.prepare("DELETE FROM schema_migrations WHERE version=46").run();
  expect(centralSchemaVersion(database)).toBe(latestCentralSchemaVersion);
  return database;
}

describe("stock host fleet migration v46", () => {
  it("registers as latest schema version", () => {
    expect(latestCentralSchemaVersion).toBe(52);
  });

  it("preserves legacy exclusive workspace bindings and lifts hosts to server-scoped usability", async () => {
    const database = await openDatabaseBeforeStockHostFleetMigration();
    const identity = new WorkspaceIdentityRepository(database);
    const workspaceId = identity.ensureWorkspaceForLegacyProject("stock-host-legacy-project");
    const enrollment = new HostEnrollmentService(database);
    const grant = enrollment.createGrant({
      workspaceId,
      expiresAt: new Date(Date.now() + 60_000),
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    });
    const credentialToken = token();
    const completed = enrollment.exchange({
      type: "host.enrollment.request",
      protocolVersion: 1,
      enrollmentCode: grant.enrollmentCode,
      enrollmentAttemptId: "stock-host-fleet-migration",
      installationId: "2c15f707-d76c-4d85-8af5-8635792d65b1",
      credentialToken,
      displayName: "Legacy Bound Host",
      capabilities: ["linux"],
      capacity: 1
    });
    const hostId = completed.hostId;
    const hosts = new AgentHostRepository(database);

    const bindingBefore = database
      .prepare("SELECT workspace_id, host_id FROM workspace_agent_hosts WHERE host_id=?")
      .all(hostId);
    expect(bindingBefore).toEqual([{ workspace_id: workspaceId, host_id: hostId }]);

    expect(hosts.authenticate(hostId, credentialToken)?.id).toBe(hostId);
    expect(identity.hostUsable(hostId, new Date())).toBe(true);
    expect(identity.hostUsable(hostId, new Date(), workspaceId)).toBe(true);

    applyMigrations(database);
    expect(centralSchemaVersion(database)).toBe(latestCentralSchemaVersion);

    expect(
      database
        .prepare("SELECT workspace_id, host_id FROM workspace_agent_hosts WHERE host_id=?")
        .all(hostId)
    ).toEqual(bindingBefore);

    expect(hosts.authenticate(hostId, credentialToken)?.id).toBe(hostId);
    expect(hosts.authenticate(hostId, credentialToken, workspaceId)?.id).toBe(hostId);
    expect(identity.hostUsable(hostId, new Date())).toBe(true);
    expect(hosts.list().map((host) => host.id)).toContain(hostId);

    hosts.reportOnline(hostId, ["linux"], 1);
    expect(hosts.getRequired(hostId).capabilities).toEqual(["linux"]);

    applyMigrations(database);
    expect(centralSchemaVersion(database)).toBe(latestCentralSchemaVersion);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=46").get()
    ).toEqual({ count: 1 });
    expect(hosts.authenticate(hostId, credentialToken)?.id).toBe(hostId);
    expect(
      database
        .prepare("SELECT workspace_id, host_id FROM workspace_agent_hosts WHERE host_id=?")
        .all(hostId)
    ).toEqual(bindingBefore);
  });
});
