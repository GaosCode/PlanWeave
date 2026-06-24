import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

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
