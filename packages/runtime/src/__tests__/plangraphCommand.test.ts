import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readJsonFile } from "../json.js";
import {
  createSqlitePlanGraphStore,
  defaultPlanGraphIndexPath,
  executePlanGraphCommand,
  loadPlanGraphPackage,
  redoPlanGraphCommand,
  selectUpstreamTasks,
  undoPlanGraphCommand
} from "../plangraph/index.js";
import { handlerForCommand, planGraphCommandHandlers } from "../plangraph/commandHandlers/index.js";
import { isProjectGraphCommand } from "../plangraph/projectGraphCommand.js";
import type { PlanGraphCommand, ProjectGraphCommand } from "../plangraph/index.js";
import type { ManifestBlock, PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

type OrdinaryPackageCommandType = Exclude<
  PlanGraphCommand["type"],
  ProjectGraphCommand["type"] | "updateLayout"
>;

const ordinaryPackageCommandTypes = [
  "addTaskDependency",
  "removeTaskDependency",
  "reconnectTaskDependency",
  "updateTaskPrompt",
  "updateBlockPrompt",
  "updateTaskFields",
  "updateBlockFields",
  "addTask",
  "removeTask",
  "restoreTask",
  "addBlock",
  "removeBlock",
  "restoreBlock",
  "updateReviewPipeline"
] as const satisfies readonly OrdinaryPackageCommandType[];

const ordinaryPackageCommandTypeCoverage: Exclude<
  OrdinaryPackageCommandType,
  (typeof ordinaryPackageCommandTypes)[number]
> extends never
  ? true
  : never = true;

describe("PlanGraph SQLite index and commands", () => {
  it("covers package commands with one registry handler and keeps special command paths explicit", () => {
    expect(ordinaryPackageCommandTypeCoverage).toBe(true);
    const registeredTypes = planGraphCommandHandlers.flatMap((handler) => handler.commandTypes);

    for (const commandType of ordinaryPackageCommandTypes) {
      expect(
        registeredTypes.filter((registeredType) => registeredType === commandType)
      ).toHaveLength(1);
    }
    expect(
      registeredTypes.filter((registeredType) => registeredType === "updateLayout")
    ).toHaveLength(1);

    const projectGraphCommandTypes = [
      "addCanvasDependency",
      "removeCanvasDependency",
      "addCrossTaskDependency",
      "removeCrossTaskDependency"
    ] as const satisfies readonly ProjectGraphCommand["type"][];
    for (const commandType of projectGraphCommandTypes) {
      expect(registeredTypes).not.toContain(commandType);
    }

    const taskSnapshot = {
      task: {
        id: "T-002",
        type: "task",
        title: "Restored task",
        prompt: "nodes/T-002/prompt.md",
        acceptance: ["Done."],
        blocks: []
      },
      taskPromptMarkdown: "# Task\n",
      blockPromptMarkdown: [],
      insertIndex: 1,
      affectedTaskEdges: []
    } satisfies Extract<PlanGraphCommand, { type: "addTask" }>["snapshot"];
    const blockSnapshot = {
      taskId: "T-001",
      block: {
        id: "B-002",
        type: "implementation",
        title: "Implement",
        prompt: "nodes/T-001/blocks/B-002.prompt.md",
        depends_on: [],
        parallel: { locks: [] }
      } satisfies ManifestBlock,
      promptMarkdown: "# Block\n",
      insertIndex: 1,
      affectedDependsOn: []
    } satisfies Extract<PlanGraphCommand, { type: "addBlock" }>["snapshot"];
    const reviewBlock = {
      id: "R-002",
      type: "review",
      title: "Review",
      prompt: "nodes/T-001/blocks/R-002.prompt.md",
      depends_on: [],
      review: { required: true, maxFeedbackCycles: 1, hook: null }
    } satisfies Extract<PlanGraphCommand, { type: "updateReviewPipeline" }>["reviewBlocks"][number];
    const commands = [
      { type: "addTaskDependency", fromTaskId: "T-002", toTaskId: "T-001" },
      { type: "removeTaskDependency", fromTaskId: "T-002", toTaskId: "T-001" },
      {
        type: "reconnectTaskDependency",
        fromTaskId: "T-002",
        oldToTaskId: "T-001",
        newFromTaskId: "T-003",
        newToTaskId: "T-001"
      },
      { type: "updateTaskPrompt", taskId: "T-001", promptMarkdown: "# Task\n" },
      { type: "updateBlockPrompt", blockRef: "T-001#B-001", promptMarkdown: "# Block\n" },
      { type: "updateTaskFields", taskId: "T-001", fields: { title: "Task" } },
      { type: "updateBlockFields", blockRef: "T-001#B-001", fields: { title: "Block" } },
      { type: "addTask", snapshot: taskSnapshot },
      { type: "removeTask", taskId: "T-001" },
      { type: "restoreTask", snapshot: taskSnapshot },
      { type: "addBlock", snapshot: blockSnapshot },
      { type: "removeBlock", blockRef: "T-001#B-001" },
      { type: "restoreBlock", snapshot: blockSnapshot },
      {
        type: "updateReviewPipeline",
        taskId: "T-001",
        packageDefaults: { maxFeedbackCycles: 1, completionPolicy: "strict" },
        reviewBlocks: [reviewBlock],
        promptMarkdownByBlockId: [{ blockId: "R-002", markdown: "# Review\n" }]
      }
    ] as const satisfies readonly PlanGraphCommand[];

    for (const command of commands) {
      const matches = planGraphCommandHandlers.filter((handler) => handler.handles(command));
      expect(matches).toHaveLength(1);
      expect(handlerForCommand(command)).toBe(matches[0]);
    }

    const projectGraphCommand: PlanGraphCommand = {
      type: "addCanvasDependency",
      fromCanvasId: "default",
      toCanvasId: "second"
    };
    expect(isProjectGraphCommand(projectGraphCommand)).toBe(true);
    expect(handlerForCommand(projectGraphCommand)).toBeUndefined();

    const layoutCommand: PlanGraphCommand = {
      type: "updateLayout",
      layoutScope: "canvas",
      layout: { activeCanvasId: "default" }
    };
    expect(handlerForCommand(layoutCommand)?.family).toBe("layout");
  });

  it("rebuilds the derived SQLite index after the database is deleted", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const indexPath = defaultPlanGraphIndexPath(init.workspace);
    const store = await createSqlitePlanGraphStore({ projectRoot: root, indexPath });

    const firstGraph = await store.rebuild();
    await expect(access(indexPath)).resolves.toBeUndefined();
    expect((await store.load())?.tasks.size).toBe(2);

    await rm(indexPath);
    const rebuiltStore = await createSqlitePlanGraphStore({ projectRoot: root, indexPath });
    const rebuiltGraph = await rebuiltStore.rebuild();

    expect(rebuiltGraph.packageFingerprint).toBe(firstGraph.packageFingerprint);
    expect((await rebuiltStore.load())?.blocks.size).toBe(4);
  });

  it("writes a task dependency to the package and re-indexes the graph", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const base = await loadPlanGraphPackage(root);

    const result = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "addTaskDependency",
        fromTaskId: "T-002",
        toTaskId: "T-001",
        baseGraphVersion: base.graph.graphVersion
      }
    });

    expect(result.ok).toBe(true);
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.edges).toEqual([{ from: "T-002", to: "T-001", type: "depends_on" }]);

    const store = await createSqlitePlanGraphStore({ projectRoot: root });
    const indexed = await store.load();
    if (!indexed) {
      throw new Error("Expected PlanGraph index.");
    }
    expect(selectUpstreamTasks(indexed, "T-002").map((task) => task.taskId)).toEqual(["T-001"]);
  });

  it("reconnects a task dependency when the dependent task changes", async () => {
    const manifest = basicManifest({ includeSecondTask: true });
    manifest.nodes.push({
      id: "T-003",
      type: "task",
      title: "Third task",
      prompt: "nodes/T-003/prompt.md",
      acceptance: ["Third implementation is complete."],
      blocks: [
        {
          id: "B-001",
          type: "implementation",
          title: "Implement third task",
          prompt: "nodes/T-003/blocks/B-001.prompt.md",
          depends_on: [],
          parallel: { locks: ["third"] }
        }
      ]
    });
    manifest.edges = [{ from: "T-002", to: "T-001", type: "depends_on" }];
    const { root, init } = await createTestWorkspace(manifest);
    const base = await loadPlanGraphPackage(root);

    const result = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "reconnectTaskDependency",
        fromTaskId: "T-002",
        oldToTaskId: "T-001",
        newFromTaskId: "T-003",
        newToTaskId: "T-001",
        baseGraphVersion: base.graph.graphVersion
      }
    });

    expect(result.ok).toBe(true);
    const written = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(written.edges).toEqual([{ from: "T-003", to: "T-001", type: "depends_on" }]);
  });

  it("treats reconnecting a task dependency to the same endpoints as a no-op", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));

    await expect(
      executePlanGraphCommand({
        projectRoot: root,
        command: {
          type: "addTaskDependency",
          fromTaskId: "T-002",
          toTaskId: "T-001"
        }
      })
    ).resolves.toMatchObject({ ok: true });

    const result = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "reconnectTaskDependency",
        fromTaskId: "T-002",
        oldToTaskId: "T-001",
        newFromTaskId: "T-002",
        newToTaskId: "T-001"
      }
    });

    expect(result.ok).toBe(true);
    let written = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(written.edges).toEqual([{ from: "T-002", to: "T-001", type: "depends_on" }]);

    await expect(undoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });
    written = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(written.edges).toEqual([]);
  });

  it("redoes multiple undone commands in the order they were undone", async () => {
    const { root, init } = await createTestWorkspace();

    await expect(
      executePlanGraphCommand({
        projectRoot: root,
        command: {
          type: "updateTaskFields",
          taskId: "T-001",
          fields: { title: "First redo title" }
        }
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      executePlanGraphCommand({
        projectRoot: root,
        command: {
          type: "updateTaskFields",
          taskId: "T-001",
          fields: { title: "Second redo title" }
        }
      })
    ).resolves.toMatchObject({ ok: true });

    await expect(undoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });
    await expect(undoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });
    let written = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(written.nodes[0]?.type === "task" ? written.nodes[0].title : null).toBe(
      "Implement test task"
    );

    await expect(redoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });
    written = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(written.nodes[0]?.type === "task" ? written.nodes[0].title : null).toBe(
      "First redo title"
    );

    await expect(redoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });
    written = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(written.nodes[0]?.type === "task" ? written.nodes[0].title : null).toBe(
      "Second redo title"
    );
  });

  it("undoes and redoes a remove block command through the command path", async () => {
    const { root, init } = await createTestWorkspace();

    const removeResult = await executePlanGraphCommand({
      projectRoot: root,
      command: { type: "removeBlock", blockRef: "T-001#R-001" }
    });
    expect(removeResult.ok).toBe(true);
    let manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(
      manifest.nodes[0]?.type === "task" ? manifest.nodes[0].blocks.map((block) => block.id) : []
    ).toEqual(["B-001"]);

    const undoResult = await undoPlanGraphCommand({ projectRoot: root });
    expect(undoResult.ok).toBe(true);
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(
      manifest.nodes[0]?.type === "task" ? manifest.nodes[0].blocks.map((block) => block.id) : []
    ).toEqual(["B-001", "R-001"]);
    await expect(
      readFile(join(init.workspace.packageDir, "nodes/T-001/blocks/R-001.prompt.md"), "utf8")
    ).resolves.toContain("# T-001#R-001 review prompt");

    const redoResult = await redoPlanGraphCommand({ projectRoot: root });
    expect(redoResult.ok).toBe(true);
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(
      manifest.nodes[0]?.type === "task" ? manifest.nodes[0].blocks.map((block) => block.id) : []
    ).toEqual(["B-001"]);
  });

  it("restores dependent block edges when undoing a removed block", async () => {
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
      parallel: { locks: ["shared"] }
    });
    task.blocks[2].depends_on = ["B-002"];
    const { root, init } = await createTestWorkspace(manifest);

    const removeResult = await executePlanGraphCommand({
      projectRoot: root,
      command: { type: "removeBlock", blockRef: "T-001#B-001" }
    });
    expect(removeResult.ok).toBe(true);
    let written = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    let writtenTask = written.nodes[0];
    if (writtenTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(writtenTask.blocks.find((block) => block.id === "B-002")?.depends_on).toEqual([]);

    const undoResult = await undoPlanGraphCommand({ projectRoot: root });
    expect(undoResult.ok).toBe(true);
    written = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    writtenTask = written.nodes[0];
    if (writtenTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(writtenTask.blocks.find((block) => block.id === "B-002")?.depends_on).toEqual(["B-001"]);
    expect(writtenTask.blocks.find((block) => block.id === "R-001")?.depends_on).toEqual(["B-002"]);
    expect(writtenTask.blocks.map((block) => block.id)).toEqual(["B-001", "B-002", "R-001"]);
  });

  it("restores task dependency edges when undoing a removed task", async () => {
    const manifest = basicManifest({ includeSecondTask: true });
    manifest.edges = [{ from: "T-002", to: "T-001", type: "depends_on" }];
    const { root, init } = await createTestWorkspace(manifest);

    await expect(
      executePlanGraphCommand({
        projectRoot: root,
        command: { type: "removeTask", taskId: "T-001" }
      })
    ).resolves.toMatchObject({ ok: true });
    let written = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(written.edges).toEqual([]);

    await expect(undoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });
    written = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(written.nodes.some((node) => node.type === "task" && node.id === "T-001")).toBe(true);
    expect(written.nodes.map((node) => node.id)).toEqual(["T-001", "T-002"]);
    expect(written.edges).toEqual([{ from: "T-002", to: "T-001", type: "depends_on" }]);
  });

  it("saves prompt markdown to the package and changes graphVersion", async () => {
    const { root, init } = await createTestWorkspace();
    const base = await loadPlanGraphPackage(root);
    const task = base.graph.tasks.get("T-001");
    if (!task) {
      throw new Error("Missing task fixture.");
    }

    const result = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "updateTaskPrompt",
        taskId: "T-001",
        promptMarkdown: "# Updated PlanGraph prompt\n",
        baseGraphVersion: base.graph.graphVersion,
        basePromptHash: task.promptRef.contentHash
      }
    });

    expect(result.ok).toBe(true);
    expect(result.graphVersion).not.toBe(base.graph.graphVersion);
    await expect(
      readFile(join(init.workspace.packageDir, "nodes/T-001/prompt.md"), "utf8")
    ).resolves.toBe("# Updated PlanGraph prompt\n");
  });

  it("updates prompt-only commands through the incremental SQLite index path", async () => {
    const { root, init } = await createTestWorkspace();
    const base = await loadPlanGraphPackage(root);
    const task = base.graph.tasks.get("T-001");
    if (!task) {
      throw new Error("Missing task fixture.");
    }
    const store = await createSqlitePlanGraphStore({ projectRoot: root });
    const rebuild = vi.fn(store.rebuild);
    const indexChangedPaths = vi.fn(store.indexChangedPaths);

    const result = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "updateTaskPrompt",
        taskId: "T-001",
        promptMarkdown: "# Incremental prompt index\n",
        baseGraphVersion: base.graph.graphVersion,
        basePromptHash: task.promptRef.contentHash
      },
      dependencies: {
        createIndexStore: async () => ({
          ...store,
          rebuild,
          indexChangedPaths
        })
      }
    });

    expect(result.ok).toBe(true);
    expect(result.affected.packageFiles).toEqual(["nodes/T-001/prompt.md"]);
    expect(result.changedPaths).toEqual([join(init.workspace.packageDir, "nodes/T-001/prompt.md")]);
    expect(indexChangedPaths).toHaveBeenCalledWith(["nodes/T-001/prompt.md"]);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("rebuilds the SQLite index for manifest-changing commands", async () => {
    const { root } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const base = await loadPlanGraphPackage(root);
    const store = await createSqlitePlanGraphStore({ projectRoot: root });
    const rebuild = vi.fn(store.rebuild);
    const indexChangedPaths = vi.fn(store.indexChangedPaths);

    const result = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "addTaskDependency",
        fromTaskId: "T-002",
        toTaskId: "T-001",
        baseGraphVersion: base.graph.graphVersion
      },
      dependencies: {
        createIndexStore: async () => ({
          ...store,
          rebuild,
          indexChangedPaths
        })
      }
    });

    expect(result.ok).toBe(true);
    expect(result.affected.packageFiles).toEqual(["manifest.json"]);
    expect(rebuild).toHaveBeenCalledOnce();
    expect(indexChangedPaths).not.toHaveBeenCalled();
  });

  it("updates and undoes task fields through the command history", async () => {
    const manifest = basicManifest();
    const task = manifest.nodes[0];
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    task.blocks[0].executor = "manual";
    const { root, init } = await createTestWorkspace(manifest);

    const result = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "updateTaskFields",
        taskId: "T-001",
        fields: {
          title: "Updated task fields",
          executor: "codex-auto",
          acceptance: ["Updated acceptance."]
        }
      }
    });

    expect(result).toMatchObject({ ok: true });
    expect(result.ok ? result.operationId : undefined).toEqual(expect.any(Number));
    let written = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    let writtenTask = written.nodes[0];
    if (writtenTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(writtenTask).toMatchObject({
      title: "Updated task fields",
      executor: "codex-auto",
      acceptance: ["Updated acceptance."]
    });
    expect(writtenTask.blocks[0]).not.toHaveProperty("executor");

    await expect(undoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });
    written = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    writtenTask = written.nodes[0];
    if (writtenTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(writtenTask).toMatchObject({
      title: "Implement test task",
      acceptance: ["Implementation is complete.", "Review passes."]
    });
    expect(writtenTask).not.toHaveProperty("executor");
    expect(writtenTask.blocks[0]).toMatchObject({ executor: "manual" });
  });

  it("updates and undoes block dependency and planning fields through the command history", async () => {
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
      executor: "manual",
      parallel: { locks: ["shared"] }
    });
    task.blocks[2].depends_on = ["B-002"];
    const { root, init } = await createTestWorkspace(manifest);

    await expect(
      executePlanGraphCommand({
        projectRoot: root,
        command: {
          type: "updateBlockFields",
          blockRef: "T-001#B-002",
          fields: {
            title: "Updated implementation block",
            executor: null,
            dependsOn: [],
            parallelSafe: false,
            parallelLocks: ["api", "db"]
          }
        }
      })
    ).resolves.toMatchObject({ ok: true });
    let written = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    let writtenTask = written.nodes[0];
    if (writtenTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(writtenTask.blocks[1]).toMatchObject({
      title: "Updated implementation block",
      depends_on: [],
      parallel: { locks: ["api", "db", "exclusive"] }
    });
    expect(writtenTask.blocks[1]).not.toHaveProperty("executor");

    await expect(undoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });
    written = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    writtenTask = written.nodes[0];
    if (writtenTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(writtenTask.blocks[1]).toMatchObject({
      title: "Follow-up implementation",
      depends_on: ["B-001"],
      executor: "manual",
      parallel: { locks: ["shared"] }
    });

    await expect(
      executePlanGraphCommand({
        projectRoot: root,
        command: {
          type: "updateBlockFields",
          blockRef: "T-001#R-001",
          fields: {
            reviewRequired: false,
            maxFeedbackCycles: 3,
            reviewHook: {
              id: "strict-review",
              type: "executable",
              command: "node",
              args: ["review.js"],
              executionPolicy: "trusted-local"
            }
          }
        }
      })
    ).resolves.toMatchObject({ ok: true });
    written = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    writtenTask = written.nodes[0];
    if (writtenTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(writtenTask.blocks[2]).toMatchObject({
      review: {
        required: false,
        maxFeedbackCycles: 3,
        hook: { id: "strict-review", command: "node" }
      }
    });

    await expect(undoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });
    written = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    writtenTask = written.nodes[0];
    if (writtenTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(writtenTask.blocks[2]).toMatchObject({
      review: {
        required: true,
        maxFeedbackCycles: 1,
        hook: null
      }
    });
  });

  it("returns command diagnostics instead of throwing for incompatible block fields", async () => {
    const { root } = await createTestWorkspace();

    const result = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "updateBlockFields",
        blockRef: "T-001#B-001",
        fields: {
          reviewRequired: false
        }
      }
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "command_validation_failed",
        message: "review fields can only be edited on review blocks."
      })
    ]);
  });

  it("undoes a prompt update when no external edit changed the history base", async () => {
    const { root, init } = await createTestWorkspace();

    await expect(
      executePlanGraphCommand({
        projectRoot: root,
        command: {
          type: "updateTaskPrompt",
          taskId: "T-001",
          promptMarkdown: "# Command edit\n"
        }
      })
    ).resolves.toMatchObject({ ok: true });

    const undoResult = await undoPlanGraphCommand({ projectRoot: root });

    expect(undoResult.ok).toBe(true);
    await expect(
      readFile(join(init.workspace.packageDir, "nodes/T-001/prompt.md"), "utf8")
    ).resolves.toBe("# T-001 task prompt\n");
  });

  it("coalesces consecutive prompt autosave entries for the same target", async () => {
    const { root, init } = await createTestWorkspace();
    const base = await loadPlanGraphPackage(root);
    const baseTask = base.graph.tasks.get("T-001");
    if (!baseTask) {
      throw new Error("Missing task fixture.");
    }

    await expect(
      executePlanGraphCommand({
        projectRoot: root,
        command: {
          type: "updateTaskPrompt",
          taskId: "T-001",
          promptMarkdown: "# Autosave first\n",
          baseGraphVersion: base.graph.graphVersion,
          basePromptHash: baseTask.promptRef.contentHash
        }
      })
    ).resolves.toMatchObject({ ok: true, operationId: 1 });
    const afterFirst = await loadPlanGraphPackage(root);
    const afterFirstTask = afterFirst.graph.tasks.get("T-001");
    if (!afterFirstTask) {
      throw new Error("Missing task fixture.");
    }
    await expect(
      executePlanGraphCommand({
        projectRoot: root,
        command: {
          type: "updateTaskPrompt",
          taskId: "T-001",
          promptMarkdown: "# Autosave final\n",
          baseGraphVersion: afterFirst.graph.graphVersion,
          basePromptHash: afterFirstTask.promptRef.contentHash
        }
      })
    ).resolves.toMatchObject({ ok: true, operationId: 1 });

    await expect(undoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });
    await expect(
      readFile(join(init.workspace.packageDir, "nodes/T-001/prompt.md"), "utf8")
    ).resolves.toBe("# T-001 task prompt\n");
    await expect(redoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });
    await expect(
      readFile(join(init.workspace.packageDir, "nodes/T-001/prompt.md"), "utf8")
    ).resolves.toBe("# Autosave final\n");
    await expect(undoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });
    await expect(
      readFile(join(init.workspace.packageDir, "nodes/T-001/prompt.md"), "utf8")
    ).resolves.toBe("# T-001 task prompt\n");
    await expect(undoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "history_empty" })]
    });
  });

  it("does not overwrite a prompt when baseGraphVersion is stale and the prompt hash changed", async () => {
    const { root, init } = await createTestWorkspace();
    const base = await loadPlanGraphPackage(root);
    const task = base.graph.tasks.get("T-001");
    if (!task) {
      throw new Error("Missing task fixture.");
    }
    await writeFile(
      join(init.workspace.packageDir, "nodes/T-001/prompt.md"),
      "# External edit\n",
      "utf8"
    );

    const result = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "updateTaskPrompt",
        taskId: "T-001",
        promptMarkdown: "# Stale overwrite\n",
        baseGraphVersion: base.graph.graphVersion,
        basePromptHash: task.promptRef.contentHash
      }
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain("graph_version_conflict");
    await expect(
      readFile(join(init.workspace.packageDir, "nodes/T-001/prompt.md"), "utf8")
    ).resolves.toBe("# External edit\n");
  });

  it("does not apply stale undo over an external prompt edit", async () => {
    const { root, init } = await createTestWorkspace();

    const result = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "updateTaskPrompt",
        taskId: "T-001",
        promptMarkdown: "# Command edit\n"
      }
    });
    expect(result.ok).toBe(true);
    await writeFile(
      join(init.workspace.packageDir, "nodes/T-001/prompt.md"),
      "# External edit\n",
      "utf8"
    );

    const undoResult = await undoPlanGraphCommand({ projectRoot: root });

    expect(undoResult.ok).toBe(false);
    expect(undoResult.diagnostics.map((item) => item.code)).toContain("graph_version_conflict");
    await expect(
      readFile(join(init.workspace.packageDir, "nodes/T-001/prompt.md"), "utf8")
    ).resolves.toBe("# External edit\n");
  });

  it("clears the redo chain after a new normal command", async () => {
    const { root } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));

    await expect(
      executePlanGraphCommand({
        projectRoot: root,
        command: { type: "addTaskDependency", fromTaskId: "T-002", toTaskId: "T-001" }
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(undoPlanGraphCommand({ projectRoot: root })).resolves.toMatchObject({ ok: true });
    await expect(
      executePlanGraphCommand({
        projectRoot: root,
        command: { type: "updateTaskPrompt", taskId: "T-001", promptMarkdown: "# New branch\n" }
      })
    ).resolves.toMatchObject({ ok: true });

    const redoResult = await redoPlanGraphCommand({ projectRoot: root });

    expect(redoResult.ok).toBe(false);
    expect(redoResult.diagnostics.map((item) => item.code)).toContain("history_empty");
  });

  it("rejects structural commands with stale base graph versions", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const base = await loadPlanGraphPackage(root);
    await writeFile(
      join(init.workspace.packageDir, "nodes/T-001/prompt.md"),
      "# External edit\n",
      "utf8"
    );

    const result = await executePlanGraphCommand({
      projectRoot: root,
      command: {
        type: "addTaskDependency",
        fromTaskId: "T-002",
        toTaskId: "T-001",
        baseGraphVersion: base.graph.graphVersion
      }
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain("graph_version_conflict");
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.edges).toEqual([]);
  });
});
