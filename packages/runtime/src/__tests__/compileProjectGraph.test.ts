import { afterEach, describe, expect, it } from "vitest";
import { createTaskCanvas, resolveTaskCanvasWorkspace } from "../desktop/index.js";
import { writeJsonFile } from "../json.js";
import { compileProjectGraph, projectTaskRefKey } from "../projectGraph/index.js";
import { loadProjectGraph, writeProjectGraph } from "../projectGraph/loadProjectGraph.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

async function createSecondCanvas(root: string, name = "Second plan") {
  const canvas = await createTaskCanvas(root, { name });
  const workspace = await resolveTaskCanvasWorkspace(root, canvas.canvasId);
  const manifest = basicManifest();
  await writeJsonFile(workspace.manifestFile, manifest);
  await writePromptFiles(workspace.packageDir, manifest);
  return { canvas, workspace, manifest };
}

describe("compileProjectGraph", () => {
  it("indexes canvas and cross-task dependencies", async () => {
    const { root, init } = await createTestWorkspace();
    const second = await createSecondCanvas(root);
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        { id: "default", type: "canvas", title: "Default", packageDir: "package", stateFile: "state.json", resultsDir: "results" },
        {
          id: second.canvas.canvasId,
          type: "canvas",
          title: "Second plan",
          packageDir: `canvases/${second.canvas.canvasId}/package`,
          stateFile: `canvases/${second.canvas.canvasId}/state.json`,
          resultsDir: `canvases/${second.canvas.canvasId}/results`
        }
      ],
      edges: [{ from: second.canvas.canvasId, to: "default", type: "depends_on" }],
      crossTaskEdges: [
        {
          from: { canvasId: second.canvas.canvasId, taskId: "T-001" },
          to: { canvasId: "default", taskId: "T-001" },
          type: "depends_on"
        }
      ]
    });

    const graph = await compileProjectGraph(await loadProjectGraph(root));

    expect(graph.diagnostics.errors).toEqual([]);
    expect(graph.canvasDependenciesByCanvas.get(second.canvas.canvasId)).toEqual(["default"]);
    expect(graph.canvasReachable(second.canvas.canvasId, "default")).toBe(true);
    expect(graph.crossTaskDependenciesByTaskRef.get(projectTaskRefKey({ canvasId: second.canvas.canvasId, taskId: "T-001" }))).toEqual([
      projectTaskRefKey({ canvasId: "default", taskId: "T-001" })
    ]);
    expect(graph.taskReachable({ canvasId: second.canvas.canvasId, taskId: "T-001" }, { canvasId: "default", taskId: "T-001" })).toBe(true);
  });

  it("reports duplicate canvas ids and missing edge endpoints", async () => {
    const { root, init } = await createTestWorkspace();
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        { id: "default", type: "canvas", title: "Default", packageDir: "package", stateFile: "state.json", resultsDir: "results" },
        { id: "default", type: "canvas", title: "Duplicate", packageDir: "package", stateFile: "state.json", resultsDir: "results" }
      ],
      edges: [{ from: "missing", to: "default", type: "depends_on" }],
      crossTaskEdges: []
    });

    const graph = await compileProjectGraph(await loadProjectGraph(root));

    expect(graph.diagnostics.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "project_canvas_id_duplicate" }),
        expect.objectContaining({ code: "project_canvas_edge_from_missing" })
      ])
    );
  });

  it("reports missing cross-task refs and cross-canvas cycles", async () => {
    const { root, init } = await createTestWorkspace();
    const second = await createSecondCanvas(root);
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        { id: "default", type: "canvas", title: "Default", packageDir: "package", stateFile: "state.json", resultsDir: "results" },
        {
          id: second.canvas.canvasId,
          type: "canvas",
          title: "Second plan",
          packageDir: `canvases/${second.canvas.canvasId}/package`,
          stateFile: `canvases/${second.canvas.canvasId}/state.json`,
          resultsDir: `canvases/${second.canvas.canvasId}/results`
        }
      ],
      edges: [],
      crossTaskEdges: [
        {
          from: { canvasId: "default", taskId: "T-001" },
          to: { canvasId: second.canvas.canvasId, taskId: "T-001" },
          type: "depends_on"
        },
        {
          from: { canvasId: second.canvas.canvasId, taskId: "T-001" },
          to: { canvasId: "default", taskId: "T-001" },
          type: "depends_on"
        },
        {
          from: { canvasId: second.canvas.canvasId, taskId: "T-MISSING" },
          to: { canvasId: "default", taskId: "T-001" },
          type: "depends_on"
        }
      ]
    });

    const graph = await compileProjectGraph(await loadProjectGraph(root));

    expect(graph.diagnostics.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "project_cross_task_from_missing" }),
        expect.objectContaining({ code: "project_task_depends_on_cycle" })
      ])
    );
  });

  it("keeps loaded canvas task refs when another canvas manifest cannot be read", async () => {
    const { root, init } = await createTestWorkspace();
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        {
          id: "broken",
          type: "canvas",
          title: "Broken",
          packageDir: "canvases/broken/package",
          stateFile: "canvases/broken/state.json",
          resultsDir: "canvases/broken/results"
        },
        { id: "default", type: "canvas", title: "Default", packageDir: "package", stateFile: "state.json", resultsDir: "results" }
      ],
      edges: [],
      crossTaskEdges: [
        {
          from: { canvasId: "broken", taskId: "T-001" },
          to: { canvasId: "default", taskId: "T-MISSING" },
          type: "depends_on"
        }
      ]
    });

    const graph = await compileProjectGraph(await loadProjectGraph(root));

    expect(graph.taskRefsInProjectOrder).toEqual([{ canvasId: "default", taskId: "T-001" }]);
    expect(graph.diagnostics.errors.map((error) => error.code)).toEqual([
      "project_canvas_manifest_read_failed",
      "project_cross_task_to_missing"
    ]);
  });
});
