import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startPlanweaveServer } from "../lifecycle.js";
import { executeIdempotent } from "../store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("authoritative server store", () => {
  it("migrates a WAL database and atomically replays an idempotent command", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-server-"));
    directories.push(dataDirectory);
    let reconciled = false;
    const server = await startPlanweaveServer({ dataDirectory, databasePath: join(dataDirectory, "server.sqlite"), host: "127.0.0.1", port: 0, busyTimeoutMs: 5000 }, [() => { reconciled = true; }]);
    try {
      const command = () => executeIdempotent(server.database, {
        deviceId: "device-a", route: "/api/v1/projects", projectId: "project-a", key: "idempotency-key-0001", requestFingerprint: "request-1",
        execute: (unit) => { unit.database.prepare("INSERT INTO projects(id,name,created_at) VALUES (?,?,?)").run("project-a", "Project A", "2026-07-12T00:00:00.000Z"); const eventId = unit.appendEvent({ projectId: "project-a", aggregateType: "project", aggregateId: "project-a", aggregateVersion: 1, type: "project.created" }); unit.audit({ projectId: "project-a", actorId: "user-a", action: "project.create", aggregateType: "project", aggregateId: "project-a", details: {} }); return { eventId }; }
      });
      expect(command()).toEqual({ replayed: false, value: { eventId: "1" } });
      expect(command()).toEqual({ replayed: true, value: { eventId: "1" } });
      // After integration: A3's identity migration v2 seeds a `_system` project
      // row, so the projects table contains both the test's "project-a" and the
      // seeded "_system" row.
      expect(server.database.prepare("SELECT COUNT(*) AS count FROM projects").get()?.count).toBe(2);
      expect(server.database.prepare("SELECT COUNT(*) AS count FROM domain_events").get()?.count).toBe(1);
      expect(server.database.prepare("SELECT COUNT(*) AS count FROM audit_log").get()?.count).toBe(1);
      const readiness = server.readiness();
      expect(readiness.status).toBe("ready");
      expect(readiness.schemaVersion).toBeGreaterThan(0);
      expect(readiness.subsystems.central).toBeGreaterThan(0);
      expect(readiness.subsystems.work).toBe(2);
      expect(readiness.subsystems.identity).toBe(1);
      expect(readiness.subsystems.planning).toBe(1);
      expect(readiness.subsystems.proposals).toBe(1);
      expect(readiness.subsystems.attachments).toBe(1);
      expect(readiness.subsystems.events).toBe(1);
      expect(reconciled).toBe(true);
      await expect(server.createBackup("before-upgrade.sqlite")).resolves.toContain("before-upgrade.sqlite");
      const backup = await server.createBackup("restore-fixture.sqlite");
      expect((await stat(backup)).size).toBeGreaterThan(0);
      expect((await readFile(backup)).subarray(0, 16).toString("utf8")).toBe("SQLite format 3\u0000");
    } finally { server.close(); }
  });

  it("rolls back domain rows, events, audit, and idempotency receipt when a command fails", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-server-rollback-"));
    directories.push(dataDirectory);
    const server = await startPlanweaveServer({ dataDirectory, databasePath: join(dataDirectory, "server.sqlite"), host: "127.0.0.1", port: 0, busyTimeoutMs: 5000 });
    try {
      expect(() => executeIdempotent(server.database, {
        deviceId: "device-fault",
        route: "/api/v1/projects",
        projectId: "project-fault",
        key: "idempotency-fault-0001",
        requestFingerprint: "request-fault",
        execute: (unit) => {
          unit.database.prepare("INSERT INTO projects(id,name,created_at) VALUES (?,?,?)").run("project-fault", "Fault", new Date().toISOString());
          unit.appendEvent({ projectId: "project-fault", aggregateType: "project", aggregateId: "project-fault", aggregateVersion: 1, type: "project.created" });
          unit.audit({ projectId: "project-fault", actorId: "user-fault", action: "project.create", aggregateType: "project", aggregateId: "project-fault", details: {} });
          throw new Error("injected failure after writes");
        }
      })).toThrowError("injected failure after writes");
      expect(server.database.prepare("SELECT id FROM projects WHERE id=?").get("project-fault")).toBeUndefined();
      expect(server.database.prepare("SELECT event_id FROM domain_events WHERE project_id=?").get("project-fault")).toBeUndefined();
      expect(server.database.prepare("SELECT id FROM audit_log WHERE project_id=?").get("project-fault")).toBeUndefined();
      expect(server.database.prepare("SELECT key FROM idempotency_keys WHERE key=?").get("idempotency-fault-0001")).toBeUndefined();
    } finally {
      server.close();
    }
  });
});
