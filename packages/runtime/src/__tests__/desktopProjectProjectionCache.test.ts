import * as fsPromises from "node:fs/promises";
import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTaskCanvas,
  getDesktopProjectSnapshot,
  removeTaskCanvas,
  resolveTaskCanvasWorkspace,
  searchProjectWithDiagnostics
} from "../desktop/index.js";
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

const fsMockState = vi.hoisted(() => ({
  statErrorPath: null as string | null,
  statErrorCode: "EACCES",
  statErrorAfterMatches: 0,
  statMatchCount: 0
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    stat: vi.fn(async (path: string) => {
      if (path === fsMockState.statErrorPath) {
        fsMockState.statMatchCount += 1;
        if (fsMockState.statMatchCount <= fsMockState.statErrorAfterMatches) {
          return actual.stat(path);
        }
        const error = new Error(
          `${fsMockState.statErrorCode} stat failed for ${path}`
        ) as NodeJS.ErrnoException;
        error.code = fsMockState.statErrorCode;
        throw error;
      }
      return actual.stat(path);
    })
  };
});

afterEach(() => {
  vi.clearAllMocks();
  fsMockState.statErrorPath = null;
  fsMockState.statErrorCode = "EACCES";
  fsMockState.statErrorAfterMatches = 0;
  fsMockState.statMatchCount = 0;
  invalidateDesktopProjectProjection();
  delete process.env.PLANWEAVE_DESKTOP_PROJECTION_SLOW_DIAGNOSTICS_MS;
  delete process.env.PLANWEAVE_HOME;
});

function canvasSnapshotFailureDiagnostics(
  diagnostics: ValidationIssue[],
  canvasId: string
): ValidationIssue[] {
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.code === "desktop_canvas_execution_snapshot_failed" && diagnostic.path === canvasId
  );
}

function resultReadPaths(resultsDir: string): string[] {
  const readFileMock = vi.mocked(fsPromises.readFile);
  return readFileMock.mock.calls
    .map(([path]) => (typeof path === "string" ? path : null))
    .filter((path): path is string => path !== null && path.startsWith(resultsDir));
}

function promptReadPaths(packageDir: string): string[] {
  const promptDir = join(packageDir, "nodes");
  const readFileMock = vi.mocked(fsPromises.readFile);
  return readFileMock.mock.calls
    .map(([path]) => (typeof path === "string" ? path : null))
    .filter((path): path is string => path !== null && path.startsWith(promptDir));
}

describe("desktop project projection cache", () => {
  it("rebuilds only the changed canvas projection entry and keeps search and statistics output identical to a full rebuild", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Stable canvas" });
    const secondWorkspace = await resolveTaskCanvasWorkspace(root, secondCanvas.canvasId);
    const secondManifest = basicManifest();
    const secondTask = secondManifest.nodes.find(
      (node) => node.type === "task" && node.id === "T-001"
    );
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
    const slowDiagnosticCodes = new Set([
      ...incrementalSearchIndex.diagnostics.map((diagnostic) => diagnostic.code),
      ...incrementalStatistics.diagnostics.map((diagnostic) => diagnostic.code)
    ]);
    const slowSearchPaths = incrementalSearchIndex.diagnostics
      .filter((diagnostic) => diagnostic.code === "desktop_search_index_slow_part")
      .filter((diagnostic) => diagnostic.message.includes("summary search index construction"))
      .map((diagnostic) => diagnostic.path);

    expect([...slowDiagnosticCodes]).toEqual(
      expect.arrayContaining([
        "desktop_projection_slow_part",
        "desktop_search_index_slow_part",
        "desktop_statistics_slow_part"
      ])
    );
    expect(slowSearchPaths).toContain("default");
    expect(slowSearchPaths).not.toContain(secondCanvas.canvasId);
    expect(
      searchDesktopSearchIndex(incrementalSearchIndex, "changed canvas cache needle", {
        kinds: ["prompt"]
      })
    ).toEqual([]);

    delete process.env.PLANWEAVE_DESKTOP_PROJECTION_SLOW_DIAGNOSTICS_MS;
    invalidateDesktopProjectProjection(root);
    const rebuiltSearchIndex = await readDesktopProjectSearchIndex(root);
    const rebuiltStatistics = await readDesktopProjectStatisticsProjection(root);
    const rebuiltSlowDiagnosticCodes = new Set([
      ...rebuiltSearchIndex.diagnostics.map((diagnostic) => diagnostic.code),
      ...rebuiltStatistics.diagnostics.map((diagnostic) => diagnostic.code)
    ]);

    expect(rebuiltSlowDiagnosticCodes).not.toContain("desktop_projection_slow_part");
    expect(rebuiltSlowDiagnosticCodes).not.toContain("desktop_search_index_slow_part");
    expect(rebuiltSlowDiagnosticCodes).not.toContain("desktop_statistics_slow_part");
    expect(searchDesktopSearchIndex(incrementalSearchIndex, "changed canvas cache needle")).toEqual(
      searchDesktopSearchIndex(rebuiltSearchIndex, "changed canvas cache needle")
    );
    expect(incrementalSearchIndex.documents).toEqual(rebuiltSearchIndex.documents);
    expect(incrementalStatistics.statistics).toEqual(rebuiltStatistics.statistics);
  });

  it("keeps summary search reusable while body search hydrates on demand and invalidates with prompt or result fingerprints", async () => {
    const { root, init } = await createTestWorkspace();
    const taskPromptPath = join(init.workspace.packageDir, "nodes", "T-001", "prompt.md");
    const runDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-BODY-CACHE"
    );
    const reportPath = join(runDir, "report.md");
    await fsPromises.mkdir(runDir, { recursive: true });
    await writeFile(taskPromptPath, "# Task prompt\n\nprojection prompt body needle\n", "utf8");
    await writeFile(reportPath, "projection result body needle\n", "utf8");

    vi.mocked(fsPromises.readFile).mockClear();
    const summaryIndex = await readDesktopProjectSearchIndex(root);

    expect(promptReadPaths(init.workspace.packageDir)).toEqual([]);
    expect(resultReadPaths(init.workspace.resultsDir)).not.toContain(reportPath);
    expect(summaryIndex.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "desktop_search_summary_index_built"
    );
    expect(
      searchDesktopSearchIndex(summaryIndex, "projection prompt body needle", { kinds: ["prompt"] })
    ).toEqual([]);
    expect(
      searchDesktopSearchIndex(summaryIndex, "projection result body needle", {
        kinds: ["run_record"]
      })
    ).toEqual([]);

    vi.mocked(fsPromises.readFile).mockClear();
    const summarySearch = await searchProjectWithDiagnostics(
      root,
      "projection prompt body needle",
      { kinds: ["prompt"], includeBodies: false }
    );
    expect(summarySearch.results).toEqual([]);
    expect(promptReadPaths(init.workspace.packageDir)).toEqual([]);

    vi.mocked(fsPromises.readFile).mockClear();
    const hydratedIndex = await readDesktopProjectSearchIndex(root, { includeBodies: true });

    expect(
      searchDesktopSearchIndex(hydratedIndex, "projection prompt body needle", {
        kinds: ["prompt"]
      })
    ).toEqual([expect.objectContaining({ canvasId: "default", ref: "T-001", targetRef: "T-001" })]);
    expect(
      searchDesktopSearchIndex(hydratedIndex, "projection result body needle", {
        kinds: ["run_record"]
      })
    ).toEqual([
      expect.objectContaining({
        canvasId: "default",
        ref: "T-001/blocks/B-001/runs/RUN-BODY-CACHE/report.md"
      })
    ]);
    expect(hydratedIndex.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "desktop_search_body_index_built"
    );
    expect(resultReadPaths(init.workspace.resultsDir)).toContain(reportPath);

    vi.mocked(fsPromises.readFile).mockClear();
    await readDesktopProjectSearchIndex(root, { includeBodies: true });
    expect(resultReadPaths(init.workspace.resultsDir)).toEqual([]);

    await writeFile(reportPath, "projection result body needle updated\n", "utf8");
    await utimes(reportPath, new Date(5_000), new Date(5_000));

    vi.mocked(fsPromises.readFile).mockClear();
    const changedResultsIndex = await readDesktopProjectSearchIndex(root, { includeBodies: true });
    expect(
      searchDesktopSearchIndex(changedResultsIndex, "projection result body needle updated", {
        kinds: ["run_record"]
      })
    ).toEqual([
      expect.objectContaining({
        canvasId: "default",
        ref: "T-001/blocks/B-001/runs/RUN-BODY-CACHE/report.md"
      })
    ]);
    expect(resultReadPaths(init.workspace.resultsDir)).toContain(reportPath);

    await writeFile(
      taskPromptPath,
      "# Task prompt\n\nprojection prompt body needle updated\n",
      "utf8"
    );
    await utimes(taskPromptPath, new Date(6_000), new Date(6_000));

    const changedPromptIndex = await readDesktopProjectSearchIndex(root, { includeBodies: true });
    expect(
      searchDesktopSearchIndex(changedPromptIndex, "projection prompt body needle updated", {
        kinds: ["prompt"]
      })
    ).toEqual([expect.objectContaining({ canvasId: "default", ref: "T-001", targetRef: "T-001" })]);
  });

  it("clears cached result bodies when a project projection is invalidated", async () => {
    const { root, init } = await createTestWorkspace();
    const runDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-PROJECT-INVALIDATE"
    );
    const reportPath = join(runDir, "report.md");
    await fsPromises.mkdir(runDir, { recursive: true });
    await writeFile(reportPath, "project invalidation result body needle\n", "utf8");

    await readDesktopProjectSearchIndex(root, { includeBodies: true });
    vi.mocked(fsPromises.readFile).mockClear();
    invalidateDesktopProjectProjection(root);
    await readDesktopProjectSearchIndex(root, { includeBodies: true });

    expect(resultReadPaths(init.workspace.resultsDir)).toContain(reportPath);
  });

  it("clears cached result bodies through the canvas removal invalidation path", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Removed canvas" });
    const secondWorkspace = await resolveTaskCanvasWorkspace(root, secondCanvas.canvasId);
    const defaultRunDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-CANVAS-INVALIDATE"
    );
    const secondRunDir = join(
      secondWorkspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-CANVAS-REMOVED"
    );
    const defaultReportPath = join(defaultRunDir, "report.md");
    await fsPromises.mkdir(defaultRunDir, { recursive: true });
    await fsPromises.mkdir(secondRunDir, { recursive: true });
    await writeFile(defaultReportPath, "canvas removal default result needle\n", "utf8");
    await writeFile(
      join(secondRunDir, "report.md"),
      "canvas removal removed result needle\n",
      "utf8"
    );

    await readDesktopProjectSearchIndex(root, { includeBodies: true });
    vi.mocked(fsPromises.readFile).mockClear();
    await removeTaskCanvas(root, secondCanvas.canvasId);
    vi.mocked(fsPromises.readFile).mockClear();
    await readDesktopProjectSearchIndex(root, { includeBodies: true });

    expect(resultReadPaths(init.workspace.resultsDir)).toContain(defaultReportPath);
  });

  it("reuses one projection context during search while keeping body hydration lazy", async () => {
    const { root, init } = await createTestWorkspace();
    const taskPromptPath = join(init.workspace.packageDir, "nodes", "T-001", "prompt.md");
    await writeFile(taskPromptPath, "# Task prompt\n\nsingle projection body needle\n", "utf8");
    fsMockState.statErrorPath = init.workspace.stateFile;
    fsMockState.statErrorAfterMatches = 100;

    vi.mocked(fsPromises.readFile).mockClear();
    const search = await searchProjectWithDiagnostics(root, "single projection body needle", {
      kinds: ["prompt"],
      includeBodies: false
    });

    expect(fsMockState.statMatchCount).toBe(3);
    expect(search.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "desktop_canvas_runtime_input_failed"
    );
    expect(search.results).toEqual([]);
    expect(promptReadPaths(init.workspace.packageDir)).toEqual([]);
    await expect(
      searchProjectWithDiagnostics(root, "needle", { canvasId: "missing-canvas" })
    ).rejects.toThrow("Task canvas 'missing-canvas' does not exist.");
  });

  it("invalidates body search when prompt or result content changes with the same size and mtime", async () => {
    const { root, init } = await createTestWorkspace();
    const taskPromptPath = join(init.workspace.packageDir, "nodes", "T-001", "prompt.md");
    const runDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-SAME-STAT"
    );
    const reportPath = join(runDir, "report.md");
    const fixedTime = new Date(8_000);
    await fsPromises.mkdir(runDir, { recursive: true });
    await writeFile(taskPromptPath, "same-size prompt body needle aaa\n", "utf8");
    await writeFile(reportPath, "same-size result body needle aaa\n", "utf8");
    await utimes(taskPromptPath, fixedTime, fixedTime);
    await utimes(reportPath, fixedTime, fixedTime);

    const firstIndex = await readDesktopProjectSearchIndex(root, { includeBodies: true });
    expect(
      searchDesktopSearchIndex(firstIndex, "same-size prompt body needle aaa", {
        kinds: ["prompt"]
      })
    ).toEqual([expect.objectContaining({ canvasId: "default", ref: "T-001", targetRef: "T-001" })]);
    expect(
      searchDesktopSearchIndex(firstIndex, "same-size result body needle aaa", {
        kinds: ["run_record"]
      })
    ).toEqual([
      expect.objectContaining({
        canvasId: "default",
        ref: "T-001/blocks/B-001/runs/RUN-SAME-STAT/report.md"
      })
    ]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(taskPromptPath, "same-size prompt body needle bbb\n", "utf8");
    await writeFile(reportPath, "same-size result body needle bbb\n", "utf8");
    await utimes(taskPromptPath, fixedTime, fixedTime);
    await utimes(reportPath, fixedTime, fixedTime);

    const changedIndex = await readDesktopProjectSearchIndex(root, { includeBodies: true });
    expect(
      searchDesktopSearchIndex(changedIndex, "same-size prompt body needle bbb", {
        kinds: ["prompt"]
      })
    ).toEqual([expect.objectContaining({ canvasId: "default", ref: "T-001", targetRef: "T-001" })]);
    expect(
      searchDesktopSearchIndex(changedIndex, "same-size result body needle bbb", {
        kinds: ["run_record"]
      })
    ).toEqual([
      expect.objectContaining({
        canvasId: "default",
        ref: "T-001/blocks/B-001/runs/RUN-SAME-STAT/report.md"
      })
    ]);
    expect(
      searchDesktopSearchIndex(changedIndex, "same-size prompt body needle aaa", {
        kinds: ["prompt"]
      })
    ).toEqual([]);
    expect(
      searchDesktopSearchIndex(changedIndex, "same-size result body needle aaa", {
        kinds: ["run_record"]
      })
    ).toEqual([]);
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

  it("reports non-missing canvas runtime input stat errors as diagnostics", async () => {
    const { root, init } = await createTestWorkspace();
    fsMockState.statErrorPath = init.workspace.stateFile;

    const snapshot = await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });

    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "desktop_canvas_runtime_input_failed",
          path: "default",
          message: expect.stringContaining("EACCES")
        })
      ])
    );
  });

  it("reports runtime input refresh stat errors after an initial successful fingerprint", async () => {
    const { root, init } = await createTestWorkspace();
    fsMockState.statErrorPath = init.workspace.stateFile;
    fsMockState.statErrorAfterMatches = 2;

    const snapshot = await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });

    expect(fsMockState.statMatchCount).toBeGreaterThan(1);
    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "desktop_canvas_runtime_input_failed",
          path: "default",
          message: expect.stringContaining("EACCES")
        })
      ])
    );
  });

  it("replays cached canvas snapshot failure diagnostics through search, snapshot, and statistics reads", async () => {
    const { root } = await createTestWorkspace();
    const brokenCanvas = await createTaskCanvas(root, { name: "Broken cached canvas" });
    const brokenWorkspace = await resolveTaskCanvasWorkspace(root, brokenCanvas.canvasId);
    const invalidManifest = basicManifest() as unknown as {
      nodes: Array<{ blocks: Array<Record<string, unknown>> }>;
    };
    invalidManifest.nodes[0].blocks[0].type = "check";
    await writeJsonFile(brokenWorkspace.manifestFile, invalidManifest);

    const failureDiagnostic = expect.objectContaining({
      code: "desktop_canvas_execution_snapshot_failed",
      path: brokenCanvas.canvasId
    });

    const firstSearch = await searchProjectWithDiagnostics(root, "T-001 task prompt", {
      kinds: ["prompt"]
    });
    expect(firstSearch).toMatchObject({
      diagnostics: expect.arrayContaining([failureDiagnostic])
    });
    const secondSearch = await searchProjectWithDiagnostics(root, "T-001 task prompt", {
      kinds: ["prompt"]
    });
    expect(secondSearch).toMatchObject({
      diagnostics: expect.arrayContaining([failureDiagnostic])
    });
    expect(
      canvasSnapshotFailureDiagnostics(secondSearch.diagnostics, brokenCanvas.canvasId)
    ).toHaveLength(1);

    const firstSnapshot = await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });
    expect(firstSnapshot).toMatchObject({
      diagnostics: expect.arrayContaining([failureDiagnostic])
    });
    const secondSnapshot = await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });
    expect(secondSnapshot).toMatchObject({
      diagnostics: expect.arrayContaining([failureDiagnostic])
    });
    expect(
      canvasSnapshotFailureDiagnostics(secondSnapshot.diagnostics, brokenCanvas.canvasId)
    ).toHaveLength(1);

    const firstStatistics = await readDesktopProjectStatisticsProjection(root);
    expect(firstStatistics).toMatchObject({
      diagnostics: expect.arrayContaining([failureDiagnostic])
    });
    const secondStatistics = await readDesktopProjectStatisticsProjection(root);
    expect(secondStatistics).toMatchObject({
      diagnostics: expect.arrayContaining([failureDiagnostic])
    });
    expect(
      canvasSnapshotFailureDiagnostics(secondStatistics.diagnostics, brokenCanvas.canvasId)
    ).toHaveLength(1);
  });
});
