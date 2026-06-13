import { afterEach, describe, expect, it } from "vitest";
import {
  createTaskCanvas,
  getCanvasGraphViewModel,
  getCanvasMapLayout,
  resetCanvasMapLayout,
  resolveTaskCanvasWorkspace,
  saveCanvasMapLayout
} from "../desktop/index.js";
import { writeJsonFile } from "../json.js";
import { writeProjectGraph } from "../projectGraph/index.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("desktop canvas graph API", () => {
  it("projects project-graph.json into a desktop canvas map view model", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Desktop plan" });
    const secondWorkspace = await resolveTaskCanvasWorkspace(root, secondCanvas.canvasId);
    const secondManifest = basicManifest();
    await writeJsonFile(secondWorkspace.manifestFile, secondManifest);
    await writePromptFiles(secondWorkspace.packageDir, secondManifest);
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        { id: "default", type: "canvas", title: "Runtime plan", packageDir: "package", stateFile: "state.json", resultsDir: "results" },
        {
          id: secondCanvas.canvasId,
          type: "canvas",
          title: "Desktop plan",
          packageDir: `canvases/${secondCanvas.canvasId}/package`,
          stateFile: `canvases/${secondCanvas.canvasId}/state.json`,
          resultsDir: `canvases/${secondCanvas.canvasId}/results`
        }
      ],
      edges: [{ from: secondCanvas.canvasId, to: "default", type: "depends_on" }],
      crossTaskEdges: [
        {
          from: { canvasId: secondCanvas.canvasId, taskId: "T-001" },
          to: { canvasId: "default", taskId: "T-001" },
          type: "depends_on"
        }
      ]
    });

    const graph = await getCanvasGraphViewModel(root);

    expect(graph.projectId).toBe(init.workspace.id);
    expect(graph.canvases.map((canvas) => canvas.canvasId)).toEqual(["default", secondCanvas.canvasId]);
    expect(graph.edges).toEqual([{ from: secondCanvas.canvasId, to: "default", type: "depends_on" }]);
    expect(graph.crossTaskEdges).toEqual([
      {
        from: { canvasId: secondCanvas.canvasId, taskId: "T-001" },
        to: { canvasId: "default", taskId: "T-001" },
        type: "depends_on"
      }
    ]);
    expect(graph.diagnostics).toEqual([]);
  });

  it("persists canvas map layout under desktop-owned state", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Second canvas" });

    const initial = await getCanvasMapLayout(root);
    expect(initial.projectId).toBe(init.workspace.id);
    expect(initial.nodes.map((node) => node.canvasId)).toEqual(["default", secondCanvas.canvasId]);

    const saved = await saveCanvasMapLayout(root, {
      version: "desktop-canvas-map-layout/v1",
      projectId: "wrong-project",
      nodes: [
        { canvasId: secondCanvas.canvasId, x: 500, y: 300 },
        { canvasId: "stale", x: 1, y: 1 }
      ],
      updatedAt: new Date(0).toISOString()
    });

    expect(saved.projectId).toBe(init.workspace.id);
    expect(saved.nodes).toEqual([{ canvasId: secondCanvas.canvasId, x: 500, y: 300 }]);
    await expect(getCanvasMapLayout(root)).resolves.toMatchObject({
      nodes: [
        { canvasId: secondCanvas.canvasId, x: 500, y: 300 },
        expect.objectContaining({ canvasId: "default" })
      ]
    });

    const reset = await resetCanvasMapLayout(root);
    expect(reset.nodes.map((node) => node.canvasId)).toEqual(["default", secondCanvas.canvasId]);
  });
});
