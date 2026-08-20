import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  backingPath,
  capturedSnapshotSchema,
  fingerprint,
  maxBackingBytes,
  snapshotId,
  stableStringify
} from "./packageSnapshotBacking.js";
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

const requiredColumns = {
  project_registry: ["project_root_internal"],
  canvas_registry: ["package_dir_internal"],
  package_snapshots: [
    "snapshot_id",
    "canvas_registry_id",
    "source_revision",
    "digest_manifest_json",
    "digest_fingerprint",
    "content_root_internal"
  ]
} as const;

function tableExists(database: SqliteDatabase, table: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?")
      .get(table)
  );
}

function assertCompatibleTable(
  database: SqliteDatabase,
  table: keyof typeof requiredColumns
): boolean {
  if (!tableExists(database, table)) return false;
  const columns = new Set(
    database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name))
  );
  if (requiredColumns[table].some((column) => !columns.has(column))) {
    throw new ServerDataRestoreHostBindingError("server_data_restore_schema_incompatible");
  }
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
  hasProjectRegistry: boolean,
  hasCanvasRegistry: boolean,
  snapshots: readonly SnapshotHostBinding[]
): void {
  if (
    hasProjectRegistry &&
    database
      .prepare(
        "SELECT 1 AS present FROM project_registry WHERE project_root_internal IS NOT NULL LIMIT 1"
      )
      .get()
  ) {
    throw new ServerDataRestoreHostBindingError("server_data_restore_host_binding_residual");
  }
  if (
    hasCanvasRegistry &&
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
  const hasProjectRegistry = assertCompatibleTable(input.database, "project_registry");
  const hasCanvasRegistry = assertCompatibleTable(input.database, "canvas_registry");
  const hasPackageSnapshots = assertCompatibleTable(input.database, "package_snapshots");
  const stagingRealPath = await realpath(stagingDirectory);
  const snapshotRows = hasPackageSnapshots
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
    if (hasProjectRegistry)
      input.database.exec("UPDATE project_registry SET project_root_internal=NULL");
    if (hasCanvasRegistry)
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
    assertNormalizedHostBindings(
      input.database,
      targetDirectory,
      hasProjectRegistry,
      hasCanvasRegistry,
      snapshots
    );
  });
}
