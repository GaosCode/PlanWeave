import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as runtime from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { applyMigrations } from "../migrations.js";
import { capturedSnapshotSchema } from "../packageSnapshotBacking.js";
import { PackageSnapshotRepository } from "../packageSnapshotRepository.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture() {
  const workspace = await createTestWorkspace();
  directories.push(workspace.home, workspace.root);
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  database.exec(`
    INSERT INTO workspaces(workspace_id,display_name,created_at) VALUES ('w','Workspace','2026-01-01');
    INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES
      ('w','owner','Owner','2026-01-01T00:00:00.000Z',NULL),('w','viewer','Viewer','2026-01-01T00:00:00.000Z',NULL);
    INSERT INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at) VALUES
      ('w','m-owner','owner','owner',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL),('w','m-viewer','viewer','member',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL);
  `);
  const access = new ProjectAccessRepository(database, () => new Date("2026-01-02T00:00:00.000Z"));
  access.registerProjectInternal({
    workspaceId: "w",
    projectId: "p",
    projectRoot: workspace.root,
    ownerHumanPrincipalId: "owner"
  });
  access.registerCanvasInternal({
    workspaceId: "w",
    projectId: "p",
    canvasId: "default",
    packageDir: workspace.init.workspace.packageDir,
    visibility: "shared",
    ownerHumanPrincipalId: "owner"
  });
  access.registerCanvasInternal({
    workspaceId: "w",
    projectId: "p",
    canvasId: "other",
    packageDir: workspace.init.workspace.packageDir,
    visibility: "shared",
    ownerHumanPrincipalId: "owner"
  });
  access.markCanvasCutover("w", "p", "default");
  access.markCanvasCutover("w", "p", "other");
  access.finalizeProjectCutover("w", "p");
  const snapshots = new PackageSnapshotRepository(
    database,
    access,
    join(workspace.root, "snapshot-data"),
    () => new Date("2026-01-02T00:00:00.000Z")
  );
  return { workspace, database, access, snapshots };
}

const owner = { kind: "human", id: "owner" } as const;
const viewer = { kind: "human", id: "viewer" } as const;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("package snapshot repository", () => {
  it("persists bounded payloads without package paths and restores through ACL", async () => {
    const { workspace, snapshots } = await fixture();
    const created = await snapshots.create({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      actor: owner,
      expectedAclRevision: 0
    });
    const backing = join(
      workspace.root,
      "snapshot-data",
      "snapshots",
      created.snapshot.immutable.snapshotId,
      "package.json"
    );
    const payload = JSON.parse(await readFile(backing, "utf8"));
    expect(payload).not.toHaveProperty("packageDir");
    await writeFile(workspace.init.workspace.manifestFile, "{}", "utf8");
    const restored = await snapshots.restore({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      snapshotId: created.snapshot.immutable.snapshotId,
      actor: owner,
      expectedAclRevision: 0
    });
    expect(restored.outcome).toBe("restored");
    expect(
      JSON.parse(await readFile(workspace.init.workspace.manifestFile, "utf8")).project.title
    ).toBe("Test Plan");
  });

  it("does not resolve a snapshot id across projects or canvases", async () => {
    const { access, snapshots, workspace } = await fixture();
    access.registerProjectInternal({
      workspaceId: "w",
      projectId: "other-project",
      projectRoot: join(workspace.root, "other-project"),
      ownerHumanPrincipalId: "owner"
    });
    access.registerCanvasInternal({
      workspaceId: "w",
      projectId: "other-project",
      canvasId: "other-canvas",
      packageDir: join(workspace.root, "other-project", "package"),
      visibility: "shared",
      ownerHumanPrincipalId: "owner"
    });
    access.markCanvasCutover("w", "other-project", "other-canvas");
    access.finalizeProjectCutover("w", "other-project");
    const created = await snapshots.create({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      actor: owner,
      expectedAclRevision: 0
    });
    expect(() =>
      snapshots.read({
        workspaceId: "w",
        projectId: "p",
        canvasId: "other",
        snapshotId: created.snapshot.immutable.snapshotId,
        actor: owner
      })
    ).toThrow("package_snapshot_not_found");
    expect(() =>
      snapshots.read({
        workspaceId: "w",
        projectId: "other-project",
        canvasId: "other-canvas",
        snapshotId: created.snapshot.immutable.snapshotId,
        actor: owner
      })
    ).toThrow("package_snapshot_not_found");
  });

  it("rejects viewer mutation, stale ACL, and tampered backing paths", async () => {
    const { database, snapshots, access } = await fixture();
    access.grant({
      workspaceId: "w",
      projectId: "p",
      humanPrincipalId: "viewer",
      role: "viewer",
      grantedBy: owner
    });
    await expect(
      snapshots.create({
        workspaceId: "w",
        projectId: "p",
        canvasId: "default",
        actor: viewer,
        expectedAclRevision: 0
      })
    ).rejects.toThrow("access_capability_denied:capability_denied");
    const created = await snapshots.create({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      actor: owner,
      expectedAclRevision: 0
    });
    database
      .prepare("UPDATE package_snapshots SET content_root_internal=? WHERE snapshot_id=?")
      .run("/tmp/evil", created.snapshot.immutable.snapshotId);
    const result = await snapshots.restore({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      snapshotId: created.snapshot.immutable.snapshotId,
      actor: owner,
      expectedAclRevision: 0
    });
    expect(result.outcome).toBe("malformed");
    expect(
      database
        .prepare("SELECT state,restore_marker FROM package_snapshots WHERE snapshot_id=?")
        .get(created.snapshot.immutable.snapshotId)
    ).toEqual({ state: "malformed", restore_marker: "none" });
  });

  it("marks snapshots malformed when backing content digest is tampered", async () => {
    const { database, workspace, snapshots } = await fixture();
    const created = await snapshots.create({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      actor: owner,
      expectedAclRevision: 0
    });
    const backing = join(
      workspace.root,
      "snapshot-data",
      "snapshots",
      created.snapshot.immutable.snapshotId,
      "package.json"
    );
    const payload = JSON.parse(await readFile(backing, "utf8")) as {
      files: Array<{ content: string }>;
    };
    payload.files[0].content = `${payload.files[0].content}\ntampered`;
    await writeFile(backing, JSON.stringify(payload), "utf8");
    const result = await snapshots.restore({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      snapshotId: created.snapshot.immutable.snapshotId,
      actor: owner,
      expectedAclRevision: 0
    });
    expect(result.outcome).toBe("malformed");
    expect(
      database
        .prepare("SELECT state,restore_marker FROM package_snapshots WHERE snapshot_id=?")
        .get(created.snapshot.immutable.snapshotId)
    ).toEqual({ state: "malformed", restore_marker: "none" });
  });

  it("marks snapshots malformed when backing paths disagree with the digest manifest", async () => {
    const { database, workspace, snapshots } = await fixture();
    const created = await snapshots.create({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      actor: owner,
      expectedAclRevision: 0
    });
    const backing = join(
      workspace.root,
      "snapshot-data",
      "snapshots",
      created.snapshot.immutable.snapshotId,
      "package.json"
    );
    const captured = capturedSnapshotSchema.parse(JSON.parse(await readFile(backing, "utf8")));
    const first = captured.files[0];
    if (!first) throw new Error("expected snapshot file");
    await writeFile(
      backing,
      JSON.stringify({
        ...captured,
        files: [{ ...first, path: "nodes/path-tampered/prompt.md" }, ...captured.files.slice(1)]
      }),
      "utf8"
    );
    const result = await snapshots.restore({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      snapshotId: created.snapshot.immutable.snapshotId,
      actor: owner,
      expectedAclRevision: 0
    });
    expect(result).toMatchObject({
      outcome: "malformed",
      detail: "snapshot_digest_manifest_mismatch"
    });
    expect(
      database
        .prepare("SELECT state,restore_marker FROM package_snapshots WHERE snapshot_id=?")
        .get(created.snapshot.immutable.snapshotId)
    ).toEqual({ state: "malformed", restore_marker: "none" });
  });

  it("marks snapshots malformed when backing source revision is tampered", async () => {
    const { database, workspace, snapshots } = await fixture();
    const created = await snapshots.create({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      actor: owner,
      expectedAclRevision: 0
    });
    const backing = join(
      workspace.root,
      "snapshot-data",
      "snapshots",
      created.snapshot.immutable.snapshotId,
      "package.json"
    );
    const payload = JSON.parse(await readFile(backing, "utf8")) as { sourceRevision: string };
    payload.sourceRevision = "snapshot:tampered-source-revision";
    await writeFile(backing, JSON.stringify(payload), "utf8");
    const result = await snapshots.restore({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      snapshotId: created.snapshot.immutable.snapshotId,
      actor: owner,
      expectedAclRevision: 0
    });
    expect(result).toMatchObject({
      outcome: "malformed",
      detail: "snapshot_source_revision_mismatch"
    });
    expect(
      database
        .prepare("SELECT state,restore_marker FROM package_snapshots WHERE snapshot_id=?")
        .get(created.snapshot.immutable.snapshotId)
    ).toEqual({ state: "malformed", restore_marker: "none" });
  });

  it("blocks revoke while restore is pending and is idempotent afterwards", async () => {
    const { database, snapshots } = await fixture();
    const created = await snapshots.create({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      actor: owner,
      expectedAclRevision: 0
    });
    database
      .prepare("UPDATE package_snapshots SET restore_marker='restore_pending' WHERE snapshot_id=?")
      .run(created.snapshot.immutable.snapshotId);
    await expect(
      snapshots.revoke({
        workspaceId: "w",
        projectId: "p",
        canvasId: "default",
        snapshotId: created.snapshot.immutable.snapshotId,
        actor: owner,
        expectedAclRevision: 0
      })
    ).rejects.toThrow("snapshot_restore_pending");
    database
      .prepare("UPDATE package_snapshots SET restore_marker='none' WHERE snapshot_id=?")
      .run(created.snapshot.immutable.snapshotId);
    await snapshots.revoke({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      snapshotId: created.snapshot.immutable.snapshotId,
      actor: owner,
      expectedAclRevision: 0
    });
    await expect(
      snapshots.revoke({
        workspaceId: "w",
        projectId: "p",
        canvasId: "default",
        snapshotId: created.snapshot.immutable.snapshotId,
        actor: owner,
        expectedAclRevision: 0
      })
    ).resolves.toBeUndefined();
  });

  it("fences project and canvas grant revocation while a restore lease is pending", async () => {
    const { access, database, snapshots } = await fixture();
    const created = await snapshots.create({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      actor: owner,
      expectedAclRevision: 0
    });
    const projectGrant = access.grant({
      workspaceId: "w",
      projectId: "p",
      humanPrincipalId: "viewer",
      role: "viewer",
      grantedBy: owner
    });
    const canvasGrant = access.grant({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      humanPrincipalId: "viewer",
      role: "viewer",
      grantedBy: owner
    });
    database
      .prepare("UPDATE package_snapshots SET restore_marker='restore_pending' WHERE snapshot_id=?")
      .run(created.snapshot.immutable.snapshotId);
    expect(() =>
      access.revoke({
        workspaceId: "w",
        projectId: "p",
        canvasId: null,
        grantId: projectGrant.grantId,
        actor: owner,
        expectedAclRevision: 1
      })
    ).toThrow("snapshot_restore_pending");
    expect(() =>
      access.revoke({
        workspaceId: "w",
        projectId: "p",
        canvasId: "default",
        grantId: canvasGrant.grantId,
        actor: owner,
        expectedAclRevision: 1
      })
    ).toThrow("snapshot_restore_pending");
  });

  it("blocks a concurrent project revoke at the before-commit fence and then restores", async () => {
    const { access, database, snapshots } = await fixture();
    const created = await snapshots.create({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      actor: owner,
      expectedAclRevision: 0
    });
    const projectGrant = access.grant({
      workspaceId: "w",
      projectId: "p",
      humanPrincipalId: "viewer",
      role: "viewer",
      grantedBy: owner
    });
    database
      .prepare(
        "UPDATE package_snapshots SET restore_marker='none',state='available' WHERE snapshot_id=?"
      )
      .run(created.snapshot.immutable.snapshotId);
    const entered = deferred<void>();
    const release = deferred<void>();
    const originalRestore = runtime.restorePackageSnapshot;
    const restoreSpy = vi
      .spyOn(runtime, "restorePackageSnapshot")
      .mockImplementation(async (restoreInput) => {
        const beforeCommit = restoreInput.beforeCommit;
        return originalRestore({
          ...restoreInput,
          beforeCommit: async () => {
            await beforeCommit?.();
            entered.resolve();
            await release.promise;
          }
        });
      });
    try {
      const restorePromise = snapshots.restore({
        workspaceId: "w",
        projectId: "p",
        canvasId: "default",
        snapshotId: created.snapshot.immutable.snapshotId,
        actor: owner,
        expectedAclRevision: 0
      });
      await entered.promise;
      expect(() =>
        access.revoke({
          workspaceId: "w",
          projectId: "p",
          canvasId: null,
          grantId: projectGrant.grantId,
          actor: owner,
          expectedAclRevision: 1
        })
      ).toThrow("snapshot_restore_pending");
      release.resolve();
      await expect(restorePromise).resolves.toMatchObject({ outcome: "restored" });
    } finally {
      restoreSpy.mockRestore();
    }
  });

  it("returns stale ACL conflict when the revision changes before commit", async () => {
    const { database, snapshots, workspace } = await fixture();
    const created = await snapshots.create({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      actor: owner,
      expectedAclRevision: 0
    });
    const originalManifest = await readFile(workspace.init.workspace.manifestFile, "utf8");
    await writeFile(workspace.init.workspace.manifestFile, "{}", "utf8");
    const entered = deferred<void>();
    const release = deferred<void>();
    const originalRestore = runtime.restorePackageSnapshot;
    const restoreSpy = vi
      .spyOn(runtime, "restorePackageSnapshot")
      .mockImplementation(async (restoreInput) => {
        const beforeCommit = restoreInput.beforeCommit;
        return originalRestore({
          ...restoreInput,
          beforeCommit: async () => {
            entered.resolve();
            await release.promise;
            await beforeCommit?.();
          }
        });
      });
    try {
      const restorePromise = snapshots.restore({
        workspaceId: "w",
        projectId: "p",
        canvasId: "default",
        snapshotId: created.snapshot.immutable.snapshotId,
        actor: owner,
        expectedAclRevision: 0
      });
      await entered.promise;
      database
        .prepare(
          "UPDATE canvas_registry SET acl_revision=acl_revision+1,updated_at=? WHERE workspace_id=? AND project_id=? AND canvas_id=?"
        )
        .run("2026-01-03T00:00:00.000Z", "w", "p", "default");
      release.resolve();
      await expect(restorePromise).resolves.toMatchObject({
        outcome: "conflict",
        detail: "stale_acl_revision"
      });
      expect(await readFile(workspace.init.workspace.manifestFile, "utf8")).toBe("{}");
      expect(originalManifest).not.toBe("{}");
    } finally {
      restoreSpy.mockRestore();
    }
  });

  it("fences grant mutations until restore commit", async () => {
    const { access, database, snapshots, workspace } = await fixture();
    const created = await snapshots.create({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      actor: owner,
      expectedAclRevision: 0
    });
    const originalManifest = await readFile(workspace.init.workspace.manifestFile, "utf8");
    await writeFile(workspace.init.workspace.manifestFile, "{}", "utf8");
    const entered = deferred<void>();
    const release = deferred<void>();
    const originalRestore = runtime.restorePackageSnapshot;
    const restoreSpy = vi
      .spyOn(runtime, "restorePackageSnapshot")
      .mockImplementation(async (restoreInput) => {
        const beforeCommit = restoreInput.beforeCommit;
        return originalRestore({
          ...restoreInput,
          beforeCommit: async () => {
            await beforeCommit?.();
            entered.resolve();
            await release.promise;
          }
        });
      });
    try {
      const restorePromise = snapshots.restore({
        workspaceId: "w",
        projectId: "p",
        canvasId: "default",
        snapshotId: created.snapshot.immutable.snapshotId,
        actor: owner,
        expectedAclRevision: 0
      });
      await entered.promise;
      database.exec(`
        INSERT INTO legacy_project_workspace_mappings(
          legacy_project_id,normalized_legacy_project_identity,workspace_id,mapped_at
        ) VALUES('p','legacy-project:p','w','2026-01-01');
        INSERT INTO workspace_identity_migrations(
          migration_id,legacy_project_id,workspace_id,from_version,to_version,step,status,
          interruption_marker,authoritative_read_version,failure_code,updated_at
        ) VALUES('identity-migration-p','p','w',0,1,'verify_cutover','completed',
          'read_cutover_complete','workspace-identity/v1',NULL,'2026-01-01');
        INSERT INTO human_principals(human_principal_id,display_name,created_at) VALUES
          ('owner','Owner','2026-01-01T00:00:00.000Z'),('viewer','Viewer','2026-01-01T00:00:00.000Z');
        INSERT INTO project_memberships(
          membership_id,project_id,human_principal_id,role,revision,created_at,updated_at,revoked_at
        ) VALUES
          ('membership-owner','p','owner','owner',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL),
          ('membership-viewer','p','viewer','owner',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL);
      `);
      const identity = new HumanIdentityRepository(database);
      expect(() => identity.removeMember("p", "owner")).toThrow("snapshot_restore_pending");
      expect(() =>
        access.grant({
          workspaceId: "w",
          projectId: "p",
          canvasId: "default",
          humanPrincipalId: "viewer",
          role: "viewer",
          grantedBy: owner
        })
      ).toThrow("snapshot_restore_pending");
      release.resolve();
      await expect(restorePromise).resolves.toMatchObject({ outcome: "restored" });
      expect(await readFile(workspace.init.workspace.manifestFile, "utf8")).toBe(originalManifest);
      expect(identity.removeMember("p", "owner").humanPrincipalId).toBe("owner");
    } finally {
      restoreSpy.mockRestore();
    }
  });

  it("clears the restore lease after a runtime restore failure", async () => {
    const { database, snapshots } = await fixture();
    const created = await snapshots.create({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      actor: owner,
      expectedAclRevision: 0
    });
    vi.spyOn(runtime, "restorePackageSnapshot").mockRejectedValue(new Error("restore-failure"));
    await expect(
      snapshots.restore({
        workspaceId: "w",
        projectId: "p",
        canvasId: "default",
        snapshotId: created.snapshot.immutable.snapshotId,
        actor: owner,
        expectedAclRevision: 0
      })
    ).resolves.toMatchObject({ outcome: "malformed", detail: "snapshot_restore_failed" });
    expect(
      database
        .prepare("SELECT state,restore_marker FROM package_snapshots WHERE snapshot_id=?")
        .get(created.snapshot.immutable.snapshotId)
    ).toEqual({ state: "available", restore_marker: "none" });
  });

  it("retains the newest bounded snapshots with a fixed clock", async () => {
    const { database, workspace, snapshots } = await fixture();
    let newest = "";
    for (let index = 0; index < 257; index += 1) {
      await writeFile(
        join(workspace.init.workspace.packageDir, "nodes", "T-001", "prompt.md"),
        `# revision ${index}\n`,
        "utf8"
      );
      newest = (
        await snapshots.create({
          workspaceId: "w",
          projectId: "p",
          canvasId: "default",
          actor: owner,
          expectedAclRevision: 0
        })
      ).snapshot.immutable.snapshotId;
    }
    const canvasRegistryId = database
      .prepare(
        "SELECT canvas_registry_id FROM canvas_registry WHERE project_id='p' AND canvas_id='default'"
      )
      .get()?.canvas_registry_id;
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM package_snapshots WHERE canvas_registry_id=? AND state='available'"
        )
        .get(canvasRegistryId)?.count
    ).toBe(256);
    expect(
      database.prepare("SELECT state FROM package_snapshots WHERE snapshot_id=?").get(newest)
    ).toEqual({ state: "available" });
  });
});
