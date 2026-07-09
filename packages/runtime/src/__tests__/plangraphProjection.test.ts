import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAgentClaimMarkdown,
  buildCanvasMapProjection,
  buildReviewProjection,
  buildStatisticsProjection,
  buildTodoProjection,
  createSqlitePlanGraphStore,
  loadPlanGraphPackage
} from "../plangraph/index.js";
import { loadPlanGraphPackageMetadata } from "../plangraph/packageRepository.js";
import { loadProjectTodoContext } from "../desktop/graph/todoModel.js";
import { buildResultsFileIndex } from "../desktop/graph/resultsFileIndex.js";
import { buildExecutionStatus } from "../taskManager/executionStatus.js";
import { renderPrompt } from "../taskManager/index.js";
import { loadRuntime } from "../taskManager/runtimeContext.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

describe("PlanGraph projections", () => {
  it("builds todo and review projections from PlanGraph and runtime status", async () => {
    const { root } = await createTestWorkspace(
      basicManifest({ includeSecondTask: true, taskDependsOn: ["T-002"] })
    );
    const runtime = await loadRuntime({ projectRoot: root });
    const status = await buildExecutionStatus(runtime);
    const { graph } = await loadPlanGraphPackage(root);

    const todo = buildTodoProjection({
      graphVersion: graph.graphVersion,
      runtime,
      status,
      planGraph: graph
    });
    const review = buildReviewProjection({
      graphVersion: graph.graphVersion,
      runtime,
      status,
      planGraph: graph
    });

    expect(todo.graphVersion).toBe(graph.graphVersion);
    expect(todo.groups.ready.map((item) => item.ref)).toEqual(["T-002#B-001"]);
    expect(
      todo.groups.planned.find((item) => item.ref === "T-001#B-001")?.dependencyBlockers
    ).toEqual(["T-002"]);
    expect(review.graphVersion).toBe(graph.graphVersion);
    expect(review.items.map((item) => item.ref)).toEqual(["T-001#R-001", "T-002#R-001"]);
    expect(review.ready).toEqual([]);
  });

  it("builds statistics and canvas map projections with graph versions", async () => {
    const { root } = await createTestWorkspace();
    const todoContext = await loadProjectTodoContext(root);
    const defaultCanvas = todoContext.aggregation.canvasesById.get("default");
    if (!defaultCanvas) {
      throw new Error("Default canvas missing.");
    }
    const resultsByCanvas = new Map([
      ["default", await buildResultsFileIndex(defaultCanvas.workspace)]
    ]);
    const graphVersion = todoContext.snapshotsByCanvas.get("default")?.graphVersion;
    if (!graphVersion) {
      throw new Error("Default canvas graph version missing.");
    }

    const statistics = buildStatisticsProjection({
      graphVersion,
      context: todoContext,
      resultsByCanvas
    });
    const canvasMap = buildCanvasMapProjection({
      graphVersion,
      context: todoContext,
      projectId: todoContext.aggregation.loaded.workspace.id,
      projectTitle: "Projection test"
    });

    expect(statistics.graphVersion).toBe(graphVersion);
    expect(statistics.statistics).toMatchObject({
      taskTotal: 1,
      blockTotal: 2,
      estimatedRemainingBlocks: 2
    });
    expect(canvasMap.graphVersion).toBe(graphVersion);
    expect(canvasMap.viewModel.canvases.map((canvas) => canvas.canvasId)).toEqual(["default"]);
    expect(canvasMap.viewModel.health.canvases.map((canvas) => canvas.canvasId)).toEqual([
      "default"
    ]);
  });

  it("stores projection version metadata and invalidates it on index rebuild", async () => {
    const { root } = await createTestWorkspace();
    const { graph } = await loadPlanGraphPackage(root);
    const store = await createSqlitePlanGraphStore({ projectRoot: root });

    await store.rebuild();
    await store.setProjectionVersion({
      projectionName: "todo",
      graphVersion: graph.graphVersion,
      projectionVersion: "todo/v1",
      cacheKey: `todo:${graph.graphVersion}`,
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    await expect(
      store.getProjectionVersion("todo", `todo:${graph.graphVersion}`)
    ).resolves.toMatchObject({
      projectionName: "todo",
      graphVersion: graph.graphVersion,
      projectionVersion: "todo/v1",
      cacheKey: `todo:${graph.graphVersion}`
    });

    await store.rebuild();
    await expect(
      store.getProjectionVersion("todo", `todo:${graph.graphVersion}`)
    ).resolves.toBeNull();
  });

  it("invalidates projection version metadata on changed package paths", async () => {
    const { root } = await createTestWorkspace();
    const { graph } = await loadPlanGraphPackage(root);
    const store = await createSqlitePlanGraphStore({ projectRoot: root });

    await store.rebuild();
    await store.setProjectionVersion({
      projectionName: "todo",
      graphVersion: graph.graphVersion,
      projectionVersion: "todo/v1",
      cacheKey: `todo:${graph.graphVersion}`,
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    await store.indexChangedPaths(["nodes/T-001/prompt.md"]);

    await expect(
      store.getProjectionVersion("todo", `todo:${graph.graphVersion}`)
    ).resolves.toBeNull();
  });

  it("changes metadata graphVersion for same-size restored-mtime prompt edits", async () => {
    const { root, init } = await createTestWorkspace();
    const promptPath = join(init.workspace.packageDir, "nodes", "T-001", "prompt.md");
    const fixedTime = new Date(10_000);

    await writeFile(promptPath, "metadata prompt body alpha\n", "utf8");
    await utimes(promptPath, fixedTime, fixedTime);
    const before = await loadPlanGraphPackageMetadata(root);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(promptPath, "metadata prompt body bravo\n", "utf8");
    await utimes(promptPath, fixedTime, fixedTime);
    const after = await loadPlanGraphPackageMetadata(root);

    expect(after.graph.graphVersion).not.toBe(before.graph.graphVersion);
  });

  it("builds agent claim markdown and includes it in rendered prompts", async () => {
    const { root } = await createTestWorkspace();
    const runtime = await loadRuntime({ projectRoot: root });
    const status = await buildExecutionStatus(runtime);
    const { graph } = await loadPlanGraphPackage(root);

    const markdown = buildAgentClaimMarkdown({
      graph,
      ref: "T-001#R-001",
      status
    });
    const renderedPrompt = await renderPrompt({ projectRoot: root, ref: "T-001#R-001" });

    expect(markdown).toContain(`PlanGraph version: ${graph.graphVersion}`);
    expect(markdown).toContain("Current claim: T-001#R-001 (review)");
    expect(markdown).toContain("T-001#B-001 [implementation] Implement task");
    expect(renderedPrompt).toContain("## PlanGraph Claim Context");
    expect(renderedPrompt).toContain("Current claim: T-001#R-001 (review)");
  });
});
