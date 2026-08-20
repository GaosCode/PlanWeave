import { CANVAS_RUNTIME_CAPABILITY } from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CanvasRuntimeHostAmbiguousError,
  CanvasRuntimeHostLocator
} from "../canvas/runtimeHostLocator.js";
import { AgentHostRepository } from "../hosts.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const scope = { workspaceId: "workspace-remote", projectId: "project-remote", canvasId: "default" };

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function setup() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  new WorkspaceIdentityRepository(database).ensureConfiguredWorkspace(scope.workspaceId);
  const projectAccess = new ProjectAccessRepository(database);
  projectAccess.registerProjectInternal({
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    projectRoot: "/runtime/project"
  });
  projectAccess.registerCanvasInternal({ ...scope, packageDir: "/runtime/project/package" });
  database
    .prepare("UPDATE project_registry SET project_root_internal=NULL WHERE project_id=?")
    .run(scope.projectId);
  database
    .prepare("UPDATE canvas_registry SET package_dir_internal=NULL WHERE project_id=?")
    .run(scope.projectId);
  const hosts = new AgentHostRepository(database, () => new Date("2026-08-20T01:00:00.000Z"));
  const active = new Set<string>();
  const sessions = { isActive: vi.fn((hostId: string) => active.has(hostId)) };
  const locator = new CanvasRuntimeHostLocator(
    hosts.runtimeBindings,
    hosts,
    sessions,
    projectAccess
  );
  const report = (hostId: string, status: "ready" | "missing" | "invalid" = "ready") =>
    hosts.reportOnline(hostId, [CANVAS_RUNTIME_CAPABILITY], 1, {
      workspaceMappings: [{ workspaceId: scope.workspaceId, status: "ready" }],
      acpProfiles: [],
      runtimeProjects: [{ workspaceId: scope.workspaceId, projectId: scope.projectId, status }]
    });
  return { active, database, hosts, locator, projectAccess, report, sessions };
}

describe("CanvasRuntimeHostLocator", () => {
  it("persists only project-level logical bindings without Host paths", async () => {
    const fixture = await setup();
    const columns = fixture.database
      .prepare("PRAGMA table_info(canvas_runtime_host_bindings)")
      .all()
      .map((column) => (column as { name: string }).name);

    expect(columns).toEqual([
      "workspace_id",
      "project_id",
      "host_id",
      "readiness_status",
      "first_observed_at",
      "last_observed_at"
    ]);
  });

  it("distinguishes no binding from an offline retained binding", async () => {
    const fixture = await setup();
    expect(fixture.locator.locate(scope)).toEqual({
      kind: "unavailable",
      reason: "runtime_not_attached"
    });

    const host = fixture.hosts.register("Remote Runtime").host;
    fixture.report(host.id);
    expect(fixture.locator.locate(scope)).toEqual({
      kind: "unavailable",
      reason: "host_offline",
      lastSeenAt: "2026-08-20T01:00:00.000Z"
    });

    fixture.active.add(host.id);
    expect(fixture.locator.locate(scope)).toEqual({ kind: "available", hostId: host.id });
  });

  it("keeps the logical relationship but fails closed after readiness loss or revoke", async () => {
    const fixture = await setup();
    const host = fixture.hosts.register("Remote Runtime").host;
    fixture.report(host.id);
    fixture.active.add(host.id);
    fixture.report(host.id, "missing");
    expect(fixture.hosts.runtimeBindings.list(scope)).toHaveLength(1);
    expect(fixture.locator.locate(scope)).toMatchObject({
      kind: "unavailable",
      reason: "host_offline"
    });

    fixture.report(host.id);
    fixture.hosts.revoke(host.id);
    expect(fixture.locator.locate(scope)).toMatchObject({
      kind: "unavailable",
      reason: "host_offline"
    });
  });

  it("treats a ready binding without the negotiated Runtime capability as offline", async () => {
    const fixture = await setup();
    const host = fixture.hosts.register("Remote Runtime").host;
    fixture.hosts.reportOnline(host.id, [], 1, {
      workspaceMappings: [{ workspaceId: scope.workspaceId, status: "ready" }],
      acpProfiles: [],
      runtimeProjects: [
        { workspaceId: scope.workspaceId, projectId: scope.projectId, status: "ready" }
      ]
    });
    fixture.active.add(host.id);

    expect(fixture.locator.locate(scope)).toMatchObject({
      kind: "unavailable",
      reason: "host_offline"
    });
  });

  it("rejects multiple active candidates instead of guessing", async () => {
    const fixture = await setup();
    const first = fixture.hosts.register("First").host;
    const second = fixture.hosts.register("Second").host;
    fixture.report(first.id);
    fixture.report(second.id);
    fixture.active.add(first.id);
    fixture.active.add(second.id);

    expect(() => fixture.locator.locate(scope)).toThrow(CanvasRuntimeHostAmbiguousError);
  });

  it("checks the Server registry before consulting Host advertisement", async () => {
    const fixture = await setup();
    const host = fixture.hosts.register("Remote Runtime").host;
    fixture.report(host.id);
    fixture.active.add(host.id);
    fixture.database
      .prepare(
        "UPDATE canvas_registry SET revoked_at=? WHERE workspace_id=? AND project_id=? AND canvas_id=?"
      )
      .run("2026-08-20T02:00:00.000Z", scope.workspaceId, scope.projectId, scope.canvasId);

    expect(() => fixture.locator.locate(scope)).toThrow("canvas_runtime_scope_unavailable");
    expect(fixture.sessions.isActive).not.toHaveBeenCalled();
  });
});
