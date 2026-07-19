import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSourceDefaultProject,
  getCanvasMapLayout,
  getSourceDefaultProject,
  initManagedProject,
  initOrOpenProject,
  linkProjectSourceRoot,
  listSourceDefaultProjectCandidates,
  listProjects,
  openProject,
  renameProject,
  removeProject,
  resolveSourceDefaultProjectRoot,
  saveCanvasMapLayout,
  setSourceDefaultProject,
  unlinkProjectSourceRoot
} from "../desktop/index.js";
import { readDesktopProjectProjection } from "../desktop/graph/projectProjectionModel.js";
import { hydrateResultsFileIndexBodies } from "../desktop/graph/resultsFileIndex.js";
import { initWorkspace } from "../initWorkspace.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { resolvePlanweaveHome } from "../paths.js";
import { loadProjectGraph, projectGraphPath } from "../projectGraph/index.js";
import { createManagedProjectId } from "../projectId.js";
import { createEmptyState } from "../state.js";
import type { PlanPackageManifest, ProjectMetadata } from "../types.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
    realpath: vi.fn(actual.realpath),
    rename: vi.fn(actual.rename),
    stat: vi.fn(actual.stat)
  };
});

let actualFs: typeof import("node:fs/promises");

beforeEach(async () => {
  actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(readFile).mockImplementation((path, options) => actualFs.readFile(path, options));
  vi.mocked(readdir).mockImplementation((path, options) => actualFs.readdir(path, options));
  vi.mocked(realpath).mockImplementation((path, options) => actualFs.realpath(path, options));
  vi.mocked(rename).mockImplementation((oldPath, newPath) => actualFs.rename(oldPath, newPath));
  vi.mocked(stat).mockImplementation((path, options) => actualFs.stat(path, options));
});

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  vi.restoreAllMocks();
});

function nodeIoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code} simulated`), { code });
}

function resultReadPaths(resultsDir: string): string[] {
  return vi
    .mocked(readFile)
    .mock.calls.map(([path]) => (typeof path === "string" ? path : null))
    .filter((path): path is string => path !== null && path.startsWith(resultsDir));
}

describe("desktop project API", () => {
  it("lists projects from the PlanWeave home registry", async () => {
    const { init } = await createTestWorkspace();

    await expect(listProjects()).resolves.toEqual([
      expect.objectContaining({
        projectId: init.workspace.id,
        kind: "external",
        rootPath: init.workspace.rootPath
      })
    ]);
  });

  it("does not return an empty project list when project metadata stat fails with EACCES", async () => {
    const { init } = await createTestWorkspace();
    vi.mocked(stat).mockImplementation((path, options) => {
      if (path === init.workspace.projectFile) {
        throw nodeIoError("EACCES");
      }
      return actualFs.stat(path, options);
    });

    await expect(listProjects()).rejects.toMatchObject({ code: "EACCES" });
  });

  it("does not return an empty project list when project metadata read fails with EIO", async () => {
    const { init } = await createTestWorkspace();
    vi.mocked(readFile).mockImplementation((path, options) => {
      if (path === init.workspace.projectFile) {
        throw nodeIoError("EIO");
      }
      return actualFs.readFile(path, options);
    });

    await expect(listProjects()).rejects.toMatchObject({ code: "EIO" });
  });

  it("lists managed projects without requiring an external source root", async () => {
    const { home: testHome } = await createTestWorkspace();
    process.env.PLANWEAVE_HOME = testHome;
    const project = await initManagedProject("Managed Demo");

    await expect(listProjects()).resolves.toContainEqual(
      expect.objectContaining({
        projectId: project.projectId,
        name: "Managed Demo",
        kind: "managed",
        rootPath: project.workspaceRoot,
        sourceRoot: null,
        workspaceRoot: project.workspaceRoot
      })
    );
    await expect(openProject({ projectId: project.projectId })).resolves.toMatchObject({
      projectId: project.projectId,
      kind: "managed",
      rootPath: project.workspaceRoot,
      sourceRoot: null
    });
  });

  it("renames managed projects across their id, workspace, layouts, source defaults, and single canvas title", async () => {
    const { home: testHome } = await createTestWorkspace();
    process.env.PLANWEAVE_HOME = testHome;
    const sourceRoot = await mkdtemp(join(tmpdir(), "planweave-source-"));
    const resolvedSourceRoot = await realpath(sourceRoot);
    const project = await initManagedProject("Managed Rename Source");
    await linkProjectSourceRoot(project.projectId, sourceRoot);
    await setSourceDefaultProject(sourceRoot, project.projectId);
    await writeJsonFile(join(project.workspaceRoot, "desktop", "layout.json"), {
      version: "desktop-layout/v1",
      projectId: project.projectId,
      nodes: [],
      updatedAt: "2026-06-20T00:00:00.000Z"
    });
    await writeJsonFile(join(project.workspaceRoot, "desktop", "canvas-map-layout.json"), {
      version: "desktop-canvas-map-layout/v1",
      projectId: project.projectId,
      nodes: [],
      updatedAt: "2026-06-20T00:00:00.000Z"
    });

    const nextName = "Managed Rename Target";
    const nextProjectId = createManagedProjectId(nextName);
    const nextWorkspaceRoot = join(testHome, "projects", nextProjectId);
    const renamed = await renameProject(project.projectId, nextName);

    expect(renamed).toMatchObject({
      projectId: nextProjectId,
      name: nextName,
      kind: "managed",
      rootPath: nextWorkspaceRoot,
      sourceRoot: resolvedSourceRoot,
      workspaceRoot: nextWorkspaceRoot,
      taskCanvases: [expect.objectContaining({ canvasId: "default", name: nextName })]
    });
    await expect(access(project.workspaceRoot)).rejects.toThrow();
    await expect(access(nextWorkspaceRoot)).resolves.toBeUndefined();
    await expect(
      access(join(nextWorkspaceRoot, ".planweave-canvas-map-layout.lock"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(openProject({ projectId: nextProjectId })).resolves.toMatchObject({
      projectId: nextProjectId,
      name: nextName,
      rootPath: nextWorkspaceRoot,
      sourceRoot: resolvedSourceRoot,
      workspaceRoot: nextWorkspaceRoot,
      taskCanvases: [expect.objectContaining({ canvasId: "default", name: nextName })]
    });
    await expect(listProjects()).resolves.toContainEqual(
      expect.objectContaining({ projectId: nextProjectId, name: nextName })
    );

    await expect(
      readJsonFile<ProjectMetadata>(join(nextWorkspaceRoot, "project.json"))
    ).resolves.toMatchObject({
      id: nextProjectId,
      name: nextName,
      kind: "managed",
      rootPath: nextWorkspaceRoot,
      sourceRoot: resolvedSourceRoot
    });
    await expect(
      readJsonFile<{ projectId: string }>(join(nextWorkspaceRoot, "desktop", "layout.json"))
    ).resolves.toMatchObject({
      projectId: nextProjectId
    });
    await expect(
      readJsonFile<{ projectId: string }>(
        join(nextWorkspaceRoot, "desktop", "canvas-map-layout.json")
      )
    ).resolves.toMatchObject({
      projectId: nextProjectId
    });
    const graph = await loadProjectGraph(nextWorkspaceRoot);
    expect(graph.manifest.canvases).toEqual([
      expect.objectContaining({ id: "default", title: nextName })
    ]);
    await expect(
      readJsonFile<PlanPackageManifest>(
        join(nextWorkspaceRoot, "canvases", "default", "package", "manifest.json")
      )
    ).resolves.toMatchObject({
      project: expect.objectContaining({ title: nextName })
    });
    await expect(getSourceDefaultProject(sourceRoot)).resolves.toMatchObject({
      projectId: nextProjectId,
      projectRoot: nextWorkspaceRoot,
      sourceRoot: resolvedSourceRoot
    });
    await expect(resolveSourceDefaultProjectRoot(sourceRoot)).resolves.toBe(nextWorkspaceRoot);
  });

  it("serializes save then rename so layout coordinates survive projectId rewrite", async () => {
    const { home: testHome } = await createTestWorkspace();
    process.env.PLANWEAVE_HOME = testHome;
    const project = await initManagedProject("Managed Layout Rename");
    await writeJsonFile(join(project.workspaceRoot, "desktop", "canvas-map-layout.json"), {
      version: "desktop-canvas-map-layout/v1",
      projectId: project.projectId,
      nodes: [{ canvasId: "default", x: 11, y: 22 }],
      updatedAt: "2026-06-20T00:00:00.000Z"
    });

    const nextName = "Managed Layout Rename Target";
    const nextProjectId = createManagedProjectId(nextName);
    const nextWorkspaceRoot = join(testHome, "projects", nextProjectId);

    const savePromise = saveCanvasMapLayout(project.rootPath, {
      version: "desktop-canvas-map-layout/v1",
      projectId: project.projectId,
      nodes: [{ canvasId: "default", x: 99, y: 88 }],
      updatedAt: "2026-07-01T00:00:00.000Z"
    });
    const renamePromise = renameProject(project.projectId, nextName);
    await Promise.all([savePromise, renamePromise]);

    await expect(
      readJsonFile<{ projectId: string; nodes: Array<{ canvasId: string; x: number; y: number }> }>(
        join(nextWorkspaceRoot, "desktop", "canvas-map-layout.json")
      )
    ).resolves.toMatchObject({
      projectId: nextProjectId,
      nodes: [{ canvasId: "default", x: 99, y: 88 }]
    });
    await expect(getCanvasMapLayout(nextWorkspaceRoot)).resolves.toMatchObject({
      projectId: nextProjectId,
      nodes: [{ canvasId: "default", x: 99, y: 88 }]
    });
  });

  it("admits rename before a save targeting the future managed workspace", async () => {
    const { home: testHome } = await createTestWorkspace();
    process.env.PLANWEAVE_HOME = testHome;
    const project = await initManagedProject("Managed Rename First");
    const nextName = "Managed Rename First Target";
    const nextProjectId = createManagedProjectId(nextName);
    const nextWorkspaceRoot = join(testHome, "projects", nextProjectId);

    const renamePromise = renameProject(project.projectId, nextName);
    const savePromise = saveCanvasMapLayout(nextWorkspaceRoot, {
      version: "desktop-canvas-map-layout/v1",
      projectId: nextProjectId,
      nodes: [{ canvasId: "default", x: 123, y: 456 }],
      updatedAt: "2026-07-01T00:00:00.000Z"
    });
    await Promise.all([renamePromise, savePromise]);

    await expect(getCanvasMapLayout(nextWorkspaceRoot)).resolves.toMatchObject({
      projectId: nextProjectId,
      nodes: [{ canvasId: "default", x: 123, y: 456 }]
    });
    await expect(access(project.workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for an external owner of the stable old-root lock before moving a workspace", async () => {
    const { home: testHome } = await createTestWorkspace();
    process.env.PLANWEAVE_HOME = testHome;
    const project = await initManagedProject("Managed External Lock");
    await saveCanvasMapLayout(project.workspaceRoot, {
      version: "desktop-canvas-map-layout/v1",
      projectId: project.projectId,
      nodes: [{ canvasId: "default", x: 17, y: 27 }],
      updatedAt: "2026-07-01T00:00:00.000Z"
    });
    const { canvasMapLayoutDiskLockPath } = await import("../desktop/canvasMapLayout.js");
    const { resolveProjectWorkspace } = await import("../project.js");
    const workspace = await resolveProjectWorkspace(project.workspaceRoot);
    const oldLockPath = canvasMapLayoutDiskLockPath(workspace);
    await mkdir(dirname(oldLockPath), { recursive: true });
    const holderScript = [
      "const fs=require('node:fs');",
      "const path=process.argv[1];",
      "fs.mkdirSync(path);",
      "fs.writeFileSync(path + '/holder.json', JSON.stringify({pid:process.pid,acquiredAt:new Date().toISOString(),operation:'external-layout-owner'}));",
      "const release=()=>{fs.rmSync(path,{recursive:true,force:true});process.exit(0)};",
      "process.on('SIGTERM',release);",
      "process.stdout.write('locked\\n');",
      "setInterval(()=>{},1000);"
    ].join("");
    const holder = spawn(process.execPath, ["-e", holderScript, oldLockPath], {
      stdio: ["ignore", "pipe", "inherit"]
    });
    await once(holder.stdout, "data");
    expect(holder.exitCode).toBeNull();
    await expect(access(oldLockPath)).resolves.toBeUndefined();

    const nextName = "Managed External Lock Target";
    const nextProjectId = createManagedProjectId(nextName);
    const nextWorkspaceRoot = join(testHome, "projects", nextProjectId);
    const renamePromise = renameProject(project.projectId, nextName);
    try {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
      expect(holder.exitCode).toBeNull();
      await expect(access(oldLockPath)).resolves.toBeUndefined();
      await expect(access(project.workspaceRoot)).resolves.toBeUndefined();
      await expect(access(nextWorkspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      const holderExit = once(holder, "exit");
      holder.kill("SIGTERM");
      await holderExit;
    }
    await renamePromise;

    const nextWorkspace = await resolveProjectWorkspace(nextWorkspaceRoot);
    await expect(access(project.workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(nextWorkspaceRoot)).resolves.toBeUndefined();
    await expect(getCanvasMapLayout(nextWorkspaceRoot)).resolves.toMatchObject({
      projectId: nextProjectId,
      nodes: [{ canvasId: "default", x: 17, y: 27 }]
    });
    await expect(access(oldLockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(canvasMapLayoutDiskLockPath(nextWorkspace))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rolls a moved workspace back without leaking stable old/new layout locks", async () => {
    const { home: testHome } = await createTestWorkspace();
    process.env.PLANWEAVE_HOME = testHome;
    const project = await initManagedProject("Managed Rollback Lock");
    await saveCanvasMapLayout(project.workspaceRoot, {
      version: "desktop-canvas-map-layout/v1",
      projectId: project.projectId,
      nodes: [{ canvasId: "default", x: 31, y: 41 }],
      updatedAt: "2026-07-01T00:00:00.000Z"
    });
    const nextName = "Managed Rollback Lock Target";
    const nextProjectId = createManagedProjectId(nextName);
    const nextWorkspaceRoot = join(testHome, "projects", nextProjectId);
    const { canvasMapLayoutDiskLockPath } = await import("../desktop/canvasMapLayout.js");
    const { resolveProjectWorkspace } = await import("../project.js");
    const previousWorkspace = await resolveProjectWorkspace(project.workspaceRoot);
    const nextWorkspace = {
      ...previousWorkspace,
      id: nextProjectId,
      rootPath: nextWorkspaceRoot,
      workspaceRoot: nextWorkspaceRoot
    };
    let failNextProjectWrite = true;
    vi.mocked(rename).mockImplementation(async (oldPath, newPath) => {
      if (newPath === join(nextWorkspaceRoot, "project.json") && failNextProjectWrite) {
        failNextProjectWrite = false;
        throw new Error("simulated identity rewrite failure");
      }
      return actualFs.rename(oldPath, newPath);
    });

    await expect(renameProject(project.projectId, nextName)).rejects.toThrow(
      "simulated identity rewrite failure"
    );

    await expect(access(project.workspaceRoot)).resolves.toBeUndefined();
    await expect(access(nextWorkspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(project.workspaceRoot, ".planweave-canvas-map-layout.lock"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(openProject({ projectId: project.projectId })).resolves.toMatchObject({
      projectId: project.projectId,
      rootPath: project.workspaceRoot
    });
    await expect(getCanvasMapLayout(project.workspaceRoot)).resolves.toMatchObject({
      projectId: project.projectId,
      nodes: [{ canvasId: "default", x: 31, y: 41 }]
    });
    await expect(access(canvasMapLayoutDiskLockPath(previousWorkspace))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(access(canvasMapLayoutDiskLockPath(nextWorkspace))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("does not overwrite another managed project when a rename target already exists", async () => {
    const { home: testHome } = await createTestWorkspace();
    process.env.PLANWEAVE_HOME = testHome;
    const source = await initManagedProject("Managed Rename Source");
    const target = await initManagedProject("Managed Rename Existing");

    await expect(renameProject(source.projectId, target.name)).rejects.toThrow("already exists");
    await expect(access(source.workspaceRoot)).resolves.toBeUndefined();
    await expect(access(target.workspaceRoot)).resolves.toBeUndefined();
    await expect(openProject({ projectId: source.projectId })).resolves.toMatchObject({
      projectId: source.projectId,
      name: source.name,
      rootPath: source.workspaceRoot
    });
    await expect(openProject({ projectId: target.projectId })).resolves.toMatchObject({
      projectId: target.projectId,
      name: target.name,
      rootPath: target.workspaceRoot
    });
  });

  it("renames external projects without moving their source-root-derived workspace", async () => {
    const { init } = await createTestWorkspace();
    const nextName = "External Display Name";

    await expect(renameProject(init.workspace.id, nextName)).resolves.toMatchObject({
      projectId: init.workspace.id,
      name: nextName,
      kind: "external",
      rootPath: init.workspace.rootPath,
      workspaceRoot: init.workspace.workspaceRoot
    });
    await expect(readJsonFile<ProjectMetadata>(init.workspace.projectFile)).resolves.toMatchObject({
      id: init.workspace.id,
      name: nextName,
      rootPath: init.workspace.rootPath
    });
    await expect(access(init.workspace.workspaceRoot)).resolves.toBeUndefined();
  });

  it("creates formal project graph files for desktop-created projects", async () => {
    const { home: testHome } = await createTestWorkspace();
    process.env.PLANWEAVE_HOME = testHome;
    const externalRoot = await mkdtemp(join(tmpdir(), "planweave-external-"));

    const externalProject = await initOrOpenProject(externalRoot);
    const managedProject = await initManagedProject("Managed Graph");
    const externalGraph = await loadProjectGraph(externalProject.rootPath);

    await expect(access(projectGraphPath(externalGraph.workspace))).resolves.toBeUndefined();
    expect(externalGraph).toMatchObject({
      source: "project_graph",
      diagnostics: []
    });
    await expect(loadProjectGraph(managedProject.rootPath)).resolves.toMatchObject({
      source: "project_graph",
      diagnostics: []
    });
  });

  it("does not reinitialize a project when project metadata stat fails with EACCES", async () => {
    const { root, init } = await createTestWorkspace();
    vi.mocked(stat).mockImplementation((path, options) => {
      if (path === init.workspace.projectFile) {
        throw nodeIoError("EACCES");
      }
      return actualFs.stat(path, options);
    });

    await expect(initOrOpenProject(root)).rejects.toMatchObject({ code: "EACCES" });
  });

  it("does not report a registered project as missing when project metadata stat fails with EPERM", async () => {
    const { init } = await createTestWorkspace();
    vi.mocked(stat).mockImplementation((path, options) => {
      if (path === init.workspace.projectFile) {
        throw nodeIoError("EPERM");
      }
      return actualFs.stat(path, options);
    });

    await expect(openProject({ projectId: init.workspace.id })).rejects.toMatchObject({
      code: "EPERM"
    });
  });

  it("materializes missing formal project graphs when opening existing legacy projects", async () => {
    const { init, root } = await createTestWorkspace();
    await rm(projectGraphPath(init.workspace));
    await mkdir(join(init.workspace.workspaceRoot, "desktop"), { recursive: true });
    await writeJsonFile(join(init.workspace.workspaceRoot, "desktop", "canvases.json"), {
      version: "desktop-canvases/v1",
      canvases: [
        {
          canvasId: "default",
          name: "Test Plan",
          packageDir: "package",
          stateFile: "state.json",
          resultsDir: "results",
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z"
        },
        {
          canvasId: "legacy-second",
          name: "Legacy second canvas",
          packageDir: "canvases/legacy-second/package",
          stateFile: "canvases/legacy-second/state.json",
          resultsDir: "canvases/legacy-second/results",
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z"
        }
      ]
    });

    await expect(loadProjectGraph(root)).resolves.toMatchObject({
      source: "legacy_registry",
      manifest: {
        canvases: [
          expect.objectContaining({ id: "default" }),
          expect.objectContaining({ id: "legacy-second" })
        ]
      }
    });

    await expect(openProject({ projectId: init.workspace.id })).resolves.toMatchObject({
      projectId: init.workspace.id
    });
    await expect(loadProjectGraph(root)).resolves.toMatchObject({
      source: "project_graph",
      diagnostics: [],
      manifest: {
        canvases: [
          expect.objectContaining({ id: "default" }),
          expect.objectContaining({ id: "legacy-second" })
        ]
      }
    });
  });

  it("does not materialize unmigrated root default projects on open", async () => {
    const { init, root } = await createTestWorkspace();
    await rm(projectGraphPath(init.workspace));
    await rm(join(init.workspace.workspaceRoot, "canvases"), { recursive: true, force: true });
    const packageDir = join(init.workspace.workspaceRoot, "package");
    const manifest = basicManifest();
    await writeJsonFile(join(packageDir, "manifest.json"), manifest);
    await writePromptFiles(packageDir, manifest);
    await writeJsonFile(join(init.workspace.workspaceRoot, "state.json"), createEmptyState());
    await mkdir(join(init.workspace.workspaceRoot, "results"), { recursive: true });

    await expect(initOrOpenProject(root)).resolves.toMatchObject({
      projectId: init.workspace.id
    });
    const loaded = await loadProjectGraph(root);
    await expect(access(projectGraphPath(init.workspace))).rejects.toThrow();
    expect(loaded.source).not.toBe("project_graph");
  });

  it("normalizes legacy MCP-managed projects to their registered workspace root", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    process.env.PLANWEAVE_HOME = home;
    const legacyRoot = join(home, "mcp-projects", "legacy-demo");
    await mkdir(legacyRoot, { recursive: true });
    const init = await initWorkspace({ projectRoot: legacyRoot });
    await writeJsonFile(init.workspace.projectFile, {
      id: init.workspace.id,
      name: "legacy-demo",
      rootPath: legacyRoot,
      createdAt: "2026-06-20T00:00:00.000Z"
    });

    await expect(listProjects()).resolves.toEqual([
      expect.objectContaining({
        projectId: init.workspace.id,
        name: "legacy-demo",
        kind: "managed",
        rootPath: init.workspace.workspaceRoot,
        sourceRoot: null,
        workspaceRoot: init.workspace.workspaceRoot
      })
    ]);
    await expect(openProject({ projectId: init.workspace.id })).resolves.toMatchObject({
      projectId: init.workspace.id,
      kind: "managed",
      rootPath: init.workspace.workspaceRoot,
      sourceRoot: null,
      workspaceRoot: init.workspace.workspaceRoot
    });
  });

  it("links and unlinks a source root for managed projects", async () => {
    const { home: testHome } = await createTestWorkspace();
    process.env.PLANWEAVE_HOME = testHome;
    const sourceRoot = await mkdtemp(join(tmpdir(), "planweave-source-"));
    const resolvedSourceRoot = await realpath(sourceRoot);
    const project = await initManagedProject("Managed With Source");

    await expect(linkProjectSourceRoot(project.projectId, sourceRoot)).resolves.toMatchObject({
      projectId: project.projectId,
      kind: "managed",
      rootPath: project.workspaceRoot,
      sourceRoot: resolvedSourceRoot,
      workspaceRoot: project.workspaceRoot
    });
    await expect(openProject({ projectId: project.projectId })).resolves.toMatchObject({
      projectId: project.projectId,
      rootPath: project.workspaceRoot,
      sourceRoot: resolvedSourceRoot
    });
    await expect(unlinkProjectSourceRoot(project.projectId)).resolves.toMatchObject({
      projectId: project.projectId,
      rootPath: project.workspaceRoot,
      sourceRoot: null
    });
  });

  it("sets and clears the default PlanWeave project for a source root", async () => {
    const { home: testHome } = await createTestWorkspace();
    process.env.PLANWEAVE_HOME = testHome;
    const sourceRoot = await mkdtemp(join(tmpdir(), "planweave-source-"));
    const resolvedSourceRoot = await realpath(sourceRoot);
    const project = await initManagedProject("Managed Source Default");
    await linkProjectSourceRoot(project.projectId, sourceRoot);

    await expect(setSourceDefaultProject(sourceRoot, project.projectId)).resolves.toMatchObject({
      projectId: project.projectId,
      projectRoot: project.workspaceRoot,
      sourceRoot: resolvedSourceRoot
    });
    await expect(getSourceDefaultProject(sourceRoot)).resolves.toMatchObject({
      projectId: project.projectId,
      projectRoot: project.workspaceRoot,
      sourceRoot: resolvedSourceRoot
    });
    await expect(resolveSourceDefaultProjectRoot(sourceRoot)).resolves.toBe(project.workspaceRoot);
    await expect(clearSourceDefaultProject(sourceRoot)).resolves.toMatchObject({
      projectId: project.projectId
    });
    await expect(getSourceDefaultProject(sourceRoot)).resolves.toBeNull();
  });

  it("does not treat source defaults stat failures as empty defaults", async () => {
    const { home: testHome } = await createTestWorkspace();
    process.env.PLANWEAVE_HOME = testHome;
    const sourceRoot = await mkdtemp(join(tmpdir(), "planweave-source-"));
    const defaultsPath = join(resolvePlanweaveHome(), "source-defaults.json");
    vi.mocked(stat).mockImplementation((path, options) => {
      if (path === defaultsPath) {
        throw nodeIoError("EACCES");
      }
      return actualFs.stat(path, options);
    });

    await expect(getSourceDefaultProject(sourceRoot)).rejects.toMatchObject({ code: "EACCES" });
  });

  it("does not treat source defaults read failures as empty defaults", async () => {
    const { home: testHome } = await createTestWorkspace();
    process.env.PLANWEAVE_HOME = testHome;
    const sourceRoot = await mkdtemp(join(tmpdir(), "planweave-source-"));
    const defaultsPath = join(resolvePlanweaveHome(), "source-defaults.json");
    await writeJsonFile(defaultsPath, {
      version: "planweave-source-defaults/v1",
      defaults: {}
    });
    vi.mocked(readFile).mockImplementation((path, options) => {
      if (path === defaultsPath) {
        throw nodeIoError("EIO");
      }
      return actualFs.readFile(path, options);
    });

    await expect(getSourceDefaultProject(sourceRoot)).rejects.toMatchObject({ code: "EIO" });
  });

  it("lists all PlanWeave projects linked to a source root", async () => {
    const { home: testHome, init, root } = await createTestWorkspace();
    process.env.PLANWEAVE_HOME = testHome;
    const managed = await initManagedProject("Managed Candidate");
    await linkProjectSourceRoot(managed.projectId, root);

    await expect(listSourceDefaultProjectCandidates(root)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: init.workspace.id,
          projectRoot: init.workspace.workspaceRoot,
          sourceRoot: await realpath(root),
          kind: "external"
        }),
        expect.objectContaining({
          projectId: managed.projectId,
          projectRoot: managed.workspaceRoot,
          sourceRoot: await realpath(root),
          kind: "managed"
        })
      ])
    );
  });

  it("does not treat projects root read failures as no source default candidates", async () => {
    const { home: testHome, root } = await createTestWorkspace();
    process.env.PLANWEAVE_HOME = testHome;
    const projectsRoot = join(resolvePlanweaveHome(), "projects");
    vi.mocked(readdir).mockImplementation((path, options) => {
      if (path === projectsRoot) {
        throw nodeIoError("EIO");
      }
      return actualFs.readdir(path, options);
    });

    await expect(listSourceDefaultProjectCandidates(root)).rejects.toMatchObject({ code: "EIO" });
  });

  it("does not report source default project metadata stat failures as a missing project", async () => {
    const { home: testHome } = await createTestWorkspace();
    process.env.PLANWEAVE_HOME = testHome;
    const sourceRoot = await mkdtemp(join(tmpdir(), "planweave-source-"));
    const project = await initManagedProject("Managed Source Metadata Error");
    await linkProjectSourceRoot(project.projectId, sourceRoot);
    const projectFile = join(project.workspaceRoot, "project.json");
    vi.mocked(stat).mockImplementation((path, options) => {
      if (path === projectFile) {
        throw nodeIoError("EPERM");
      }
      return actualFs.stat(path, options);
    });

    await expect(setSourceDefaultProject(sourceRoot, project.projectId)).rejects.toMatchObject({
      code: "EPERM"
    });
  });

  it("does not hide source root realpath I/O failures while listing source default candidates", async () => {
    const { home: testHome } = await createTestWorkspace();
    process.env.PLANWEAVE_HOME = testHome;
    const sourceRoot = await mkdtemp(join(tmpdir(), "planweave-source-"));
    const resolvedSourceRoot = await actualFs.realpath(sourceRoot);
    const project = await initManagedProject("Managed Source Realpath Error");
    await linkProjectSourceRoot(project.projectId, sourceRoot);
    let sourceRootRealpathCalls = 0;
    vi.mocked(realpath).mockImplementation((path, options) => {
      if (path === sourceRoot || path === resolvedSourceRoot) {
        sourceRootRealpathCalls += 1;
        if (sourceRootRealpathCalls > 1) {
          throw nodeIoError("EACCES");
        }
      }
      return actualFs.realpath(path, options);
    });

    await expect(listSourceDefaultProjectCandidates(sourceRoot)).rejects.toMatchObject({
      code: "EACCES"
    });
  });

  it("rejects source default projects bound to another source root", async () => {
    const { home: testHome } = await createTestWorkspace();
    process.env.PLANWEAVE_HOME = testHome;
    const sourceRoot = await mkdtemp(join(tmpdir(), "planweave-source-"));
    const otherSourceRoot = await mkdtemp(join(tmpdir(), "planweave-other-source-"));
    const project = await initManagedProject("Managed Source Mismatch");
    await linkProjectSourceRoot(project.projectId, sourceRoot);

    await expect(setSourceDefaultProject(otherSourceRoot, project.projectId)).rejects.toThrow(
      "is linked to source root"
    );
  });

  it("rejects source root binding for external projects", async () => {
    const { init } = await createTestWorkspace();
    const sourceRoot = await mkdtemp(join(tmpdir(), "planweave-source-"));

    await expect(linkProjectSourceRoot(init.workspace.id, sourceRoot)).rejects.toThrow(
      "Only managed PlanWeave projects can bind a source root."
    );
  });

  it("keeps valid projects visible when another PlanWeave registry entry is stale", async () => {
    const { init } = await createTestWorkspace();
    const staleProjectRoot = join(resolvePlanweaveHome(), "projects", "stale-project");
    await mkdir(staleProjectRoot, { recursive: true });
    await writeJsonFile(join(staleProjectRoot, "project.json"), {
      id: "stale-project",
      name: "stale-project",
      rootPath: join(resolvePlanweaveHome(), "missing-source-root"),
      createdAt: "2026-05-23T00:00:00.000Z"
    });

    await expect(listProjects()).resolves.toEqual([
      expect.objectContaining({
        projectId: init.workspace.id,
        kind: "external",
        rootPath: init.workspace.rootPath
      })
    ]);
  });

  it("keeps projects visible when project-graph.json has schema errors", async () => {
    const { init } = await createTestWorkspace();
    await writeJsonFile(join(init.workspace.workspaceRoot, "project-graph.json"), {
      version: "plan-project/v1",
      canvases: "invalid"
    });

    await expect(listProjects()).resolves.toEqual([
      expect.objectContaining({
        projectId: init.workspace.id,
        taskCanvases: [
          expect.objectContaining({
            canvasId: "project-graph",
            diagnostics: [expect.objectContaining({ code: "project_graph_schema" })]
          })
        ]
      })
    ]);
    await expect(openProject({ projectId: init.workspace.id })).resolves.toMatchObject({
      projectId: init.workspace.id,
      taskCanvases: [
        expect.objectContaining({
          canvasId: "project-graph",
          diagnostics: [expect.objectContaining({ code: "project_graph_schema" })]
        })
      ]
    });
  });

  it("removes a project from the PlanWeave registry without deleting the source root", async () => {
    const { init, root } = await createTestWorkspace();

    await expect(removeProject(init.workspace.id)).resolves.toBeUndefined();

    await expect(listProjects()).resolves.toEqual([]);
    await expect(access(root)).resolves.toBeUndefined();
  });

  it("clears projection result body cache when removing an external project", async () => {
    const { init, root } = await createTestWorkspace();
    const runDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-REMOVE-CACHE"
    );
    const reportPath = join(runDir, "report.md");
    await mkdir(runDir, { recursive: true });
    await writeFile(reportPath, "remove project cache needle\n", "utf8");

    const projection = await readDesktopProjectProjection(init.workspace.rootPath);
    const resultIndex = projection.resultsByCanvas.get("default");
    if (!resultIndex) {
      throw new Error("Default canvas results index missing.");
    }
    const hydratedBeforeRemove = await hydrateResultsFileIndexBodies(resultIndex);
    expect(hydratedBeforeRemove.entries).toContainEqual(
      expect.objectContaining({
        absolutePath: reportPath,
        body: "remove project cache needle\n",
        bodyLoaded: true
      })
    );

    vi.mocked(readFile).mockClear();
    await expect(removeProject(init.workspace.id)).resolves.toBeUndefined();
    const hydratedAfterRemove = await hydrateResultsFileIndexBodies(resultIndex);

    expect(resultReadPaths(init.workspace.resultsDir)).toContain(reportPath);
    expect(hydratedAfterRemove.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "desktop_result_file_read_failed",
        path: "results/T-001/blocks/B-001/runs/RUN-REMOVE-CACHE/report.md"
      })
    );
    await expect(listProjects()).resolves.toEqual([]);
    await expect(access(root)).resolves.toBeUndefined();
  });
});
