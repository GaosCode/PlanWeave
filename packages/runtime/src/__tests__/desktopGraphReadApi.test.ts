import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getBlockDetail,
  createTaskCanvas,
  getDesktopLayout,
  getDesktopProjectSnapshot,
  getGraphViewModel,
  getProjectExecutionPlan,
  getStatistics,
  getTaskDetail,
  getTaskFileManagerPath,
  getTaskExecutionOrder,
  getTodoGroups,
  listPendingImportRecoveries,
  resolveTaskCanvasWorkspace,
  createDesktopPackageFileSnapshot,
  detectDesktopPackageFileChanges,
  readProjectPrompt,
  readProjectPromptPolicy,
  updateProjectPromptPolicy,
  updateProjectPrompt,
  updateBlockPrompt,
  updateTaskPrompt
} from "../desktop/index.js";
import {
  buildDesktopGraphViewModelContext,
  buildGraphViewModel
} from "../desktop/graph/readModel.js";
import { ImportTransaction } from "../package/importTransaction.js";
import { buildExecutionStatus } from "../taskManager/executionStatus.js";
import { loadRuntime } from "../taskManager/runtimeContext.js";
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
    expect(graph.executorOptions).toEqual(
      expect.arrayContaining([
        "default",
        "manual",
        "codex",
        "opencode",
        "claude-code",
        "pi",
        "grok"
      ])
    );
    expect(graph.executorOptions).not.toEqual(
      expect.arrayContaining(["codex-auto", "codex-acp", "pi-auto", "pi-acp"])
    );
    expect(graph.agentTransport).toBe("acp");
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
    expect(graph.tasks[0].blockPreview.map((block) => block.ref)).toEqual([
      "T-001#B-001",
      "T-001#R-001"
    ]);
  });

  it("includes manifest custom executors in graph executor options", async () => {
    const { root, init } = await createTestWorkspace();
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    manifest.executors = {
      ...(manifest.executors ?? {}),
      "custom-shell": {
        adapter: "manual"
      },
      "codex-acp": {
        adapter: "manual"
      }
    };
    manifest.execution.defaultExecutor = "custom-shell";
    await writeJsonFile(init.workspace.manifestFile, manifest);

    const graph = await getGraphViewModel(root);

    expect(graph.executorOptions).toEqual(expect.arrayContaining(["manual", "custom-shell"]));
    expect(graph.executorOptions).not.toContain("codex-acp");
    expect(graph.packageExecutorNames).toEqual(["custom-shell"]);
    expect(graph.executorOptions.length).toBeGreaterThan(1);
    expect(graph.autoRunPreflightExecutorHint).toBe("custom-shell");
  });

  it("resolves Auto Run preflight hint from the next serial claim instead of all executor options", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const firstTask = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    const secondTask = manifest.nodes.find((node) => node.type === "task" && node.id === "T-002");
    if (firstTask?.type !== "task" || secondTask?.type !== "task") {
      throw new Error("Fixture tasks missing.");
    }
    firstTask.blocks = firstTask.blocks.map((block) =>
      block.id === "B-001" ? { ...block, executor: "codex" } : block
    );
    secondTask.blocks = secondTask.blocks.map((block) =>
      block.id === "B-001" ? { ...block, executor: "opencode" } : block
    );
    await writeJsonFile(init.workspace.manifestFile, manifest);

    const graph = await getGraphViewModel(root);

    expect(graph.executorOptions).toEqual(
      expect.arrayContaining(["default", "manual", "codex", "opencode"])
    );
    expect(graph.autoRunPreflightExecutorHint).toBe("codex");
  });

  it("resolves Auto Run preflight hint from the parallel review fallback before serial implementation fallback", async () => {
    const { root, init } = await createTestWorkspace(
      basicManifest({ includeSecondTask: true, parallel: true })
    );
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const firstTask = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    const secondTask = manifest.nodes.find((node) => node.type === "task" && node.id === "T-002");
    if (firstTask?.type !== "task" || secondTask?.type !== "task") {
      throw new Error("Fixture tasks missing.");
    }
    firstTask.blocks = firstTask.blocks.map((block) =>
      block.id === "R-001" ? { ...block, executor: "codex" } : block
    );
    // T-002 waits on T-001 becoming implemented, so it is not parallel-batchable yet.
    // Every ready implementation is batch-eligible; task dependencies
    // are how we keep a serial-only peer out of the parallel batch while review is ready.
    secondTask.blocks = secondTask.blocks.map((block) =>
      block.id === "B-001" ? { ...block, executor: "opencode" } : block
    );
    manifest.edges = [
      ...(manifest.edges ?? []),
      { from: "T-002", to: "T-001", type: "depends_on" }
    ];
    await writeJsonFile(init.workspace.manifestFile, manifest);
    await writeJsonFile(init.workspace.stateFile, {
      currentRefs: [],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {
        "T-001#B-001": { status: "completed", lastRunId: "RUN-001" }
      },
      feedback: {}
    });

    const graph = await getGraphViewModel(root);

    expect(graph.autoRunPreflightExecutorHint).toBe("codex");
  });

  it("resolves Auto Run preflight hint from the serial implementation fallback when parallel has no batch or review", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ parallel: true }));
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    // A single ready implementation still yields a single-ref parallel batch with codex.
    task.blocks = task.blocks.map((block) =>
      block.id === "B-001"
        ? { ...block, executor: "codex", parallel: { sharedResources: ["runtime"] } }
        : block
    );
    await writeJsonFile(init.workspace.manifestFile, manifest);

    const graph = await getGraphViewModel(root);

    expect(graph.autoRunPreflightExecutorHint).toBe("codex");
  });

  it("does not resolve a serial implementation fallback hint when parallel no-batch is project-blocked", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ parallel: true }));
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    task.blocks = task.blocks.map((block) =>
      block.id === "B-001"
        ? { ...block, executor: "codex", parallel: { sharedResources: ["runtime"] } }
        : block
    );
    await writeJsonFile(init.workspace.manifestFile, manifest);
    const runtime = await loadRuntime({ projectRoot: root });
    const claimGuard = {
      blockersForTask: (taskId: string) =>
        taskId === "T-001" ? ["Project dependency is incomplete."] : [],
      blockerReasonForTask: (taskId: string) =>
        taskId === "T-001" ? "Project dependency is incomplete." : null
    };
    const status = await buildExecutionStatus(runtime, { claimGuard });

    const graph = await buildGraphViewModel(
      buildDesktopGraphViewModelContext(runtime, status, { claimGuard })
    );

    expect(graph.autoRunPreflightExecutorHint).toBeNull();
  });

  it("rejects graph view models when persisted state has malformed current refs", async () => {
    const { root, init } = await createTestWorkspace();
    await writeJsonFile(init.workspace.stateFile, {
      currentRefs: {},
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {},
      feedback: {}
    });

    await expect(getGraphViewModel(root)).rejects.toThrow(
      /Runtime state at .* is invalid:.*currentRefs.*doctor/is
    );
  });

  it("exposes dirty prompt refs from desktop file sync in graph view models", async () => {
    const { root, init } = await createTestWorkspace();
    const snapshot = await createDesktopPackageFileSnapshot(root);
    await writeFile(
      join(init.workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md"),
      "# external block prompt edit\n",
      "utf8"
    );

    await expect(detectDesktopPackageFileChanges(root, snapshot.snapshotId)).resolves.toMatchObject(
      {
        dirtyPromptRefs: ["T-001#B-001"]
      }
    );

    await expect(getGraphViewModel(root)).resolves.toMatchObject({
      dirtyPromptRefs: ["T-001#B-001"]
    });
  });

  it("returns task-local execution order", async () => {
    const { root } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));

    await expect(getTaskExecutionOrder(root, "T-001")).resolves.toEqual({
      taskId: "T-001",
      blockRefs: ["T-001#B-001", "T-001#R-001"]
    });
  });

  it("resolves shared task prompt files from the manifest path", async () => {
    const { root, init } = await createTestWorkspace();
    await expect(getTaskFileManagerPath(root, "T-001")).resolves.toBe(
      join(init.workspace.packageDir, "nodes", "T-001")
    );
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    task.prompt = "shared/P00.md";
    await mkdir(join(init.workspace.packageDir, "shared"), { recursive: true });
    await writeFile(
      join(init.workspace.packageDir, "shared", "P00.md"),
      "# Shared prompt\n",
      "utf8"
    );
    await writeJsonFile(init.workspace.manifestFile, manifest);

    await expect(getTaskFileManagerPath(root, "T-001")).resolves.toBe(
      join(init.workspace.packageDir, "shared", "P00.md")
    );
  });

  it("labels task executors from effective block executors", async () => {
    const { root, init } = await createTestWorkspace();
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
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
    expect(
      await readFile(join(init.workspace.packageDir, "nodes", "T-001", "prompt.md"), "utf8")
    ).toBe(longTaskPrompt);
    expect(
      await readFile(
        join(init.workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md"),
        "utf8"
      )
    ).toBe("# Updated block prompt\n");

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
    await writeFile(
      join(home, "config", "global-prompt.md"),
      "Global policy from parent flow.\n",
      "utf8"
    );
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
      expect.objectContaining({
        kind: "projectCanvas",
        label: "Project/Canvas Prompt",
        included: true
      }),
      expect.objectContaining({
        kind: "projectGraph",
        label: "Project Canvas Context",
        included: true,
        missing: false
      }),
      expect.objectContaining({ kind: "taskNode", label: "Task Node Prompt", included: true }),
      expect.objectContaining({ kind: "block", label: "Block Prompt", included: true })
    ]);

    await updateProjectPromptPolicy(root, { includeGlobalPrompt: false });
    const projectScopedDetail = await getBlockDetail(root, "T-001#B-001");

    expect(projectScopedDetail.promptSurfaceMarkdown).not.toContain(
      "Global policy from parent flow."
    );
    expect(projectScopedDetail.promptSurfaceMarkdown).toContain("Project canvas policy.");
    expect(
      projectScopedDetail.promptSources.find((source) => source.kind === "global")
    ).toMatchObject({
      included: false,
      disabledReason: "Disabled for this project."
    });
  });

  it("reads and updates the project canvas prompt from the desktop API", async () => {
    const { root } = await createTestWorkspace();

    await expect(readProjectPrompt(root)).resolves.toContain("# Project Prompt");
    await updateProjectPrompt(root, "Project/Canvas prompt visible in settings.\n");

    await expect(readProjectPrompt(root)).resolves.toBe(
      "Project/Canvas prompt visible in settings.\n"
    );
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
        expect.objectContaining({
          code: "prompt_missing",
          path: "nodes/T-001/blocks/B-001.prompt.md"
        })
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
    expect(
      Object.values(todo)
        .flat()
        .find((item) => item.ref === "T-001#R-001")
    ).toMatchObject({
      reviewGate: {
        required: true,
        executorRole: "reviewer",
        needsChangesReturnsTo: ["T-001#B-001"]
      }
    });
  });

  it("returns a desktop project snapshot aligned with standalone read APIs", async () => {
    const { root } = await createTestWorkspace();
    await updateProjectPrompt(root, "Project snapshot prompt.\n");
    await updateProjectPromptPolicy(root, { includeGlobalPrompt: false });

    const snapshot = await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });

    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.errors).toEqual([]);
    await expect(readProjectPrompt(root)).resolves.toBe(snapshot.projectPromptMarkdown);
    await expect(readProjectPromptPolicy(root)).resolves.toEqual(snapshot.projectPromptPolicy);
    await expect(getGraphViewModel(root)).resolves.toEqual(snapshot.graph);
    await expect(getDesktopLayout(root)).resolves.toEqual(snapshot.layout);
    await expect(getTodoGroups(root)).resolves.toEqual(snapshot.todoGroups);
    await expect(getProjectExecutionPlan(root)).resolves.toEqual(snapshot.executionPlan);
    await expect(getStatistics(root)).resolves.toEqual(snapshot.statistics);
    await expect(listPendingImportRecoveries(root)).resolves.toEqual(
      snapshot.pendingImportRecoveries
    );
  });

  it("includes pending import recoveries in desktop project snapshots", async () => {
    const { root, init } = await createTestWorkspace();
    const transactionId = "desktop-snapshot-recovery";
    const target = join(init.workspace.workspaceRoot, "desktop", "snapshot-recovery-target.txt");
    const staged = join(init.workspace.workspaceRoot, "desktop", "snapshot-recovery-staged.txt");
    await mkdir(join(init.workspace.workspaceRoot, "desktop"), { recursive: true });
    await writeFile(target, "old target\n", "utf8");
    await writeFile(staged, "new target\n", "utf8");
    const transaction = await ImportTransaction.create({
      workspaceRoot: init.workspace.workspaceRoot,
      transactionId
    });
    await transaction.replacePath(target, staged);

    const snapshot = await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });

    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.pendingImportRecoveries).toMatchObject([
      {
        transactionId,
        recoveryRoot: join(
          init.workspace.workspaceRoot,
          "desktop",
          "recovery",
          "package-import",
          transactionId
        ),
        operationCount: 1,
        phases: ["installed"]
      }
    ]);
  });

  it("reports pending import recovery read failures as snapshot diagnostics", async () => {
    const { root, init } = await createTestWorkspace();
    await mkdir(join(init.workspace.workspaceRoot, "desktop", "recovery"), { recursive: true });
    await writeFile(
      join(init.workspace.workspaceRoot, "desktop", "recovery", "package-import"),
      "not a directory",
      "utf8"
    );

    const snapshot = await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });

    expect(snapshot.pendingImportRecoveries).toEqual([]);
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({
        code: "desktop_snapshot_part_failed",
        path: "pendingImportRecoveries"
      })
    ]);
    expect(snapshot.errors).toEqual([expect.stringContaining("pendingImportRecoveries:")]);
  });

  it("keeps snapshot fields when one first-screen part fails", async () => {
    const { root } = await createTestWorkspace();
    const workspace = await resolveTaskCanvasWorkspace(root, "default");
    await mkdir(join(workspace.workspaceRoot, "desktop"), { recursive: true });
    await writeFile(join(workspace.workspaceRoot, "desktop", "layout.json"), "{", "utf8");

    const snapshot = await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });

    expect(snapshot.projectPromptMarkdown).toContain("# Project Prompt");
    expect(snapshot.projectPromptPolicy).toEqual({ includeGlobalPrompt: true });
    expect(snapshot.graph?.tasks.map((task) => task.taskId)).toEqual(["T-001"]);
    expect(snapshot.layout).toBeNull();
    expect(snapshot.todoGroups).not.toBeNull();
    expect(snapshot.executionPlan).not.toBeNull();
    expect(snapshot.statistics).not.toBeNull();
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({ code: "desktop_snapshot_part_failed", path: "layout" })
    ]);
    expect(snapshot.errors).toEqual([expect.stringContaining("layout:")]);
  });

  it("reports statistics errors when a canvas execution snapshot fails", async () => {
    const { root } = await createTestWorkspace();
    const brokenCanvas = await createTaskCanvas(root, { name: "Broken imported canvas" });
    const brokenWorkspace = await resolveTaskCanvasWorkspace(root, brokenCanvas.canvasId);
    const invalidManifest = basicManifest() as unknown as {
      nodes: Array<{ blocks: Array<Record<string, unknown>> }>;
    };
    invalidManifest.nodes[0].blocks[0].type = "check";
    await writeJsonFile(brokenWorkspace.manifestFile, invalidManifest);

    const snapshot = await getDesktopProjectSnapshot({ projectRoot: root, canvasId: null });

    expect(snapshot.graph?.tasks.map((task) => task.taskId)).toEqual(["T-001"]);
    expect(snapshot.todoGroups?.ready.map((item) => item.ref)).toEqual([]);
    expect(snapshot.todoGroups?.planned.map((item) => item.ref)).toEqual([
      "T-001#B-001",
      "T-001#R-001"
    ]);
    expect(snapshot.todoGroups?.planned[0]?.dependencyBlockers).toEqual([
      expect.stringContaining("Project graph is invalid; no task canvas work can be claimed.")
    ]);
    expect(snapshot.executionPlan?.phases.map((phase) => phase.canvasId)).toEqual([
      "default",
      brokenCanvas.canvasId
    ]);
    expect(snapshot.statistics).toMatchObject({ taskTotal: 1, blockTotal: 2 });
    expect(snapshot.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "desktop_canvas_execution_snapshot_failed",
          path: brokenCanvas.canvasId
        })
      ])
    );
    expect(snapshot.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `${brokenCanvas.canvasId}: Canvas '${brokenCanvas.canvasId}' execution snapshot failed`
        )
      ])
    );
  });
});
