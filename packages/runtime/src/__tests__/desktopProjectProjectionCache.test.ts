import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskCanvas, getDesktopProjectSnapshot, resolveTaskCanvasWorkspace, searchProjectWithDiagnostics } from "../desktop/index.js";
import {
  invalidateDesktopProjectProjection,
  readDesktopProjectSearchIndex,
  readDesktopProjectStatisticsProjection
} from "../desktop/graph/projectProjectionModel.js";
import { searchDesktopSearchIndex } from "../desktop/graph/searchIndexModel.js";
import { writeJsonFile } from "../json.js";
import { claimBlock } from "../taskManager/claimScheduler.js";
import type { ValidationIssue } from "../types.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

afterEach(() => {
  invalidateDesktopProjectProjection();
  delete process.env.PLANWEAVE_DESKTOP_PROJECTION_SLOW_DIAGNOSTICS_MS;
  delete process.env.PLANWEAVE_HOME;
});

function canvasSnapshotFailureDiagnostics(diagnostics: ValidationIssue[], canvasId: string): ValidationIssue[] {
  return diagnostics.filter((diagnostic) => diagnostic.code === "desktop_canvas_execution_snapshot_failed" && diagnostic.path === canvasId);
}

describe("desktop project projection cache", () => {
  it("rebuilds only the changed canvas projection entry and keeps search and statistics output identical to a full rebuild", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Stable canvas" });
    const secondWorkspace = await resolveTaskCanvasWorkspace(root, secondCanvas.canvasId);
    const secondManifest = basicManifest();
    const secondTask = secondManifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (secondTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    secondTask.title = "Stable canvas task";
    await writeJsonFile(secondWorkspace.manifestFile, secondManifest);
    await writePromptFiles(secondWorkspace.packageDir, secondManifest);

    await readDesktopProjectSearchIndex(root);
    process.env.PLANWEAVE_DESKTOP_PROJECTION_SLOW_DIAGNOSTICS_MS = "0";
    await writeFile(
      join(init.workspace.packageDir, "nodes", "T-001", "prompt.md"),
      "# Edited prompt\n\nchanged canvas cache needle\n",
      "utf8"
    );

    const incrementalSearchIndex = await readDesktopProjectSearchIndex(root);
    const incrementalStatistics = await readDesktopProjectStatisticsProjection(root);
    const slowSearchPaths = incrementalSearchIndex.diagnostics
      .filter((diagnostic) => diagnostic.code === "desktop_projection_slow_part")
      .filter((diagnostic) => diagnostic.message.includes("search index construction"))
      .map((diagnostic) => diagnostic.path);

    expect(slowSearchPaths).toContain("default");
    expect(slowSearchPaths).not.toContain(secondCanvas.canvasId);
    expect(searchDesktopSearchIndex(incrementalSearchIndex, "changed canvas cache needle", { kinds: ["prompt"] })).toEqual([
      expect.objectContaining({ canvasId: "default", ref: "T-001", targetRef: "T-001" })
    ]);

    delete process.env.PLANWEAVE_DESKTOP_PROJECTION_SLOW_DIAGNOSTICS_MS;
    invalidateDesktopProjectProjection(root);
    const rebuiltSearchIndex = await readDesktopProjectSearchIndex(root);
    const rebuiltStatistics = await readDesktopProjectStatisticsProjection(root);

    expect(searchDesktopSearchIndex(incrementalSearchIndex, "changed canvas cache needle")).toEqual(
      searchDesktopSearchIndex(rebuiltSearchIndex, "changed canvas cache needle")
    );
    expect(incrementalSearchIndex.documents).toEqual(rebuiltSearchIndex.documents);
    expect(incrementalStatistics.statistics).toEqual(rebuiltStatistics.statistics);
  });

  it("refreshes cached project snapshots after manifest and state file changes", async () => {
    const { root, init } = await createTestWorkspace();
    await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });

    const nextManifest = basicManifest({ includeSecondTask: true });
    await writeJsonFile(init.workspace.manifestFile, nextManifest);
    await writePromptFiles(init.workspace.packageDir, nextManifest);

    const manifestSnapshot = await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });
    expect(manifestSnapshot.graph?.tasks.map((task) => task.taskId)).toEqual(["T-001", "T-002"]);

    await claimBlock({ projectRoot: root, ref: "T-001#B-001" });
    const stateSnapshot = await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });

    expect(stateSnapshot.graph?.tasks.find((task) => task.taskId === "T-001")).toMatchObject({
      status: "in_progress"
    });
    expect(stateSnapshot.todoGroups?.ready.map((item) => item.ref)).not.toContain("T-001#B-001");
  });

  it("replays cached canvas snapshot failure diagnostics through search, snapshot, and statistics reads", async () => {
    const { root } = await createTestWorkspace();
    const brokenCanvas = await createTaskCanvas(root, { name: "Broken cached canvas" });
    const brokenWorkspace = await resolveTaskCanvasWorkspace(root, brokenCanvas.canvasId);
    const invalidManifest = basicManifest() as unknown as { nodes: Array<{ blocks: Array<Record<string, unknown>> }> };
    invalidManifest.nodes[0].blocks[0].type = "check";
    await writeJsonFile(brokenWorkspace.manifestFile, invalidManifest);

    const failureDiagnostic = expect.objectContaining({
      code: "desktop_canvas_execution_snapshot_failed",
      path: brokenCanvas.canvasId
    });

    const firstSearch = await searchProjectWithDiagnostics(root, "T-001 task prompt", { kinds: ["prompt"] });
    expect(firstSearch).toMatchObject({
      diagnostics: expect.arrayContaining([failureDiagnostic])
    });
    const secondSearch = await searchProjectWithDiagnostics(root, "T-001 task prompt", { kinds: ["prompt"] });
    expect(secondSearch).toMatchObject({
      diagnostics: expect.arrayContaining([failureDiagnostic])
    });
    expect(canvasSnapshotFailureDiagnostics(secondSearch.diagnostics, brokenCanvas.canvasId)).toHaveLength(1);

    const firstSnapshot = await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });
    expect(firstSnapshot).toMatchObject({
      diagnostics: expect.arrayContaining([failureDiagnostic])
    });
    const secondSnapshot = await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });
    expect(secondSnapshot).toMatchObject({
      diagnostics: expect.arrayContaining([failureDiagnostic])
    });
    expect(canvasSnapshotFailureDiagnostics(secondSnapshot.diagnostics, brokenCanvas.canvasId)).toHaveLength(1);

    const firstStatistics = await readDesktopProjectStatisticsProjection(root);
    expect(firstStatistics).toMatchObject({
      diagnostics: expect.arrayContaining([failureDiagnostic])
    });
    const secondStatistics = await readDesktopProjectStatisticsProjection(root);
    expect(secondStatistics).toMatchObject({
      diagnostics: expect.arrayContaining([failureDiagnostic])
    });
    expect(canvasSnapshotFailureDiagnostics(secondStatistics.diagnostics, brokenCanvas.canvasId)).toHaveLength(1);
  });
});
