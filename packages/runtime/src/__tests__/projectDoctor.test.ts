import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonFile, writeJsonFile } from "../json.js";
import { projectGraphPath, projectCanvasWorkspace } from "../projectGraph/index.js";
import { runProjectDoctor } from "../taskManager/index.js";
import type { ProjectGraphManifest } from "../projectGraph/index.js";
import type { PlanPackageManifest, RuntimeState } from "../types.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

function singleCanvasProjectGraph(canvasId = "runtime"): ProjectGraphManifest {
  return {
    version: "plan-project/v1",
    canvases: [
      {
        id: canvasId,
        type: "canvas",
        title: "Runtime",
        packageDir: "package",
        stateFile: "state.json",
        resultsDir: "results"
      }
    ],
    edges: [],
    crossTaskEdges: []
  };
}

function twoCanvasProjectGraph(): ProjectGraphManifest {
  return {
    version: "plan-project/v1",
    canvases: [
      ...singleCanvasProjectGraph("runtime").canvases,
      {
        id: "desktop",
        type: "canvas",
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

async function createTwoCanvasProject(): Promise<Awaited<ReturnType<typeof createTestWorkspace>> & {
  graph: ProjectGraphManifest;
  desktopManifest: PlanPackageManifest;
}> {
  const workspace = await createTestWorkspace();
  const graph = twoCanvasProjectGraph();
  const desktopCanvas = graph.canvases.find((canvas) => canvas.id === "desktop");
  if (!desktopCanvas) {
    throw new Error("Test graph is missing desktop canvas.");
  }
  const desktopWorkspace = projectCanvasWorkspace(workspace.init.workspace, desktopCanvas);
  const desktopManifest = basicManifest();
  await writeJsonFile(desktopWorkspace.manifestFile, desktopManifest);
  await writePromptFiles(desktopWorkspace.packageDir, desktopManifest);
  await writeJsonFile(projectGraphPath(workspace.init.workspace), graph);
  return { ...workspace, graph, desktopManifest };
}

describe("runProjectDoctor", () => {
  it("reports project graph diagnostics", async () => {
    const { root, init } = await createTestWorkspace();
    const graph = singleCanvasProjectGraph("runtime");
    graph.edges.push({ from: "runtime", to: "missing", type: "depends_on" });
    await writeJsonFile(projectGraphPath(init.workspace), graph);

    const report = await runProjectDoctor({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "project_canvas_edge_to_missing",
          source: "project_graph",
          path: "project-graph.json:edges"
        })
      ])
    );
  });

  it("reports missing canvas prompts with canvas id and path", async () => {
    const { root, init } = await createTestWorkspace();
    await writeJsonFile(projectGraphPath(init.workspace), singleCanvasProjectGraph("runtime"));
    await rm(join(init.workspace.packageDir, "nodes", "T-001", "prompt.md"));

    const report = await runProjectDoctor({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.canvasReports).toEqual([
      expect.objectContaining({
        canvasId: "runtime",
        errors: expect.arrayContaining([
          expect.objectContaining({
            code: "prompt_missing",
            canvasId: "runtime",
            source: "canvas_package",
            path: "package/nodes/T-001/prompt.md"
          })
        ])
      })
    ]);
  });

  it("reports invalid canvas workspace paths without throwing", async () => {
    const { root, init } = await createTestWorkspace();
    const graph = singleCanvasProjectGraph("escape");
    graph.canvases[0] = {
      ...graph.canvases[0],
      packageDir: "../escape/package"
    };
    await writeJsonFile(projectGraphPath(init.workspace), graph);

    const report = await runProjectDoctor({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.canvasReports).toEqual([
      expect.objectContaining({
        canvasId: "escape",
        ok: false,
        errors: expect.arrayContaining([
          expect.objectContaining({
            code: "canvas_workspace_invalid",
            canvasId: "escape",
            source: "project_graph",
            path: "project-graph.json:canvases.0"
          })
        ])
      })
    ]);
  });

  it("reports state issues with stable state file paths", async () => {
    const { root, init } = await createTestWorkspace();
    await writeJsonFile(projectGraphPath(init.workspace), singleCanvasProjectGraph("runtime"));
    await writeJsonFile(init.workspace.stateFile, {
      currentRefs: ["T-404#B-001"],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {
        "T-OLD#B-001": { status: "completed", lastRunId: null }
      },
      feedback: {}
    });

    const report = await runProjectDoctor({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "stale_current_ref",
          canvasId: "runtime",
          source: "canvas_doctor",
          path: "state.json:currentRefs"
        })
      ])
    );
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "orphan_state",
          canvasId: "runtime",
          source: "canvas_package",
          path: "state.json:blocks.T-OLD#B-001"
        })
      ])
    );
  });

  it("repairs each canvas state/results index drift through package doctor", async () => {
    const { root, init, graph } = await createTwoCanvasProject();
    const desktopCanvas = graph.canvases.find((canvas) => canvas.id === "desktop");
    if (!desktopCanvas) {
      throw new Error("Test graph is missing desktop canvas.");
    }
    const desktopWorkspace = projectCanvasWorkspace(init.workspace, desktopCanvas);
    const runDir = join(desktopWorkspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-002");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.md"), "persisted report\n", "utf8");
    await writeJsonFile(join(runDir, "metadata.json"), {
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-002",
      submittedAt: "2026-05-25T00:00:00.000Z"
    });
    await writeJsonFile(desktopWorkspace.stateFile, {
      currentRefs: ["T-001#B-001"],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {
        "T-001#B-001": { status: "in_progress", lastRunId: null }
      },
      feedback: {}
    });
    await writeJsonFile(join(desktopWorkspace.resultsDir, "T-001", "index.json"), {
      latestRunByBlock: { "T-001#B-001": "RUN-002" },
      counts: { runs: 2 }
    });

    const report = await runProjectDoctor({ projectRoot: root, repair: true });

    expect(report.ok).toBe(true);
    expect(report.repaired).toBe(true);
    expect(report.canvasReports.find((canvas) => canvas.canvasId === "desktop")).toMatchObject({
      ok: true,
      repaired: true,
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: "index_state_mismatch",
          canvasId: "desktop",
          source: "canvas_doctor",
          repaired: true,
          path: "results/T-001/index.json"
        })
      ])
    });
    await expect(readJsonFile<RuntimeState>(desktopWorkspace.stateFile)).resolves.toMatchObject({
      currentRefs: [],
      blocks: {
        "T-001#B-001": {
          status: "completed",
          lastRunId: "RUN-002"
        }
      }
    });
  });

  it("keeps legacy project graph fallback warnings out of ok calculation", async () => {
    const { root } = await createTestWorkspace();

    const report = await runProjectDoctor({ projectRoot: root });

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "project_graph_missing_default_canvas_used",
          source: "project_graph",
          path: "project-graph.json"
        })
      ])
    );
  });
});
