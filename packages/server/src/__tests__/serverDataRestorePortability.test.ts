import { createServer } from "node:http";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeCanvasReplicaDocument, type PlanPackageManifest } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ContentVersionRepository } from "../canvas/contentVersionRepository.js";
import { parseServerConfig } from "../config.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { hashOperatorToken } from "../operatorAuth.js";
import {
  backingPath,
  capturedSnapshotSchema,
  fingerprint,
  stableStringify
} from "../packageSnapshotBacking.js";
import { PackageSnapshotRepository } from "../packageSnapshotRepository.js";
import { createLocalFilesystemCanvasRuntimeAdapter } from "../canvas/localFilesystemRuntimeAdapter.js";
import type { CanvasPackageSnapshotRuntimePort } from "../canvas/runtimePort.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import {
  exportServerDataDirectory,
  restoreServerDataDirectory,
  ServerDataArchiveError
} from "../serverDataArchive.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../serverComposition.js";
import { normalizeServerDataRestoreHostBindings } from "../serverDataRestoreHostBindings.js";
import { openServerDatabase } from "../sqlite.js";

const clock = () => new Date("2030-01-01T00:00:00.000Z");
const projectId = "portable-project";
const canvasId = "default";
const unavailableSnapshotRuntime: CanvasPackageSnapshotRuntimePort = {
  async captureSnapshot() {
    throw new Error("canvas_runtime_unavailable");
  },
  async restoreSnapshot() {
    throw new Error("canvas_runtime_unavailable");
  }
};
const ownerId = "portable-owner";
const operatorToken = `pw_operator_${"R".repeat(43)}`;
const directories: string[] = [];
const compositions: DistributedServerComposition[] = [];

afterEach(async () => {
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function authoritativeContent(manifest: PlanPackageManifest) {
  const promptMarkdownByPath = Object.fromEntries(
    manifest.nodes.flatMap((task) => [
      [task.prompt, `# ${task.title}\n`],
      ...task.blocks.map((block) => [block.prompt, `# ${block.title}\n`])
    ])
  );
  return encodeCanvasReplicaDocument({
    schemaVersion: "canvas-replica-document/v1",
    manifest,
    promptMarkdownByPath,
    layout: {
      version: "desktop-layout/v1",
      projectId,
      nodes: [],
      updatedAt: clock().toISOString()
    }
  });
}

type PortableSource = {
  root: string;
  dataDirectory: string;
  databasePath: string;
  workspaceId: string;
  snapshotId: string;
  snapshotBackingFile: string;
  packageDirectory: string;
};

async function createPortableSource(): Promise<PortableSource> {
  const workspace = await createTestWorkspace();
  directories.push(workspace.home, workspace.root);
  const dataDirectory = join(workspace.root, "source-server-data-A");
  const databasePath = join(dataDirectory, "planweave-server.sqlite");
  const database = await openServerDatabase(databasePath, 5_000);
  try {
    applyMigrations(database);
    const workspaceIdentity = new WorkspaceIdentityRepository(database);
    const workspaceId = workspaceIdentity.ensureWorkspaceForLegacyProject(projectId);
    const identity = new HumanIdentityRepository(database, clock);
    identity.bootstrapOwner({
      kind: "local_administrative_proof",
      projectId,
      humanPrincipalId: ownerId,
      displayName: "Portable Owner",
      issuedAt: clock().toISOString()
    });
    const access = new ProjectAccessRepository(database, clock);
    access.registerProjectInternal({
      workspaceId,
      projectId,
      projectRoot: workspace.root,
      ownerHumanPrincipalId: ownerId
    });
    access.registerCanvasInternal({
      workspaceId,
      projectId,
      canvasId,
      packageDir: workspace.init.workspace.packageDir,
      ownerHumanPrincipalId: ownerId
    });
    access.markCanvasCutover(workspaceId, projectId, canvasId);
    access.finalizeProjectCutover(workspaceId, projectId);
    new ContentVersionRepository(database, clock).publishInitial({
      scope: { workspaceId, projectId, canvasId },
      content: authoritativeContent(basicManifest()),
      createdBy: { kind: "human", id: ownerId }
    });
    const created = await new PackageSnapshotRepository(
      database,
      access,
      dataDirectory,
      createLocalFilesystemCanvasRuntimeAdapter({
        resolveExactCanvasLocation(scope) {
          return scope.workspaceId === workspaceId &&
            scope.projectId === projectId &&
            scope.canvasId === canvasId
            ? {
                workspaceId,
                projectId,
                canvasId,
                projectRoot: workspace.root,
                packageDir: workspace.init.workspace.packageDir
              }
            : undefined;
        }
      }),
      clock
    ).create({
      workspaceId,
      projectId,
      canvasId,
      actor: { kind: "human", id: ownerId },
      expectedAclRevision: 0
    });
    database
      .prepare(
        `INSERT INTO server_instance_ownership(
           singleton,owner_token,process_id,hostname,acquired_at
         ) VALUES(1,'archived-owner',999999,'source-host-A',?)`
      )
      .run(clock().toISOString());
    const snapshotId = created.snapshot.immutable.snapshotId;
    return {
      root: workspace.root,
      dataDirectory,
      databasePath,
      workspaceId,
      snapshotId,
      snapshotBackingFile: join(backingPath(dataDirectory, snapshotId), "package.json"),
      packageDirectory: workspace.init.workspace.packageDir
    };
  } finally {
    database.close();
  }
}

async function exportSource(source: PortableSource): Promise<string> {
  const archivePath = join(source.root, `archive-${crypto.randomUUID()}.tgz`);
  await exportServerDataDirectory({ dataDirectory: source.dataDirectory, archivePath, now: clock });
  return archivePath;
}

async function createOccupiedTarget(root: string): Promise<{
  dataDirectory: string;
  databasePath: string;
}> {
  const dataDirectory = join(root, `target-B-${crypto.randomUUID()}`);
  const databasePath = join(dataDirectory, "planweave-server.sqlite");
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(join(dataDirectory, "sentinel.txt"), "original-target", "utf8");
  const database = await openServerDatabase(databasePath, 5_000);
  try {
    database.exec("CREATE TABLE target_sentinel(value TEXT NOT NULL)");
    database.prepare("INSERT INTO target_sentinel(value) VALUES(?)").run("original-database");
  } finally {
    database.close();
  }
  return { dataDirectory, databasePath };
}

async function expectOriginalTargetPreserved(target: {
  dataDirectory: string;
  databasePath: string;
}): Promise<void> {
  await expect(readFile(join(target.dataDirectory, "sentinel.txt"), "utf8")).resolves.toBe(
    "original-target"
  );
  const database = await openServerDatabase(target.databasePath, 5_000);
  try {
    expect(database.prepare("SELECT value FROM target_sentinel").get()).toEqual({
      value: "original-database"
    });
  } finally {
    database.close();
  }
}

async function expectRestoreFailurePreservesTarget(input: {
  source: PortableSource;
  expectedCode: string;
}): Promise<void> {
  const archivePath = await exportSource(input.source);
  const target = await createOccupiedTarget(input.source.root);
  await expect(
    restoreServerDataDirectory({
      dataDirectory: target.dataDirectory,
      archivePath,
      overwrite: true
    })
  ).rejects.toEqual(new ServerDataArchiveError(input.expectedCode));
  await expectOriginalTargetPreserved(target);
}

describe("server data restore portability", () => {
  it("normalizes A host bindings to B and keeps content and snapshot repositories readable", async () => {
    const source = await createPortableSource();
    const archivePath = await exportSource(source);
    const target = join(source.root, "restored-server-data-B");

    await restoreServerDataDirectory({ dataDirectory: target, archivePath, overwrite: false });

    const databasePath = join(target, "planweave-server.sqlite");
    const database = await openServerDatabase(databasePath, 5_000);
    try {
      expect(database.prepare("SELECT project_root_internal FROM project_registry").all()).toEqual([
        { project_root_internal: null }
      ]);
      expect(database.prepare("SELECT package_dir_internal FROM canvas_registry").all()).toEqual([
        { package_dir_internal: null }
      ]);
      expect(
        database
          .prepare("SELECT content_root_internal FROM package_snapshots WHERE snapshot_id=?")
          .get(source.snapshotId)
      ).toEqual({ content_root_internal: backingPath(target, source.snapshotId) });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM server_instance_ownership").get()
      ).toEqual({ count: 0 });
      const serializedBindings = JSON.stringify({
        projects: database.prepare("SELECT project_root_internal FROM project_registry").all(),
        canvases: database.prepare("SELECT package_dir_internal FROM canvas_registry").all(),
        snapshots: database.prepare("SELECT content_root_internal FROM package_snapshots").all()
      });
      expect(serializedBindings).not.toContain(source.dataDirectory);
      expect(serializedBindings).not.toContain(".planweave-server-restore-");
    } finally {
      database.close();
    }

    const httpServer = createServer();
    const config = parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7_443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory: target,
      trustedProjects: [],
      operatorCredentials: [
        {
          operatorId: "restore-admin",
          tokenSha256: hashOperatorToken(operatorToken),
          projectIds: [],
          serverAdmin: true
        }
      ]
    });
    const composition = await createDistributedServerComposition({ httpServer, config, clock });
    compositions.push(composition);
    expect(composition.trustedProjectControl.listTrustedProjectScopes()).toEqual([]);

    const restoredDatabase = await openServerDatabase(databasePath, 5_000);
    try {
      const content = new ContentVersionRepository(restoredDatabase, clock);
      const scope = {
        workspaceId: source.workspaceId,
        projectId,
        canvasId
      };
      const head = content.head(scope);
      expect(head).not.toBeNull();
      if (!head) throw new Error("expected restored authoritative content head");
      expect(content.readVersion(scope, head.content).content.members.length).toBeGreaterThan(0);

      const access = new ProjectAccessRepository(restoredDatabase, clock);
      const snapshot = new PackageSnapshotRepository(
        restoredDatabase,
        access,
        target,
        unavailableSnapshotRuntime,
        clock
      ).read({
        ...scope,
        snapshotId: source.snapshotId,
        actor: { kind: "human", id: ownerId }
      });
      const backing = capturedSnapshotSchema.parse(
        JSON.parse(
          await readFile(join(backingPath(target, source.snapshotId), "package.json"), "utf8")
        )
      );
      expect(snapshot.immutable.sourceRevision).toBe(backing.sourceRevision);
      expect(stableStringify(snapshot.immutable.digestManifest)).toBe(
        stableStringify(backing.digestManifest)
      );
      expect(fingerprint(backing.digestManifest)).toBe(
        restoredDatabase
          .prepare("SELECT digest_fingerprint FROM package_snapshots WHERE snapshot_id=?")
          .get(source.snapshotId)?.digest_fingerprint
      );
    } finally {
      restoredDatabase.close();
    }
  });

  it("fails closed when snapshot backing is missing", async () => {
    const source = await createPortableSource();
    await rm(backingPath(source.dataDirectory, source.snapshotId), { recursive: true });
    await expectRestoreFailurePreservesTarget({
      source,
      expectedCode: "server_data_restore_snapshot_backing_missing"
    });
  });

  it("fails closed when snapshot content digest is corrupted", async () => {
    const source = await createPortableSource();
    const captured = capturedSnapshotSchema.parse(
      JSON.parse(await readFile(source.snapshotBackingFile, "utf8"))
    );
    const first = captured.files[0];
    if (!first) throw new Error("expected snapshot file");
    await writeFile(
      source.snapshotBackingFile,
      JSON.stringify({
        ...captured,
        files: [{ ...first, content: `${first.content}\ncorrupt` }, ...captured.files.slice(1)]
      }),
      "utf8"
    );
    await expectRestoreFailurePreservesTarget({
      source,
      expectedCode: "server_data_restore_snapshot_backing_malformed"
    });
  });

  it("fails closed when snapshot file paths disagree with the digest manifest", async () => {
    const source = await createPortableSource();
    const captured = capturedSnapshotSchema.parse(
      JSON.parse(await readFile(source.snapshotBackingFile, "utf8"))
    );
    const first = captured.files[0];
    if (!first) throw new Error("expected snapshot file");
    await writeFile(
      source.snapshotBackingFile,
      JSON.stringify({
        ...captured,
        files: [{ ...first, path: "nodes/path-tampered/prompt.md" }, ...captured.files.slice(1)]
      }),
      "utf8"
    );
    await expectRestoreFailurePreservesTarget({
      source,
      expectedCode: "server_data_restore_snapshot_backing_malformed"
    });
  });

  it("fails closed when database immutable snapshot metadata is corrupted", async () => {
    const source = await createPortableSource();
    const database = await openServerDatabase(source.databasePath, 5_000);
    try {
      database
        .prepare("UPDATE package_snapshots SET digest_fingerprint=? WHERE snapshot_id=?")
        .run("0".repeat(64), source.snapshotId);
    } finally {
      database.close();
    }
    await expectRestoreFailurePreservesTarget({
      source,
      expectedCode: "server_data_restore_snapshot_immutable_mismatch"
    });
  });

  it("fails closed when an archived snapshot id escapes the staging backing root", async () => {
    const source = await createPortableSource();
    const database = await openServerDatabase(source.databasePath, 5_000);
    try {
      database.prepare("UPDATE package_snapshots SET snapshot_id='../../outside'").run();
    } finally {
      database.close();
    }
    await expectRestoreFailurePreservesTarget({
      source,
      expectedCode: "server_data_restore_snapshot_backing_outside"
    });
  });

  it("rolls back path and ownership normalization when a database update fails", async () => {
    const source = await createPortableSource();
    const database = await openServerDatabase(source.databasePath, 5_000);
    try {
      database.exec(`
        CREATE TRIGGER reject_snapshot_relocation
        BEFORE UPDATE OF content_root_internal ON package_snapshots
        BEGIN
          SELECT RAISE(ABORT, 'forced_snapshot_relocation_failure');
        END;
      `);
      await expect(
        normalizeServerDataRestoreHostBindings({
          database,
          stagingDirectory: source.dataDirectory,
          targetDirectory: join(source.root, "transaction-target-B")
        })
      ).rejects.toThrow("forced_snapshot_relocation_failure");
      expect(database.prepare("SELECT project_root_internal FROM project_registry").get()).toEqual({
        project_root_internal: source.root
      });
      expect(database.prepare("SELECT package_dir_internal FROM canvas_registry").get()).toEqual({
        package_dir_internal: source.packageDirectory
      });
      expect(
        database
          .prepare("SELECT content_root_internal FROM package_snapshots WHERE snapshot_id=?")
          .get(source.snapshotId)
      ).toEqual({
        content_root_internal: backingPath(source.dataDirectory, source.snapshotId)
      });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM server_instance_ownership").get()
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("rejects a snapshot package file that resolves through a symlink", async () => {
    const source = await createPortableSource();
    await rm(source.snapshotBackingFile);
    await symlink(join(source.packageDirectory, "manifest.json"), source.snapshotBackingFile);
    const database = await openServerDatabase(source.databasePath, 5_000);
    try {
      await expect(
        normalizeServerDataRestoreHostBindings({
          database,
          stagingDirectory: source.dataDirectory,
          targetDirectory: join(source.root, "symlink-target-B")
        })
      ).rejects.toMatchObject({ code: "server_data_restore_snapshot_backing_outside" });
    } finally {
      database.close();
    }
  });

  it("rejects path-only host-binding tables even when migration 28 is claimed", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const source: PortableSource = {
      root: workspace.root,
      dataDirectory: join(workspace.root, "incompatible-source"),
      databasePath: join(workspace.root, "incompatible-source", "planweave-server.sqlite"),
      workspaceId: "unused",
      snapshotId: "unused",
      snapshotBackingFile: "unused",
      packageDirectory: "unused"
    };
    const database = await openServerDatabase(source.databasePath, 5_000);
    try {
      database.exec(`
        CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations(version,applied_at) VALUES(28,'2030-01-01T00:00:00.000Z');
        CREATE TABLE project_registry(project_root_internal TEXT);
        CREATE TABLE canvas_registry(package_dir_internal TEXT);
        CREATE TABLE package_snapshots(
          snapshot_id TEXT,
          canvas_registry_id TEXT,
          source_revision TEXT,
          digest_manifest_json TEXT,
          digest_fingerprint TEXT,
          content_root_internal TEXT
        );
      `);
    } finally {
      database.close();
    }
    await expectRestoreFailurePreservesTarget({
      source,
      expectedCode: "server_data_restore_schema_incompatible"
    });
  });
});
