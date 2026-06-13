import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getBlockDetail,
  getGraphViewModel,
  getTaskDetail,
  getTaskExecutionOrder,
  getTodoGroups,
  readProjectPrompt,
  updateProjectPromptPolicy,
  updateProjectPrompt,
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
    expect(graph.edges).toEqual([]);
    expect(graph.tasks[0]).toMatchObject({
      taskId: "T-001",
      title: "Implement test task",
      status: "ready",
      executorLabel: "manual",
      hiddenBlockRefs: [],
      overflowBlockCount: 0
    });
    expect(graph.tasks[0].promptPreview).toContain("T-001 task prompt");
    expect(graph.tasks[0].blocks.map((block) => block.ref)).toEqual(["T-001#B-001", "T-001#R-001"]);
    expect(graph.tasks[0].blockPreview.map((block) => block.ref)).toEqual(["T-001#B-001", "T-001#R-001"]);
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
      blockRefs: ["T-001#B-001", "T-001#R-001"]
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
    expect(graph.tasks[0].blocks.map((block) => block.executor)).toEqual(["opencode", "opencode"]);
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

  it("exposes the rendered prompt surface with visible prompt source provenance", async () => {
    const { home, root, init } = await createTestWorkspace();
    await writeFile(join(home, "config", "global-prompt.md"), "Global policy from parent flow.\n", "utf8");
    await writeFile(init.workspace.projectPromptFile, "Project canvas policy.\n", "utf8");

    const inheritedDetail = await getBlockDetail(root, "T-001#B-001");

    expect(inheritedDetail.promptSurfaceMarkdown).toContain("Global policy from parent flow.");
    expect(inheritedDetail.promptSurfaceMarkdown).toContain("Project canvas policy.");
    expect(inheritedDetail.promptSurfaceMarkdown).toContain("## Project Canvas Context");
    expect(inheritedDetail.promptSurfaceMarkdown).toContain("Current canvas: Test Plan (default)");
    expect(inheritedDetail.promptSurfaceMarkdown).toContain("# T-001 task prompt");
    expect(inheritedDetail.promptSurfaceMarkdown).toContain("# T-001#B-001 implementation prompt");
    expect(inheritedDetail.promptSources).toEqual([
      expect.objectContaining({ kind: "global", label: "PlanWeave Global Prompt", included: true }),
      expect.objectContaining({ kind: "projectCanvas", label: "Project/Canvas Prompt", included: true }),
      expect.objectContaining({ kind: "projectGraph", label: "Project Canvas Context", included: true, missing: true }),
      expect.objectContaining({ kind: "taskNode", label: "Task Node Prompt", included: true }),
      expect.objectContaining({ kind: "block", label: "Block Prompt", included: true })
    ]);

    await updateProjectPromptPolicy(root, { includeGlobalPrompt: false });
    const projectScopedDetail = await getBlockDetail(root, "T-001#B-001");

    expect(projectScopedDetail.promptSurfaceMarkdown).not.toContain("Global policy from parent flow.");
    expect(projectScopedDetail.promptSurfaceMarkdown).toContain("Project canvas policy.");
    expect(projectScopedDetail.promptSources.find((source) => source.kind === "global")).toMatchObject({
      included: false,
      disabledReason: "Disabled for this project."
    });
  });

  it("reads and updates the project canvas prompt from the desktop API", async () => {
    const { root } = await createTestWorkspace();

    await expect(readProjectPrompt(root)).resolves.toContain("# Project Prompt");
    await updateProjectPrompt(root, "Project/Canvas prompt visible in settings.\n");

    await expect(readProjectPrompt(root)).resolves.toBe("Project/Canvas prompt visible in settings.\n");
    await expect(getBlockDetail(root, "T-001#B-001")).resolves.toMatchObject({
      promptSurfaceMarkdown: expect.stringContaining("Project/Canvas prompt visible in settings.")
    });
  });

  it("marks missing source prompts in graph and detail view models", async () => {
    const { root, init } = await createTestWorkspace();
    await rm(join(init.workspace.packageDir, "nodes", "T-001", "prompt.md"));
    await rm(join(init.workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md"));

    const graph = await getGraphViewModel(root);
    const taskDetail = await getTaskDetail(root, "T-001");
    const blockDetail = await getBlockDetail(root, "T-001#B-001");

    expect(graph.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "prompt_missing", path: "nodes/T-001/prompt.md" }),
        expect.objectContaining({ code: "prompt_missing", path: "nodes/T-001/blocks/B-001.prompt.md" })
      ])
    );
    expect(graph.tasks[0]).toMatchObject({ promptMarkdown: "", promptMissing: true });
    expect(graph.tasks[0].blocks[0]).toMatchObject({ ref: "T-001#B-001", promptMissing: true });
    expect(taskDetail).toMatchObject({ promptMarkdown: "", promptMissing: true });
    expect(blockDetail).toMatchObject({ promptMarkdown: "", promptMissing: true });
  });

  it("exposes review gate metadata in block detail and todo items", async () => {
    const { root } = await createTestWorkspace();

    await expect(getBlockDetail(root, "T-001#R-001")).resolves.toMatchObject({
      ref: "T-001#R-001",
      reviewGate: {
        required: true,
        executorRole: "reviewer",
        needsChangesReturnsTo: ["T-001#B-001"]
      }
    });
    const todo = await getTodoGroups(root);
    expect(Object.values(todo).flat().find((item) => item.ref === "T-001#R-001")).toMatchObject({
      reviewGate: {
        required: true,
        executorRole: "reviewer",
        needsChangesReturnsTo: ["T-001#B-001"]
      }
    });
  });
});
