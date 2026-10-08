import { join } from "node:path";
import { createLocalFilesystemCanvasRuntimeAdapter } from "../../canvas/localFilesystemRuntimeAdapter.js";
import { PackageSnapshotRepository } from "../../packageSnapshotRepository.js";
import { backingPath } from "../../packageSnapshotBacking.js";
import { ProjectAccessRepository } from "../../projectAccessRepository.js";
import { openServerDatabase } from "../../sqlite.js";
import { packageSnapshotFixture } from "../packageSnapshotFixture.js";

export const recoveryAt = "2026-01-02T00:00:00.000Z";
export const recoveryScope = {
  workspaceId: "w",
  projectId: "p",
  canvasId: "default",
  actor: { kind: "human", id: "owner" } as const,
  expectedAclRevision: 0
};

export async function snapshotRecoveryFixture() {
  const initial = await packageSnapshotFixture();
  const file = join(initial.workspace.root, "recovery.sqlite");
  initial.database.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  initial.database.close();
  let database = await openServerDatabase(file, 5_000);
  const data = join(initial.workspace.root, "snapshot-data");
  const location = {
    workspaceId: "w",
    projectId: "p",
    canvasId: "default",
    projectRoot: initial.workspace.root,
    packageDir: initial.workspace.init.workspace.packageDir
  };
  const runtime = createLocalFilesystemCanvasRuntimeAdapter({
    resolveExactCanvasLocation: () => location
  });
  const repository = () =>
    new PackageSnapshotRepository(
      database,
      new ProjectAccessRepository(database, () => new Date(recoveryAt)),
      data,
      runtime,
      () => new Date(recoveryAt)
    );
  let snapshots = repository();
  const created = await snapshots.create(recoveryScope);
  const id = created.snapshot.immutable.snapshotId;
  const canvas = created.snapshot.immutable.registry.canvasRegistryId;
  const original = database.prepare("SELECT * FROM package_snapshots WHERE snapshot_id=?").get(id)!;
  const columns = Object.keys(original);
  let sequence = 0;
  return {
    workspace: initial.workspace,
    file,
    data,
    location,
    id,
    canvas,
    get database() {
      return database;
    },
    get snapshots() {
      return snapshots;
    },
    async reopen() {
      database.close();
      database = await openServerDatabase(file, 5_000);
      snapshots = repository();
    },
    add(count: number, overrides: Record<string, unknown> = {}) {
      const statement = database.prepare(
        `INSERT INTO package_snapshots(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`
      );
      const ids: string[] = [];
      for (let index = 0; index < count; index++) {
        const id = `snapshot-${(++sequence).toString(16).padStart(32, "0")}`;
        const row: Record<string, unknown> = {
          ...original,
          snapshot_id: id,
          source_revision: `revision-${sequence}`,
          content_root_internal: backingPath(data, id),
          ...overrides
        };
        statement.run(...columns.map((column) => row[column]));
        ids.push(id);
      }
      return ids;
    }
  };
}
