import { afterEach, describe, expect, it } from "vitest";
import { createTaskCanvas, resolveTaskCanvasWorkspace } from "../desktop/index.js";
import { writeJsonFile } from "../json.js";
import { canonicalProjectCanvasNode, compileProjectGraph, parseProjectTaskRefKey, projectTaskRefKey } from "../projectGraph/index.js";
import { loadProjectGraph, writeProjectGraph } from "../projectGraph/loadProjectGraph.js";
import type { PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

async function createSecondCanvas(root: string, name = "Second plan", manifest: PlanPackageManifest = basicManifest()) {
  const canvas = await createTaskCanvas(root, { name });
  const workspace = await resolveTaskCanvasWorkspace(root, canvas.canvasId);
  await writeJsonFile(workspace.manifestFile, manifest);
  await writePromptFiles(workspace.packageDir, manifest);
  return { canvas, workspace, manifest };
}

function manyTaskManifest(count: number): PlanPackageManifest {
  const manifest = basicManifest();
  return {
    ...manifest,
    nodes: Array.from({ length: count }, (_, index) => {
      const taskId = `T-${String(index + 1).padStart(3, "0")}`;
      return {
        id: taskId,
        type: "task" as const,
        title: `Task ${index + 1}`,
        prompt: `nodes/${taskId}/prompt.md`,
        acceptance: [`${taskId} is complete.`],
        blocks: [
          {
            id: "B-001",
            type: "implementation" as const,
            title: `Implement ${taskId}`,
            prompt: `nodes/${taskId}/blocks/B-001.prompt.md`,
            depends_on: [],
            parallel: { safe: true, locks: [taskId] }
          }
        ]
      };
    }),
    edges: []
  };
}

describe("compileProjectGraph", () => {
  it("parses project task ref keys and rejects incomplete refs", () => {
    expect(parseProjectTaskRefKey("default::T-001")).toEqual({ canvasId: "default", taskId: "T-001" });
    expect(() => parseProjectTaskRefKey("default")).toThrow("Expected '<canvas-id>::<task-id>'.");
    expect(() => parseProjectTaskRefKey("::T-001")).toThrow("Expected '<canvas-id>::<task-id>'.");
    expect(() => parseProjectTaskRefKey("default::")).toThrow("Expected '<canvas-id>::<task-id>'.");
  });

  it("indexes canvas and cross-task dependencies", async () => {
    const { root, init } = await createTestWorkspace();
    const second = await createSecondCanvas(root);
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Default" }),
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

  it("does not expand canvas dependencies into task dependency edges", async () => {
    const { root, init } = await createTestWorkspace();
    const second = await createSecondCanvas(root);
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Default" }),
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
      crossTaskEdges: []
    });

    const graph = await compileProjectGraph(await loadProjectGraph(root));

    expect(graph.diagnostics.errors).toEqual([]);
    expect(graph.canvasDependenciesByCanvas.get(second.canvas.canvasId)).toEqual(["default"]);
    expect(graph.canvasReachable(second.canvas.canvasId, "default")).toBe(true);
    expect(graph.taskDependencies({ canvasId: second.canvas.canvasId, taskId: "T-001" })).toEqual([]);
    expect(graph.taskDependents({ canvasId: "default", taskId: "T-001" })).toEqual([]);
    expect(graph.taskReachable({ canvasId: second.canvas.canvasId, taskId: "T-001" }, { canvasId: "default", taskId: "T-001" })).toBe(false);
  });

  it("keeps large canvas dependency graphs from materializing cartesian task edges", async () => {
    const manifest = manyTaskManifest(100);
    const { root, init } = await createTestWorkspace(manifest);
    const second = await createSecondCanvas(root, "Second plan", manifest);
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Default" }),
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
      crossTaskEdges: []
    });

    const graph = await compileProjectGraph(await loadProjectGraph(root));
    const dependencyCount = Array.from(graph.taskDependenciesByTaskRef.values()).reduce((total, dependencies) => total + dependencies.length, 0);

    expect(graph.diagnostics.errors).toEqual([]);
    expect(graph.taskRefsInProjectOrder).toHaveLength(200);
    expect(dependencyCount).toBe(0);
  });

  it("reports duplicate canvas ids and missing edge endpoints", async () => {
    const { root, init } = await createTestWorkspace();
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Default" }),
        canonicalProjectCanvasNode({ id: "default", title: "Duplicate" })
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
        canonicalProjectCanvasNode({ id: "default", title: "Default" }),
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
        canonicalProjectCanvasNode({ id: "default", title: "Default" })
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
