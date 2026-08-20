import { mkdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { createRemoteBlockRuntimePort } from "@planweave-ai/runtime";
import { writeJsonFile } from "../../../runtime/src/json.js";
import { createTrustedRuntimeRegistry } from "../runtimeProjectRegistry.js";
import { createLocalFilesystemCanvasRuntimeAdapter } from "../canvas/localFilesystemRuntimeAdapter.js";
import { LocalFilesystemExecutionRuntimeAdapter } from "../canvas/localFilesystemExecutionRuntimeAdapter.js";
import { LocalFilesystemWorkRuntimeAdapter } from "../work/localFilesystemRuntimeAdapter.js";
import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { applyMigrations } from "../migrations.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";

const directories: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("createTrustedRuntimeRegistry", () => {
  it("uses an attached local Runtime when the SQLite collaboration scope is pathless", async () => {
    const manifest = basicManifest();
    manifest.execution.defaultExecutor = "codex-acp";
    manifest.executors = {
      "codex-acp": {
        adapter: "agent",
        agent: "codex",
        runner: { transport: "acp" }
      }
    };
    const workspace = await createTestWorkspace(manifest);
    directories.push(workspace.home, workspace.root);
    const scope = {
      workspaceId: "workspace-pathless",
      projectId: workspace.init.workspace.id,
      canvasId: "default"
    };
    const trusted = await createTrustedRuntimeRegistry([{ ...scope, projectRoot: workspace.root }]);
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    const workspaceIdentity = new WorkspaceIdentityRepository(database);
    workspaceIdentity.ensureConfiguredWorkspace(scope.workspaceId);
    const projectAccess = new ProjectAccessRepository(database);
    projectAccess.registerProjectInternal({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      projectRoot: workspace.root
    });
    projectAccess.registerCanvasInternal({
      ...scope,
      packageDir: workspace.init.workspace.packageDir
    });
    database
      .prepare("UPDATE project_registry SET project_root_internal=NULL WHERE project_id=?")
      .run(scope.projectId);
    database
      .prepare("UPDATE canvas_registry SET package_dir_internal=NULL WHERE project_id=?")
      .run(scope.projectId);

    const execution = new LocalFilesystemExecutionRuntimeAdapter(trusted);
    execution.attachCollaborationScopeResolution({ workspaceIdentity, projectAccess });
    const work = new LocalFilesystemWorkRuntimeAdapter(trusted);
    work.attachCollaborationScopeResolution({ workspaceIdentity, projectAccess });

    const lease = await execution.acquire(scope);
    await expect(lease.runtime.inspect({ ref: "T-001#B-001" })).resolves.toMatchObject({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      canvasId: scope.canvasId
    });
    await lease.release();
    const workLease = work.acquirePackage(scope);
    expect(
      workLease?.package.resolveWorkItem({
        kind: "block",
        canvasId: scope.canvasId,
        blockRef: "T-001#B-001"
      })
    ).toMatchObject({ exists: true });
    await workLease?.release();
    trusted.close();
  });

  it("keeps local filesystem paths behind the logical Canvas runtime port", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const scope = canvasScopeRefSchema.parse({
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "default"
    });
    const adapter = createLocalFilesystemCanvasRuntimeAdapter({
      resolveExactCanvasLocation(input) {
        return input.workspaceId === scope.workspaceId &&
          input.projectId === scope.projectId &&
          input.canvasId === scope.canvasId
          ? {
              ...scope,
              projectRoot: workspace.root,
              packageDir: workspace.init.workspace.packageDir
            }
          : undefined;
      }
    });

    const content = await adapter.captureInitialContent(scope);
    const snapshot = await adapter.captureSnapshot(scope);
    const status = await adapter.read(scope, "2026-08-20T00:00:00.000Z");

    expect(content.members.length).toBeGreaterThan(0);
    expect(snapshot.files.length).toBeGreaterThan(0);
    expect(status).toMatchObject({ scope, capturedAt: "2026-08-20T00:00:00.000Z" });
    expect(JSON.stringify({ content, snapshot, status })).not.toContain(workspace.root);
    expect(JSON.stringify({ content, snapshot, status })).not.toContain(
      workspace.init.workspace.packageDir
    );
  });

  it("fails local filesystem access when the exact Canvas binding is missing", async () => {
    const adapter = createLocalFilesystemCanvasRuntimeAdapter({
      resolveExactCanvasLocation() {
        return undefined;
      }
    });
    const scope = canvasScopeRefSchema.parse({
      workspaceId: "workspace-missing",
      projectId: "project-missing",
      canvasId: "canvas-missing"
    });

    await expect(adapter.read(scope)).rejects.toThrow("canvas_runtime_unavailable");
    await expect(adapter.captureInitialContent(scope)).rejects.toThrow(
      "canvas_runtime_unavailable"
    );
    await expect(adapter.captureSnapshot(scope)).rejects.toThrow("canvas_runtime_unavailable");
  });

  it("supports an empty collaboration runtime registry", async () => {
    const trusted = await createTrustedRuntimeRegistry([]);

    expect(trusted.expansions).toEqual([]);
    expect(trusted.locators).toEqual([]);
    expect(trusted.hasProject("project-1")).toBe(false);
    trusted.close();
  });

  it("binds only an explicitly configured project identity", async () => {
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    await expect(
      createTrustedRuntimeRegistry([
        {
          workspaceId: "workspace-one",
          projectId: "wrong-project",
          canvasId: "default",
          projectRoot: workspace.root
        }
      ])
    ).rejects.toThrow("trusted_project_identity_mismatch");

    const locator = {
      workspaceId: "workspace-one",
      projectId: workspace.init.workspace.id,
      canvasId: "default"
    };
    const trusted = await createTrustedRuntimeRegistry([
      { ...locator, projectRoot: workspace.root }
    ]);
    expect(trusted.locators).toEqual([locator]);
    expect(trusted.hasScope(locator)).toBe(true);
    expect(trusted.resolveExactCanvasLocation(locator)).toMatchObject({
      ...locator,
      projectRoot: workspace.root,
      packageDir: workspace.init.workspace.packageDir
    });
    expect(
      trusted.resolveExactCanvasLocation({ ...locator, workspaceId: "workspace-missing" })
    ).toBeUndefined();
    expect(trusted.hasProject("unknown-project")).toBe(false);
    expect(trusted.hasScope(locator)).toBe(true);
    expect(trusted.hasCanvas(locator.projectId, "unknown-canvas")).toBe(false);
    expect(trusted.hasCanvas("unknown-project", locator.canvasId)).toBe(false);
    trusted.locators.push({
      workspaceId: "workspace-unknown",
      projectId: "unknown-project",
      canvasId: "default"
    });
    expect(trusted.hasProject("unknown-project")).toBe(false);
    expect(trusted.hasCanvas("unknown-project", "default")).toBe(false);
    expect(() => trusted.registry.resolve(locator)).not.toThrow();
    trusted.close();
    expect(() => trusted.registry.resolve(locator)).toThrow("remote_runtime_locator_unresolved");
  });

  it("treats an installed scoped package resolver as authoritative", async () => {
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    const locator = {
      workspaceId: "workspace-one",
      projectId: workspace.init.workspace.id,
      canvasId: "default"
    };
    const trusted = await createTrustedRuntimeRegistry([
      { ...locator, projectRoot: workspace.root }
    ]);
    const scope = locator;

    expect(trusted.scopedWorkItemPackagePort(scope)).toBeDefined();
    trusted.setScopedPackageResolver(() => undefined);
    expect(trusted.scopedWorkItemPackagePort(scope)).toBeUndefined();
    expect(trusted.acquireScopedWorkItemPackagePort(scope)).toBeUndefined();
    trusted.close();
  });

  it("keeps identical project and canvas IDs isolated by Workspace scope", async () => {
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    const projectId = workspace.init.workspace.id;
    const trusted = await createTrustedRuntimeRegistry([
      {
        workspaceId: "workspace-a",
        projectId,
        canvasId: "default",
        projectRoot: workspace.root
      },
      {
        workspaceId: "workspace-b",
        projectId,
        canvasId: "default",
        projectRoot: workspace.root
      }
    ]);

    expect(trusted.hasScope({ workspaceId: "workspace-a", projectId, canvasId: "default" })).toBe(
      true
    );
    expect(trusted.hasScope({ workspaceId: "workspace-b", projectId, canvasId: "default" })).toBe(
      true
    );
    expect(trusted.hasCanvas(projectId, "default")).toBe(false);
    expect(
      trusted.resolveExactCanvasLocation({
        workspaceId: "workspace-a",
        projectId,
        canvasId: "default"
      })
    ).toMatchObject({ workspaceId: "workspace-a", projectId, canvasId: "default" });
    expect(
      trusted.resolveExactCanvasLocation({
        workspaceId: "workspace-missing",
        projectId,
        canvasId: "default"
      })
    ).toBeUndefined();
    expect(() =>
      trusted.registry.resolve({ workspaceId: "workspace-missing", projectId, canvasId: "default" })
    ).toThrow("remote_runtime_locator_unresolved");
    expect(() =>
      trusted.registry.resolve({ workspaceId: "workspace-a", projectId, canvasId: "default" })
    ).not.toThrow();
    expect(() =>
      trusted.registry.resolve({ workspaceId: "workspace-b", projectId, canvasId: "default" })
    ).not.toThrow();
    trusted.close();
  });

  it("acquires and releases scoped runtime and artifact bindings", async () => {
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    const locator = {
      workspaceId: "workspace-one",
      projectId: workspace.init.workspace.id,
      canvasId: "default"
    };
    const trusted = await createTrustedRuntimeRegistry([
      { ...locator, projectRoot: workspace.root }
    ]);
    const runtime = trusted.registry.resolve(locator);
    const artifacts = trusted.registry.resolveArtifactSource(locator);
    const release = vi.fn();
    const resolveScoped = vi.fn(() => ({ runtime, artifacts, release }));
    trusted.registry.setScopedResolver(resolveScoped);

    const runtimeHandle = await trusted.registry.acquire({
      projectId: locator.projectId,
      canvasId: "dynamically-registered"
    });
    expect(runtimeHandle.runtime).toBe(runtime);
    runtimeHandle.release();
    runtimeHandle.release();
    const artifactHandle = await trusted.registry.acquireArtifactSource(locator);
    expect(artifactHandle.source).toBe(artifacts);
    artifactHandle.release();

    expect(resolveScoped).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    trusted.close();
  });

  it("keeps runtime-only lookup compatible but rejects an execution lease without artifacts", async () => {
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    const locator = {
      workspaceId: "workspace-runtime-only",
      projectId: workspace.init.workspace.id,
      canvasId: "default"
    };
    const trusted = await createTrustedRuntimeRegistry([]);
    trusted.registry.bind(locator, createRemoteBlockRuntimePort({ projectRoot: workspace.root }));

    expect(() => trusted.registry.resolve(locator)).not.toThrow();
    await expect(trusted.registry.acquire(locator)).rejects.toThrow(
      "remote_runtime_artifact_source_unresolved"
    );
    trusted.close();
  });

  it("expands every Runtime-declared canvas from one trusted project root", async () => {
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    const loaded = await loadProjectGraph(workspace.root);
    const secondaryCanvas = canonicalProjectCanvasNode({
      id: "secondary",
      title: "Secondary canvas"
    });
    const secondaryWorkspace = projectCanvasWorkspace(loaded.workspace, secondaryCanvas);
    await mkdir(secondaryWorkspace.packageDir, { recursive: true });
    await writeJsonFile(secondaryWorkspace.manifestFile, basicManifest());
    await writePromptFiles(secondaryWorkspace.packageDir, basicManifest());
    await mkdir(secondaryWorkspace.resultsDir, { recursive: true });
    await mkdir(join(loaded.workspace.workspaceRoot, "canvases", "undeclared"), {
      recursive: true
    });
    await writeProjectGraph(loaded.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Default canvas" }),
        secondaryCanvas
      ],
      edges: [],
      crossTaskEdges: []
    });

    const projectId = workspace.init.workspace.id;
    const loadManifest = vi.fn((manifestFile: string) =>
      JSON.parse(readFileSync(manifestFile, "utf8"))
    );
    const trusted = await createTrustedRuntimeRegistry(
      [
        {
          workspaceId: "workspace-one",
          projectId,
          projectRoot: workspace.root,
          trustAllDeclaredCanvases: true
        }
      ],
      { loadManifest }
    );
    expect(trusted.locators).toEqual([
      { workspaceId: "workspace-one", projectId, canvasId: "default" },
      { workspaceId: "workspace-one", projectId, canvasId: "secondary" }
    ]);
    expect(trusted.expansions).toEqual([
      expect.objectContaining({
        projectId,
        workspaceId: "workspace-one",
        projectRoot: workspace.root,
        canvasId: "default",
        packageDir: workspace.init.workspace.packageDir
      }),
      expect.objectContaining({ projectId, canvasId: "secondary" })
    ]);
    expect(Object.isFrozen(trusted.expansions)).toBe(true);
    expect(Object.isFrozen(trusted.expansions[0])).toBe(true);
    expect(
      trusted.hasScope({ workspaceId: "workspace-one", projectId, canvasId: "secondary" })
    ).toBe(true);
    expect(trusted.hasCanvas(projectId, "undeclared")).toBe(false);
    expect(() =>
      trusted.registry.resolve({ workspaceId: "workspace-one", projectId, canvasId: "secondary" })
    ).not.toThrow();
    const projectPort = trusted.scopedProjectWorkItemPackagePort({
      workspaceId: "workspace-one",
      projectId
    });
    if (!projectPort) throw new Error("project_package_port_missing");
    const defaultItems = Array.from({ length: 50 }, (_, index) => ({
      kind: "block" as const,
      canvasId: "default",
      blockRef: `T-001#B-${String(index + 1).padStart(3, "0")}`
    }));
    projectPort.resolveWorkItems(defaultItems);
    expect(loadManifest).toHaveBeenCalledTimes(1);
    loadManifest.mockClear();
    projectPort.resolveWorkItems([
      defaultItems[0]!,
      { ...defaultItems[0]!, canvasId: "secondary" }
    ]);
    expect(loadManifest).toHaveBeenCalledTimes(2);
    trusted.close();
  });

  it("keeps legacy canvas trust scoped to the configured canvas", async () => {
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    const loaded = await loadProjectGraph(workspace.root);
    const secondaryCanvas = canonicalProjectCanvasNode({
      id: "secondary",
      title: "Secondary canvas"
    });
    const secondaryWorkspace = projectCanvasWorkspace(loaded.workspace, secondaryCanvas);
    await mkdir(secondaryWorkspace.packageDir, { recursive: true });
    await writeJsonFile(secondaryWorkspace.manifestFile, basicManifest());
    await writePromptFiles(secondaryWorkspace.packageDir, basicManifest());
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

    const projectId = workspace.init.workspace.id;
    const trusted = await createTrustedRuntimeRegistry([
      { workspaceId: "workspace-one", projectId, projectRoot: workspace.root, canvasId: "default" }
    ]);
    expect(trusted.locators).toEqual([
      { workspaceId: "workspace-one", projectId, canvasId: "default" }
    ]);
    expect(trusted.hasCanvas(projectId, "default")).toBe(true);
    expect(trusted.hasCanvas(projectId, "secondary")).toBe(false);
    expect(() =>
      trusted.registry.resolve({ workspaceId: "workspace-one", projectId, canvasId: "secondary" })
    ).toThrow("remote_runtime_locator_unresolved");
    trusted.close();
  });

  it("rejects a legacy canvas hint that is not declared by Runtime", async () => {
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    await expect(
      createTrustedRuntimeRegistry([
        {
          workspaceId: "workspace-one",
          projectId: workspace.init.workspace.id,
          projectRoot: workspace.root,
          canvasId: "missing"
        }
      ])
    ).rejects.toThrow("trusted_project_canvas_not_declared");
  });
});
