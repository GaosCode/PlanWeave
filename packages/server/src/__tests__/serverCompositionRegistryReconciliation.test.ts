import { createServer, type Server as HttpServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import {
  loadProjectGraph,
  projectCanvasWorkspace,
  writeProjectGraph
} from "../../../runtime/src/projectGraph/index.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { parseServerConfig } from "../config.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { aclMigrationIdFor, applyMigrations, projectRegistryIdFor } from "../migrations.js";
import { openServerDatabase } from "../sqlite.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../serverComposition.js";
import {
  adminToken,
  addSecondaryCanvas,
  remoteManifest
} from "./support/serverCompositionFixture.js";

const httpServers: HttpServer[] = [];
const compositions: DistributedServerComposition[] = [];
const directories: string[] = [];

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

describe("distributed server composition", () => {
  it("binds an unbound legacy registry row without rewriting package/state/results", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const dataDirectory = join(workspace.root, "legacy-server-data");
    const databasePath = join(dataDirectory, "planweave-server.sqlite");
    const database = await openServerDatabase(databasePath, 5_000);
    applyMigrations(database);
    const workspaceIdentity = new WorkspaceIdentityRepository(database);
    const workspaceId = workspaceIdentity.ensureWorkspaceForLegacyProject(
      workspace.init.workspace.id
    );
    const at = "2026-01-01T00:00:00.000Z";
    database
      .prepare(
        `INSERT INTO project_registry(project_registry_id,workspace_id,project_id,project_root_internal,visibility,owner_human_principal_id,acl_revision,created_at,updated_at,revoked_at) VALUES(?,?,?,NULL,'private',NULL,0,?,?,NULL)`
      )
      .run(
        projectRegistryIdFor(workspaceId, workspace.init.workspace.id),
        workspaceId,
        workspace.init.workspace.id,
        at,
        at
      );
    database
      .prepare(
        `INSERT INTO acl_registry_migrations(migration_id,workspace_id,project_id,canvas_id,source_kind,marker,status,failure_code,updated_at) VALUES(?,?,?,NULL,'legacy_project','project_registered','pending',NULL,?)`
      )
      .run(
        aclMigrationIdFor("legacy_project", workspaceId, workspace.init.workspace.id),
        workspaceId,
        workspace.init.workspace.id,
        at
      );
    const beforeManifest = await readFile(workspace.init.workspace.manifestFile);
    const beforeState = await readFile(workspace.init.workspace.stateFile);
    const resultsFile = join(workspace.init.workspace.resultsDir, "existing-result.json");
    await writeFile(resultsFile, '{"result":"preserve"}\n', "utf8");
    const beforeResults = await readFile(resultsFile);
    database.close();
    const httpServer = createServer();
    httpServers.push(httpServer);
    const config = parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7_443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory,
      trustedProjects: [
        {
          workspaceId,
          projectId: workspace.init.workspace.id,
          canvasId: "default",
          projectRoot: workspace.root
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
    const composition = await createDistributedServerComposition({ httpServer, config });
    compositions.push(composition);
    const reopened = await openServerDatabase(databasePath, 5_000);
    expect(
      reopened
        .prepare("SELECT project_root_internal FROM project_registry WHERE project_id=?")
        .get(workspace.init.workspace.id)?.project_root_internal
    ).toBe(workspace.root);
    expect(
      reopened
        .prepare(
          "SELECT status,marker FROM acl_registry_migrations WHERE workspace_id=? AND project_id=? AND source_kind='legacy_project'"
        )
        .get(workspaceId, workspace.init.workspace.id)
    ).toEqual({ status: "completed", marker: "cutover_complete" });
    expect(await readFile(workspace.init.workspace.manifestFile)).toEqual(beforeManifest);
    expect(await readFile(workspace.init.workspace.stateFile)).toEqual(beforeState);
    expect(await readFile(resultsFile)).toEqual(beforeResults);
    reopened.close();
  });

  it("revokes Runtime canvases removed between composition startups", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    await addSecondaryCanvas(workspace.root);
    const projectId = workspace.init.workspace.id;
    const dataDirectory = join(workspace.root, "reconcile-server-data");
    const loaded = await loadProjectGraph(workspace.root);
    const secondaryCanvas = loaded.manifest.canvases.find((canvas) => canvas.id === "secondary");
    if (!secondaryCanvas) throw new Error("Expected secondary canvas");
    const secondaryWorkspace = projectCanvasWorkspace(loaded.workspace, secondaryCanvas);
    const secondaryManifestBefore = await readFile(secondaryWorkspace.manifestFile);
    const secondaryResultPath = join(secondaryWorkspace.resultsDir, "existing-result.json");
    await mkdir(secondaryWorkspace.resultsDir, { recursive: true });
    await writeFile(secondaryResultPath, '{"result":"preserve"}\n', "utf8");
    const secondaryResultsBefore = await readFile(secondaryResultPath);

    const startComposition = async () => {
      const httpServer = createServer();
      httpServers.push(httpServer);
      const config = parseServerConfig({
        version: "server-config/v1",
        bind: { host: "127.0.0.1", port: 7_443 },
        publicUrl: "http://127.0.0.1:7443",
        allowInsecureDevelopment: true,
        dataDirectory,
        trustedProjects: [
          {
            workspaceId: "workspace-server",
            projectId,
            projectRoot: workspace.root,
            trustAllDeclaredCanvases: true
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
      const composition = await createDistributedServerComposition({ httpServer, config });
      compositions.push(composition);
      return composition;
    };

    const first = await startComposition();
    await first.close();
    compositions.splice(compositions.indexOf(first), 1);
    const current = await loadProjectGraph(workspace.root);
    const defaultCanvas = current.manifest.canvases.find((canvas) => canvas.id === "default");
    if (!defaultCanvas) throw new Error("Expected default canvas");
    await writeProjectGraph(current.workspace, {
      version: "plan-project/v1",
      canvases: [defaultCanvas],
      edges: [],
      crossTaskEdges: []
    });

    const second = await startComposition();
    await second.close();
    compositions.splice(compositions.indexOf(second), 1);
    const database = await openServerDatabase(
      join(dataDirectory, "planweave-server.sqlite"),
      5_000
    );
    const workspaceId = "workspace-server";
    expect(
      database
        .prepare(
          "SELECT revoked_at FROM canvas_registry WHERE workspace_id=? AND project_id=? AND canvas_id=?"
        )
        .get(workspaceId, projectId, "default")
    ).toMatchObject({ revoked_at: null });
    expect(
      database
        .prepare(
          "SELECT revoked_at FROM canvas_registry WHERE workspace_id=? AND project_id=? AND canvas_id=?"
        )
        .get(workspaceId, projectId, "secondary")
    ).toMatchObject({ revoked_at: expect.any(String) });
    const access = new ProjectAccessRepository(database);
    expect(() =>
      access.registry.resolveCanvasPath({
        workspaceId,
        projectId,
        canvasId: "secondary"
      })
    ).toThrow("runtime_canvas_revoked");
    database.close();
    expect(await readFile(secondaryWorkspace.manifestFile)).toEqual(secondaryManifestBefore);
    expect(await readFile(secondaryResultPath)).toEqual(secondaryResultsBefore);
  });
});
