import { afterEach, describe, expect, it } from "vitest";
import { canvasCommandMigrationSql } from "../migrations/canvas.js";
import { canvasOperationRetentionMigrationSql } from "../migrations/canvasOperationRetention.js";
import { migration17 } from "../migrations/collaborationLegacy.js";
import { migrationModules } from "../migrations/registry.js";
import {
  setupCodeHostEnrollmentOutcomeMigration,
  setupCodeMigration
} from "../migrations/setup.js";
import { applyMigrations, latestCentralSchemaVersion } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function openDatabase(): Promise<SqliteDatabase> {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  return database;
}

async function openDatabaseAtV26(): Promise<SqliteDatabase> {
  const database = await openDatabase();
  applyMigrations(database);
  database.exec("PRAGMA foreign_keys=OFF");
  for (const table of [
    "canvas_runtime_status_snapshots",
    "canvas_runtime_artifact_grants",
    "canvas_runtime_leases",
    "canvas_runtime_host_bindings",
    "server_exposure_leases",
    "setup_code_host_enrollment_outcomes",
    "setup_code_revocations",
    "setup_code_grants",
    "canvas_command_pending",
    "canvas_command_pending_scopes",
    "canvas_command_operation_retention_scopes",
    "canvas_command_operation_receipts",
    "canvas_command_snapshots",
    "canvas_command_journal",
    "canvas_command_operations",
    "canvas_command_heads",
    "assignment_authority_migrations",
    "execution_target_records",
    "review_assignment_records",
    "responsibility_records",
    "package_snapshots",
    "acl_registry_migrations",
    "project_access_grants",
    "canvas_registry",
    "project_registry",
    "workspace_identity_repairs",
    "workspace_host_enrollments",
    "workspace_agent_hosts",
    "workspace_identity_revocations",
    "workspace_operator_sessions",
    "workspace_device_sessions",
    "workspace_memberships",
    "workspace_principals",
    "workspace_identity_migrations",
    "legacy_project_workspace_mappings",
    "workspaces",
    "work_assignments_unscoped_legacy"
  ]) {
    database.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  database.exec("DROP TABLE work_assignments");
  database.exec(migration17);
  database.prepare("DELETE FROM schema_migrations WHERE version>=27").run();
  database.exec("PRAGMA foreign_keys=ON");
  return database;
}

function tableExists(database: SqliteDatabase, table: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
  );
}

type MigrationMatrixRow = {
  legacyVersion: number | "ephemeral";
  domainStep: string;
  authoritativeReadVersion: string;
  interruptionMarker: string;
  recoveryResult: string;
};

describe("collaboration migration reconciliation", () => {
  it("keeps OSS-001 through OSS-005 registered in their owning domain order", () => {
    const matrix: readonly MigrationMatrixRow[] = [
      {
        legacyVersion: 26,
        domainStep: "identity",
        authoritativeReadVersion: "workspace-identity/v1",
        interruptionMarker: "read_cutover_complete|partial_backfill_failed",
        recoveryResult: "retry_idempotent|resume_from_marker|rollback_to_legacy"
      },
      {
        legacyVersion: 27,
        domainStep: "acl-registry",
        authoritativeReadVersion: "acl-registry/v1",
        interruptionMarker: "path_bound|migration_failed",
        recoveryResult: "retry|repair|rollback"
      },
      {
        legacyVersion: 27,
        domainStep: "package-registry",
        authoritativeReadVersion: "package-snapshot/v1",
        interruptionMarker: "legacy_package_mapped|migration_failed",
        recoveryResult: "registry_repair_without_runtime_result_mutation"
      },
      {
        legacyVersion: 28,
        domainStep: "assignment-authority",
        authoritativeReadVersion: "oss003_authorities|legacy_assignment",
        interruptionMarker: "cutover_complete|repair_required",
        recoveryResult: "retry_idempotent|repair_completed|rollback_to_legacy"
      },
      {
        legacyVersion: 29,
        domainStep: "canvas-command",
        authoritativeReadVersion: "canvas-command/v1",
        interruptionMarker: "atomic_transaction",
        recoveryResult: "transaction_rollback_then_retry"
      },
      {
        legacyVersion: "ephemeral",
        domainStep: "presence",
        authoritativeReadVersion: "ephemeral_presence/v1",
        interruptionMarker: "ephemeral_no_migration",
        recoveryResult: "not_persisted"
      },
      {
        legacyVersion: 30,
        domainStep: "setup-code",
        authoritativeReadVersion: "workspace-setup/v1",
        interruptionMarker: "atomic_transaction",
        recoveryResult: "transaction_rollback_then_retry"
      }
    ];

    expect(matrix.map((row) => row.domainStep)).toEqual([
      "identity",
      "acl-registry",
      "package-registry",
      "assignment-authority",
      "canvas-command",
      "presence",
      "setup-code"
    ]);
    expect(
      migrationModules
        .filter((module) => module.migrations.some((migration) => migration.version >= 27))
        .map((module) => ({
          name: module.name,
          versions: module.migrations.map((migration) => migration.version)
        }))
    ).toEqual([
      { name: "identity", versions: [27, 34] },
      { name: "acl-registry", versions: [28] },
      { name: "assignment-authority", versions: [29] },
      { name: "canvas-command", versions: [30, 41, 42, 50] },
      { name: "content-versions", versions: [33] },
      { name: "setup-code", versions: [31, 32] },
      { name: "comment-workspace-scope", versions: [35] },
      { name: "host-readiness", versions: [36] },
      { name: "assignment-workspace-scope", versions: [37] },
      { name: "observer-workspace-scope", versions: [38] },
      { name: "attachment-workspace-scope", versions: [39] },
      { name: "remote-workspace-scope", versions: [40] },
      { name: "server-exposure", versions: [43] },
      { name: "endpoint-selection", versions: [44] },
      { name: "remote-attempt-cancellation", versions: [45] },
      { name: "stock-host-fleet", versions: [46] },
      { name: "host-credential-lifecycle", versions: [47] },
      { name: "host-installation-identity", versions: [48] },
      { name: "remote-operation-retention", versions: [49] },
      { name: "canvas-runtime-host-binding", versions: [51] },
      { name: "canvas-runtime-artifact-grant", versions: [52] },
      { name: "canvas-runtime-status", versions: [53] }
    ]);
    expect(latestCentralSchemaVersion).toBe(53);
  });

  it("maps a representative v26 project to one stable Workspace and package registry key", async () => {
    const database = await openDatabaseAtV26();
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
});
