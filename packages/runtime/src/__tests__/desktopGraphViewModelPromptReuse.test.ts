import type { PathLike } from "node:fs";
import { realpath } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const promptReadObservations = vi.hoisted(() => ({
  paths: [] as string[]
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

import {
  buildGraphViewModel,
  loadDesktopGraphViewModelContext
} from "../desktop/graph/readModel.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  promptReadObservations.paths = [];
});

function classifyPromptReads(paths: string[], packageDirs: string[]) {
  const prefixes = packageDirs.map((directory) => `${directory.replaceAll("\\", "/")}/`);
  const promptPaths = paths
    .map((path) => path.replaceAll("\\", "/"))
    .flatMap((path) => {
      const prefix = prefixes.find((candidate) => path.startsWith(candidate));
      return prefix === undefined ? [] : [path.slice(prefix.length)];
    })
    .filter((path) => path.startsWith("nodes/") && path.endsWith(".md"));
  const taskPromptPaths = promptPaths.filter((path) => /^nodes\/[^/]+\/prompt\.md$/.test(path));
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
    const packageDirs = [packageDir, await realpath(packageDir)];
    // 2 tasks + 4 blocks
    const promptFileCount = 6;

    const context = await loadDesktopGraphViewModelContext(root);

    promptReadObservations.paths = [];
    const first = await buildGraphViewModel(context);
    const firstCounts = classifyPromptReads(promptReadObservations.paths, packageDirs);

    promptReadObservations.paths = [];
    const second = await buildGraphViewModel(context);
    const secondCounts = classifyPromptReads(promptReadObservations.paths, packageDirs);

    // loadPlanGraphPackage remains the indexing authority: compile validation + prompt index
    // may each read prompt bodies once. No third eager view-model pass.
    expect(first.tasks).toHaveLength(2);
    expect(first.tasks.reduce((count, task) => count + task.blocks.length, 0)).toBe(4);
    expect(firstCounts.uniquePromptPaths).toBe(promptFileCount);
    expect(firstCounts.maxReadsPerPromptPath).toBeLessThanOrEqual(2);
    expect(firstCounts.totalPromptRelatedReads).toBeLessThanOrEqual(promptFileCount * 2);
    expect(firstCounts.blockBodyReads).toBeLessThanOrEqual(4 * 2);
    expect(secondCounts).toEqual(firstCounts);

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
});
