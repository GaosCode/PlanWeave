import { afterEach, describe, expect, it } from "vitest";
import { createTaskCanvas, getGraphViewModel, getStatistics, getTodoGroups, searchProject } from "../desktop/index.js";
import { mapProjectTaskCanvases } from "../desktop/graph/projectCanvasAggregation.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { claimNext, submitBlockResult, submitReviewResult } from "../taskManager/index.js";
import type { PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace, writeReport, writeReviewResult } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("desktop search and statistics API", () => {
  it("maps project task canvases in registry order including empty canvases", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Empty follow-up canvas" });

    const seen = await mapProjectTaskCanvases(root, async ({ canvasId, canvasName, workspace }) => ({
      canvasId,
      canvasName,
      manifestFile: workspace.manifestFile
    }));

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
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true, taskDependsOn: ["T-002"] }));
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const firstTask = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (firstTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    firstTask.blocks[0] = { ...firstTask.blocks[0], executor: "codex-auto" };
    await writeJsonFile(init.workspace.manifestFile, manifest);

    const todo = await getTodoGroups(root);
    expect(todo.ready.map((item) => item.ref)).toEqual(["T-002#B-001"]);
    expect(todo.planned.find((item) => item.ref === "T-001#B-001")?.dependencyBlockers).toEqual(["T-002"]);

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
    await expect(searchProject(root, "T-001 task prompt", { kinds: ["task"] })).resolves.toEqual([]);

    const graph = await getGraphViewModel(root);
    expect(graph.tasks.find((task) => task.taskId === "T-001")?.executorLabel).toBe("Mixed");
  });

  it("groups blocks under implemented once their task is implemented", async () => {
    const { root } = await createTestWorkspace();

    await claimNext({ projectRoot: root });
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "implemented-b.md") });
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
});
