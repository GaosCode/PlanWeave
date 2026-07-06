import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addBlock,
  addDependencyEdge,
  addTaskNode,
  applyCanvasLaneLayout,
  bulkCreateBlocks,
  bulkCreateTasks,
  bulkRemoveGraphItems,
  bulkApplyReviewPipeline,
  bulkUpdateBlocks,
  bulkUpdateParallelPolicy,
  bulkUpdateTasks,
  createTaskDraft,
  getDesktopLayout,
  getProjectOverview,
  removeBlock,
  removeDependencyEdge,
  removeTaskNode,
  redoDesktopPlanGraphCommand,
  saveDesktopLayout,
  selectTaskCanvas,
  undoDesktopPlanGraphCommand,
  updateBlockDependencies,
  updateBlockExecutor,
  updateBlockFields,
  updateBlockPlanning,
  updateBlockTitle,
  updateCanvasExecutionPolicy,
  updateTaskAcceptance,
  updateTaskExecutor,
  updateTaskFields,
  updateTaskTitle,
  createTaskCanvas,
  resolveTaskCanvasWorkspace,
  validateGraphEdit
} from "../desktop/index.js";
import { createSqlitePlanGraphStore } from "../plangraph/index.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { canonicalProjectCanvasNode, loadProjectGraph, writeProjectGraph } from "../projectGraph/index.js";
import type { PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("desktop graph edit API", () => {
  it("updates canvas execution policy through the manifest without writing invalid policies", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));

    await expect(updateCanvasExecutionPolicy(root, {
      defaultExecutor: "codex-auto",
      parallelEnabled: true,
      maxConcurrent: 3
    })).resolves.toMatchObject({
      ok: true,
      affectedTasks: ["T-001", "T-002"]
    });

    let manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.execution).toEqual({
      defaultExecutor: "codex-auto",
      parallel: {
        enabled: true,
        maxConcurrent: 3
      }
    });

    await expect(updateCanvasExecutionPolicy(root, { defaultExecutor: null })).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.execution).toEqual({
      parallel: {
        enabled: true,
        maxConcurrent: 3
      }
    });

    const invalid = await updateCanvasExecutionPolicy(root, { defaultExecutor: "missing-executor" });
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics).toEqual([
      expect.objectContaining({
        code: "manifest_schema",
        path: "execution.defaultExecutor"
      })
    ]);
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.execution).toEqual({
      parallel: {
        enabled: true,
        maxConcurrent: 3
      }
    });
  });

  it("writes task/block titles, executor overrides, and task dependency edges through the manifest", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));

    await expect(updateTaskTitle(root, "T-001", "Updated task title")).resolves.toMatchObject({ ok: true });
    await expect(updateBlockExecutor(root, "T-001#R-001", "manual")).resolves.toMatchObject({ ok: true });
    await expect(updateTaskExecutor(root, "T-001", "codex-auto")).resolves.toMatchObject({ ok: true });
    await expect(updateBlockTitle(root, "T-001#B-001", "Updated block title")).resolves.toMatchObject({ ok: true });
    await expect(updateBlockExecutor(root, "T-001#B-001", "manual")).resolves.toMatchObject({ ok: true });
    await expect(addDependencyEdge(root, "T-001", "T-002")).resolves.toMatchObject({ ok: true, affectedTasks: ["T-001"] });

    let manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(task.title).toBe("Updated task title");
    expect(task.executor).toBe("codex-auto");
    expect(task.blocks.find((block) => block.id === "B-001")).toMatchObject({
      title: "Updated block title",
      executor: "manual"
    });
    expect(task.blocks.find((block) => block.id === "R-001")).not.toHaveProperty("executor");
    expect(manifest.edges).toContainEqual({ from: "T-001", to: "T-002", type: "depends_on" });

    const cyclic = await addDependencyEdge(root, "T-002", "T-001");
    expect(cyclic.ok).toBe(false);
    expect(cyclic.diagnostics.map((diagnostic) => diagnostic.code)).toContain("depends_on_cycle");
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.edges).not.toContainEqual({ from: "T-002", to: "T-001", type: "depends_on" });

    await expect(updateBlockExecutor(root, "T-001#B-001", null)).resolves.toMatchObject({ ok: true });
    await expect(removeDependencyEdge(root, "T-001", "T-002")).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const updatedTask = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (updatedTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(updatedTask.blocks.find((block) => block.id === "B-001")).not.toHaveProperty("executor");
    expect(manifest.edges).not.toContainEqual({ from: "T-001", to: "T-002", type: "depends_on" });
  });

  it("applies a desktop lane layout from task dependency depth", async () => {
    const { root } = await createTestWorkspace(basicManifest({ includeSecondTask: true, taskDependsOn: ["T-002"] }));

    const layout = await applyCanvasLaneLayout(root, { columnWidth: 400, rowHeight: 200, startX: 40, startY: 60 });

    expect(layout.nodes).toContainEqual({ nodeId: "T-002", x: 40, y: 60 });
    expect(layout.nodes).toContainEqual({ nodeId: "T-001", x: 440, y: 60 });
    await expect(getDesktopLayout(root)).resolves.toMatchObject({ nodes: layout.nodes });
  });

  it("does not partially write bulk review pipeline updates when a later task is invalid", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const manifestBefore = await readFile(init.workspace.manifestFile, "utf8");

    await expect(bulkApplyReviewPipeline(root, [
      {
        taskId: "T-001",
        input: {
          packageDefaults: { maxFeedbackCycles: 3, completionPolicy: "strict" },
          steps: [
            {
              blockId: "R-001",
              title: "Updated review",
              enabled: true,
              preset: "manual",
              triggerCondition: "after_required_work_completed",
              inputContext: "Implementation report",
              passCriteria: "No blocking issues",
              feedbackFormat: "Actionable findings",
              maxFeedbackCycles: 3,
              hook: null,
              promptMarkdown: "# Updated review\n"
            }
          ]
        }
      },
      {
        taskId: "T-MISSING",
        input: { steps: [] }
      }
    ])).rejects.toThrow("Task 'T-MISSING' does not exist.");

    await expect(readFile(init.workspace.manifestFile, "utf8")).resolves.toBe(manifestBefore);
  });

  it("applies Phase 7 bulk create update and remove graph item mutations transactionally", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));

    await expect(bulkCreateTasks(root, [
      {
        title: "Bulk alpha",
        promptMarkdown: "# Bulk alpha\n",
        acceptance: ["Alpha accepted."],
        blockTypes: ["implementation", "review"]
      },
      {
        title: "Bulk beta",
        promptMarkdown: "# Bulk beta\n",
        blockTypes: ["implementation"]
      }
    ])).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(init.workspace.packageDir, "nodes/T-BULK-ALPHA/prompt.md"), "utf8")).resolves.toBe("# Bulk alpha\n");

    await expect(bulkCreateBlocks(root, [
      { taskId: "T-001", type: "implementation", title: "Bulk implementation", promptMarkdown: "# Bulk block\n" },
      { taskId: "T-002", type: "review", title: "Bulk review", promptMarkdown: "# Bulk review block\n" }
    ])).resolves.toMatchObject({ ok: true });

    await expect(bulkUpdateTasks(root, [
      { taskId: "T-BULK-ALPHA", fields: { title: "Bulk alpha updated", acceptance: ["Updated alpha accepted."] } },
      { taskId: "T-BULK-BETA", fields: { executor: "manual", promptMarkdown: "# Bulk beta updated\n" } }
    ])).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(init.workspace.packageDir, "nodes/T-BULK-BETA/prompt.md"), "utf8")).resolves.toBe("# Bulk beta updated\n");

    await expect(bulkUpdateBlocks(root, [
      { blockRef: "T-BULK-ALPHA#B-001", fields: { title: "Bulk alpha implementation updated", parallelSafe: true } },
      { blockRef: "T-BULK-ALPHA#R-001", fields: { maxFeedbackCycles: 4, promptMarkdown: "# Updated alpha review\n" } }
    ])).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(init.workspace.packageDir, "nodes/T-BULK-ALPHA/blocks/R-001.prompt.md"), "utf8")).resolves.toBe("# Updated alpha review\n");

    await expect(bulkRemoveGraphItems(root, {
      blockDependencyEdges: [{ blockRef: "T-BULK-ALPHA#R-001", dependsOnBlockId: "B-001" }],
      blockRefs: ["T-BULK-BETA#B-001"],
      taskIds: ["T-BULK-BETA"]
    })).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(init.workspace.packageDir, "nodes/T-BULK-BETA/prompt.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const alpha = manifest.nodes.find((node) => node.type === "task" && node.id === "T-BULK-ALPHA");
    expect(alpha).toMatchObject({ title: "Bulk alpha updated", acceptance: ["Updated alpha accepted."] });
    expect(manifest.nodes.some((node) => node.id === "T-BULK-BETA")).toBe(false);
  });

  it("rolls back bulk review prompt side effects when a later prompt write fails", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const firstPromptPath = join(init.workspace.packageDir, "nodes/T-001/blocks/R-001.prompt.md");
    const secondBlocksDirectory = join(init.workspace.packageDir, "nodes/T-002/blocks");
    const secondPromptPath = join(secondBlocksDirectory, "R-002.prompt.md");
    const manifestBefore = await readFile(init.workspace.manifestFile, "utf8");
    const firstPromptBefore = await readFile(firstPromptPath, "utf8");
    const originalMode = (await stat(secondBlocksDirectory)).mode;
    await chmod(secondBlocksDirectory, 0o555);
    try {
      await expect(bulkApplyReviewPipeline(root, [
        {
          taskId: "T-001",
          input: {
            steps: [
              {
                blockId: "R-001",
                title: "Updated first review",
                enabled: true,
                preset: "manual",
                triggerCondition: "after_required_work_completed",
                inputContext: "Implementation report",
                passCriteria: "No blocking issues",
                feedbackFormat: "Actionable findings",
                maxFeedbackCycles: 2,
                hook: null,
                promptMarkdown: "# Updated first review\n"
              }
            ]
          }
        },
        {
          taskId: "T-002",
          input: {
            steps: [
              {
                title: "New second review",
                enabled: true,
                preset: "manual",
                triggerCondition: "after_required_work_completed",
                inputContext: "Implementation report",
                passCriteria: "No blocking issues",
                feedbackFormat: "Actionable findings",
                maxFeedbackCycles: 2,
                hook: null,
                promptMarkdown: "# New second review\n"
              }
            ]
          }
        }
      ])).rejects.toThrow();
    } finally {
      await chmod(secondBlocksDirectory, originalMode & 0o777);
    }

    await expect(readFile(init.workspace.manifestFile, "utf8")).resolves.toBe(manifestBefore);
    await expect(readFile(firstPromptPath, "utf8")).resolves.toBe(firstPromptBefore);
    await expect(readFile(secondPromptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back bulk task creation prompt side effects when a later task prompt write fails", async () => {
    const { root, init } = await createTestWorkspace(basicManifest());
    const manifestBefore = await readFile(init.workspace.manifestFile, "utf8");
    const firstTaskPromptPath = join(init.workspace.packageDir, "nodes/T-FIRST-BULK/prompt.md");
    const blockedSecondTaskPath = join(init.workspace.packageDir, "nodes/T-SECOND-BULK");
    await writeFile(blockedSecondTaskPath, "not a directory", "utf8");

    await expect(bulkCreateTasks(root, [
      {
        title: "First bulk",
        promptMarkdown: "# First bulk\n",
        blockTypes: ["implementation"]
      },
      {
        title: "Second bulk",
        promptMarkdown: "# Second bulk\n",
        blockTypes: ["implementation"]
      }
    ])).rejects.toThrow();

    await expect(readFile(init.workspace.manifestFile, "utf8")).resolves.toBe(manifestBefore);
    await expect(readFile(firstTaskPromptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(blockedSecondTaskPath, "utf8")).resolves.toBe("not a directory");
  });

  it("rolls back bulk task prompt updates when a later task prompt write fails", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const blockedPath = join(init.workspace.packageDir, "nodes/T-002-blocked");
    const manifestWithBlockedPrompt: PlanPackageManifest = {
      ...manifest,
      nodes: manifest.nodes.map((node) =>
        node.type === "task" && node.id === "T-002"
          ? { ...node, prompt: "nodes/T-002-blocked/prompt.md" }
          : node
      )
    };
    await writeJsonFile(init.workspace.manifestFile, manifestWithBlockedPrompt);
    await writeFile(blockedPath, "not a directory", "utf8");
    const manifestBefore = await readFile(init.workspace.manifestFile, "utf8");
    const firstPromptPath = join(init.workspace.packageDir, "nodes/T-001/prompt.md");
    const firstPromptBefore = await readFile(firstPromptPath, "utf8");

    await expect(bulkUpdateTasks(root, [
      { taskId: "T-001", fields: { promptMarkdown: "# Updated first task prompt\n" } },
      { taskId: "T-002", fields: { promptMarkdown: "# Updated second task prompt\n" } }
    ])).rejects.toThrow();

    await expect(readFile(init.workspace.manifestFile, "utf8")).resolves.toBe(manifestBefore);
    await expect(readFile(firstPromptPath, "utf8")).resolves.toBe(firstPromptBefore);
    await expect(readFile(blockedPath, "utf8")).resolves.toBe("not a directory");
  });

  it("rolls back bulk graph item prompt removals when a later prompt delete fails", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const blockedPath = join(init.workspace.packageDir, "nodes/T-002-blocked");
    const manifestWithBlockedBlockPrompt: PlanPackageManifest = {
      ...manifest,
      nodes: manifest.nodes.map((node) =>
        node.type === "task" && node.id === "T-002"
          ? {
              ...node,
              blocks: node.blocks.map((block) =>
                block.id === "R-001" ? { ...block, prompt: "nodes/T-002-blocked/R-001.prompt.md" } : block
              )
            }
          : node
      )
    };
    await writeJsonFile(init.workspace.manifestFile, manifestWithBlockedBlockPrompt);
    await writeFile(blockedPath, "not a directory", "utf8");
    const manifestBefore = await readFile(init.workspace.manifestFile, "utf8");
    const firstBlockPromptPath = join(init.workspace.packageDir, "nodes/T-001/blocks/R-001.prompt.md");
    const firstBlockPromptBefore = await readFile(firstBlockPromptPath, "utf8");

    await expect(bulkRemoveGraphItems(root, {
      blockRefs: ["T-001#R-001", "T-002#R-001"]
    })).rejects.toThrow();

    await expect(readFile(init.workspace.manifestFile, "utf8")).resolves.toBe(manifestBefore);
    await expect(readFile(firstBlockPromptPath, "utf8")).resolves.toBe(firstBlockPromptBefore);
    await expect(readFile(blockedPath, "utf8")).resolves.toBe("not a directory");
  });

  it("does not partially write bulk parallel policy updates when a later block is invalid", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const manifestBefore = await readFile(init.workspace.manifestFile, "utf8");

    await expect(bulkUpdateParallelPolicy(root, {
      canvasPolicy: { parallelEnabled: true, maxConcurrent: 3 },
      blocks: [
        { blockRef: "T-001#B-001", input: { parallelSafe: false, parallelLocks: ["api"] } },
        { blockRef: "T-002#MISSING", input: { parallelSafe: true } }
      ]
    })).rejects.toThrow("Block 'T-002#MISSING' does not exist.");

    await expect(readFile(init.workspace.manifestFile, "utf8")).resolves.toBe(manifestBefore);
  });

  it("updates task fields atomically through one desktop graph command", async () => {
    const { root, init } = await createTestWorkspace();

    const result = await updateTaskFields(root, "T-001", {
      title: "Updated task fields",
      promptMarkdown: "# Updated task prompt\n",
      executor: "codex-auto"
    });

    expect(result).toMatchObject({ ok: true, affectedTasks: ["T-001"], diagnostics: [] });
    let manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    let task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(task).toMatchObject({ title: "Updated task fields", executor: "codex-auto" });
    expect(task.blocks.find((block) => block.id === "B-001")).not.toHaveProperty("executor");
    expect(await readFile(join(init.workspace.packageDir, task.prompt), "utf8")).toBe("# Updated task prompt\n");

    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(task.title).toBe("Implement test task");
    expect(task).not.toHaveProperty("executor");
    expect(await readFile(join(init.workspace.packageDir, task.prompt), "utf8")).toBe("# T-001 task prompt\n");
    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "history_empty" })]
    });
  });

  it("updates block fields atomically through one desktop graph command", async () => {
    const { root, init } = await createTestWorkspace();

    const result = await updateBlockFields(root, "T-001#B-001", {
      title: "Updated block fields",
      promptMarkdown: "# Updated block prompt\n",
      executor: "manual"
    });

    expect(result).toMatchObject({ ok: true, affectedTasks: ["T-001"], diagnostics: [] });
    let manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    let task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    let block = task.blocks.find((candidate) => candidate.id === "B-001");
    expect(block).toMatchObject({ title: "Updated block fields", executor: "manual" });
    expect(await readFile(join(init.workspace.packageDir, block?.prompt ?? ""), "utf8")).toBe("# Updated block prompt\n");

    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    block = task.blocks.find((candidate) => candidate.id === "B-001");
    expect(block?.title).toBe("Implement task");
    expect(block).not.toHaveProperty("executor");
    expect(await readFile(join(init.workspace.packageDir, block?.prompt ?? ""), "utf8")).toBe("# T-001#B-001 implementation prompt\n");
    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "history_empty" })]
    });
  });

  it("does not write task prompt or manifest fields when task field validation fails", async () => {
    const { root, init } = await createTestWorkspace();
    const manifestBefore = await readFile(init.workspace.manifestFile, "utf8");
    const promptPath = join(init.workspace.packageDir, "nodes", "T-001", "prompt.md");
    const promptBefore = await readFile(promptPath, "utf8");

    await expect(
      updateTaskFields(root, "T-001", {
        title: "   ",
        promptMarkdown: "# Must not be written\n",
        executor: "codex-auto"
      })
    ).rejects.toThrow("Title must not be empty.");

    await expect(readFile(init.workspace.manifestFile, "utf8")).resolves.toBe(manifestBefore);
    await expect(readFile(promptPath, "utf8")).resolves.toBe(promptBefore);
  });

  it("does not write block prompt or manifest fields when block field validation fails", async () => {
    const { root, init } = await createTestWorkspace();
    const manifestBefore = await readFile(init.workspace.manifestFile, "utf8");
    const promptPath = join(init.workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md");
    const promptBefore = await readFile(promptPath, "utf8");

    await expect(
      updateBlockFields(root, "T-001#B-001", {
        title: "   ",
        promptMarkdown: "# Must not be written\n",
        executor: "manual"
      })
    ).rejects.toThrow("Title must not be empty.");

    await expect(readFile(init.workspace.manifestFile, "utf8")).resolves.toBe(manifestBefore);
    await expect(readFile(promptPath, "utf8")).resolves.toBe(promptBefore);
  });

  it("validates graph edits without writing the manifest", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true, taskDependsOn: ["T-002"] }));

    const invalid = await validateGraphEdit(root, {
      kind: "addDependencyEdge",
      fromTaskId: "T-002",
      toTaskId: "T-001"
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics.map((diagnostic) => diagnostic.code)).toContain("depends_on_cycle");

    let manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.edges).not.toContainEqual({ from: "T-002", to: "T-001", type: "depends_on" });

    await expect(
      validateGraphEdit(root, {
        kind: "removeBlock",
        blockRef: "T-001#R-001"
      })
    ).resolves.toMatchObject({ ok: true, affectedTasks: ["T-001"] });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const firstTask = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (firstTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(firstTask.blocks.map((block) => block.id)).toEqual(["B-001", "R-001"]);
  });

  it("persists dependency edge layout snapshots without adding a separate undo step", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true, taskDependsOn: ["T-002"] }));
    const layoutSnapshot = {
      version: "desktop-layout/v1" as const,
      projectId: init.workspace.id,
      nodes: [
        { nodeId: "T-001", x: 120, y: 80 },
        { nodeId: "T-002", x: 580, y: 80 }
      ],
      updatedAt: new Date(0).toISOString()
    };

    await expect(removeDependencyEdge(root, "T-001", "T-002", undefined, layoutSnapshot)).resolves.toMatchObject({ ok: true });
    expect((await getDesktopLayout(root)).nodes).toEqual(layoutSnapshot.nodes);
    let manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.edges).not.toContainEqual({ from: "T-001", to: "T-002", type: "depends_on" });

    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.edges).toContainEqual({ from: "T-001", to: "T-002", type: "depends_on" });
    expect((await getDesktopLayout(root)).nodes).toEqual(layoutSnapshot.nodes);
    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "history_empty" })]
    });
  });

  it("creates task drafts and writes new task nodes and blocks through package files", async () => {
    const { root, init } = await createTestWorkspace();

    const draft = await createTaskDraft(root, {
      mode: "task",
      text: "# Add export flow\n\nUsers can export the current plan."
    });
    expect(draft).toMatchObject({
      mode: "task",
      tasks: [
        {
          title: "Add export flow",
          blockTypes: ["implementation"]
        }
      ]
    });

    await expect(addTaskNode(root, draft.tasks[0])).resolves.toMatchObject({ ok: true });
    let manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const createdTask = manifest.nodes.find((node) => node.type === "task" && node.title === "Add export flow");
    if (createdTask?.type !== "task") {
      throw new Error("Created task missing.");
    }
    expect(createdTask.id).toBe("T-ADD-EXPORT-FLOW");
    expect(createdTask.acceptance).toEqual(["# Add export flow", "Users can export the current plan."]);
    expect(createdTask.blocks.map((block) => block.type)).toEqual(["implementation"]);
    expect(createdTask.blocks.map((block) => block.depends_on)).toEqual([[]]);
    expect(await readFile(join(init.workspace.packageDir, createdTask.prompt), "utf8")).toContain("Users can export");
    expect(await readFile(join(init.workspace.packageDir, createdTask.blocks[0].prompt), "utf8")).toContain("Add export flow");

    await expect(
      addBlock(root, {
        taskId: createdTask.id,
        type: "implementation",
        title: "Implement export follow-up",
        promptMarkdown: "# Implement export follow-up\n"
      })
    ).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const updatedTask = manifest.nodes.find((node) => node.type === "task" && node.id === createdTask.id);
    if (updatedTask?.type !== "task") {
      throw new Error("Updated task missing.");
    }
    const addedBlock = updatedTask.blocks.at(-1);
    expect(addedBlock).toMatchObject({
      id: "B-002",
      type: "implementation",
      title: "Implement export follow-up",
      depends_on: ["B-001"]
    });
    expect(await readFile(join(init.workspace.packageDir, addedBlock?.prompt ?? ""), "utf8")).toBe("# Implement export follow-up\n");

    await expect(
      addTaskNode(root, {
        title: "Fallback default blocks",
        promptMarkdown: "# Fallback default blocks\n"
      })
    ).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const fallbackTask = manifest.nodes.find((node) => node.type === "task" && node.title === "Fallback default blocks");
    if (fallbackTask?.type !== "task") {
      throw new Error("Fallback task missing.");
    }
    expect(fallbackTask.acceptance).toEqual(["Task is implemented."]);
    expect(fallbackTask.blocks.map((block) => block.type)).toEqual(["implementation"]);

    await expect(
      addTaskNode(root, {
        title: " --Edge slug-- ",
        promptMarkdown: "# Edge slug\n"
      })
    ).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.nodes.some((node) => node.type === "task" && node.id === "T-EDGE-SLUG")).toBe(true);

    await expect(
      addTaskNode(root, {
        title: "Dropped task",
        promptMarkdown: "# Dropped task\n",
        layoutPosition: { x: 480, y: 240 }
      })
    ).resolves.toMatchObject({ ok: true });
    expect((await getDesktopLayout(root)).nodes).toContainEqual({ nodeId: "T-DROPPED-TASK", x: 480, y: 240 });

    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.nodes.some((node) => node.type === "task" && node.id === "T-DROPPED-TASK")).toBe(false);
    expect((await getDesktopLayout(root)).nodes).not.toContainEqual({ nodeId: "T-DROPPED-TASK", x: 480, y: 240 });
    const defaultWorkspace = await resolveTaskCanvasWorkspace(root, "default");
    await expect(readJsonFile<{ nodes: Array<{ nodeId: string }> }>(join(defaultWorkspace.workspaceRoot, "desktop/layout.json"))).resolves.toMatchObject({
      nodes: expect.not.arrayContaining([expect.objectContaining({ nodeId: "T-DROPPED-TASK" })])
    });

    await expect(redoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.nodes.some((node) => node.type === "task" && node.id === "T-DROPPED-TASK")).toBe(true);
    expect((await getDesktopLayout(root)).nodes).toContainEqual({ nodeId: "T-DROPPED-TASK", x: 480, y: 240 });

    await expect(
      addTaskNode(root, {
        title: "Manual review gate",
        promptMarkdown: "# Manual review gate\n",
        acceptance: ["Manual review remains opt-in."],
        blockTypes: ["implementation", "review"]
      })
    ).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const reviewedTask = manifest.nodes.find((node) => node.type === "task" && node.title === "Manual review gate");
    if (reviewedTask?.type !== "task") {
      throw new Error("Explicit review task missing.");
    }
    expect(reviewedTask.blocks.map((block) => block.type)).toEqual(["implementation", "review"]);
    expect(reviewedTask.blocks.map((block) => block.depends_on)).toEqual([[], ["B-001"]]);

    const appendDraft = await createTaskDraft(root, {
      mode: "blocks",
      targetTaskId: createdTask.id,
      text: "Add a follow-up validation block."
    });
    expect(appendDraft.blocks).toMatchObject([{ taskId: createdTask.id, type: "implementation", title: "Add a follow-up validation block." }]);
  });

  it("removes task/block package surfaces through graph APIs", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    await saveDesktopLayout(root, {
      version: "desktop-layout/v1",
      projectId: init.workspace.id,
      nodes: [{ nodeId: "T-002", x: 320, y: 180 }],
      updatedAt: new Date(0).toISOString()
    });

    await expect(removeBlock(root, "T-001#R-001")).resolves.toMatchObject({ ok: true, affectedTasks: ["T-001"] });
    let manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const firstTask = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (firstTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(firstTask.blocks.map((block) => block.id)).toEqual(["B-001"]);
    await expect(readFile(join(init.workspace.packageDir, "nodes", "T-001", "blocks", "R-001.prompt.md"), "utf8")).rejects.toThrow();

    await expect(removeTaskNode(root, "T-002")).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.nodes.some((node) => node.id === "T-002")).toBe(false);
    expect(manifest.edges.some((edge) => edge.from === "T-002" || edge.to === "T-002")).toBe(false);
    await expect(readFile(join(init.workspace.packageDir, "nodes", "T-002", "prompt.md"), "utf8")).rejects.toThrow();

    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
    const restoredLayout = await getDesktopLayout(root);
    expect(restoredLayout.nodes).toContainEqual({ nodeId: "T-002", x: 320, y: 180 });
  });

  it("refuses to delete a task referenced by a project cross-task dependency", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Second plan" });
    const secondWorkspace = await resolveTaskCanvasWorkspace(root, secondCanvas.canvasId);
    const secondManifest = basicManifest();
    await writeJsonFile(secondWorkspace.manifestFile, secondManifest);
    await writePromptFiles(secondWorkspace.packageDir, secondManifest);
    await writeProjectGraph(init.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Runtime plan" }),
        {
          id: secondCanvas.canvasId,
          type: "canvas",
          title: "Second plan",
          packageDir: `canvases/${secondCanvas.canvasId}/package`,
          stateFile: `canvases/${secondCanvas.canvasId}/state.json`,
          resultsDir: `canvases/${secondCanvas.canvasId}/results`
        }
      ],
      edges: [],
      crossTaskEdges: [
        {
          from: { canvasId: secondCanvas.canvasId, taskId: "T-001" },
          to: { canvasId: "default", taskId: "T-001" },
          type: "depends_on"
        }
      ]
    });

    const result = await removeTaskNode(secondWorkspace, "T-001");

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("project_cross_task_edge_blocks_task_delete");
    const written = await readJsonFile<PlanPackageManifest>(secondWorkspace.manifestFile);
    expect(written.nodes.some((node) => node.id === "T-001")).toBe(true);
    expect((await loadProjectGraph(root)).manifest.crossTaskEdges).toHaveLength(1);
  });

  it("records desktop field edits as undoable PlanGraph history", async () => {
    const manifest = basicManifest();
    const task = manifest.nodes[0];
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    task.blocks.splice(1, 0, {
      id: "B-002",
      type: "implementation",
      title: "Follow-up implementation",
      prompt: "nodes/T-001/blocks/B-002.prompt.md",
      depends_on: ["B-001"],
      parallel: { safe: true, locks: ["shared"] }
    });
    task.blocks[2].depends_on = ["B-002"];
    const { root, init } = await createTestWorkspace(manifest);

    await expect(updateTaskAcceptance(root, "T-001", ["Desktop acceptance."])).resolves.toMatchObject({ ok: true });
    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
    let written = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    let writtenTask = written.nodes[0];
    if (writtenTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(writtenTask.acceptance).toEqual(["Implementation is complete.", "Review passes."]);

    await expect(updateBlockDependencies(root, "T-001#B-002", [])).resolves.toMatchObject({ ok: true });
    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
    written = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    writtenTask = written.nodes[0];
    if (writtenTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(writtenTask.blocks.find((block) => block.id === "B-002")?.depends_on).toEqual(["B-001"]);

    await expect(updateBlockPlanning(root, "T-001#B-002", { parallelSafe: false, parallelLocks: ["api"] })).resolves.toMatchObject({
      ok: true
    });
    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
    written = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    writtenTask = written.nodes[0];
    if (writtenTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(writtenTask.blocks.find((block) => block.id === "B-002")).toMatchObject({
      parallel: { safe: true, locks: ["shared"] }
    });
  });

  it("records desktop layout saves as undoable PlanGraph history", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const firstLayout = {
      version: "desktop-layout/v1" as const,
      projectId: init.workspace.id,
      nodes: [{ nodeId: "T-001", x: 80, y: 120 }],
      updatedAt: new Date(0).toISOString()
    };
    const secondLayout = {
      ...firstLayout,
      nodes: [{ nodeId: "T-001", x: 360, y: 220 }]
    };

    await saveDesktopLayout(root, firstLayout);
    await saveDesktopLayout(root, secondLayout);
    expect((await getDesktopLayout(root)).nodes).toEqual([{ nodeId: "T-001", x: 360, y: 220 }]);

    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
    expect((await getDesktopLayout(root)).nodes).toEqual([{ nodeId: "T-001", x: 80, y: 120 }]);

    await expect(redoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
    expect((await getDesktopLayout(root)).nodes).toEqual([{ nodeId: "T-001", x: 360, y: 220 }]);
  });

  it("uses one project-level PlanGraph history across task canvases", async () => {
    const { root, init } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Second plan" });
    const secondWorkspace = await resolveTaskCanvasWorkspace(root, secondCanvas.canvasId);
    await writeJsonFile(secondWorkspace.manifestFile, basicManifest());
    await writePromptFiles(secondWorkspace.packageDir, basicManifest());

    const defaultStore = await createSqlitePlanGraphStore({ projectRoot: init.workspace });
    await defaultStore.rebuild();
    await expect(updateTaskTitle(secondWorkspace, "T-001", "Second canvas title")).resolves.toMatchObject({ ok: true });
    const secondStore = await createSqlitePlanGraphStore({ projectRoot: secondWorkspace });
    expect(secondStore.indexPath).toBe(defaultStore.indexPath);
    expect((await defaultStore.load())?.tasks.get("T-001")?.title).toBe("Implement test task");
    expect((await secondStore.load())?.tasks.get("T-001")?.title).toBe("Second canvas title");

    await expect(undoDesktopPlanGraphCommand(init.workspace)).resolves.toMatchObject({ ok: true });
    const secondManifest = await readJsonFile<PlanPackageManifest>(secondWorkspace.manifestFile);
    const secondTask = secondManifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    expect(secondTask?.title).toBe("Implement test task");
  });

  it("applies cross-canvas task history layout side effects to the entry workspace", async () => {
    const { root } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Second plan" });
    const secondWorkspace = await resolveTaskCanvasWorkspace(root, secondCanvas.canvasId);
    await writeJsonFile(secondWorkspace.manifestFile, basicManifest());
    await writePromptFiles(secondWorkspace.packageDir, basicManifest());

    await expect(
      addTaskNode(secondWorkspace, {
        title: "Dropped task",
        promptMarkdown: "# Dropped task\n",
        layoutPosition: { x: 480, y: 240 }
      })
    ).resolves.toMatchObject({ ok: true });
    expect((await getDesktopLayout(secondWorkspace)).nodes).toContainEqual({ nodeId: "T-DROPPED-TASK", x: 480, y: 240 });

    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
    const secondManifest = await readJsonFile<PlanPackageManifest>(secondWorkspace.manifestFile);
    expect(secondManifest.nodes.some((node) => node.type === "task" && node.id === "T-DROPPED-TASK")).toBe(false);
    await expect(readJsonFile<{ nodes: Array<{ nodeId: string }> }>(join(secondWorkspace.workspaceRoot, "desktop/layout.json"))).resolves.toMatchObject({
      nodes: expect.not.arrayContaining([expect.objectContaining({ nodeId: "T-DROPPED-TASK" })])
    });
  });

  it("records active task canvas selection as undoable PlanGraph history", async () => {
    const { root } = await createTestWorkspace();
    const secondCanvas = await createTaskCanvas(root, { name: "Second plan" });

    await expect(selectTaskCanvas(root, secondCanvas.canvasId)).resolves.toBe(secondCanvas.canvasId);
    await expect(getProjectOverview(root)).resolves.toMatchObject({ activeCanvasId: secondCanvas.canvasId });

    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
    await expect(getProjectOverview(root)).resolves.toMatchObject({ activeCanvasId: "default" });

    await expect(redoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
    await expect(getProjectOverview(root)).resolves.toMatchObject({ activeCanvasId: secondCanvas.canvasId });
  });
});
