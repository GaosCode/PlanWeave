import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listProjects, openProject, removeProject } from "../desktop/index.js";
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
        rootPath: init.workspace.rootPath
      })
    ]);
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
