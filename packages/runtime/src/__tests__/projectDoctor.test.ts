import { access, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonFile, writeJsonFile } from "../json.js";
import {
  canonicalProjectCanvasNode,
  projectGraphPath,
  projectCanvasWorkspace
} from "../projectGraph/index.js";
import { DEFAULT_CANVAS_WORKSPACE_STALE_THRESHOLD_MS } from "../projectGraph/canvasWorkspaceRecovery.js";
import { runProjectDoctor } from "../taskManager/index.js";
import type { ProjectGraphManifest } from "../projectGraph/index.js";
import type { PlanPackageManifest, RuntimeState } from "../types.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

function singleCanvasProjectGraph(canvasId = "default"): ProjectGraphManifest {
  return {
    version: "plan-project/v1",
    canvases: [
      canonicalProjectCanvasNode({
        id: canvasId,
        title: canvasId === "default" ? "Default" : "Runtime"
      })
    ],
    edges: [],
    crossTaskEdges: []
  };
}

function twoCanvasProjectGraph(): ProjectGraphManifest {
  return {
    version: "plan-project/v1",
    canvases: [
      ...singleCanvasProjectGraph().canvases,
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

async function createTwoCanvasProject(): Promise<
  Awaited<ReturnType<typeof createTestWorkspace>> & {
    graph: ProjectGraphManifest;
    desktopManifest: PlanPackageManifest;
  }
> {
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

async function ageCanvasRecoveryDirectory(path: string): Promise<void> {
  const staleDate = new Date(Date.now() - DEFAULT_CANVAS_WORKSPACE_STALE_THRESHOLD_MS - 10_000);
  await utimes(path, staleDate, staleDate);
}

describe("runProjectDoctor", () => {
  it("reports project graph diagnostics", async () => {
    const { root, init } = await createTestWorkspace();
    const graph = singleCanvasProjectGraph();
    graph.edges.push({ from: "default", to: "missing", type: "depends_on" });
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
    await writeJsonFile(projectGraphPath(init.workspace), singleCanvasProjectGraph());
    await rm(join(init.workspace.packageDir, "nodes", "T-001", "prompt.md"));

    const report = await runProjectDoctor({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.canvasReports).toEqual([
      expect.objectContaining({
        canvasId: "default",
        errors: expect.arrayContaining([
          expect.objectContaining({
            code: "prompt_missing",
            canvasId: "default",
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
    await writeJsonFile(projectGraphPath(init.workspace), singleCanvasProjectGraph());
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
          canvasId: "default",
          source: "canvas_doctor",
          path: "state.json:currentRefs"
        })
      ])
    );
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "orphan_state",
          canvasId: "default",
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
    const { root, init } = await createTestWorkspace();
    await rm(projectGraphPath(init.workspace));

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

  it("reports canvas workspace recovery anomalies and repairs orphan and staging directories conservatively", async () => {
    const { root, init } = await createTestWorkspace();
    const orphanRoot = join(init.workspace.workspaceRoot, "canvases", "orphaned-canvas");
    const stagingRoot = join(
      init.workspace.workspaceRoot,
      "desktop",
      "canvas-staging",
      "stale-create"
    );
    const quarantineRoot = join(
      init.workspace.workspaceRoot,
      "desktop",
      "canvas-quarantine",
      "deleted-canvas"
    );
    await mkdir(join(orphanRoot, "package"), { recursive: true });
    await writeJsonFile(join(orphanRoot, "package", "manifest.json"), basicManifest());
    await writeJsonFile(join(orphanRoot, "state.json"), {
      currentRefs: [],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {},
      feedback: {}
    });
    await mkdir(join(stagingRoot, "package"), { recursive: true });
    await writeFile(join(stagingRoot, "package", "manifest.json"), "{}", "utf8");
    await mkdir(join(quarantineRoot, "package"), { recursive: true });
    await writeFile(join(quarantineRoot, "package", "manifest.json"), "{}", "utf8");
    await ageCanvasRecoveryDirectory(stagingRoot);
    await ageCanvasRecoveryDirectory(quarantineRoot);

    const report = await runProjectDoctor({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "orphan_canvas_directory",
          source: "project_graph",
          path: "canvases/orphaned-canvas"
        }),
        expect.objectContaining({
          code: "stale_canvas_staging_directory",
          source: "project_graph",
          path: "desktop/canvas-staging/stale-create"
        })
      ])
    );
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "stale_canvas_quarantine_directory",
          source: "project_graph",
          path: "desktop/canvas-quarantine/deleted-canvas"
        })
      ])
    );

    const repaired = await runProjectDoctor({ projectRoot: root, repair: true });

    expect(repaired.ok).toBe(true);
    expect(repaired.repaired).toBe(true);
    expect(repaired.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "orphan_canvas_directory", repaired: true }),
        expect.objectContaining({ code: "stale_canvas_staging_directory", repaired: true })
      ])
    );
    await expect(access(orphanRoot)).rejects.toThrow();
    await expect(access(stagingRoot)).rejects.toThrow();
  });

  it("does not report fresh canvas recovery directories as stale or delete fresh staging during repair", async () => {
    const { root, init } = await createTestWorkspace();
    const orphanRoot = join(init.workspace.workspaceRoot, "canvases", "orphaned-canvas");
    const stagingRoot = join(
      init.workspace.workspaceRoot,
      "desktop",
      "canvas-staging",
      "fresh-create"
    );
    const quarantineRoot = join(
      init.workspace.workspaceRoot,
      "desktop",
      "canvas-quarantine",
      "fresh-delete"
    );
    await mkdir(join(orphanRoot, "package"), { recursive: true });
    await writeJsonFile(join(orphanRoot, "package", "manifest.json"), basicManifest());
    await mkdir(join(orphanRoot, "results"), { recursive: true });
    await mkdir(join(stagingRoot, "package"), { recursive: true });
    await writeFile(join(stagingRoot, "package", "manifest.json"), "{}", "utf8");
    await mkdir(join(quarantineRoot, "package"), { recursive: true });
    await writeFile(join(quarantineRoot, "package", "manifest.json"), "{}", "utf8");

    const report = await runProjectDoctor({ projectRoot: root, repair: true });

    expect(report.ok).toBe(true);
    expect(report.repaired).toBe(true);
    expect(report.errors).toEqual([
      expect.objectContaining({ code: "orphan_canvas_directory", repaired: true })
    ]);
    expect(report.errors.some((issue) => issue.code === "stale_canvas_staging_directory")).toBe(
      false
    );
    expect(
      report.warnings.some((issue) => issue.code === "stale_canvas_quarantine_directory")
    ).toBe(false);
    await expect(access(orphanRoot)).rejects.toThrow();
    await expect(access(stagingRoot)).resolves.toBeUndefined();
    await expect(access(quarantineRoot)).resolves.toBeUndefined();
  });

  it("warns without moving unregistered non-canvas directories during recovery repair", async () => {
    const { root, init } = await createTestWorkspace();
    const userDirectory = join(init.workspace.workspaceRoot, "canvases", "user-notes");
    const invalidCanvasDirectory = join(init.workspace.workspaceRoot, "canvases", "invalid-canvas");
    await mkdir(userDirectory, { recursive: true });
    await writeFile(join(userDirectory, "notes.md"), "not a canvas workspace\n", "utf8");
    await mkdir(join(invalidCanvasDirectory, "package"), { recursive: true });
    await writeFile(join(invalidCanvasDirectory, "package", "manifest.json"), "{}", "utf8");

    const report = await runProjectDoctor({ projectRoot: root, repair: true });

    expect(report.errors.some((issue) => issue.code === "orphan_canvas_directory")).toBe(false);
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unrecognized_orphan_canvas_directory",
          path: "canvases/user-notes"
        }),
        expect.objectContaining({
          code: "unrecognized_orphan_canvas_directory",
          path: "canvases/invalid-canvas"
        })
      ])
    );
    await expect(access(userDirectory)).resolves.toBeUndefined();
    await expect(access(invalidCanvasDirectory)).resolves.toBeUndefined();
  });

  it("reports formal project graph entries whose canvas workspace is missing", async () => {
    const { root, init } = await createTestWorkspace();
    await writeJsonFile(projectGraphPath(init.workspace), twoCanvasProjectGraph());

    const report = await runProjectDoctor({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.canvasReports.find((canvas) => canvas.canvasId === "desktop")).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: "canvas_graph_entry_missing_workspace",
          canvasId: "desktop",
          source: "project_graph",
          path: "project-graph.json:canvases.1"
        })
      ])
    });
  });

  it("reports legacy registry entries whose canvas workspace is missing", async () => {
    const { root, init } = await createTestWorkspace();
    await rm(projectGraphPath(init.workspace));
    await writeJsonFile(join(init.workspace.workspaceRoot, "desktop", "canvases.json"), {
      version: "desktop-canvases/v1",
      canvases: [
        {
          canvasId: "default",
          name: "Test Plan",
          packageDir: "package",
          stateFile: "state.json",
          resultsDir: "results",
          createdAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:00:00.000Z"
        },
        {
          canvasId: "ghost",
          name: "Ghost",
          packageDir: "canvases/ghost/package",
          stateFile: "canvases/ghost/state.json",
          resultsDir: "canvases/ghost/results",
          createdAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:00:00.000Z"
        }
      ]
    });

    const report = await runProjectDoctor({ projectRoot: root });

    expect(report.ok).toBe(false);
    expect(report.canvasReports.find((canvas) => canvas.canvasId === "ghost")).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: "canvas_registry_entry_missing_workspace",
          canvasId: "ghost",
          source: "project_graph",
          path: "desktop/canvases.json:canvases.1"
        })
      ])
    });
  });
});
