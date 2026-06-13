import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTaskCanvas, resolveTaskCanvasWorkspace } from "../desktop/index.js";
import { writeJsonFile } from "../json.js";
import { writeProjectGraph } from "../projectGraph/index.js";
import { validatePackage } from "../validatePackage.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

describe("validatePackage", () => {
  it("accepts a complete v1 block-level package", async () => {
    const { root } = await createTestWorkspace();

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("rejects legacy global_prompt and missing block prompt files", async () => {
    const { root, init } = await createTestWorkspace();
    const manifest = { ...basicManifest(), global_prompt: "global-prompt.md" };
    await writeJsonFile(init.workspace.manifestFile, manifest);

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toContain("manifest_schema");
  });

  it("warns about stale prompt files instead of treating them as active contract", async () => {
    const { root, init } = await createTestWorkspace();
    await rm(join(init.workspace.packageDir, "nodes", "T-001", "blocks", "R-001.prompt.md"));

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.code)).toContain("prompt_missing");
  });

  it("validates prompt references inside desktop task canvas packages", async () => {
    const { root } = await createTestWorkspace();
    const canvas = await createTaskCanvas(root, { name: "Canvas missing prompts" });
    const canvasWorkspace = await resolveTaskCanvasWorkspace(root, canvas.canvasId);
    await writeJsonFile(canvasWorkspace.manifestFile, basicManifest());

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "prompt_missing",
          path: expect.stringContaining(`canvases/${canvas.canvasId}/package/nodes/T-001/prompt.md`)
        }),
        expect.objectContaining({
          code: "prompt_missing",
          path: expect.stringContaining(`canvases/${canvas.canvasId}/package/nodes/T-001/blocks/B-001.prompt.md`)
        })
      ])
    );
  });

  it("reports task canvas layout schema diagnostics with the canvas layout path", async () => {
    const { root } = await createTestWorkspace();
    const canvas = await createTaskCanvas(root, { name: "Legacy layout canvas" });
    const canvasWorkspace = await resolveTaskCanvasWorkspace(root, canvas.canvasId);
    const manifest = basicManifest();
    await writeJsonFile(canvasWorkspace.manifestFile, manifest);
    await writePromptFiles(canvasWorkspace.packageDir, manifest);
    await writeJsonFile(join(canvasWorkspace.workspaceRoot, "desktop", "layout.json"), {
      version: 1,
      nodes: {
        "T-001": {
          position: { x: 120, y: 240 }
        }
      }
    });

    const report = await validatePackage({ projectRoot: root });

    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "legacy_layout_schema",
          path: expect.stringContaining(`canvases/${canvas.canvasId}/desktop/layout.json:nodes`)
        })
      ])
    );
  });

  it("reports formal project graph dependency diagnostics", async () => {
    const { root, init } = await createTestWorkspace();
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
        }
      ],
      edges: [{ from: "default", to: "missing-canvas", type: "depends_on" }],
      crossTaskEdges: [
        {
          from: { canvasId: "default", taskId: "T-MISSING" },
          to: { canvasId: "default", taskId: "T-001" },
          type: "depends_on"
        }
      ]
    });

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "project_canvas_edge_to_missing",
          path: "project-graph.json:edges"
        }),
        expect.objectContaining({
          code: "project_cross_task_from_missing",
          path: "project-graph.json:crossTaskEdges"
        })
      ])
    );
  });

  it("validates only canvases referenced by a formal project graph", async () => {
    const { root, init } = await createTestWorkspace();
    await writeJsonFile(init.workspace.manifestFile, { version: "plan-package/v1", nodes: "invalid" });
    const packageDir = join(init.workspace.workspaceRoot, "manual-only", "package");
    const manifest = basicManifest();
    await writeJsonFile(join(packageDir, "manifest.json"), manifest);
    await writePromptFiles(packageDir, manifest);
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        {
          id: "manual-only",
          type: "canvas",
          title: "Manual only",
          packageDir: "manual-only/package",
          stateFile: "manual-only/state.json",
          resultsDir: "manual-only/results"
        }
      ],
      edges: [],
      crossTaskEdges: []
    });

    const report = await validatePackage({ projectRoot: root });

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });
});
