import type { PathLike } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordBlockRunInIndex } from "../autoRun/blockRunIndex.js";

const readObservations = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (path: PathLike | number, options?: Parameters<typeof actual.readFile>[1]) => {
      if (typeof path !== "number") {
        readObservations.paths.push(path.toString());
      }
      return actual.readFile(path as never, options as never);
    }
  };
});

import * as taskGraphCompiler from "../graph/compileTaskGraph.js";
import * as graphSession from "../graph/session.js";
import * as packageLoader from "../package/loadPackage.js";
import * as planGraphRepository from "../plangraph/packageRepository.js";
import * as projectGraphLoader from "../projectGraph/loadProjectGraph.js";
import * as projectGraphAggregation from "../projectGraph/runtimeAggregation.js";
import * as executionStatus from "../taskManager/executionStatus.js";
import * as projectGraphClaimGuard from "../taskManager/projectGraphClaimGuard.js";
import * as runtimeContext from "../taskManager/runtimeContext.js";
import { writeJsonFile } from "../json.js";
import {
  getTaskWorkspace,
  getTaskWorkspaceRunDetail,
  listTaskWorkspaceRuns
} from "../desktop/taskWorkspaceApi.js";
import * as taskWorkspaceReadContext from "../desktop/taskWorkspaceReadContext.js";
import type { PlanPackageManifest } from "../types.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

type ExpensiveCallCounts = {
  contextFactory: number;
  session: number;
  runtime: number;
  packageLoad: number;
  compile: number;
  status: number;
  planGraph: number;
  projectGraphLoad: number;
  projectAggregation: number;
  claimGuard: number;
};

afterEach(() => {
  vi.restoreAllMocks();
  readObservations.paths = [];
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
});

function manifestWithBlocks(blockCount: number): PlanPackageManifest {
  return {
    version: "plan-package/v1",
    project: { title: "Scale test", description: "Task Workspace read scaling." },
    execution: { parallel: { enabled: false, maxConcurrent: 1 } },
    review: { maxFeedbackCycles: 1, completionPolicy: "strict" },
    nodes: [
      {
        id: "T-001",
        type: "task",
        title: "Scale task",
        prompt: "nodes/T-001/prompt.md",
        acceptance: ["All blocks remain visible."],
        blocks: Array.from({ length: blockCount }, (_, index) => {
          const blockId = `B-${String(index + 1).padStart(3, "0")}`;
          return {
            id: blockId,
            type: "implementation" as const,
            title: `Block ${index + 1}`,
            prompt: `nodes/T-001/blocks/${blockId}.prompt.md`,
            depends_on: []
          };
        })
      }
    ],
    edges: []
  };
}

async function measureWorkspaceRequest(blockCount: number): Promise<ExpensiveCallCounts> {
  const { home, root, init } = await createTestWorkspace(manifestWithBlocks(blockCount));
  await mkdir(join(home, "config"), { recursive: true });
  await mkdir(join(init.workspace.workspaceRoot, "policy"), { recursive: true });
  const globalPromptPath = join(home, "config", "global-prompt.md");
  await writeFile(globalPromptPath, "global prompt\n", "utf8");
  await writeFile(init.workspace.projectPromptFile, "project prompt\n", "utf8");
  readObservations.paths = [];

  const contextFactory = vi.spyOn(taskWorkspaceReadContext, "createTaskWorkspaceReadContext");
  const session = vi.spyOn(graphSession, "createExecutionGraphSession");
  const runtime = vi.spyOn(runtimeContext, "loadRuntimeReadonly");
  const packageLoad = vi.spyOn(packageLoader, "loadPackage");
  const compileTaskGraph = vi.spyOn(taskGraphCompiler, "compileTaskGraph");
  const compilePackageGraph = vi.spyOn(taskGraphCompiler, "compilePackageGraph");
  const status = vi.spyOn(executionStatus, "buildExecutionStatus");
  const planGraph = vi.spyOn(planGraphRepository, "loadPlanGraphPackage");
  const projectGraphLoad = vi.spyOn(projectGraphLoader, "loadProjectGraphForWorkspace");
  const projectAggregation = vi.spyOn(
    projectGraphAggregation,
    "loadProjectCanvasRuntimeAggregation"
  );
  const claimGuard = vi.spyOn(
    projectGraphClaimGuard,
    "createProjectGraphClaimGuardFromAggregation"
  );

  const workspace = await getTaskWorkspace({
    projectRoot: root,
    canvasId: "default",
    taskId: "T-001"
  });

  expect(workspace.blocks).toHaveLength(blockCount);
  const normalizedReads = readObservations.paths.map((path) => path.replaceAll("\\", "/"));
  for (const sharedPath of [globalPromptPath, init.workspace.projectPromptFile]) {
    const normalizedSharedPath = sharedPath.replaceAll("\\", "/");
    expect(normalizedReads.filter((path) => path === normalizedSharedPath)).toHaveLength(1);
  }
  expect(
    normalizedReads.filter((path) => path.endsWith("/policy/prompt-policy.json"))
  ).toHaveLength(1);

  const counts = {
    contextFactory: contextFactory.mock.calls.length,
    session: session.mock.calls.length,
    runtime: runtime.mock.calls.length,
    packageLoad: packageLoad.mock.calls.length,
    compile: compileTaskGraph.mock.calls.length + compilePackageGraph.mock.calls.length,
    status: status.mock.calls.length,
    planGraph: planGraph.mock.calls.length,
    projectGraphLoad: projectGraphLoad.mock.calls.length,
    projectAggregation: projectAggregation.mock.calls.length,
    claimGuard: claimGuard.mock.calls.length
  };
  vi.restoreAllMocks();
  return counts;
}

describe("Task Workspace read-context scaling", () => {
  it("keeps expensive request work constant for 1, 64, and 256 blocks", async () => {
    const oneBlock = await measureWorkspaceRequest(1);
    const sixtyFourBlocks = await measureWorkspaceRequest(64);
    const twoHundredFiftySixBlocks = await measureWorkspaceRequest(256);

    expect(oneBlock).toMatchObject({
      contextFactory: 1,
      session: 1,
      runtime: 1,
      status: 1,
      planGraph: 1,
      projectGraphLoad: 1,
      projectAggregation: 1,
      claimGuard: 1
    });
    expect(sixtyFourBlocks).toEqual(oneBlock);
    expect(twoHundredFiftySixBlocks).toEqual(oneBlock);
  }, 30_000);

  it("builds one context snapshot for each public Task Workspace request", async () => {
    const { root, init } = await createTestWorkspace(manifestWithBlocks(1));
    const runRoot = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    const runDir = join(runRoot, "RUN-001");
    await mkdir(runDir, { recursive: true });
    await writeJsonFile(join(runDir, "metadata.json"), {
      runId: "RUN-001",
      ref: "T-001#B-001",
      executor: "codex",
      adapter: "codex-exec",
      startedAt: "2026-07-17T00:00:00.000Z",
      finishedAt: "2026-07-17T00:00:01.000Z",
      exitCode: 0
    });
    await recordBlockRunInIndex(runRoot, "RUN-001");

    const contextFactory = vi.spyOn(taskWorkspaceReadContext, "createTaskWorkspaceReadContext");
    const session = vi.spyOn(graphSession, "createExecutionGraphSession");
    const runtime = vi.spyOn(runtimeContext, "loadRuntimeReadonly");
    const projectAggregation = vi.spyOn(
      projectGraphAggregation,
      "loadProjectCanvasRuntimeAggregation"
    );
    const status = vi.spyOn(executionStatus, "buildExecutionStatus");
    const planGraph = vi.spyOn(planGraphRepository, "loadPlanGraphPackage");
    const claimGuard = vi.spyOn(
      projectGraphClaimGuard,
      "createProjectGraphClaimGuardFromAggregation"
    );
    const spies = [
      contextFactory,
      session,
      runtime,
      projectAggregation,
      status,
      planGraph,
      claimGuard
    ];
    const expectOneContext = async (request: () => Promise<unknown>) => {
      await request();
      for (const spy of spies) {
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockClear();
      }
    };

    await expectOneContext(() =>
      getTaskWorkspace({ projectRoot: root, canvasId: "default", taskId: "T-001" })
    );
    await expectOneContext(() =>
      listTaskWorkspaceRuns({ projectRoot: root, canvasId: "default", taskId: "T-001" })
    );
    await expectOneContext(() =>
      getTaskWorkspaceRunDetail({
        projectRoot: root,
        canvasId: "default",
        taskId: "T-001",
        recordId: "T-001#B-001::RUN-001"
      })
    );
  });
});
