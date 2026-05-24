import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getBlockDetail,
  getGraphViewModel,
  getTaskDetail,
  getTaskExecutionOrder,
  updateBlockPrompt,
  updateTaskPrompt
} from "../desktop/index.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import type { PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("desktop graph read API", () => {
  it("returns graph view models with source prompt previews and block order", async () => {
    const { root, init } = await createTestWorkspace();

    const graph = await getGraphViewModel(root);

    expect(graph.projectId).toBe(init.workspace.id);
    expect(graph.projectTitle).toBe("Test Plan");
    expect(graph.executorOptions).toEqual(expect.arrayContaining(["default", "manual", "codex-auto", "codex-reviewer"]));
    expect(graph.edges).toContainEqual({ from: "T-001", to: "G-001", type: "implements" });
    expect(graph.tasks[0]).toMatchObject({
      taskId: "T-001",
      title: "Implement test task",
      status: "ready",
      executorLabel: "manual",
      hiddenBlockRefs: [],
      overflowBlockCount: 0
    });
    expect(graph.tasks[0].promptPreview).toContain("T-001 task prompt");
    expect(graph.tasks[0].blocks.map((block) => block.ref)).toEqual(["T-001#B-001", "T-001#C-001", "T-001#R-001"]);
    expect(graph.tasks[0].blockPreview.map((block) => block.ref)).toEqual(["T-001#B-001", "T-001#C-001", "T-001#R-001"]);
  });

  it("returns graph view models for persisted state with malformed current refs", async () => {
    const { root, init } = await createTestWorkspace();
    await writeJsonFile(init.workspace.stateFile, {
      currentRefs: {},
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {},
      feedback: {}
    });

    const graph = await getGraphViewModel(root);

    expect(graph.tasks.map((task) => task.taskId)).toEqual(["T-001"]);
    expect(graph.tasks[0]).toMatchObject({
      title: "Implement test task",
      status: "ready"
    });
  });

  it("returns task-local execution order", async () => {
    const { root } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));

    await expect(getTaskExecutionOrder(root, "T-001")).resolves.toEqual({
      taskId: "T-001",
      blockRefs: ["T-001#B-001", "T-001#C-001", "T-001#R-001"]
    });
  });

  it("labels task executors from effective block executors", async () => {
    const { root, init } = await createTestWorkspace();
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    manifest.executors = {
      ...(manifest.executors ?? {}),
      opencode: { adapter: "opencode-exec", command: "opencode", args: ["run", "-"] }
    };
    task.executor = "codex-auto";
    task.blocks = task.blocks.map((block) => ({ ...block, executor: "opencode" }));
    await writeJsonFile(init.workspace.manifestFile, manifest);

    const graph = await getGraphViewModel(root);

    expect(graph.tasks[0]).toMatchObject({
      executor: "codex-auto",
      executorLabel: "opencode"
    });
    expect(graph.tasks[0].blocks.map((block) => block.executor)).toEqual(["opencode", "opencode", "opencode"]);
  });

  it("reads details and writes task/block source prompts through package files", async () => {
    const { root, init } = await createTestWorkspace();

    const longTaskPrompt = `# Updated task prompt\n\n${"Long source prompt content. ".repeat(20)}`;
    await updateTaskPrompt(root, "T-001", longTaskPrompt);
    await updateBlockPrompt(root, "T-001#B-001", "# Updated block prompt\n");

    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(task.title).toBe("Implement test task");
    expect(task.blocks.find((block) => block.id === "B-001")?.title).toBe("Implement task");
    expect(await readFile(join(init.workspace.packageDir, "nodes", "T-001", "prompt.md"), "utf8")).toBe(longTaskPrompt);
    expect(await readFile(join(init.workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md"), "utf8")).toBe("# Updated block prompt\n");

    await expect(getTaskDetail(root, "T-001")).resolves.toMatchObject({
      title: "Implement test task",
      promptMarkdown: longTaskPrompt
    });
    const graph = await getGraphViewModel(root);
    expect(graph.tasks[0].promptMarkdown).toBe(longTaskPrompt);
    expect(graph.tasks[0].promptPreview.length).toBeLessThan(graph.tasks[0].promptMarkdown.length);
    await expect(getBlockDetail(root, "T-001#B-001")).resolves.toMatchObject({
      title: "Implement task",
      promptMarkdown: "# Updated block prompt\n"
    });
  });
});
