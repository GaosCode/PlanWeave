import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskCanvas, listTaskCanvases, resolveTaskCanvasWorkspace } from "../desktop/index.js";
import { writeJsonFile } from "../json.js";
import { projectGraphManifestSchema } from "../projectGraph/schema.js";
import { loadProjectGraph, projectGraphPath, writeProjectGraph } from "../projectGraph/loadProjectGraph.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("project graph schema", () => {
  it("parses the project-level canvas graph contract", () => {
    expect(
      projectGraphManifestSchema.parse({
        version: "plan-project/v1",
        canvases: [
          {
            id: "default",
            type: "canvas",
            title: "Default plan",
            packageDir: "package",
            stateFile: "state.json",
            resultsDir: "results"
          }
        ],
        edges: [],
        crossTaskEdges: []
      })
    ).toMatchObject({ version: "plan-project/v1" });
  });

  it("derives a legacy project graph when project-graph.json is missing", async () => {
    const { root } = await createTestWorkspace();
    const second = await createTaskCanvas(root, { name: "Second plan" });

    const loaded = await loadProjectGraph(root);

    expect(loaded.source).toBe("legacy_registry");
    expect(loaded.diagnostics).toEqual([expect.objectContaining({ code: "project_graph_missing_legacy_registry_used" })]);
    expect(loaded.manifest.canvases.map((canvas) => canvas.id)).toEqual(["default", second.canvasId]);
  });

  it("loads a formal project graph when present", async () => {
    const { root, init } = await createTestWorkspace();
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        {
          id: "default",
          type: "canvas",
          title: "Formal default",
          packageDir: "package",
          stateFile: "state.json",
          resultsDir: "results"
        }
      ],
      edges: [],
      crossTaskEdges: []
    });

    const loaded = await loadProjectGraph(root);

    expect(projectGraphPath(init.workspace)).toBe(join(init.workspace.workspaceRoot, "project-graph.json"));
    expect(loaded.source).toBe("project_graph");
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.manifest.canvases[0]?.title).toBe("Formal default");
  });

  it("can reference a second canvas package from project-graph.json", async () => {
    const { root, init } = await createTestWorkspace();
    const canvas = await createTaskCanvas(root, { name: "Explicit second" });
    const workspace = await resolveTaskCanvasWorkspace(root, canvas.canvasId);
    const manifest = basicManifest();
    await writeJsonFile(workspace.manifestFile, manifest);
    await writePromptFiles(workspace.packageDir, manifest);

    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        {
          id: "default",
          type: "canvas",
          title: "Default",
          packageDir: "package",
          stateFile: "state.json",
          resultsDir: "results"
        },
        {
          id: canvas.canvasId,
          type: "canvas",
          title: "Explicit second",
          packageDir: `canvases/${canvas.canvasId}/package`,
          stateFile: `canvases/${canvas.canvasId}/state.json`,
          resultsDir: `canvases/${canvas.canvasId}/results`
        }
      ],
      edges: [],
      crossTaskEdges: []
    });

    await expect(loadProjectGraph(root)).resolves.toMatchObject({
      source: "project_graph",
      manifest: { canvases: expect.arrayContaining([expect.objectContaining({ id: canvas.canvasId })]) }
    });
  });

  it("resolves formal project graph canvases outside the legacy registry", async () => {
    const { root, init } = await createTestWorkspace();
    const packageDir = join(init.workspace.workspaceRoot, "manual-canvas", "package");
    const manifest = basicManifest();
    await writeJsonFile(join(packageDir, "manifest.json"), manifest);
    await writePromptFiles(packageDir, manifest);
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        {
          id: "manual-canvas",
          type: "canvas",
          title: "Manual formal canvas",
          packageDir: "manual-canvas/package",
          stateFile: "manual-canvas/state.json",
          resultsDir: "manual-canvas/results"
        }
      ],
      edges: [],
      crossTaskEdges: []
    });

    const workspace = await resolveTaskCanvasWorkspace(root, "manual-canvas");
    const canvases = await listTaskCanvases(root);

    expect(workspace.packageDir).toBe(packageDir);
    expect(canvases).toEqual([
      expect.objectContaining({
        canvasId: "manual-canvas",
        name: "Manual formal canvas",
        taskCount: 1
      })
    ]);
  });
});
