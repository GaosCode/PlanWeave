import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addBlock,
  addDependencyEdge,
  addTaskNode,
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
  updateBlockPlanning,
  updateBlockTitle,
  updateCanvasExecutionPolicy,
  updateTaskAcceptance,
  updateTaskExecutor,
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
