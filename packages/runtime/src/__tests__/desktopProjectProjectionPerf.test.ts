import * as fsPromises from "node:fs/promises";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTaskCanvasWorkspace } from "../desktop/index.js";
import {
  invalidateDesktopProjectProjection,
  readDesktopProjectProjection,
  readDesktopProjectSearchIndex,
  readDesktopProjectStatisticsProjection
} from "../desktop/graph/projectProjectionModel.js";
import { searchDesktopSearchIndex } from "../desktop/graph/searchIndexModel.js";
import { writeJsonFile } from "../json.js";
import { createCanvasWorkspace } from "../projectGraph/createCanvasWorkspace.js";
import { writeState } from "../state.js";
import { loadRuntime, refreshDerivedState } from "../taskManager/runtimeContext.js";
import type { ManifestTaskNode, PlanPackageManifest, ProjectWorkspace } from "../types.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

const REGRESSION_CANVAS_IDS = ["default", "cache-alpha", "cache-beta"] as const;
const TASKS_PER_CANVAS = 4;
const BLOCKS_PER_TASK = 2;
const RESULT_FILES_PER_TASK = 2;
const PROMPT_BODY_FILES_PER_CANVAS = TASKS_PER_CANVAS * (1 + BLOCKS_PER_TASK);
const RESULT_BODY_FILES_PER_CANVAS = TASKS_PER_CANVAS * RESULT_FILES_PER_TASK;
const TOTAL_PROMPT_BODY_FILES = REGRESSION_CANVAS_IDS.length * PROMPT_BODY_FILES_PER_CANVAS;
const TOTAL_RESULT_BODY_FILES = REGRESSION_CANVAS_IDS.length * RESULT_BODY_FILES_PER_CANVAS;
const MAX_WARM_BODY_READS = 0;
const MAX_SINGLE_CANVAS_PROMPT_BODY_READS = PROMPT_BODY_FILES_PER_CANVAS;
const MAX_SINGLE_RESULT_INVALIDATION_RESULT_BODY_READS = 1;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile)
  };
});

type CanvasFixture = {
  canvasId: string;
  workspace: ProjectWorkspace;
  promptPaths: string[];
  resultPaths: string[];
};

type ProjectionRegressionFixture = {
  root: string;
  canvases: CanvasFixture[];
};

type BodyReadCounts = {
  promptTotal: number;
  resultTotal: number;
  promptsByCanvas: Map<string, number>;
  resultsByCanvas: Map<string, number>;
};

afterEach(() => {
  vi.clearAllMocks();
  invalidateDesktopProjectProjection();
  delete process.env.PLANWEAVE_HOME;
});

function taskId(index: number): string {
  return `T-${String(index).padStart(3, "0")}`;
}

function implementationBlockId(index: number): string {
  return `B-${String(index).padStart(3, "0")}`;
}

function reviewBlockId(index: number): string {
  return `R-${String(index).padStart(3, "0")}`;
}

function createRegressionManifest(canvasId: string): PlanPackageManifest {
  const nodes: ManifestTaskNode[] = Array.from({ length: TASKS_PER_CANVAS }, (_, taskIndex) => {
    const id = taskId(taskIndex + 1);
    const implementationId = implementationBlockId(1);
    const reviewId = reviewBlockId(1);
    return {
      id,
      type: "task",
      title: `${canvasId} task ${taskIndex + 1}`,
      prompt: `nodes/${id}/prompt.md`,
      acceptance: [`${canvasId} task ${taskIndex + 1} accepted.`],
      blocks: [
        {
          id: implementationId,
          type: "implementation",
          title: `${canvasId} implementation ${taskIndex + 1}`,
          prompt: `nodes/${id}/blocks/${implementationId}.prompt.md`,
          depends_on: [],
          parallel: { sharedResources: [canvasId] }
        },
        {
          id: reviewId,
          type: "review",
          title: `${canvasId} review ${taskIndex + 1}`,
          prompt: `nodes/${id}/blocks/${reviewId}.prompt.md`,
          depends_on: [implementationId],
          review: {
            required: true,
            maxFeedbackCycles: 1,
            hook: null
          }
        }
      ]
    };
  });

  return {
    version: "plan-package/v1",
    project: {
      title: `${canvasId} projection regression`,
      description: "Fixed-size desktop projection cache regression fixture."
    },
    execution: {
      parallel: {
        enabled: true,
        maxConcurrent: TASKS_PER_CANVAS
      }
    },
    review: {
      maxFeedbackCycles: 1,
      completionPolicy: "strict"
    },
    nodes,
    edges: []
  };
}

async function writeRegressionPackage(
  workspace: ProjectWorkspace,
  canvasId: string
): Promise<string[]> {
  const manifest = createRegressionManifest(canvasId);
  const promptPaths: string[] = [];
  await writeJsonFile(workspace.manifestFile, manifest);
  for (const node of manifest.nodes) {
    await mkdir(join(workspace.packageDir, "nodes", node.id, "blocks"), { recursive: true });
    const taskPromptPath = join(workspace.packageDir, node.prompt);
    await writeFile(
      taskPromptPath,
      `# ${canvasId} ${node.id}\n\n${canvasId} ${node.id} task prompt body needle\n`,
      "utf8"
    );
    promptPaths.push(taskPromptPath);
    for (const block of node.blocks) {
      const blockPromptPath = join(workspace.packageDir, block.prompt);
      await writeFile(
        blockPromptPath,
        `# ${canvasId} ${node.id}#${block.id}\n\n${canvasId} ${node.id}#${block.id} block prompt body needle\n`,
        "utf8"
      );
      promptPaths.push(blockPromptPath);
    }
  }
  return promptPaths;
}

async function writeRegressionResults(
  workspace: ProjectWorkspace,
  canvasId: string
): Promise<string[]> {
  const resultPaths: string[] = [];
  for (let taskIndex = 1; taskIndex <= TASKS_PER_CANVAS; taskIndex += 1) {
    const id = taskId(taskIndex);
    for (let resultIndex = 1; resultIndex <= RESULT_FILES_PER_TASK; resultIndex += 1) {
      const runDir = join(
        workspace.resultsDir,
        id,
        "blocks",
        implementationBlockId(1),
        "runs",
        `RUN-${resultIndex}`
      );
      const reportPath = join(runDir, "report.md");
      await mkdir(runDir, { recursive: true });
      await writeFile(reportPath, `${canvasId} ${id} result ${resultIndex} body needle\n`, "utf8");
      resultPaths.push(reportPath);
    }
  }
  return resultPaths;
}

async function createProjectionRegressionFixture(): Promise<ProjectionRegressionFixture> {
  const { root, init } = await createTestWorkspace(createRegressionManifest("default"));
  const defaultPromptPaths = await writeRegressionPackage(init.workspace, "default");
  const defaultResultPaths = await writeRegressionResults(init.workspace, "default");
  const canvases: CanvasFixture[] = [
    {
      canvasId: "default",
      workspace: init.workspace,
      promptPaths: defaultPromptPaths,
      resultPaths: defaultResultPaths
    }
  ];

  for (const canvasId of REGRESSION_CANVAS_IDS.slice(1)) {
    await createCanvasWorkspace({
      cwd: root,
      id: canvasId,
      title: `${canvasId} projection regression`
    });
    const workspace = await resolveTaskCanvasWorkspace(root, canvasId);
    const promptPaths = await writeRegressionPackage(workspace, canvasId);
    const resultPaths = await writeRegressionResults(workspace, canvasId);
    canvases.push({ canvasId, workspace, promptPaths, resultPaths });
  }

  return { root, canvases };
}

function readPath(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function countBodyReads(fixture: ProjectionRegressionFixture): BodyReadCounts {
  const promptsByCanvas = new Map(fixture.canvases.map((canvas) => [canvas.canvasId, 0]));
  const resultsByCanvas = new Map(fixture.canvases.map((canvas) => [canvas.canvasId, 0]));
  for (const [pathValue] of vi.mocked(fsPromises.readFile).mock.calls) {
    const path = readPath(pathValue);
    if (!path) {
      continue;
    }
    for (const canvas of fixture.canvases) {
      if (canvas.promptPaths.includes(path)) {
        promptsByCanvas.set(canvas.canvasId, (promptsByCanvas.get(canvas.canvasId) ?? 0) + 1);
      }
      if (canvas.resultPaths.includes(path)) {
        resultsByCanvas.set(canvas.canvasId, (resultsByCanvas.get(canvas.canvasId) ?? 0) + 1);
      }
    }
  }
  return {
    promptTotal: [...promptsByCanvas.values()].reduce((sum, count) => sum + count, 0),
    resultTotal: [...resultsByCanvas.values()].reduce((sum, count) => sum + count, 0),
    promptsByCanvas,
    resultsByCanvas
  };
}

function expectNoUnrelatedCanvasBodyReads(counts: BodyReadCounts, changedCanvasId: string): void {
  for (const [canvasId, count] of counts.promptsByCanvas) {
    if (canvasId !== changedCanvasId) {
      expect(count).toBe(0);
    }
  }
  for (const [canvasId, count] of counts.resultsByCanvas) {
    if (canvasId !== changedCanvasId) {
      expect(count).toBe(0);
    }
  }
}

function targetCanvas(fixture: ProjectionRegressionFixture, canvasId: string): CanvasFixture {
  const canvas = fixture.canvases.find((candidate) => candidate.canvasId === canvasId);
  if (!canvas) {
    throw new Error(`Fixture canvas '${canvasId}' is missing.`);
  }
  return canvas;
}

describe("desktop project projection cache regression budget", () => {
  it("keeps warm body reads at zero and limits result, prompt, and state invalidation to one canvas", async () => {
    const fixture = await createProjectionRegressionFixture();
    const changedCanvas = targetCanvas(fixture, "cache-alpha");

    vi.mocked(fsPromises.readFile).mockClear();
    const coldProjection = await readDesktopProjectProjection(fixture.root);
    const coldSummarySearch = await readDesktopProjectSearchIndex(fixture.root);
    const coldStatistics = await readDesktopProjectStatisticsProjection(fixture.root);
    const coldSummaryCounts = countBodyReads(fixture);

    expect(coldProjection.todoContext.aggregation.orderedCanvasIds).toEqual([
      ...REGRESSION_CANVAS_IDS
    ]);
    expect(coldSummarySearch.documents.length).toBeGreaterThan(0);
    expect(coldStatistics.statistics.taskTotal).toBe(
      REGRESSION_CANVAS_IDS.length * TASKS_PER_CANVAS
    );
    expect(coldSummaryCounts.promptTotal).toBe(0);
    expect(coldSummaryCounts.resultTotal).toBe(0);

    vi.mocked(fsPromises.readFile).mockClear();
    const coldBodySearch = await readDesktopProjectSearchIndex(fixture.root, {
      includeBodies: true
    });
    const coldBodyCounts = countBodyReads(fixture);

    expect(coldBodyCounts.promptTotal).toBe(TOTAL_PROMPT_BODY_FILES);
    expect(coldBodyCounts.resultTotal).toBe(TOTAL_RESULT_BODY_FILES);
    expect(
      searchDesktopSearchIndex(coldBodySearch, "cache-alpha T-001 task prompt body needle", {
        kinds: ["prompt"]
      })
    ).toEqual([
      expect.objectContaining({ canvasId: "cache-alpha", ref: "T-001", targetRef: "T-001" })
    ]);

    vi.mocked(fsPromises.readFile).mockClear();
    await readDesktopProjectProjection(fixture.root);
    await readDesktopProjectSearchIndex(fixture.root, { includeBodies: true });
    await readDesktopProjectSearchIndex(fixture.root, { includeBodies: true });
    await readDesktopProjectStatisticsProjection(fixture.root);
    const warmCounts = countBodyReads(fixture);

    expect(warmCounts.promptTotal).toBe(MAX_WARM_BODY_READS);
    expect(warmCounts.resultTotal).toBe(MAX_WARM_BODY_READS);

    const changedReportPath = changedCanvas.resultPaths[0];
    await writeFile(changedReportPath, "cache-alpha T-001 result 1 body needle updated\n", "utf8");
    await utimes(changedReportPath, new Date(10_000), new Date(10_000));

    vi.mocked(fsPromises.readFile).mockClear();
    const resultInvalidationSearch = await readDesktopProjectSearchIndex(fixture.root, {
      includeBodies: true
    });
    const resultInvalidationStatistics = await readDesktopProjectStatisticsProjection(fixture.root);
    const resultInvalidationCounts = countBodyReads(fixture);

    expectNoUnrelatedCanvasBodyReads(resultInvalidationCounts, changedCanvas.canvasId);
    expect(
      resultInvalidationCounts.promptsByCanvas.get(changedCanvas.canvasId)
    ).toBeLessThanOrEqual(MAX_SINGLE_CANVAS_PROMPT_BODY_READS);
    expect(
      resultInvalidationCounts.resultsByCanvas.get(changedCanvas.canvasId)
    ).toBeLessThanOrEqual(MAX_SINGLE_RESULT_INVALIDATION_RESULT_BODY_READS);
    expect(
      searchDesktopSearchIndex(
        resultInvalidationSearch,
        "cache-alpha T-001 result 1 body needle updated",
        { kinds: ["run_record"] }
      )
    ).toEqual([
      expect.objectContaining({
        canvasId: changedCanvas.canvasId,
        ref: "T-001/blocks/B-001/runs/RUN-1/report.md"
      })
    ]);

    invalidateDesktopProjectProjection(fixture.root);
    const resultFullRebuildSearch = await readDesktopProjectSearchIndex(fixture.root, {
      includeBodies: true
    });
    const resultFullRebuildStatistics = await readDesktopProjectStatisticsProjection(fixture.root);
    expect(resultInvalidationSearch.documents).toEqual(resultFullRebuildSearch.documents);
    expect(resultInvalidationStatistics.statistics).toEqual(resultFullRebuildStatistics.statistics);

    const changedPromptPath = changedCanvas.promptPaths[0];
    await writeFile(
      changedPromptPath,
      "# cache-alpha T-001\n\ncache-alpha prompt body needle updated\n",
      "utf8"
    );
    await utimes(changedPromptPath, new Date(20_000), new Date(20_000));

    vi.mocked(fsPromises.readFile).mockClear();
    const promptInvalidationSearch = await readDesktopProjectSearchIndex(fixture.root, {
      includeBodies: true
    });
    const promptInvalidationCounts = countBodyReads(fixture);

    expectNoUnrelatedCanvasBodyReads(promptInvalidationCounts, changedCanvas.canvasId);
    expect(
      promptInvalidationCounts.promptsByCanvas.get(changedCanvas.canvasId)
    ).toBeLessThanOrEqual(MAX_SINGLE_CANVAS_PROMPT_BODY_READS);
    expect(promptInvalidationCounts.resultsByCanvas.get(changedCanvas.canvasId)).toBe(0);
    expect(
      searchDesktopSearchIndex(promptInvalidationSearch, "cache-alpha prompt body needle updated", {
        kinds: ["prompt"]
      })
    ).toEqual([
      expect.objectContaining({
        canvasId: changedCanvas.canvasId,
        ref: "T-001",
        targetRef: "T-001"
      })
    ]);

    invalidateDesktopProjectProjection(fixture.root);
    const promptFullRebuildSearch = await readDesktopProjectSearchIndex(fixture.root, {
      includeBodies: true
    });
    expect(promptInvalidationSearch.documents).toEqual(promptFullRebuildSearch.documents);

    const statisticsBeforeStateChange = await readDesktopProjectStatisticsProjection(fixture.root);
    const runtimeBeforeStateChange = await loadRuntime({ projectRoot: changedCanvas.workspace });
    await writeState(
      changedCanvas.workspace.stateFile,
      refreshDerivedState(runtimeBeforeStateChange.manifest, {
        ...runtimeBeforeStateChange.state,
        blocks: {
          ...runtimeBeforeStateChange.state.blocks,
          "T-001#B-001": {
            ...runtimeBeforeStateChange.state.blocks["T-001#B-001"],
            status: "completed",
            lastRunId: "RUN-STATE-ONLY"
          }
        }
      })
    );

    vi.mocked(fsPromises.readFile).mockClear();
    const stateInvalidationSearch = await readDesktopProjectSearchIndex(fixture.root, {
      includeBodies: true
    });
    const stateInvalidationStatistics = await readDesktopProjectStatisticsProjection(fixture.root);
    const stateInvalidationCounts = countBodyReads(fixture);

    expectNoUnrelatedCanvasBodyReads(stateInvalidationCounts, changedCanvas.canvasId);
    expect(stateInvalidationCounts.promptsByCanvas.get(changedCanvas.canvasId)).toBeLessThanOrEqual(
      MAX_SINGLE_CANVAS_PROMPT_BODY_READS
    );
    expect(stateInvalidationCounts.resultsByCanvas.get(changedCanvas.canvasId)).toBe(0);
    expect(stateInvalidationStatistics.statistics).not.toEqual(
      statisticsBeforeStateChange.statistics
    );

    invalidateDesktopProjectProjection(fixture.root);
    const stateFullRebuildSearch = await readDesktopProjectSearchIndex(fixture.root, {
      includeBodies: true
    });
    const stateFullRebuildStatistics = await readDesktopProjectStatisticsProjection(fixture.root);
    expect(stateInvalidationSearch.documents).toEqual(stateFullRebuildSearch.documents);
    expect(stateInvalidationStatistics.statistics).toEqual(stateFullRebuildStatistics.statistics);
  });
});
