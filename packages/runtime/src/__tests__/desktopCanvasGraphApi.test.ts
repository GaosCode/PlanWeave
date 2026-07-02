import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTaskCanvas,
  getCanvasGraphViewModel,
  getCanvasMapLayout,
  resetCanvasMapLayout,
  resolveTaskCanvasWorkspace,
  saveCanvasMapLayout
} from "../desktop/index.js";
import { writeJsonFile } from "../json.js";
import { canonicalProjectCanvasNode, writeProjectGraph } from "../projectGraph/index.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: vi.fn(actual.stat)
  };
});

let actualFs: typeof import("node:fs/promises");

beforeEach(async () => {
  actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(stat).mockImplementation((path, options) => actualFs.stat(path, options));
});

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  vi.restoreAllMocks();
});

function nodeIoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code} simulated`), { code });
}

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
        canonicalProjectCanvasNode({ id: "default", title: "Runtime plan" }),
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
    expect(graph.health.severity).toBe("warning");
    expect(graph.health.blockedBlocks).toEqual([
      expect.objectContaining({
        blocked: expect.objectContaining({
          canvasId: secondCanvas.canvasId,
          taskId: "T-001",
          blockRef: "T-001#B-001",
          blockTitle: "Implement task"
        }),
        blockers: [
          expect.objectContaining({ kind: "canvas", canvasId: "default" }),
          expect.objectContaining({ kind: "task", canvasId: "default", taskId: "T-001" })
        ]
      })
    ]);
    expect(graph.health.canvases.find((canvas) => canvas.canvasId === secondCanvas.canvasId)).toMatchObject({
      severity: "warning",
      blockerCount: 1
    });
    expect(graph.health.edges.find((edge) => edge.from === secondCanvas.canvasId && edge.to === "default")).toMatchObject({
      severity: "warning",
      blockerCount: 1
    });
  });

  it("keeps health ok when a formal canvas graph has no blockers or diagnostics", async () => {
    const { root, init } = await createTestWorkspace();
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Runtime plan" })
      ],
      edges: [],
      crossTaskEdges: []
    });

    const graph = await getCanvasGraphViewModel(root);

    expect(graph.health).toEqual({
      severity: "ok",
      canvases: [{ canvasId: "default", severity: "ok", blockerCount: 0, diagnosticCount: 0 }],
      edges: [],
      blockedBlocks: [],
      diagnostics: []
    });
  });

  it("refreshes the cached canvas graph when project graph changes externally", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Externally added canvas" });
    const secondWorkspace = await resolveTaskCanvasWorkspace(root, secondCanvas.canvasId);
    const secondManifest = basicManifest();
    await writeJsonFile(secondWorkspace.manifestFile, secondManifest);
    await writePromptFiles(secondWorkspace.packageDir, secondManifest);
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Runtime plan" })
      ],
      edges: [],
      crossTaskEdges: []
    });

    await expect(getCanvasGraphViewModel(root)).resolves.toMatchObject({
      canvases: [expect.objectContaining({ canvasId: "default" })]
    });

    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Runtime plan" }),
        {
          id: secondCanvas.canvasId,
          type: "canvas",
          title: "Externally added canvas",
          packageDir: `canvases/${secondCanvas.canvasId}/package`,
          stateFile: `canvases/${secondCanvas.canvasId}/state.json`,
          resultsDir: `canvases/${secondCanvas.canvasId}/results`
        }
      ],
      edges: [{ from: secondCanvas.canvasId, to: "default", type: "depends_on" }],
      crossTaskEdges: []
    });

    const graph = await getCanvasGraphViewModel(root);

    expect(graph.canvases.map((canvas) => canvas.canvasId)).toEqual(["default", secondCanvas.canvasId]);
    expect(graph.edges).toEqual([{ from: secondCanvas.canvasId, to: "default", type: "depends_on" }]);
  });

  it("surfaces broken project graph diagnostics in canvas health", async () => {
    const { root, init } = await createTestWorkspace();
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Runtime plan" })
      ],
      edges: [{ from: "default", to: "missing-canvas", type: "depends_on" }],
      crossTaskEdges: [
        {
          from: { canvasId: "default", taskId: "T-001" },
          to: { canvasId: "missing-canvas", taskId: "T-999" },
          type: "depends_on"
        }
      ]
    });

    const graph = await getCanvasGraphViewModel(root);

    expect(graph.health.severity).toBe("error");
    expect(graph.health.diagnostics).toEqual([
      expect.objectContaining({ code: "project_canvas_edge_to_missing" }),
      expect.objectContaining({ code: "project_cross_task_to_canvas_missing" })
    ]);
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

  it("does not fall back to the default canvas map layout when layout stat fails with EACCES", async () => {
    const { root, init } = await createTestWorkspace();
    const layoutPath = join(init.workspace.workspaceRoot, "desktop", "canvas-map-layout.json");
    vi.mocked(stat).mockImplementation((path, options) => {
      if (path === layoutPath) {
        throw nodeIoError("EACCES");
      }
      return actualFs.stat(path, options);
    });

    await expect(getCanvasMapLayout(root)).rejects.toMatchObject({ code: "EACCES" });
  });
});
