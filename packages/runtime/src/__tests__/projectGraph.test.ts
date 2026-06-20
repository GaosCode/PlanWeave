import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskCanvas } from "../desktop/index.js";
import { writeJsonFile } from "../json.js";
import {
  compileProjectGraph,
  loadProjectGraph,
  projectGraphPath,
  projectGraphSchema
} from "../projectGraph/index.js";
import { manifestSchema } from "../schema/manifest.js";
import type { PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

function projectGraph() {
  return {
    version: "plan-project/v1" as const,
    canvases: [
      {
        id: "runtime",
        type: "canvas" as const,
        title: "Runtime",
        packageDir: "package",
        stateFile: "state.json",
        resultsDir: "results"
      },
      {
        id: "desktop",
        type: "canvas" as const,
        title: "Desktop",
        packageDir: "canvases/desktop/package",
        stateFile: "canvases/desktop/state.json",
        resultsDir: "canvases/desktop/results"
      }
    ],
    edges: [],
    crossTaskEdges: []
  };
}

function codes(graph: Awaited<ReturnType<typeof compileProjectGraph>>): string[] {
  return graph.diagnostics.errors.map((error) => error.code);
}

async function createTwoCanvasProject(manifest = projectGraph()) {
  const { root, init } = await createTestWorkspace();
  const desktopPackageDir = join(init.workspace.workspaceRoot, "canvases", "desktop", "package");
  const desktopManifest = basicManifest();
  await writeJsonFile(join(desktopPackageDir, "manifest.json"), desktopManifest);
  await writePromptFiles(desktopPackageDir, desktopManifest);
  await writeJsonFile(projectGraphPath(init.workspace), manifest);
  return loadProjectGraph(root);
}

describe("project graph schema and compiler", () => {
  it("accepts project-graph.json without changing single-canvas manifest nodes", () => {
    expect(() => projectGraphSchema.parse(projectGraph())).not.toThrow();

    const baseManifest = basicManifest();
    const manifestWithCanvasNode: unknown = {
      ...baseManifest,
      nodes: [
        ...baseManifest.nodes,
        {
          id: "canvas-node",
          type: "canvas",
          title: "Canvas",
          packageDir: "package",
          stateFile: "state.json",
          resultsDir: "results"
        }
      ]
    };

    expect(manifestSchema.safeParse(manifestWithCanvasNode).success).toBe(false);
  });

  it("detects duplicate canvas ids and edges pointing at missing canvases", async () => {
    const manifest = projectGraph();
    manifest.canvases.push({ ...manifest.canvases[0], title: "Duplicate runtime" });
    manifest.edges.push({ from: "desktop", to: "missing", type: "depends_on" });

    const loaded = await createTwoCanvasProject(manifest);
    const graph = await compileProjectGraph({ ...loaded, manifest });

    expect(codes(graph)).toEqual(expect.arrayContaining(["project_canvas_id_duplicate", "project_canvas_edge_to_missing"]));
  });

  it("detects missing tasks in cross-canvas task edges", async () => {
    const manifest = projectGraph();
    manifest.crossTaskEdges.push({
      from: { canvasId: "desktop", taskId: "T-DOES-NOT-EXIST" },
      to: { canvasId: "runtime", taskId: "T-001" },
      type: "depends_on"
    });

    const loaded = await createTwoCanvasProject(manifest);
    const graph = await compileProjectGraph(loaded);

    expect(codes(graph)).toContain("project_cross_task_from_missing");
  });

  it("detects canvas dependency cycles", async () => {
    const manifest = projectGraph();
    manifest.edges.push({ from: "desktop", to: "runtime", type: "depends_on" });
    manifest.edges.push({ from: "runtime", to: "desktop", type: "depends_on" });

    const loaded = await createTwoCanvasProject(manifest);
    const graph = await compileProjectGraph(loaded);

    expect(codes(graph)).toContain("project_canvas_depends_on_cycle");
    expect(graph.canvasReachable("desktop", "runtime")).toBe(true);
  });

  it("detects mixed canvas and cross-task cycles", async () => {
    const { root, init } = await createTestWorkspace();
    for (const canvasId of ["B", "C", "D"]) {
      const manifest = canvasId === "B" ? basicManifest({ includeSecondTask: true }) : basicManifest();
      const packageDir = join(init.workspace.workspaceRoot, "canvases", canvasId, "package");
      await writeJsonFile(join(packageDir, "manifest.json"), manifest);
      await writePromptFiles(packageDir, manifest);
    }
    await writeJsonFile(projectGraphPath(init.workspace), {
      version: "plan-project/v1",
      canvases: [
        { id: "default", type: "canvas", title: "Default", packageDir: "package", stateFile: "state.json", resultsDir: "results" },
        { id: "B", type: "canvas", title: "B", packageDir: "canvases/B/package", stateFile: "canvases/B/state.json", resultsDir: "canvases/B/results" },
        { id: "C", type: "canvas", title: "C", packageDir: "canvases/C/package", stateFile: "canvases/C/state.json", resultsDir: "canvases/C/results" },
        { id: "D", type: "canvas", title: "D", packageDir: "canvases/D/package", stateFile: "canvases/D/state.json", resultsDir: "canvases/D/results" }
      ],
      edges: [{ from: "C", to: "D", type: "depends_on" }],
      crossTaskEdges: [
        { from: { canvasId: "default", taskId: "T-001" }, to: { canvasId: "B", taskId: "T-001" }, type: "depends_on" },
        { from: { canvasId: "B", taskId: "T-002" }, to: { canvasId: "default", taskId: "T-001" }, type: "depends_on" },
        { from: { canvasId: "D", taskId: "T-001" }, to: { canvasId: "C", taskId: "T-001" }, type: "depends_on" }
      ]
    });

    const loaded = await loadProjectGraph(root);
    const graph = await compileProjectGraph(loaded);

    expect(codes(graph)).toContain("project_mixed_depends_on_cycle");
    expect(codes(graph)).not.toContain("project_task_depends_on_cycle");
    expect(codes(graph)).not.toContain("project_canvas_depends_on_cycle");
  });

  it("detects task cycles from same-canvas and cross-task edges", async () => {
    const manifest = projectGraph();
    const runtimeManifest = basicManifest({ includeSecondTask: true, taskDependsOn: ["T-002"] });
    manifest.crossTaskEdges.push(
      {
        from: { canvasId: "runtime", taskId: "T-002" },
        to: { canvasId: "desktop", taskId: "T-001" },
        type: "depends_on"
      },
      {
        from: { canvasId: "desktop", taskId: "T-001" },
        to: { canvasId: "runtime", taskId: "T-001" },
        type: "depends_on"
      }
    );

    const loaded = await createTwoCanvasProject(manifest);
    await writeJsonFile(loaded.workspace.manifestFile, runtimeManifest);
    const graph = await compileProjectGraph(loaded);

    expect(codes(graph)).toContain("project_task_depends_on_cycle");
  });

  it("indexes cross-task dependencies with structured task refs", async () => {
    const manifest = projectGraph();
    manifest.crossTaskEdges.push({
      from: { canvasId: "desktop", taskId: "T-001" },
      to: { canvasId: "runtime", taskId: "T-001" },
      type: "depends_on"
    });

    const loaded = await createTwoCanvasProject(manifest);
    const graph = await compileProjectGraph(loaded);

    expect(graph.crossTaskDependencies({ canvasId: "desktop", taskId: "T-001" })).toEqual([{ canvasId: "runtime", taskId: "T-001" }]);
    expect(graph.taskDependencies({ canvasId: "desktop", taskId: "T-001" })).toEqual([{ canvasId: "runtime", taskId: "T-001" }]);
  });
});

describe("project graph loader", () => {
  it("reads formal project-graph.json and canvas manifests", async () => {
    const { root, init } = await createTestWorkspace();
    const graphManifest = projectGraph();
    graphManifest.canvases = [graphManifest.canvases[0]];
    await writeJsonFile(projectGraphPath(init.workspace), graphManifest);

    const loaded = await loadProjectGraph(root);
    const graph = await compileProjectGraph(loaded);

    expect(loaded.source).toBe("project_graph");
    expect(loaded.diagnostics).toEqual([]);
    expect(graph.diagnostics).toEqual({ errors: [], warnings: [] });
    expect(graph.canvasIdsInOrder).toEqual(["runtime"]);
    expect(graph.taskRefsInProjectOrder).toEqual([{ canvasId: "runtime", taskId: "T-001" }]);
  });

  it("derives a legacy graph from desktop/canvases.json with a warning", async () => {
    const { root } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Second canvas" });

    const loaded = await loadProjectGraph(root);

    expect(loaded.source).toBe("legacy_registry");
    expect(loaded.diagnostics.map((warning) => warning.code)).toContain("project_graph_missing_legacy_registry_used");
    expect(loaded.manifest.canvases.map((canvas) => canvas.id)).toEqual(["default", secondCanvas.canvasId]);
  });

  it("derives a default canvas graph when no formal graph or legacy registry exists", async () => {
    const { root } = await createTestWorkspace();

    const loaded = await loadProjectGraph(root);

    expect(loaded.source).toBe("legacy_default_canvas");
    expect(loaded.diagnostics.map((warning) => warning.code)).toContain("project_graph_missing_default_canvas_used");
    expect(loaded.manifest.canvases.map((canvas) => canvas.id)).toEqual(["default"]);
  });

  it("resolves legacy canvas workspaces and validates missing manifests as diagnostics", async () => {
    const { root, init } = await createTestWorkspace();
    const registry = {
      version: "desktop-canvases/v1",
      canvases: [
        {
          canvasId: "broken",
          name: "Broken",
          packageDir: "canvases/broken/package",
          stateFile: "canvases/broken/state.json",
          resultsDir: "canvases/broken/results",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString()
        }
      ]
    };
    await writeJsonFile(join(init.workspace.workspaceRoot, "desktop", "canvases.json"), registry);

    const loaded = await loadProjectGraph(root);
    const graph = await compileProjectGraph(loaded);

    expect(loaded.source).toBe("legacy_registry");
    expect(graph.diagnostics.errors.map((error) => error.code)).toContain("project_canvas_manifest_read_failed");
  });

  it("can compile a formal two-canvas graph from disk", async () => {
    const { root, init } = await createTestWorkspace();
    const manifest = projectGraph();
    const desktopPackageDir = join(init.workspace.workspaceRoot, "canvases", "desktop", "package");
    const desktopManifest: PlanPackageManifest = basicManifest({ includeSecondTask: true });
    await writeJsonFile(join(desktopPackageDir, "manifest.json"), desktopManifest);
    await writePromptFiles(desktopPackageDir, desktopManifest);
    await writeJsonFile(projectGraphPath(init.workspace), manifest);

    const loaded = await loadProjectGraph(root);
    const graph = await compileProjectGraph(loaded);

    expect(graph.diagnostics.errors).toEqual([]);
    expect(graph.taskRefsInProjectOrder).toEqual([
      { canvasId: "runtime", taskId: "T-001" },
      { canvasId: "desktop", taskId: "T-001" },
      { canvasId: "desktop", taskId: "T-002" }
    ]);
  });

  it("rejects invalid project-graph.json schema", async () => {
    const { root, init } = await createTestWorkspace();
    await writeJsonFile(projectGraphPath(init.workspace), { version: "plan-project/v1", canvases: [] });

    await expect(loadProjectGraph(root)).rejects.toThrow();
  });
});
