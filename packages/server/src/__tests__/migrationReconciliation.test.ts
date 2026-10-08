import { applyMigrationsThroughVersion } from "./support/migrationFixture.js";
import { afterEach, describe, expect, it } from "vitest";
import { canvasCommandMigrationSql } from "../migrations/canvas.js";
import { canvasOperationRetentionMigrationSql } from "../migrations/canvasOperationRetention.js";
import { migration17 } from "../migrations/collaborationLegacy.js";
import { migrationModules } from "../migrations/registry.js";
import {
  setupCodeHostEnrollmentOutcomeMigration,
  setupCodeMigration
} from "../migrations/setup.js";
import {
  applyMigrations,
  centralSchemaVersion,
  latestCentralSchemaVersion
} from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { AgentHostRepository } from "../hosts.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function openDatabase(): Promise<SqliteDatabase> {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  return database;
}

async function openDatabaseAtVersion(throughVersion: number): Promise<SqliteDatabase> {
  const database = await openDatabase();
  applyMigrationsThroughVersion(database, throughVersion);
  expect(centralSchemaVersion(database)).toBe(throughVersion);
  return database;
}

function tableExists(database: SqliteDatabase, table: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
  );
}

describe("collaboration migration reconciliation", () => {
  it("keeps the v27-v32 collaboration migrations in their owning domain order", () => {
    const historicalModules = migrationModules.flatMap((module) => {
      const versions = module.migrations
        .filter((migration) => migration.version >= 27 && migration.version <= 32)
        .map((migration) => migration.version);
      return versions.length > 0 ? [{ name: module.name, versions }] : [];
    });
    expect(historicalModules).toEqual([
      { name: "identity", versions: [27] },
      { name: "acl-registry", versions: [28] },
      { name: "assignment-authority", versions: [29] },
      { name: "canvas-command", versions: [30] },
      { name: "setup-code", versions: [31, 32] }
    ]);
  });

  it("removes project route selection atomically and replays v66 idempotently", async () => {
    const database = await openDatabase();
    applyMigrations(database);
    const hosts = new AgentHostRepository(database);
    const first = hosts.register("First Runtime Host").host;
    const second = hosts.register("Second Runtime Host").host;
    database.exec(`
      ALTER TABLE canvas_runtime_host_bindings
        ADD COLUMN route_selected INTEGER NOT NULL DEFAULT 0 CHECK(route_selected IN (0,1));
      CREATE UNIQUE INDEX idx_canvas_runtime_host_binding_selected_route
        ON canvas_runtime_host_bindings(workspace_id,project_id) WHERE route_selected=1;
    `);
    const insert = database.prepare(
      `INSERT INTO canvas_runtime_host_bindings(
         workspace_id,project_id,host_id,readiness_status,route_selected,
         first_observed_at,last_observed_at
       ) VALUES ('workspace-v66','project-v66',?,'ready',?,
         '2026-08-30T00:00:00.000Z','2026-08-30T00:01:00.000Z')`
    );
    insert.run(first.id, 1);
    insert.run(second.id, 0);
    database.prepare("DELETE FROM schema_migrations WHERE version=66").run();
    database.exec(`
      CREATE TRIGGER fail_v66_marker
      BEFORE INSERT ON schema_migrations
      WHEN NEW.version=66
      BEGIN
        SELECT RAISE(ABORT, 'fail_v66_marker');
      END;
    `);

    expect(() => applyMigrations(database)).toThrow("fail_v66_marker");
    expect(
      database
        .prepare("SELECT name FROM pragma_table_info('canvas_runtime_host_bindings')")
        .all()
        .map((column) => column.name)
    ).toContain("route_selected");
    expect(
      database.prepare("SELECT 1 FROM schema_migrations WHERE version=66").get()
    ).toBeUndefined();
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    database.exec("DROP TRIGGER fail_v66_marker");
    applyMigrations(database);
    expect(
      database
        .prepare("SELECT name FROM pragma_table_info('canvas_runtime_host_bindings')")
        .all()
        .map((column) => column.name)
    ).toEqual([
      "workspace_id",
      "project_id",
      "host_id",
      "readiness_status",
      "first_observed_at",
      "last_observed_at"
    ]);
    expect(
      database
        .prepare(
          `SELECT host_id,readiness_status FROM canvas_runtime_host_bindings
           WHERE workspace_id='workspace-v66' AND project_id='project-v66' ORDER BY host_id`
        )
        .all()
    ).toEqual(
      [first.id, second.id].sort().map((hostId) => ({ host_id: hostId, readiness_status: "ready" }))
    );
    expect(
      database.prepare("SELECT 1 AS present FROM schema_migrations WHERE version=66").get()
    ).toEqual({
      present: 1
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => applyMigrations(database)).not.toThrow();
  });

  it("upgrades a representative v53 database through v58 exactly once", async () => {
    const database = await openDatabaseAtVersion(53);
    database
      .prepare(
        `INSERT INTO canvas_runtime_status_snapshots(
          workspace_id,project_id,canvas_id,package_fingerprint,status_json,origin,updated_at
        ) VALUES(?,?,?,?,?,?,?)`
      )
      .run(
        "workspace-v53",
        "project-v53",
        "default",
        "package-v53",
        '{"tasks":[],"blocks":[]}',
        "execution",
        "2026-08-22T00:00:00.000Z"
      );

    expect(centralSchemaVersion(database)).toBe(53);
    expect(tableExists(database, "canvas_workspace_publish_operations")).toBe(false);
    expect(tableExists(database, "canvas_runtime_reset_operations")).toBe(false);
    expect(
      database
        .prepare(
          "SELECT 1 FROM pragma_table_info('canvas_runtime_status_snapshots') WHERE name='runtime_revision'"
        )
        .get()
    ).toBeUndefined();

    applyMigrations(database);

    expect(centralSchemaVersion(database)).toBe(latestCentralSchemaVersion);
    expect(
      database
        .prepare(
          `SELECT package_fingerprint,status_json,origin,runtime_revision
           FROM canvas_runtime_status_snapshots
           WHERE workspace_id=? AND project_id=? AND canvas_id=?`
        )
        .get("workspace-v53", "project-v53", "default")
    ).toEqual({
      package_fingerprint: "package-v53",
      status_json: '{"tasks":[],"blocks":[]}',
      origin: "execution",
      runtime_revision: 1
    });
    expect(
      database
        .prepare(
          "SELECT name FROM pragma_table_info('canvas_workspace_publish_operations') WHERE name IN ('local_project_id','local_canvas_id') ORDER BY name"
        )
        .all()
    ).toEqual([{ name: "local_canvas_id" }, { name: "local_project_id" }]);
    expect(tableExists(database, "canvas_runtime_reset_operations")).toBe(true);
    const applied = database
      .prepare(
        "SELECT version,applied_at FROM schema_migrations WHERE version >= 54 ORDER BY version"
      )
      .all();

    expect(() => applyMigrations(database)).not.toThrow();
    expect(
      database
        .prepare(
          "SELECT version,applied_at FROM schema_migrations WHERE version >= 54 ORDER BY version"
        )
        .all()
    ).toEqual(applied);
  });

  it("maps a representative v26 project to one stable Workspace and package registry key", async () => {
    const database = await openDatabaseAtVersion(26);
    expect(tableExists(database, "canvas_workspace_publish_operations")).toBe(false);
    expect(tableExists(database, "canvas_runtime_status_snapshots")).toBe(false);
    expect(tableExists(database, "canvas_runtime_reset_operations")).toBe(false);
    const at = "2026-07-28T00:00:00.000Z";
    database
      .prepare(
        "INSERT INTO human_principals(human_principal_id,display_name,created_at) VALUES(?,?,?)"
      )
      .run("owner", "Owner", at);
    database
      .prepare(
        `INSERT INTO project_memberships(
          membership_id,project_id,human_principal_id,role,created_at,updated_at,revision
        ) VALUES(?,?,?,?,?,?,?)`
      )
      .run("membership-owner", "legacy-project", "owner", "owner", at, at, 1);
    database
      .prepare(
        `INSERT INTO work_assignments(
          project_id,canvas_id,work_item_kind,work_item_key,target_kind,
          target_human_principal_id,target_host_id,revision,updated_by_kind,
          updated_by_id,updated_by_display_name,updated_at,reason
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        "legacy-project",
        "default",
        "task",
        "T-001",
        "human",
        "owner",
        null,
        1,
        "human",
        "owner",
        "Owner",
        at,
        null
      );

    applyMigrations(database);
    const mapping = database
      .prepare(
        `SELECT normalized_legacy_project_identity,workspace_id
         FROM legacy_project_workspace_mappings WHERE legacy_project_id=?`
      )
      .get("legacy-project");
    expect(mapping).toEqual({
      normalized_legacy_project_identity: "legacy-project:legacy-project",
      workspace_id: expect.any(String)
    });
    const workspaceId = String(mapping?.workspace_id);
    expect(
      database
        .prepare(
          `SELECT status,interruption_marker,authoritative_read_version
           FROM workspace_identity_migrations WHERE legacy_project_id=?`
        )
        .get("legacy-project")
    ).toEqual({
      status: "completed",
      interruption_marker: "read_cutover_complete",
      authoritative_read_version: "workspace-identity/v1"
    });
    expect(
      database
        .prepare(
          `SELECT workspace_id,project_root_internal,visibility
           FROM project_registry WHERE workspace_id=? AND project_id=?`
        )
        .get(workspaceId, "legacy-project")
    ).toEqual({ workspace_id: workspaceId, project_root_internal: null, visibility: "private" });
    expect(
      database
        .prepare(
          `SELECT workspace_id,project_id,canvas_id,work_item_kind,work_item_key
           FROM work_assignments WHERE project_id=?`
        )
        .get("legacy-project")
    ).toEqual({
      workspace_id: workspaceId,
      project_id: "legacy-project",
      canvas_id: "default",
      work_item_kind: "task",
      work_item_key: "T-001"
    });
    applyMigrations(database);
    expect(
      database
        .prepare(
          "SELECT workspace_id FROM legacy_project_workspace_mappings WHERE legacy_project_id=?"
        )
        .get("legacy-project")
    ).toEqual({ workspace_id: workspaceId });
  });

  it("quarantines unmapped v36 assignment rows and remains reentrant", async () => {
    const database = await openDatabase();
    applyMigrations(database);
    database.exec("DROP TABLE work_assignments");
    database.exec("DROP TABLE work_assignments_unscoped_legacy");
    database.exec(migration17);
    database.prepare("DELETE FROM schema_migrations WHERE version=37").run();
    database
      .prepare(
        `INSERT INTO work_assignments(
          project_id,canvas_id,work_item_kind,work_item_key,target_kind,
          target_human_principal_id,target_host_id,revision,updated_by_kind,
          updated_by_id,updated_by_display_name,updated_at,reason
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        "unmapped-project",
        "default",
        "task",
        "T-001",
        "unassigned",
        null,
        null,
        1,
        "system",
        "migration",
        null,
        "2026-07-28T00:00:00.000Z",
        null
      );

    applyMigrations(database);
    expect(database.prepare("SELECT COUNT(*) AS count FROM work_assignments").get()).toEqual({
      count: 0
    });
    expect(
      database
        .prepare(
          "SELECT project_id,work_item_key FROM work_assignments_unscoped_legacy WHERE project_id=?"
        )
        .get("unmapped-project")
    ).toEqual({ project_id: "unmapped-project", work_item_key: "T-001" });
    applyMigrations(database);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM work_assignments_unscoped_legacy").get()
    ).toEqual({ count: 1 });
  });

  it("rolls canvas and setup schema writes back atomically, then retries from the registry", async () => {
    const canvas = await openDatabase();
    expect(() => {
      canvas.exec("BEGIN IMMEDIATE");
      try {
        canvas.exec(canvasCommandMigrationSql);
        throw new Error("injected_canvas_migration_interruption");
      } catch (error) {
        canvas.exec("ROLLBACK");
        throw error;
      }
    }).toThrow("injected_canvas_migration_interruption");
    expect(tableExists(canvas, "canvas_command_journal")).toBe(false);

    const retention = await openDatabase();
    expect(() => {
      retention.exec("BEGIN IMMEDIATE");
      try {
        retention.exec(canvasOperationRetentionMigrationSql);
        throw new Error("injected_canvas_retention_migration_interruption");
      } catch (error) {
        retention.exec("ROLLBACK");
        throw error;
      }
    }).toThrow("injected_canvas_retention_migration_interruption");
    expect(tableExists(retention, "canvas_command_operation_receipts")).toBe(false);

    const setup = await openDatabase();
    expect(() => {
      setup.exec("BEGIN IMMEDIATE");
      try {
        setup.exec(setupCodeMigration.sql);
        setup.exec(setupCodeHostEnrollmentOutcomeMigration.sql);
        throw new Error("injected_setup_migration_interruption");
      } catch (error) {
        setup.exec("ROLLBACK");
        throw error;
      }
    }).toThrow("injected_setup_migration_interruption");
    expect(tableExists(setup, "setup_code_grants")).toBe(false);
    expect(tableExists(setup, "setup_code_host_enrollment_outcomes")).toBe(false);

    applyMigrations(canvas);
    applyMigrations(retention);
    applyMigrations(setup);
    expect(tableExists(canvas, "canvas_command_journal")).toBe(true);
    expect(tableExists(retention, "canvas_command_operation_receipts")).toBe(true);
    expect(tableExists(setup, "setup_code_grants")).toBe(true);
    expect(tableExists(setup, "setup_code_host_enrollment_outcomes")).toBe(true);
    expect(canvas.prepare("SELECT version FROM schema_migrations WHERE version=30").get()).toEqual({
      version: 30
    });
    expect(
      setup
        .prepare("SELECT version FROM schema_migrations WHERE version IN (31,32) ORDER BY version")
        .all()
    ).toEqual([{ version: 31 }, { version: 32 }]);
  });

  it("keeps presence outside the durable migration schema", async () => {
    const database = await openDatabase();
    applyMigrations(database);
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%presence%'")
        .all()
    ).toEqual([]);
  });

  it("reconciles the endpoint selection column after migration-record rollback", async () => {
    const database = await openDatabase();
    applyMigrations(database);
    expect(
      database
        .prepare(
          "SELECT name FROM pragma_table_info('remote_operations') WHERE name='endpoint_selection_json'"
        )
        .get()
    ).toEqual({ name: "endpoint_selection_json" });

    database
      .prepare(
        `INSERT INTO remote_operations(
          id,workspace_id,project_id,canvas_id,block_ref,ownership_generation,idempotency_key,
          request_fingerprint,source_fingerprint,required_capabilities_json,state,dispatch_id,
          execution_attempt_id,endpoint_selection_json,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        "operation-migration",
        "workspace-1",
        "project-1",
        "default",
        "T-1#B-1",
        "generation-1",
        "idempotency-1",
        "a".repeat(64),
        "source-1",
        "[]",
        "preparing",
        "dispatch-migration",
        "attempt-migration",
        null,
        "2030-01-01T00:00:00.000Z",
        "2030-01-01T00:00:00.000Z"
      );
    database.prepare("DELETE FROM schema_migrations WHERE version=44").run();

    applyMigrations(database);

    expect(
      database.prepare("SELECT version FROM schema_migrations WHERE version=44").get()
    ).toEqual({
      version: 44
    });
    expect(
      database
        .prepare("SELECT endpoint_selection_json FROM remote_operations WHERE id=?")
        .get("operation-migration")
    ).toEqual({ endpoint_selection_json: null });
  });

  it("backfills only diagnostic errors with authoritative retryability", async () => {
    const database = await openDatabase();
    applyMigrations(database);
    database.exec("DROP TABLE remote_operation_diagnostics");

    const insertLegacyDiagnostic = (operationId: string, code: string) => {
      const dispatchId = `dispatch-${operationId}`;
      const attemptId = `attempt-${operationId}`;
      database
        .prepare(
          `INSERT INTO remote_operations(
            id,workspace_id,project_id,canvas_id,block_ref,ownership_generation,idempotency_key,
            request_fingerprint,source_fingerprint,required_capabilities_json,state,dispatch_id,
            execution_attempt_id,diagnostic_code,diagnostic_message,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          operationId,
          "workspace-1",
          "project-1",
          "default",
          `T-1#${operationId}`,
          "generation-1",
          `idempotency-${operationId}`,
          "a".repeat(64),
          "source-1",
          "[]",
          "preparing",
          dispatchId,
          attemptId,
          code,
          code,
          "2030-01-01T00:00:00.000Z",
          "2030-01-01T00:00:00.000Z"
        );
      database
        .prepare(
          `INSERT INTO remote_execution_attempts(
            execution_attempt_id,operation_id,dispatch_id,workspace_id,project_id,canvas_id,
            block_ref,ownership_generation,status,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          attemptId,
          operationId,
          dispatchId,
          "workspace-1",
          "project-1",
          "default",
          `T-1#${operationId}`,
          "generation-1",
          "prepared",
          "2030-01-01T00:00:00.000Z",
          "2030-01-01T00:00:00.000Z"
        );
    };

    insertLegacyDiagnostic("retryable", "host_offline");
    insertLegacyDiagnostic("non-retryable", "remote_source_changed");
    insertLegacyDiagnostic("unknown", "legacy_unclassified_failure");
    database.prepare("DELETE FROM schema_migrations WHERE version=63").run();

    applyMigrations(database);

    expect(
      database
        .prepare(
          `SELECT operation_id,error_code,error_retryable
           FROM remote_operation_diagnostics ORDER BY operation_id`
        )
        .all()
    ).toEqual([
      {
        operation_id: "non-retryable",
        error_code: "remote_source_changed",
        error_retryable: 0
      },
      { operation_id: "retryable", error_code: "host_offline", error_retryable: 1 }
    ]);
  });
});
