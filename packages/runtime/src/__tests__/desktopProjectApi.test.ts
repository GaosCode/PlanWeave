import { access, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initManagedProject, linkProjectSourceRoot, listProjects, openProject, removeProject, unlinkProjectSourceRoot } from "../desktop/index.js";
import { initWorkspace } from "../initWorkspace.js";
import { writeJsonFile } from "../json.js";
import { resolvePlanweaveHome } from "../paths.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

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
