import type { PathLike } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const promptReadObservations = vi.hoisted(() => ({
  paths: [] as string[],
  optionalFileCalls: 0
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (path: PathLike | number, options?: Parameters<typeof actual.readFile>[1]) => {
      if (typeof path !== "number") {
        promptReadObservations.paths.push(path.toString());
      }
      return actual.readFile(path as never, options as never);
    }
  };
});

vi.mock("../desktop/graph/graphHelpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../desktop/graph/graphHelpers.js")>();
  return {
    ...actual,
    readOptionalFile: async (...args: Parameters<typeof actual.readOptionalFile>) => {
      promptReadObservations.optionalFileCalls += 1;
      return actual.readOptionalFile(...args);
    }
  };
});

import {
  buildGraphViewModel,
  getBlockDetail,
  getGraphViewModel,
  loadDesktopGraphViewModelContext
} from "../desktop/graph/readModel.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  promptReadObservations.paths = [];
  promptReadObservations.optionalFileCalls = 0;
});

function classifyPromptReads(paths: string[], packageDir: string) {
  const normalizedPackageDir = packageDir.replaceAll("\\", "/");
  const promptPaths = paths
    .map((path) => path.replaceAll("\\", "/"))
    .filter(
      (path) =>
        path.startsWith(normalizedPackageDir) && path.includes("/nodes/") && path.endsWith(".md")
    );
  const taskPromptPaths = promptPaths.filter((path) => /\/nodes\/[^/]+\/prompt\.md$/.test(path));
  const blockPromptPaths = promptPaths.filter(
    (path) => path.includes("/blocks/") && path.endsWith(".prompt.md")
  );
  const countsByPath = new Map<string, number>();
  for (const path of promptPaths) {
    countsByPath.set(path, (countsByPath.get(path) ?? 0) + 1);
  }
  return {
    totalPromptRelatedReads: promptPaths.length,
    taskPromptReads: taskPromptPaths.length,
    blockBodyReads: blockPromptPaths.length,
    uniquePromptPaths: new Set(promptPaths).size,
    maxReadsPerPromptPath: promptPaths.length === 0 ? 0 : Math.max(...countsByPath.values())
  };
}

describe("desktop graph view model prompt reuse", () => {
  it("builds the view model from the PlanGraph prompt index without eager per-prompt re-reads", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const packageDir = init.workspace.packageDir;
    // 2 tasks + 4 blocks
    const promptFileCount = 6;

    const context = await loadDesktopGraphViewModelContext(root);

    promptReadObservations.paths = [];
    promptReadObservations.optionalFileCalls = 0;
    const first = await buildGraphViewModel(context);
    const firstCounts = classifyPromptReads(promptReadObservations.paths, packageDir);
    const firstOptionalCalls = promptReadObservations.optionalFileCalls;

    promptReadObservations.paths = [];
    promptReadObservations.optionalFileCalls = 0;
    const second = await buildGraphViewModel(context);
    const secondCounts = classifyPromptReads(promptReadObservations.paths, packageDir);
    const secondOptionalCalls = promptReadObservations.optionalFileCalls;

    // View-model layer must not re-read prompts via readOptionalFile.
    // Before this change each build issued O(tasks + blocks) optional reads.
    expect(firstOptionalCalls).toBe(0);
    expect(secondOptionalCalls).toBe(0);

    // loadPlanGraphPackage remains the indexing authority: compile validation + prompt index
    // may each read prompt bodies once. No third eager view-model pass.
    expect(first.tasks).toHaveLength(2);
    expect(first.tasks.reduce((count, task) => count + task.blocks.length, 0)).toBe(4);
    expect(firstCounts.uniquePromptPaths).toBe(promptFileCount);
    expect(firstCounts.maxReadsPerPromptPath).toBeLessThanOrEqual(2);
    expect(firstCounts.totalPromptRelatedReads).toBeLessThanOrEqual(promptFileCount * 2);
    expect(firstCounts.blockBodyReads).toBeLessThanOrEqual(4 * 2);
    expect(secondCounts).toEqual(firstCounts);

    // Baseline for this fixture with the old eager re-read loop was:
    // (compile + index + view-model) * 6 prompts = 18 prompt body reads per buildGraphViewModel.
    // After reuse: at most (compile + index) * 6 = 12, and zero view-model optional reads.
    expect(firstCounts.totalPromptRelatedReads).toBeLessThan(promptFileCount * 3);

    // Byte-identical output for repeated unchanged builds.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(
      first.tasks.map((task) => ({
        taskId: task.taskId,
        promptMarkdown: task.promptMarkdown,
        promptPreview: task.promptPreview,
        promptMissing: task.promptMissing,
        blocks: task.blocks.map((block) => ({ ref: block.ref, promptMissing: block.promptMissing }))
      }))
    ).toEqual([
      {
        taskId: "T-001",
        promptMarkdown: expect.stringContaining("T-001 task prompt"),
        promptPreview: expect.stringContaining("T-001 task prompt"),
        promptMissing: false,
        blocks: [
          { ref: "T-001#B-001", promptMissing: false },
          { ref: "T-001#R-001", promptMissing: false }
        ]
      },
      {
        taskId: "T-002",
        promptMarkdown: expect.stringContaining("T-002 task prompt"),
        promptPreview: expect.stringContaining("T-002 task prompt"),
        promptMissing: false,
        blocks: [
          { ref: "T-002#B-001", promptMissing: false },
          { ref: "T-002#R-001", promptMissing: false }
        ]
      }
    ]);
  });

  it("keeps end-to-end getGraphViewModel free of view-model optional prompt re-reads", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));

    promptReadObservations.paths = [];
    promptReadObservations.optionalFileCalls = 0;
    const graph = await getGraphViewModel(root);
    const counts = classifyPromptReads(promptReadObservations.paths, init.workspace.packageDir);

    expect(promptReadObservations.optionalFileCalls).toBe(0);
    expect(graph.tasks[0]?.promptMarkdown).toContain("T-001 task prompt");
    // Full getGraphViewModel also loads runtime context (session compile + fingerprint),
    // which is outside the view-model re-read loop this plan removes.
    expect(counts.uniquePromptPaths).toBe(6);
    expect(counts.totalPromptRelatedReads).toBeGreaterThan(0);
  });

  it("still loads full block prompt bodies on demand for inspector detail", async () => {
    const { root, init } = await createTestWorkspace();
    promptReadObservations.paths = [];
    promptReadObservations.optionalFileCalls = 0;

    const detail = await getBlockDetail(root, "T-001#B-001");
    const counts = classifyPromptReads(promptReadObservations.paths, init.workspace.packageDir);

    expect(detail.promptMarkdown).toContain("T-001#B-001");
    expect(promptReadObservations.optionalFileCalls).toBeGreaterThan(0);
    expect(counts.blockBodyReads).toBeGreaterThan(0);
  });
});
