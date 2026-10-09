import { createServer, type Server as HttpServer } from "node:http";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlanPackageManifest } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  basicManifest,
  createTestWorkspace,
  writePromptFiles
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import {
  canonicalProjectCanvasNode,
  loadProjectGraph,
  projectCanvasWorkspace,
  writeProjectGraph
} from "../../../runtime/src/projectGraph/index.js";
import { writeJsonFile } from "../../../runtime/src/json.js";
import { parseServerConfig } from "../config.js";
import { legacyWorkspaceIdForProject } from "./support/legacyWorkspaceId.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { createDistributedServerComposition } from "../serverComposition.js";
import { backingPath } from "../packageSnapshotBacking.js";
import { ServerReadinessController } from "../readiness.js";
import { openServerDatabase } from "../sqlite.js";

const httpServers: HttpServer[] = [];
const compositions: Array<Awaited<ReturnType<typeof createDistributedServerComposition>>> = [];
const directories: string[] = [];
const adminToken = `pw_operator_${"A".repeat(43)}`;

afterEach(async () => {
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    httpServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function remoteManifest(): PlanPackageManifest {
  const manifest = basicManifest();
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
  };
  return manifest;
}

async function addSecondaryCanvas(root: string): Promise<void> {
  const loaded = await loadProjectGraph(root);
  const secondaryCanvas = canonicalProjectCanvasNode({
    id: "secondary",
    title: "Secondary canvas"
  });
  const secondaryWorkspace = projectCanvasWorkspace(loaded.workspace, secondaryCanvas);
  const manifest = remoteManifest();
  await mkdir(secondaryWorkspace.packageDir, { recursive: true });
  await writeJsonFile(secondaryWorkspace.manifestFile, manifest);
  await writePromptFiles(secondaryWorkspace.packageDir, manifest);
  await writeFile(secondaryWorkspace.stateFile, await readFile(loaded.workspace.stateFile));
  await mkdir(secondaryWorkspace.resultsDir, { recursive: true });
  await writeProjectGraph(loaded.workspace, {
    version: "plan-project/v1",
    canvases: [
      canonicalProjectCanvasNode({ id: "default", title: "Default canvas" }),
      secondaryCanvas
    ],
    edges: [],
    crossTaskEdges: []
  });
}

async function startComposition(
  projectRoot: string,
  dataDirectory: string,
  projectId: string,
  trustAllDeclaredCanvases: boolean,
  readiness?: ServerReadinessController
) {
  const httpServer = createServer();
  httpServers.push(httpServer);
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7_443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    dataDirectory,
    trustedProjects: [
      trustAllDeclaredCanvases
        ? {
            workspaceId: legacyWorkspaceIdForProject(projectId),
            projectId,
            projectRoot,
            trustAllDeclaredCanvases: true
          }
        : {
            workspaceId: legacyWorkspaceIdForProject(projectId),
            projectId,
            projectRoot,
            canvasId: "default"
          }
    ],
    operatorCredentials: [
      {
        operatorId: "admin",
        tokenSha256: hashOperatorToken(adminToken),
        projectIds: [],
        serverAdmin: true
      }
    ]
  });
  const composition = await createDistributedServerComposition({ httpServer, config, readiness });
  compositions.push(composition);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  return { composition, origin: `http://127.0.0.1:${address.port}` };
}

describe("distributed server ACL migration recovery", () => {
  it("repairs partial startup migration and preserves package bytes", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    await addSecondaryCanvas(workspace.root);
    const projectId = workspace.init.workspace.id;
    const dataDirectory = join(workspace.root, "migration-recovery-data");
    const loaded = await loadProjectGraph(workspace.root);
    const defaultCanvas = loaded.manifest.canvases.find((canvas) => canvas.id === "default");
    const secondaryCanvas = loaded.manifest.canvases.find((canvas) => canvas.id === "secondary");
    if (!defaultCanvas || !secondaryCanvas) throw new Error("Expected Runtime canvases");
    const defaultWorkspace = projectCanvasWorkspace(loaded.workspace, defaultCanvas);
    const beforeManifest = await readFile(defaultWorkspace.manifestFile);
    const beforeState = await readFile(defaultWorkspace.stateFile);
    const resultPath = join(defaultWorkspace.resultsDir, "recovery-result.json");
    await writeFile(resultPath, '{"result":"preserve"}\n', "utf8");
    const beforeResults = await readFile(resultPath);

    const first = await startComposition(workspace.root, dataDirectory, projectId, true);
    const bootstrap = await fetch(`${first.origin}/api/v1/projects/${projectId}/human/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Trusted Owner", humanPrincipalId: "trusted-owner" })
    });
    expect(bootstrap.status).toBe(201);
    const { deviceToken } = (await bootstrap.json()) as { deviceToken: string };
    await first.composition.close();
    compositions.splice(compositions.indexOf(first.composition), 1);

    const databasePath = join(dataDirectory, "planweave-server.sqlite");
    const database = await openServerDatabase(databasePath, 5_000);
    const workspaceId = new WorkspaceIdentityRepository(database).workspaceForLegacyProject(
      projectId
    );
    if (!workspaceId) throw new Error("Expected workspace mapping");
    database
      .prepare(
        `UPDATE acl_registry_migrations
         SET marker='path_bound',status='interrupted',failure_code='simulated_crash'
         WHERE workspace_id=? AND project_id=? AND canvas_id IS NULL AND source_kind='trusted_project'`
      )
      .run(workspaceId, projectId);
    database
      .prepare(
        `UPDATE acl_registry_migrations
         SET marker='canvas_registered',status='repair_required',failure_code='simulated_partial_write'
         WHERE workspace_id=? AND project_id=? AND canvas_id='default' AND source_kind='trusted_canvas'`
      )
      .run(workspaceId, projectId);
    database
      .prepare(
        "UPDATE canvas_registry SET package_dir_internal=NULL WHERE workspace_id=? AND project_id=? AND canvas_id='default'"
      )
      .run(workspaceId, projectId);
    database.close();

    const second = await startComposition(workspace.root, dataDirectory, projectId, false);
    const canvases = await fetch(
      `${second.origin}/api/v1/registry/projects/${projectId}/canvases`,
      {
        headers: { Authorization: `Bearer ${deviceToken}` }
      }
    );
    expect(canvases.status).toBe(200);
    await expect(canvases.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          registry: expect.objectContaining({ canvasId: "default" })
        })
      ]
    });
    await second.composition.close();
    compositions.splice(compositions.indexOf(second.composition), 1);

    const reopened = await openServerDatabase(databasePath, 5_000);
    expect(
      reopened
        .prepare(
          "SELECT status,marker,failure_code FROM acl_registry_migrations WHERE workspace_id=? AND project_id=? AND canvas_id IS NULL AND source_kind='trusted_project'"
        )
        .get(workspaceId, projectId)
    ).toEqual({ status: "completed", marker: "cutover_complete", failure_code: null });
    expect(
      reopened
        .prepare(
          "SELECT status,marker,failure_code,canvas_id FROM acl_registry_migrations WHERE workspace_id=? AND project_id=? AND canvas_id='default' AND source_kind='trusted_canvas'"
        )
        .get(workspaceId, projectId)
    ).toEqual({
      status: "completed",
      marker: "cutover_complete",
      failure_code: null,
      canvas_id: "default"
    });
    expect(
      reopened
        .prepare(
          "SELECT package_dir_internal,revoked_at FROM canvas_registry WHERE workspace_id=? AND project_id=? AND canvas_id='default'"
        )
        .get(workspaceId, projectId)
    ).toMatchObject({ package_dir_internal: defaultWorkspace.packageDir, revoked_at: null });
    expect(
      reopened
        .prepare(
          "SELECT revoked_at FROM canvas_registry WHERE workspace_id=? AND project_id=? AND canvas_id='secondary'"
        )
        .get(workspaceId, projectId)
    ).toMatchObject({ revoked_at: expect.any(String) });
    reopened.close();
    expect(await readFile(defaultWorkspace.manifestFile)).toEqual(beforeManifest);
    expect(await readFile(defaultWorkspace.stateFile)).toEqual(beforeState);
    expect(await readFile(resultPath)).toEqual(beforeResults);
  });

  it("rejects a trusted canvas path mismatch during startup repair", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const projectId = workspace.init.workspace.id;
    const dataDirectory = join(workspace.root, "migration-conflict-data");
    const first = await startComposition(workspace.root, dataDirectory, projectId, false);
    await first.composition.close();
    compositions.splice(compositions.indexOf(first.composition), 1);
    const database = await openServerDatabase(
      join(dataDirectory, "planweave-server.sqlite"),
      5_000
    );
    const workspaceId = new WorkspaceIdentityRepository(database).workspaceForLegacyProject(
      projectId
    );
    if (!workspaceId) throw new Error("Expected workspace mapping");
    database
      .prepare(
        "UPDATE canvas_registry SET package_dir_internal=? WHERE workspace_id=? AND project_id=? AND canvas_id='default'"
      )
      .run("/tmp/not-the-runtime-package", workspaceId, projectId);
    database.close();
    await expect(startComposition(workspace.root, dataDirectory, projectId, false)).rejects.toThrow(
      "canvas_registry_conflict"
    );
  });

  it("preserves authoritative project and canvas visibility across restarts", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const projectId = workspace.init.workspace.id;
    const dataDirectory = join(workspace.root, "visibility-restart-data");
    const first = await startComposition(workspace.root, dataDirectory, projectId, false);
    await first.composition.close();
    compositions.splice(compositions.indexOf(first.composition), 1);

    const databasePath = join(dataDirectory, "planweave-server.sqlite");
    const database = await openServerDatabase(databasePath, 5_000);
    const workspaceId = new WorkspaceIdentityRepository(database).workspaceForLegacyProject(
      projectId
    );
    if (!workspaceId) throw new Error("Expected workspace mapping");
    database
      .prepare(
        "UPDATE project_registry SET visibility='shared' WHERE workspace_id=? AND project_id=?"
      )
      .run(workspaceId, projectId);
    database
      .prepare(
        "UPDATE canvas_registry SET visibility='shared' WHERE workspace_id=? AND project_id=? AND canvas_id='default'"
      )
      .run(workspaceId, projectId);
    database.close();

    const second = await startComposition(workspace.root, dataDirectory, projectId, false);
    await second.composition.close();
    compositions.splice(compositions.indexOf(second.composition), 1);

    const reopened = await openServerDatabase(databasePath, 5_000);
    expect(
      reopened
        .prepare("SELECT visibility FROM project_registry WHERE workspace_id=? AND project_id=?")
        .get(workspaceId, projectId)
    ).toEqual({ visibility: "shared" });
    expect(
      reopened
        .prepare(
          "SELECT visibility FROM canvas_registry WHERE workspace_id=? AND project_id=? AND canvas_id='default'"
        )
        .get(workspaceId, projectId)
    ).toEqual({ visibility: "shared" });
    reopened.close();
  });
});

async function cleanupStartupFixture() {
  const workspace = await createTestWorkspace(remoteManifest());
  directories.push(workspace.home, workspace.root);
  await addSecondaryCanvas(workspace.root);
  const data = join(workspace.root, "cleanup-startup-data");
  const bootstrap = await startComposition(workspace.root, data, workspace.init.workspace.id, true);
  await bootstrap.composition.close();
  compositions.splice(compositions.indexOf(bootstrap.composition), 1);
  const database = await openServerDatabase(join(data, "planweave-server.sqlite"), 5000);
  const canvases = database.prepare("SELECT * FROM canvas_registry ORDER BY canvas_id").all();
  const ids = [`snapshot-${"1".repeat(32)}`, `snapshot-${"2".repeat(32)}`];
  for (const [index, id] of ids.entries()) {
    const canvas = canvases[index]!;
    const backing = backingPath(data, id);
    await mkdir(backing, { recursive: true });
    await writeFile(join(backing, "package.json"), "{}");
    const row = {
      snapshot_id: id,
      project_registry_id: canvas.project_registry_id,
      canvas_registry_id: canvas.canvas_registry_id,
      workspace_id: canvas.workspace_id,
      project_id: canvas.project_id,
      canvas_id: canvas.canvas_id,
      source_revision: `cleanup-revision-${index}`,
      digest_manifest_json: "[]",
      digest_fingerprint: "a".repeat(64),
      content_root_internal: backing,
      creator_kind: "system",
      creator_id: "cleanup-test",
      migration_marker: "none",
      state: "revoked",
      acl_revision: 0,
      project_visibility: "private",
      canvas_visibility: "private",
      created_at: "2026-01-02T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      revoked_at: "2026-01-02T00:00:00.000Z",
      retention_order: null,
      restore_marker: "none",
      backing_cleanup_completed_at: null
    };
    const columns = Object.keys(row);
    database
      .prepare(
        `INSERT INTO package_snapshots(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`
      )
      .run(...Object.values(row));
  }
  database.close();
  return { workspace, data, ids, canvases, file: join(data, "planweave-server.sqlite") };
}

describe("startup backing cleanup failure boundaries", () => {
  it("keeps ready and other canvases usable on a physical failure, then retries pending deletion", async () => {
    const f = await cleanupStartupFixture();
    const blocked = backingPath(f.data, f.ids[0]!);
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    await chmod(blocked, 0o500);
    try {
      const started = await startComposition(
        f.workspace.root,
        f.data,
        f.workspace.init.workspace.id,
        true
      );
      expect(started.composition.readiness().status).toBe("ready");
      const bootstrap = await fetch(
        `${started.origin}/api/v1/projects/${f.workspace.init.workspace.id}/human/bootstrap`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName: "Cleanup owner", humanPrincipalId: "cleanup-owner" })
        }
      );
      expect(bootstrap.status).toBe(201);
      const { deviceToken } = (await bootstrap.json()) as { deviceToken: string };
      const response = await fetch(
        `${started.origin}/api/v1/registry/projects/${f.workspace.init.workspace.id}/canvases`,
        {
          headers: { authorization: `Bearer ${deviceToken}` }
        }
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ registry: expect.objectContaining({ canvasId: "secondary" }) })
        ])
      });
      const database = await openServerDatabase(f.file, 5000);
      try {
        expect(
          database
            .prepare(
              "SELECT backing_cleanup_completed_at FROM package_snapshots WHERE snapshot_id=?"
            )
            .get(f.ids[0])
        ).toEqual({ backing_cleanup_completed_at: null });
        expect(
          database
            .prepare(
              "SELECT backing_cleanup_completed_at FROM package_snapshots WHERE snapshot_id=?"
            )
            .get(f.ids[1])!.backing_cleanup_completed_at
        ).not.toBeNull();
      } finally {
        database.close();
      }
      expect(diagnostics).toHaveBeenCalledWith(
        "snapshot_retention_cleanup_failed",
        expect.objectContaining({
          canvasRegistryId: f.canvases[0]!.canvas_registry_id,
          error: expect.objectContaining({
            snapshotId: f.ids[0],
            cause: expect.objectContaining({ code: "EACCES" })
          })
        })
      );
      await started.composition.close();
      compositions.splice(compositions.indexOf(started.composition), 1);
    } finally {
      await chmod(blocked, 0o700);
      diagnostics.mockRestore();
    }
    const restarted = await startComposition(
      f.workspace.root,
      f.data,
      f.workspace.init.workspace.id,
      true
    );
    expect(restarted.composition.readiness().status).toBe("ready");
    await expect(stat(blocked)).rejects.toMatchObject({ code: "ENOENT" });
    const database = await openServerDatabase(f.file, 5000);
    try {
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM package_snapshots WHERE backing_cleanup_completed_at IS NULL"
          )
          .get()
      ).toEqual({ count: 0 });
      database.exec(
        "CREATE TRIGGER reject_completed_update BEFORE UPDATE OF backing_cleanup_completed_at ON package_snapshots BEGIN SELECT RAISE(ABORT,'completed row reselected'); END;"
      );
      await restarted.composition.close();
      compositions.splice(compositions.indexOf(restarted.composition), 1);
      await startComposition(f.workspace.root, f.data, f.workspace.init.workspace.id, true);
    } finally {
      database.close();
    }
  });

  it.each([
    false,
    true
  ])("propagates real completion UPDATE failure even with physical failure=%s", async (physicalFailure) => {
    const f = await cleanupStartupFixture();
    const blocked = backingPath(f.data, f.ids[0]!);
    const database = await openServerDatabase(f.file, 5000);
    database.exec(`CREATE TRIGGER fail_cleanup_completion BEFORE UPDATE OF backing_cleanup_completed_at ON package_snapshots
      WHEN NEW.snapshot_id='${f.ids[1]}' AND NEW.backing_cleanup_completed_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'completion write interrupted'); END;`);
    database.close();
    if (physicalFailure) await chmod(blocked, 0o500);
    const readiness = new ServerReadinessController();
    try {
      const failure = await startComposition(
        f.workspace.root,
        f.data,
        f.workspace.init.workspace.id,
        true,
        readiness
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toContainEqual(
        expect.objectContaining({ message: "completion write interrupted" })
      );
      expect(readiness.readiness().status).toBe("draining");
    } finally {
      if (physicalFailure) await chmod(blocked, 0o700);
    }
  });
});
