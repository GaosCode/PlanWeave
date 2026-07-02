import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSourceDefaultProject,
  createTaskCanvas,
  getSourceDefaultProject,
  initManagedProject,
  initOrOpenProject,
  linkProjectSourceRoot,
  listSourceDefaultProjectCandidates,
  listProjects,
  openProject,
  removeProject,
  resolveSourceDefaultProjectRoot,
  setSourceDefaultProject,
  unlinkProjectSourceRoot
} from "../desktop/index.js";
import { initWorkspace } from "../initWorkspace.js";
import { writeJsonFile } from "../json.js";
import { resolvePlanweaveHome } from "../paths.js";
import { loadProjectGraph, projectGraphPath } from "../projectGraph/index.js";
import { createEmptyState } from "../state.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
    realpath: vi.fn(actual.realpath),
    stat: vi.fn(actual.stat)
  };
});

let actualFs: typeof import("node:fs/promises");

beforeEach(async () => {
  actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(readFile).mockImplementation((path, options) => actualFs.readFile(path, options));
  vi.mocked(readdir).mockImplementation((path, options) => actualFs.readdir(path, options));
  vi.mocked(realpath).mockImplementation((path, options) => actualFs.realpath(path, options));
  vi.mocked(stat).mockImplementation((path, options) => actualFs.stat(path, options));
});

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  vi.restoreAllMocks();
});

function nodeIoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code} simulated`), { code });
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

    await expect(openProject({ projectId: init.workspace.id })).rejects.toMatchObject({ code: "EPERM" });
  });

  it("materializes missing formal project graphs when opening existing legacy projects", async () => {
    const { init, root } = await createTestWorkspace();
    await rm(projectGraphPath(init.workspace));
    const second = await createTaskCanvas(root, { name: "Legacy second canvas" });

    await expect(loadProjectGraph(root)).resolves.toMatchObject({
      source: "legacy_registry",
      manifest: {
        canvases: [
          expect.objectContaining({ id: "default" }),
          expect.objectContaining({ id: second.canvasId })
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
          expect.objectContaining({ id: second.canvasId })
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

    await expect(setSourceDefaultProject(sourceRoot, project.projectId)).rejects.toMatchObject({ code: "EPERM" });
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

    await expect(listSourceDefaultProjectCandidates(sourceRoot)).rejects.toMatchObject({ code: "EACCES" });
  });

  it("rejects source default projects bound to another source root", async () => {
    const { home: testHome } = await createTestWorkspace();
    process.env.PLANWEAVE_HOME = testHome;
    const sourceRoot = await mkdtemp(join(tmpdir(), "planweave-source-"));
    const otherSourceRoot = await mkdtemp(join(tmpdir(), "planweave-other-source-"));
    const project = await initManagedProject("Managed Source Mismatch");
    await linkProjectSourceRoot(project.projectId, sourceRoot);

    await expect(setSourceDefaultProject(otherSourceRoot, project.projectId)).rejects.toThrow("is linked to source root");
  });

  it("rejects source root binding for external projects", async () => {
    const { init } = await createTestWorkspace();
    const sourceRoot = await mkdtemp(join(tmpdir(), "planweave-source-"));

    await expect(linkProjectSourceRoot(init.workspace.id, sourceRoot)).rejects.toThrow("Only managed PlanWeave projects can bind a source root.");
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
});
