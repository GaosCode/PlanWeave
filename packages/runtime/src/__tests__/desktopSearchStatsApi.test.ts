import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTaskCanvas,
  getDesktopProjectSnapshot,
  getGraphViewModel,
  getProjectExecutionPlan,
  getStatistics,
  getStatisticsProjection,
  getTodoGroups,
  resolveTaskCanvasWorkspace,
  searchProject,
  searchProjectWithDiagnostics
} from "../desktop/index.js";
import { mapProjectTaskCanvases } from "../desktop/graph/projectCanvasAggregation.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { canonicalProjectCanvasNode, writeProjectGraph } from "../projectGraph/index.js";
import { runAutoRunStep } from "../taskManager/autoRun.js";
import {
  claimNext,
  getExecutionStatus,
  submitBlockResult,
  submitReviewResult
} from "../taskManager/index.js";
import type { PlanPackageManifest } from "../types.js";
import {
  maxIndexedResultFileBytes,
  maxIndexedResultTotalBodyBytes
} from "../desktop/graph/resultsFileIndex.js";
import {
  basicManifest,
  createTestWorkspace,
  writePromptFiles,
  writeReport,
  writeReviewResult
} from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

function sizedBody(needle: string, size: number): string {
  if (needle.length > size) {
    throw new Error("Needle exceeds requested body size.");
  }
  return needle + " ".repeat(size - needle.length);
}

describe("desktop search and statistics API", () => {
  it("maps project task canvases in registry order including empty canvases", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Empty follow-up canvas" });

    const seen = await mapProjectTaskCanvases(
      root,
      async ({ canvasId, canvasName, workspace }) => ({
        canvasId,
        canvasName,
        manifestFile: workspace.manifestFile
      })
    );

    expect(seen).toEqual([
      {
        canvasId: "default",
        canvasName: "Test Plan",
        manifestFile: init.workspace.manifestFile
      },
      expect.objectContaining({
        canvasId: secondCanvas.canvasId,
        canvasName: "Empty follow-up canvas"
      })
    ]);
  });

  it("derives todo, statistics, and search from runtime/package sources", async () => {
    const { root, init } = await createTestWorkspace(
      basicManifest({ includeSecondTask: true, taskDependsOn: ["T-002"] })
    );
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const firstTask = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (firstTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    firstTask.blocks[0] = { ...firstTask.blocks[0], executor: "codex-auto" };
    await writeJsonFile(init.workspace.manifestFile, manifest);

    const todo = await getTodoGroups(root);
    expect(todo.ready.map((item) => item.ref)).toEqual(["T-002#B-001"]);
    expect(todo.planned.find((item) => item.ref === "T-001#B-001")?.dependencyBlockers).toEqual([
      "T-002"
    ]);

    const stats = await getStatistics(root);
    expect(stats.taskTotal).toBe(2);
    expect(stats.estimatedRemainingBlocks).toBe(4);
    expect(stats).toMatchObject({
      taskThroughput: 0,
      implementedRatio: 0,
      averageImplementationTimeMs: null,
      reviewPassedRatio: 0,
      reworkCount: 0
    });

    const search = await searchProject(root, "T-001 task prompt");
    expect(search).toContainEqual(expect.objectContaining({ kind: "prompt", ref: "T-001" }));
    await expect(searchProject(root, "T-001 task prompt", { kinds: ["prompt"] })).resolves.toEqual([
      expect.objectContaining({ kind: "prompt", ref: "T-001", targetRef: "T-001" })
    ]);
    await expect(searchProject(root, "T-001 task prompt", { kinds: ["task"] })).resolves.toEqual(
      []
    );

    const graph = await getGraphViewModel(root);
    expect(graph.tasks.find((task) => task.taskId === "T-001")?.executorLabel).toBe("Mixed");
  });

  it("reports missing results directories through snapshot diagnostics without changing statistics shape", async () => {
    const { root, init } = await createTestWorkspace();
    await rm(init.workspace.resultsDir, { recursive: true, force: true });

    const snapshot = await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });

    expect(snapshot.statistics).toMatchObject({
      taskTotal: 1,
      averageImplementationTimeMs: null
    });
    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "desktop_results_read_failed", path: "results" })
      ])
    );
    expect(snapshot.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("results: Result files could not be listed")])
    );
  });

  it("refreshes cached desktop projection diagnostics after results directory becomes unreadable", async () => {
    const { root, init } = await createTestWorkspace();

    await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });
    await rm(init.workspace.resultsDir, { recursive: true, force: true });

    const snapshot = await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });

    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "desktop_results_read_failed", path: "results" })
      ])
    );
    expect(snapshot.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("results: Result files could not be listed")])
    );
  });

  it("reports search result file listing failures through public diagnostics without changing search results", async () => {
    const { root, init } = await createTestWorkspace();
    await rm(init.workspace.resultsDir, { recursive: true, force: true });

    await expect(searchProject(root, "T-001 task prompt", { kinds: ["prompt"] })).resolves.toEqual([
      expect.objectContaining({ kind: "prompt", ref: "T-001", targetRef: "T-001" })
    ]);
    const projection = await searchProjectWithDiagnostics(root, "T-001 task prompt", {
      kinds: ["prompt"]
    });

    expect(projection.results).toEqual([
      expect.objectContaining({ kind: "prompt", ref: "T-001", targetRef: "T-001" })
    ]);
    expect(projection.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "desktop_results_read_failed", path: "results" })
      ])
    );
  });

  it("reports malformed result metadata through snapshot diagnostics", async () => {
    const { root, init } = await createTestWorkspace();
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-BAD");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "metadata.json"), "{", "utf8");

    const snapshot = await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });
    const statisticsProjection = await getStatisticsProjection(root);

    expect(snapshot.statistics).toMatchObject({
      taskTotal: 1,
      averageImplementationTimeMs: null
    });
    expect(statisticsProjection.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "desktop_result_metadata_read_failed",
          path: "results/T-001/blocks/B-001/runs/RUN-BAD/metadata.json"
        })
      ])
    );
    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "desktop_result_metadata_read_failed",
          path: "results/T-001/blocks/B-001/runs/RUN-BAD/metadata.json"
        })
      ])
    );
    expect(snapshot.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "results/T-001/blocks/B-001/runs/RUN-BAD/metadata.json: Result metadata could not be read or parsed"
        )
      ])
    );
  });

  it("reports schema-invalid present result metadata as diagnostics, not empty trusted history", async () => {
    const { root, init } = await createTestWorkspace();
    const runDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-SCHEMA-BAD"
    );
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "metadata.json"),
      JSON.stringify({
        ref: 1,
        startedAt: "2026-05-25T00:00:00.000Z",
        finishedAt: "2026-05-25T01:00:00.000Z"
      }),
      "utf8"
    );

    const projection = await getStatisticsProjection(root);

    expect(projection.statistics.averageImplementationTimeMs).toBeNull();
    expect(projection.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "desktop_result_metadata_invalid",
          path: "results/T-001/blocks/B-001/runs/RUN-SCHEMA-BAD/metadata.json",
          message: expect.stringMatching(/Implementation run metadata .* is invalid/)
        })
      ])
    );
  });

  it("reports empty and oversized result metadata through statistics diagnostics", async () => {
    const { root, init } = await createTestWorkspace();
    const emptyRunDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-EMPTY"
    );
    const oversizedRunDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-OVERSIZED"
    );
    await mkdir(emptyRunDir, { recursive: true });
    await mkdir(oversizedRunDir, { recursive: true });
    await writeFile(join(emptyRunDir, "metadata.json"), "", "utf8");
    await writeFile(
      join(oversizedRunDir, "metadata.json"),
      " ".repeat(maxIndexedResultFileBytes + 1),
      "utf8"
    );

    const projection = await getStatisticsProjection(root);

    expect(projection.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "desktop_result_metadata_read_failed",
          path: "results/T-001/blocks/B-001/runs/RUN-EMPTY/metadata.json"
        }),
        expect.objectContaining({
          code: "desktop_result_metadata_read_failed",
          path: "results/T-001/blocks/B-001/runs/RUN-OVERSIZED/metadata.json"
        })
      ])
    );
  });

  it("reports result index byte limits through snapshot diagnostics without changing statistics shape", async () => {
    const { root, init } = await createTestWorkspace();
    const limitedDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-SNAPSHOT-LIMIT"
    );
    await mkdir(limitedDir, { recursive: true });

    const bodySize = 250_000;
    const indexedFileCount = Math.floor(maxIndexedResultTotalBodyBytes / bodySize);
    const skippedReport = join(limitedDir, "0000-skipped.md");
    await writeFile(skippedReport, sizedBody("snapshot skipped result needle\n", bodySize), "utf8");
    await utimes(skippedReport, new Date(1_000), new Date(1_000));

    for (let index = 0; index < indexedFileCount; index += 1) {
      const path = join(limitedDir, `${String(index + 1).padStart(4, "0")}-indexed.md`);
      await writeFile(path, sizedBody(`snapshot indexed result ${index}\n`, bodySize), "utf8");
      await utimes(path, new Date(2_000 + index), new Date(2_000 + index));
    }

    const snapshot = await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });
    const statisticsProjection = await getStatisticsProjection(root);

    expect(snapshot.statistics).toMatchObject({
      taskTotal: 1,
      averageImplementationTimeMs: null
    });
    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "desktop_results_index_byte_limit_exceeded",
          path: "results",
          message: expect.stringContaining(`limit=${maxIndexedResultTotalBodyBytes}`)
        })
      ])
    );
    expect(snapshot.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("results: Results index body byte limit exceeded")
      ])
    );
    expect(statisticsProjection.statistics).toMatchObject({
      taskTotal: 1,
      averageImplementationTimeMs: null
    });
    expect(statisticsProjection.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "desktop_results_index_byte_limit_exceeded",
          path: "results"
        })
      ])
    );
  });

  it("refreshes cached desktop projection after task manager result and state writes", async () => {
    const { root } = await createTestWorkspace();

    await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });
    await searchProjectWithDiagnostics(root, "cache invalidation marker");
    await getStatisticsProjection(root);
    await claimNext({ projectRoot: root });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(
        root,
        "cache-invalidation-report.md",
        "cache invalidation marker\n"
      )
    });

    const snapshot = await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });
    const search = await searchProjectWithDiagnostics(root, "cache invalidation marker");

    expect(snapshot.todoGroups?.completed).toEqual([
      expect.objectContaining({ ref: "T-001#B-001" })
    ]);
    expect(search.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "run_record",
          ref: "T-001/blocks/B-001/runs/RUN-001/report.md"
        })
      ])
    );
  });

  it("refreshes cached desktop projection after external prompt file edits", async () => {
    const { root, init } = await createTestWorkspace();

    await searchProjectWithDiagnostics(root, "external prompt cache marker");
    await writeFile(
      join(init.workspace.packageDir, "nodes", "T-001", "prompt.md"),
      "# Edited prompt\n\nexternal prompt cache marker\n",
      "utf8"
    );

    const search = await searchProjectWithDiagnostics(root, "external prompt cache marker", {
      kinds: ["prompt"]
    });

    expect(search.results).toEqual([
      expect.objectContaining({
        kind: "prompt",
        ref: "T-001",
        targetRef: "T-001"
      })
    ]);
  });

  it("searches only the requested task canvas when canvasId is filtered", async () => {
    const { root } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Search-only canvas" });
    const secondWorkspace = await resolveTaskCanvasWorkspace(root, secondCanvas.canvasId);
    const secondManifest = basicManifest();
    const firstTask = secondManifest.nodes.find(
      (node) => node.type === "task" && node.id === "T-001"
    );
    if (firstTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    firstTask.title = "Unique downstream task";
    await writeJsonFile(secondWorkspace.manifestFile, secondManifest);
    await writePromptFiles(secondWorkspace.packageDir, secondManifest);

    await expect(
      searchProject(root, "Unique downstream task", { canvasId: "default" })
    ).resolves.toEqual([]);
    await expect(
      searchProject(root, "Unique downstream task", { canvasId: secondCanvas.canvasId })
    ).resolves.toEqual([
      expect.objectContaining({
        canvasId: secondCanvas.canvasId,
        canvasName: "Search-only canvas",
        kind: "task",
        ref: "T-001"
      })
    ]);
    await expect(searchProject(root, "Unique downstream task")).resolves.toEqual([
      expect.objectContaining({
        canvasId: secondCanvas.canvasId,
        canvasName: "Search-only canvas",
        kind: "task",
        ref: "T-001"
      })
    ]);
  });

  it("summarizes canvas phases and ready queues in registry order", async () => {
    const { root } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Follow-up canvas" });
    const secondWorkspace = await resolveTaskCanvasWorkspace(root, secondCanvas.canvasId);
    await writeJsonFile(secondWorkspace.manifestFile, basicManifest());
    await writePromptFiles(secondWorkspace.packageDir, basicManifest());

    const plan = await getProjectExecutionPlan(root);

    expect(
      plan.phases.map((phase) => ({
        phaseIndex: phase.phaseIndex,
        canvasId: phase.canvasId,
        canvasName: phase.canvasName
      }))
    ).toEqual([
      { phaseIndex: 1, canvasId: "default", canvasName: "Test Plan" },
      { phaseIndex: 2, canvasId: secondCanvas.canvasId, canvasName: "Follow-up canvas" }
    ]);
    expect(plan.phases[0].readyQueue.map((item) => item.ref)).toEqual(["T-001#B-001"]);
    expect(plan.phases[1].readyQueue).toEqual([
      expect.objectContaining({
        canvasId: secondCanvas.canvasId,
        ref: "T-001#B-001",
        dispatchable: true
      })
    ]);
    expect(plan.readyQueue.map((item) => `${item.canvasId}:${item.ref}`)).toEqual([
      "default:T-001#B-001",
      `${secondCanvas.canvasId}:T-001#B-001`
    ]);
    expect(plan.notes).toContain(
      "Project graph dependencies gate ready queues; canvases without upstream blockers may run in parallel."
    );
  });

  it("orders project execution phases by project graph blockers", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Dependent canvas" });
    const secondWorkspace = await resolveTaskCanvasWorkspace(root, secondCanvas.canvasId);
    await writeJsonFile(secondWorkspace.manifestFile, basicManifest());
    await writePromptFiles(secondWorkspace.packageDir, basicManifest());
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        {
          id: secondCanvas.canvasId,
          type: "canvas",
          title: "Dependent canvas",
          packageDir: `canvases/${secondCanvas.canvasId}/package`,
          stateFile: `canvases/${secondCanvas.canvasId}/state.json`,
          resultsDir: `canvases/${secondCanvas.canvasId}/results`
        },
        canonicalProjectCanvasNode({ id: "default", title: "Test Plan" })
      ],
      edges: [{ from: secondCanvas.canvasId, to: "default", type: "depends_on" }],
      crossTaskEdges: []
    });

    const plan = await getProjectExecutionPlan(root);
    const todo = await getTodoGroups(root);

    expect(plan.phases.map((phase) => phase.canvasId)).toEqual(["default", secondCanvas.canvasId]);
    expect(plan.phases[0].readyQueue.map((item) => item.ref)).toEqual(["T-001#B-001"]);
    expect(plan.phases[1].readyQueue).toEqual([]);
    expect(plan.phases[1].blockedCount).toBe(1);
    expect(plan.readyQueue.map((item) => `${item.canvasId}:${item.ref}`)).toEqual([
      "default:T-001#B-001"
    ]);
    expect(todo.ready.map((item) => `${item.canvasId}:${item.ref}`)).toEqual([
      "default:T-001#B-001"
    ]);
    expect(
      todo.planned.find(
        (item) => item.canvasId === secondCanvas.canvasId && item.ref === "T-001#B-001"
      )?.dependencyBlockers
    ).toEqual(["canvas:default"]);
    const downstreamStatus = await getExecutionStatus({ projectRoot: secondWorkspace });
    const downstreamHint = downstreamStatus.claimHints.find((hint) => hint.ref === "T-001#B-001");
    expect(downstreamStatus.nextClaimable).toEqual([]);
    expect(downstreamHint).toMatchObject({
      ready: false,
      statusReason: expect.stringContaining("canvas:default"),
      recommendedCommand: null,
      dispatchable: false,
      dispatchCommand: null
    });
    await expect(claimNext({ projectRoot: secondWorkspace })).resolves.toMatchObject({
      kind: "blocked",
      ref: "T-001#B-001",
      reason: expect.stringContaining("canvas:default")
    });
    await expect(runAutoRunStep({ projectRoot: secondWorkspace })).resolves.toMatchObject({
      kind: "blocked",
      claim: {
        kind: "blocked",
        ref: "T-001#B-001",
        reason: expect.stringContaining("canvas:default")
      }
    });
  });

  it("keeps explicit cross-task blockers distinct from canvas-level blockers", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Cross-task dependent canvas" });
    const secondWorkspace = await resolveTaskCanvasWorkspace(root, secondCanvas.canvasId);
    await writeJsonFile(secondWorkspace.manifestFile, basicManifest());
    await writePromptFiles(secondWorkspace.packageDir, basicManifest());
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Test Plan" }),
        {
          id: secondCanvas.canvasId,
          type: "canvas",
          title: "Cross-task dependent canvas",
          packageDir: `canvases/${secondCanvas.canvasId}/package`,
          stateFile: `canvases/${secondCanvas.canvasId}/state.json`,
          resultsDir: `canvases/${secondCanvas.canvasId}/results`
        }
      ],
      edges: [],
      crossTaskEdges: [
        {
          from: { canvasId: secondCanvas.canvasId, taskId: "T-001" },
          to: { canvasId: "default", taskId: "T-001" },
          type: "depends_on"
        }
      ]
    });

    const todo = await getTodoGroups(root);

    expect(todo.ready.map((item) => `${item.canvasId}:${item.ref}`)).toEqual([
      "default:T-001#B-001"
    ]);
    expect(
      todo.planned.find(
        (item) => item.canvasId === secondCanvas.canvasId && item.ref === "T-001#B-001"
      )?.dependencyBlockers
    ).toEqual(["default:T-001"]);
  });

  it("blocks open feedback claims when project graph upstream blockers are incomplete", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Feedback dependent canvas" });
    const secondWorkspace = await resolveTaskCanvasWorkspace(root, secondCanvas.canvasId);
    await writeJsonFile(secondWorkspace.manifestFile, basicManifest());
    await writePromptFiles(secondWorkspace.packageDir, basicManifest());
    await claimNext({ projectRoot: secondWorkspace });
    await submitBlockResult({
      projectRoot: secondWorkspace,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "downstream-report.md")
    });
    await claimNext({ projectRoot: secondWorkspace });
    await submitReviewResult({
      projectRoot: secondWorkspace,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Fix downstream work.")
    });
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Test Plan" }),
        {
          id: secondCanvas.canvasId,
          type: "canvas",
          title: "Feedback dependent canvas",
          packageDir: `canvases/${secondCanvas.canvasId}/package`,
          stateFile: `canvases/${secondCanvas.canvasId}/state.json`,
          resultsDir: `canvases/${secondCanvas.canvasId}/results`
        }
      ],
      edges: [{ from: secondCanvas.canvasId, to: "default", type: "depends_on" }],
      crossTaskEdges: []
    });

    await expect(claimNext({ projectRoot: secondWorkspace })).resolves.toMatchObject({
      kind: "blocked",
      ref: "T-001#R-001",
      reason: expect.stringContaining("canvas:default")
    });
    await expect(runAutoRunStep({ projectRoot: secondWorkspace })).resolves.toMatchObject({
      kind: "blocked",
      claim: {
        kind: "blocked",
        ref: "T-001#R-001",
        reason: expect.stringContaining("canvas:default")
      }
    });
  });

  it("groups blocks under implemented once their task is implemented", async () => {
    const { root } = await createTestWorkspace();

    await claimNext({ projectRoot: root });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "implemented-b.md")
    });
    await claimNext({ projectRoot: root });
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "passed", "ready to ship")
    });

    const todo = await getTodoGroups(root);
    expect(todo.implemented.map((item) => item.ref)).toEqual(["T-001#B-001", "T-001#R-001"]);
    expect(todo.completed).toEqual([]);
  });

  it("keeps project aggregations available when one canvas contains a removed check block", async () => {
    const { root } = await createTestWorkspace();
    const brokenCanvas = await createTaskCanvas(root, { name: "Broken imported canvas" });
    const brokenWorkspace = await resolveTaskCanvasWorkspace(root, brokenCanvas.canvasId);
    const invalidManifest = basicManifest() as unknown as {
      nodes: Array<{ blocks: Array<Record<string, unknown>> }>;
    };
    invalidManifest.nodes[0].blocks[0].type = "check";
    await writeJsonFile(brokenWorkspace.manifestFile, invalidManifest);

    await expect(getStatistics(root)).resolves.toMatchObject({ taskTotal: 1, blockTotal: 2 });
    await expect(getStatisticsProjection(root)).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "desktop_canvas_execution_snapshot_failed",
          path: brokenCanvas.canvasId
        })
      ])
    });
    await expect(getTodoGroups(root)).resolves.toMatchObject({
      planned: expect.arrayContaining([
        expect.objectContaining({
          canvasId: "default",
          ref: "T-001#B-001",
          dependencyBlockers: [expect.stringContaining("Project graph is invalid")]
        })
      ])
    });
    await expect(searchProject(root, "T-001 task prompt", { kinds: ["prompt"] })).resolves.toEqual([
      expect.objectContaining({ canvasId: "default", ref: "T-001" })
    ]);
  });
});
