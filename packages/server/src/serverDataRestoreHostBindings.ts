import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  assertCapturedSnapshotIntegrity,
  backingPath,
  capturedSnapshotSchema,
  fingerprint,
  maxBackingBytes,
  PackageSnapshotBackingIntegrityError,
  snapshotId,
  stableStringify
} from "./packageSnapshotBacking.js";
import { aclRegistryMigration } from "./migrations/aclRegistry.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

export class ServerDataRestoreHostBindingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ServerDataRestoreHostBindingError";
  }
}

type SnapshotHostBinding = {
  snapshotId: string;
  finalContentRoot: string;
};

const hostBindingTables = ["project_registry", "canvas_registry", "package_snapshots"] as const;
type HostBindingTable = (typeof hostBindingTables)[number];

const requiredColumns: Record<HostBindingTable, readonly string[]> = {
  project_registry: [
    "project_registry_id",
    "workspace_id",
    "project_id",
    "project_root_internal",
    "visibility",
    "owner_human_principal_id",
    "acl_revision",
    "created_at",
    "updated_at",
    "revoked_at"
  ],
  canvas_registry: [
    "canvas_registry_id",
    "project_registry_id",
    "workspace_id",
    "project_id",
    "canvas_id",
    "package_dir_internal",
    "visibility",
    "owner_human_principal_id",
    "acl_revision",
    "created_at",
    "updated_at",
    "revoked_at"
  ],
  package_snapshots: [
    "snapshot_id",
    "project_registry_id",
    "canvas_registry_id",
    "workspace_id",
    "project_id",
    "canvas_id",
    "source_revision",
    "digest_manifest_json",
    "digest_fingerprint",
    "content_root_internal",
    "creator_kind",
    "creator_id",
    "migration_marker",
    "state",
    "acl_revision",
    "project_visibility",
    "canvas_visibility",
    "created_at",
    "updated_at",
    "revoked_at",
    "retention_order",
    "restore_marker"
  ]
};

function tableExists(database: SqliteDatabase, table: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?")
      .get(table)
  );
}

function assertCompatibleTable(database: SqliteDatabase, table: HostBindingTable): void {
  const columns = new Set(
    database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name))
  );
  if (requiredColumns[table].some((column) => !columns.has(column))) {
    throw new ServerDataRestoreHostBindingError("server_data_restore_schema_incompatible");
  }
}

function assertCompatibleHostBindingSchema(database: SqliteDatabase): boolean {
  const presentTables = hostBindingTables.filter((table) => tableExists(database, table));
  if (presentTables.length === 0) return false;
  if (
    presentTables.length !== hostBindingTables.length ||
    !tableExists(database, "schema_migrations")
  ) {
    throw new ServerDataRestoreHostBindingError("server_data_restore_schema_incompatible");
  }
  const migrationColumns = new Set(
    database
      .prepare("PRAGMA table_info(schema_migrations)")
      .all()
      .map((row) => String(row.name))
  );
  if (!migrationColumns.has("version") || !migrationColumns.has("applied_at")) {
    throw new ServerDataRestoreHostBindingError("server_data_restore_schema_incompatible");
  }
  const migration = database
    .prepare("SELECT 1 AS applied FROM schema_migrations WHERE version=?")
    .get(aclRegistryMigration.version);
  if (!migration) {
    throw new ServerDataRestoreHostBindingError("server_data_restore_schema_incompatible");
  }
  for (const table of hostBindingTables) assertCompatibleTable(database, table);
  return true;
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
}

function requiredString(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) {
    throw new ServerDataRestoreHostBindingError("server_data_restore_snapshot_immutable_mismatch");
  }
  return value;
}

async function validateSnapshotBacking(input: {
  stagingDirectory: string;
  stagingRealPath: string;
  targetDirectory: string;
  row: Record<string, unknown>;
}): Promise<SnapshotHostBinding> {
  const snapshotIdValue = requiredString(input.row, "snapshot_id");
  const canvasRegistryId = requiredString(input.row, "canvas_registry_id");
  const sourceRevision = requiredString(input.row, "source_revision");
  const digestManifestJson = requiredString(input.row, "digest_manifest_json");
  const digestFingerprint = requiredString(input.row, "digest_fingerprint");
  const stagingContentRoot = resolve(backingPath(input.stagingDirectory, snapshotIdValue));
  if (!isWithin(input.stagingDirectory, stagingContentRoot)) {
    throw new ServerDataRestoreHostBindingError("server_data_restore_snapshot_backing_outside");
  }
  const packageFile = join(stagingContentRoot, "package.json");
  const backingPaths = await Promise.all([
    lstat(stagingContentRoot),
    lstat(packageFile),
    realpath(stagingContentRoot),
    realpath(packageFile)
  ]).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ServerDataRestoreHostBindingError("server_data_restore_snapshot_backing_missing");
    }
    throw error;
  });
  const [contentRootInfo, packageInfo, resolvedContentRoot, resolvedPackageFile] = backingPaths;
  if (
    !contentRootInfo.isDirectory() ||
    contentRootInfo.isSymbolicLink() ||
    !packageInfo.isFile() ||
    packageInfo.isSymbolicLink() ||
    !isWithin(input.stagingRealPath, resolvedContentRoot) ||
    !isWithin(input.stagingRealPath, resolvedPackageFile)
  ) {
    throw new ServerDataRestoreHostBindingError("server_data_restore_snapshot_backing_outside");
  }
  const packageStat = await stat(resolvedPackageFile);
  if (packageStat.size > maxBackingBytes) {
    throw new ServerDataRestoreHostBindingError("server_data_restore_snapshot_backing_too_large");
  }
  const rawBacking = await readFile(resolvedPackageFile, "utf8");
  let parsedBacking: unknown;
  try {
    parsedBacking = JSON.parse(rawBacking);
  } catch {
    throw new ServerDataRestoreHostBindingError("server_data_restore_snapshot_backing_malformed");
  }
  const parsed = capturedSnapshotSchema.safeParse(parsedBacking);
  if (!parsed.success) {
    throw new ServerDataRestoreHostBindingError("server_data_restore_snapshot_backing_malformed");
  }
  const captured = parsed.data;
  try {
    assertCapturedSnapshotIntegrity(captured);
  } catch (error) {
    if (error instanceof PackageSnapshotBackingIntegrityError) {
      throw new ServerDataRestoreHostBindingError("server_data_restore_snapshot_backing_malformed");
    }
    throw error;
  }
  const expectedFingerprint = fingerprint(captured.digestManifest);
  if (
    captured.sourceRevision !== sourceRevision ||
    stableStringify(captured.digestManifest) !== digestManifestJson ||
    expectedFingerprint !== digestFingerprint ||
    snapshotId(canvasRegistryId, captured.sourceRevision, expectedFingerprint) !== snapshotIdValue
  ) {
    throw new ServerDataRestoreHostBindingError("server_data_restore_snapshot_immutable_mismatch");
  }
  const finalContentRoot = resolve(backingPath(input.targetDirectory, snapshotIdValue));
  if (!isWithin(input.targetDirectory, finalContentRoot)) {
    throw new ServerDataRestoreHostBindingError("server_data_restore_snapshot_backing_outside");
  }
  return {
    snapshotId: snapshotIdValue,
    finalContentRoot
  };
}

function assertNormalizedHostBindings(
  database: SqliteDatabase,
  targetDirectory: string,
  hasHostBindingSchema: boolean,
  snapshots: readonly SnapshotHostBinding[]
): void {
  if (
    hasHostBindingSchema &&
    database
      .prepare(
        "SELECT 1 AS present FROM project_registry WHERE project_root_internal IS NOT NULL LIMIT 1"
      )
      .get()
  ) {
    throw new ServerDataRestoreHostBindingError("server_data_restore_host_binding_residual");
  }
  if (
    hasHostBindingSchema &&
    database
      .prepare(
        "SELECT 1 AS present FROM canvas_registry WHERE package_dir_internal IS NOT NULL LIMIT 1"
      )
      .get()
  ) {
    throw new ServerDataRestoreHostBindingError("server_data_restore_host_binding_residual");
  }
  for (const snapshot of snapshots) {
    const row = database
      .prepare("SELECT content_root_internal FROM package_snapshots WHERE snapshot_id=?")
      .get(snapshot.snapshotId);
    const contentRoot = row?.content_root_internal;
    if (
      typeof contentRoot !== "string" ||
      contentRoot !== snapshot.finalContentRoot ||
      !isWithin(targetDirectory, resolve(contentRoot))
    ) {
      throw new ServerDataRestoreHostBindingError("server_data_restore_host_binding_residual");
    }
  }
}

export async function normalizeServerDataRestoreHostBindings(input: {
  database: SqliteDatabase;
  stagingDirectory: string;
  targetDirectory: string;
}): Promise<void> {
  const stagingDirectory = resolve(input.stagingDirectory);
  const targetDirectory = resolve(input.targetDirectory);
  const hasHostBindingSchema = assertCompatibleHostBindingSchema(input.database);
  const stagingRealPath = await realpath(stagingDirectory);
  const snapshotRows = hasHostBindingSchema
    ? input.database
        .prepare(
          `SELECT snapshot_id,canvas_registry_id,source_revision,digest_manifest_json,
                  digest_fingerprint,content_root_internal
             FROM package_snapshots`
        )
        .all()
    : [];
  const snapshots: SnapshotHostBinding[] = [];
  for (const row of snapshotRows) {
    snapshots.push(
      await validateSnapshotBacking({
        stagingDirectory,
        stagingRealPath,
        targetDirectory,
        row
      })
    );
  }
  inWriteTransaction(input.database, () => {
    if (hasHostBindingSchema)
      input.database.exec("UPDATE project_registry SET project_root_internal=NULL");
    if (hasHostBindingSchema)
      input.database.exec("UPDATE canvas_registry SET package_dir_internal=NULL");
    for (const snapshot of snapshots) {
      const changed = input.database
        .prepare("UPDATE package_snapshots SET content_root_internal=? WHERE snapshot_id=?")
        .run(snapshot.finalContentRoot, snapshot.snapshotId);
      if (changed.changes !== 1) {
        throw new ServerDataRestoreHostBindingError(
          "server_data_restore_snapshot_immutable_mismatch"
        );
      }
    }
    if (tableExists(input.database, "server_instance_ownership")) {
      input.database.exec("DELETE FROM server_instance_ownership");
    }
    assertNormalizedHostBindings(input.database, targetDirectory, hasHostBindingSchema, snapshots);
  });
}
