import { access, chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyPackageDraftImport,
  previewPackageDraftImport,
  validatePackageDraft
} from "../package/packageDraftImport.js";
import { ImportTransaction } from "../package/importTransaction.js";
import { bulkApplyReviewPipeline } from "../desktop/index.js";
import { inspectGraph } from "../graph/inspectGraph.js";
import { validateGraphQuality } from "../graph/validateGraphQuality.js";
import { validatePackage } from "../validatePackage.js";
import { writeJsonFile } from "../json.js";
import { projectGraphPath } from "../projectGraph/index.js";
import type { ManifestTaskNode, PlanPackageManifest, ProjectWorkspace } from "../types.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

async function createDraft(manifest: PlanPackageManifest): Promise<string> {
  const draftRoot = await mkdtemp(join(tmpdir(), "planweave-package-draft-"));
  await writeJsonFile(join(draftRoot, "manifest.json"), manifest);
  await writePromptFiles(draftRoot, manifest);
  return draftRoot;
}

async function readManifestTitle(packageDir: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(packageDir, "manifest.json"), "utf8")
  ) as PlanPackageManifest;
  return manifest.project.title;
}

async function packageImportRecoveryEntries(workspaceRoot: string): Promise<string[]> {
  try {
    return await readdir(join(workspaceRoot, "desktop", "recovery", "package-import"));
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : null;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return [];
    }
    throw error;
  }
}

async function createProjectDraft(
  options: { canvasIds?: string[]; extraUnreadableFile?: boolean } = {}
): Promise<string> {
  const draftRoot = await mkdtemp(join(tmpdir(), "planweave-project-draft-"));
  const canvasIds = options.canvasIds ?? ["default"];
  for (const canvasId of canvasIds) {
    const packageDir = join(draftRoot, "canvases", canvasId, "package");
    await mkdir(packageDir, { recursive: true });
    const manifest = basicManifest();
    await writeJsonFile(join(packageDir, "manifest.json"), manifest);
    await writePromptFiles(packageDir, manifest);
    if (options.extraUnreadableFile && canvasId === canvasIds[0]) {
      const unreadable = join(packageDir, "unreadable.txt");
      await writeFile(unreadable, "cannot copy\n", "utf8");
      await chmod(unreadable, 0o000);
    }
  }
  await writeJsonFile(join(draftRoot, "project-graph.json"), {
    version: "plan-project/v1",
    canvases: canvasIds.map((canvasId) => ({
      id: canvasId,
      type: "canvas",
      title: `Draft ${canvasId}`,
      packageDir: `canvases/${canvasId}/package`,
      stateFile: `canvases/${canvasId}/state.json`,
      resultsDir: `canvases/${canvasId}/results`
    })),
    edges: [],
    crossTaskEdges: []
  });
  return draftRoot;
}

async function addStaleCanvas(workspace: ProjectWorkspace) {
  const stalePackageDir = join(workspace.workspaceRoot, "canvases", "stale", "package");
  const staleStateFile = join(workspace.workspaceRoot, "canvases", "stale", "state.json");
  const staleResultsDir = join(workspace.workspaceRoot, "canvases", "stale", "results");
  await mkdir(stalePackageDir, { recursive: true });
  await writeJsonFile(join(stalePackageDir, "manifest.json"), basicManifest());
  await writePromptFiles(stalePackageDir, basicManifest());
  await writeJsonFile(staleStateFile, { currentRefs: ["STALE#B-001"] });
  await mkdir(staleResultsDir, { recursive: true });
  await writeFile(join(staleResultsDir, "old.txt"), "stale result\n", "utf8");
  await writeJsonFile(projectGraphPath(workspace), {
    version: "plan-project/v1",
    canvases: [
      {
        id: "default",
        type: "canvas",
        title: "Default",
        packageDir: "canvases/default/package",
        stateFile: "canvases/default/state.json",
        resultsDir: "canvases/default/results"
      },
      {
        id: "stale",
        type: "canvas",
        title: "Stale",
        packageDir: "canvases/stale/package",
        stateFile: "canvases/stale/state.json",
        resultsDir: "canvases/stale/results"
      }
    ],
    edges: [],
    crossTaskEdges: []
  });
  return { stalePackageDir, staleStateFile, staleResultsDir };
}

function taskId(index: number): string {
  return `T-${String(index).padStart(3, "0")}`;
}

function hundredTaskManifest(): PlanPackageManifest {
  const nodes: ManifestTaskNode[] = Array.from({ length: 100 }, (_, index) => {
    const number = index + 1;
    const id = taskId(number);
    return {
      id,
      type: "task",
      title: `Import acceptance task ${number}`,
      prompt: `nodes/${id}/prompt.md`,
      acceptance: [
        `Task ${number} writes a verifiable runtime result without relying on planning archives.`,
        `Task ${number} review confirms the implementation block output and dependency contract.`
      ],
      blocks: [
        {
          id: "B-001",
          type: "implementation",
          title: `Implement import acceptance task ${number}`,
          prompt: `nodes/${id}/blocks/B-001.prompt.md`,
          depends_on: [],
          parallel: { locks: [`acceptance-${id}`] }
        }
      ]
    };
  });

  return {
    version: "plan-package/v1",
    project: {
      title: "100 Task Import Acceptance",
      description: "Programmatic package draft used to prove large import acceptance."
    },
    execution: {
      parallel: {
        enabled: false,
        maxConcurrent: 1
      }
    },
    review: {
      maxFeedbackCycles: 1,
      completionPolicy: "strict"
    },
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      from: node.id,
      to: taskId(index + 1),
      type: "depends_on" as const
    }))
  };
}

function reviewPipelineUpdate(task: ManifestTaskNode) {
  return {
    taskId: task.id,
    input: {
      packageDefaults: {
        maxFeedbackCycles: 1,
        completionPolicy: "strict" as const
      },
      steps: [
        {
          title: `Review ${task.title}`,
          enabled: true,
          preset: "general",
          triggerCondition: "after_required_work_completed" as const,
          inputContext: "implementation block report and task acceptance criteria",
          passCriteria: "The implementation satisfies all task acceptance criteria.",
          feedbackFormat: "Actionable findings grouped by affected implementation block.",
          maxFeedbackCycles: 1,
          hook: null,
          promptMarkdown: `# Review ${task.id}\n\nReview the implementation block for ${task.title}.\n`
        }
      ]
    }
  };
}

describe("package draft import", () => {
  it("validates package-shaped draft roots and includes graph quality errors", async () => {
    const manifest = basicManifest({ includeSecondTask: true });
    manifest.edges = [{ from: "T-001", to: "MISSING", type: "depends_on" }];
    const draftRoot = await createDraft(manifest);

    const result = await validatePackageDraft({ draftRoot });

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("single-canvas");
    expect(result.validation.errors.map((issue) => issue.code)).toContain("edge_to_missing");
    expect(result.canvases[0]?.graphQuality?.ok).toBe(false);
    expect(
      result.canvases[0]?.graphQuality?.diagnostics.map((diagnostic) => diagnostic.code)
    ).toContain("edge_to_missing");
  });

  it("previews imports without writing target files", async () => {
    const { root, init } = await createTestWorkspace();
    const draftManifest = {
      ...basicManifest(),
      project: { title: "Draft Plan", description: "Imported draft" }
    };
    const draftRoot = await createDraft(draftManifest);

    const preview = await previewPackageDraftImport({ draftRoot, projectRoot: root });

    expect(preview.ok).toBe(true);
    expect(preview.target.canvasId).toBe("default");
    expect(preview.effects).toEqual(
      expect.arrayContaining([
        { type: "replace_package", path: "package" },
        { type: "reset_state", path: "state.json" },
        { type: "reset_results", path: "results" }
      ])
    );
    expect(preview.fileDiffs.map((diff) => diff.path)).toContain("package/manifest.json");
    expect(preview.summary.changed).toBeGreaterThan(0);
    expect(await readManifestTitle(init.workspace.packageDir)).toBe("Test Plan");
  });

  it("applies imports and leaves the target package valid with passing graph quality", async () => {
    const { root, init } = await createTestWorkspace();
    const draftManifest = {
      ...basicManifest(),
      project: { title: "Draft Plan", description: "Imported draft" }
    };
    const draftRoot = await createDraft(draftManifest);

    const applied = await applyPackageDraftImport({ draftRoot, projectRoot: root });
    const validation = await validatePackage({ projectRoot: root });
    const quality = await validateGraphQuality({ projectRoot: root });

    expect(applied).toMatchObject({ ok: true, applied: true, target: { canvasId: "default" } });
    expect(await readManifestTitle(init.workspace.packageDir)).toBe("Draft Plan");
    expect(validation.ok).toBe(true);
    expect(quality.ok).toBe(true);
    expect(await packageImportRecoveryEntries(init.workspace.workspaceRoot)).toEqual([]);
  });

  it("does not write target files when validation fails before apply", async () => {
    const { root, init } = await createTestWorkspace();
    const manifest = basicManifest({ includeSecondTask: true });
    manifest.edges = [{ from: "T-001", to: "MISSING", type: "depends_on" }];
    const draftRoot = await createDraft(manifest);

    const applied = await applyPackageDraftImport({ draftRoot, projectRoot: root });

    expect(applied.applied).toBe(false);
    expect(applied.ok).toBe(false);
    expect(await readManifestTitle(init.workspace.packageDir)).toBe("Test Plan");
  });

  it("rolls back project graph files when apply fails after partial replacement", async () => {
    const { root, init } = await createTestWorkspace();
    const draftRoot = await createProjectDraft({ extraUnreadableFile: true });

    await expect(applyPackageDraftImport({ draftRoot, projectRoot: root })).rejects.toThrow();

    const projectGraph = JSON.parse(await readFile(projectGraphPath(init.workspace), "utf8")) as {
      canvases: Array<{ title: string }>;
    };
    expect(projectGraph.canvases[0]?.title).toBe("Test Plan");
  });

  it("rolls back after project graph replacement when a later canvas cannot be written", async () => {
    const { root, init } = await createTestWorkspace();
    const draftRoot = await createProjectDraft({ canvasIds: ["default", "blocked"] });
    const blockerParent = join(init.workspace.workspaceRoot, "canvases");
    await mkdir(blockerParent, { recursive: true });
    await writeFile(join(blockerParent, "blocked"), "not a directory\n", "utf8");

    await expect(applyPackageDraftImport({ draftRoot, projectRoot: root })).rejects.toThrow();

    const projectGraph = JSON.parse(await readFile(projectGraphPath(init.workspace), "utf8")) as {
      canvases: Array<{ id: string; title: string }>;
    };
    expect(projectGraph.canvases.map((canvas) => canvas.id)).toEqual(["default"]);
    expect(projectGraph.canvases[0]?.title).toBe("Test Plan");
  });

  it("validates project-shaped draft roots", async () => {
    const draftRoot = await createProjectDraft();
    await writeFile(join(draftRoot, "README.md"), "# Draft\n", "utf8");

    const result = await validatePackageDraft({ draftRoot });

    expect(result).toMatchObject({
      ok: true,
      mode: "project",
      canvases: [{ canvasId: "default", validation: { ok: true }, graphQuality: { ok: true } }]
    });
  });

  it("previews and applies project-shaped imports without stale workspace diff drift", async () => {
    const { root, init } = await createTestWorkspace();
    const { stalePackageDir, staleStateFile, staleResultsDir } = await addStaleCanvas(
      init.workspace
    );
    const draftRoot = await createProjectDraft();

    const preview = await previewPackageDraftImport({ draftRoot, projectRoot: root });
    const applied = await applyPackageDraftImport({ draftRoot, projectRoot: root });

    expect(preview.fileDiffs.map((diff) => diff.path)).not.toContain("project.json");
    expect(preview.fileDiffs).toContainEqual({
      path: "canvases/stale/package/manifest.json",
      type: "removed"
    });
    expect(preview.fileDiffs).toContainEqual({
      path: "canvases/stale/state.json",
      type: "removed"
    });
    expect(preview.fileDiffs).toContainEqual({
      path: "canvases/stale/results/old.txt",
      type: "removed"
    });
    expect(preview.effects).toContainEqual({ type: "remove_canvas", path: "stale" });
    expect(applied.applied).toBe(true);
    await expect(access(stalePackageDir)).rejects.toThrow();
    await expect(access(staleStateFile)).rejects.toThrow();
    await expect(access(staleResultsDir)).rejects.toThrow();
    expect(await packageImportRecoveryEntries(init.workspace.workspaceRoot)).toEqual([]);
  });

  it("restores stale canvas removal when a later canvas write fails", async () => {
    const { root, init } = await createTestWorkspace();
    const { stalePackageDir, staleStateFile, staleResultsDir } = await addStaleCanvas(
      init.workspace
    );
    const draftRoot = await createProjectDraft({ canvasIds: ["default", "blocked"] });
    await writeFile(
      join(init.workspace.workspaceRoot, "canvases", "blocked"),
      "not a directory\n",
      "utf8"
    );

    await expect(applyPackageDraftImport({ draftRoot, projectRoot: root })).rejects.toThrow(
      "Package draft import apply failed"
    );

    const projectGraph = JSON.parse(await readFile(projectGraphPath(init.workspace), "utf8")) as {
      canvases: Array<{ id: string }>;
    };
    expect(projectGraph.canvases.map((canvas) => canvas.id)).toEqual(["default", "stale"]);
    expect(await readFile(join(stalePackageDir, "manifest.json"), "utf8")).toContain("Test Plan");
    expect(await readFile(staleStateFile, "utf8")).toContain("STALE#B-001");
    expect(await readFile(join(staleResultsDir, "old.txt"), "utf8")).toBe("stale result\n");
    expect(await packageImportRecoveryEntries(init.workspace.workspaceRoot)).toEqual([]);
  });

  it("reports import and rollback failures", async () => {
    const { root, init } = await createTestWorkspace();
    const draftRoot = await createProjectDraft({ canvasIds: ["default", "blocked"] });
    await writeFile(
      join(init.workspace.workspaceRoot, "canvases", "blocked"),
      "not a directory\n",
      "utf8"
    );
    const rollbackSpy = vi
      .spyOn(ImportTransaction.prototype, "rollback")
      .mockRejectedValueOnce(new Error("rollback failed"));

    try {
      await expect(applyPackageDraftImport({ draftRoot, projectRoot: root })).rejects.toThrow(
        /Package draft import apply failed: .*rollback failed: rollback failed/
      );
    } finally {
      rollbackSpy.mockRestore();
    }

    const entries = await packageImportRecoveryEntries(init.workspace.workspaceRoot);
    expect(entries).toHaveLength(1);
    await expect(
      access(
        join(
          init.workspace.workspaceRoot,
          "desktop",
          "recovery",
          "package-import",
          entries[0] ?? "",
          "recovery.json"
        )
      )
    ).resolves.toBeUndefined();
  });

  it("applies bulk review pipeline coverage to a 100-task implementation-only draft", async () => {
    const { root, init } = await createTestWorkspace();
    const draftManifest = hundredTaskManifest();
    const draftRoot = await createDraft(draftManifest);

    const draftValidation = await validatePackageDraft({ draftRoot });
    const draftCanvas = draftValidation.canvases[0];

    expect(draftValidation).toMatchObject({ ok: true, mode: "single-canvas" });
    expect(draftCanvas?.validation.ok).toBe(true);
    expect(draftCanvas?.graphQuality?.ok).toBe(true);
    expect(draftCanvas?.graphQuality?.summary).toMatchObject({
      taskCount: 100,
      blockCount: 100,
      taskDependencyCount: 99,
      reviewBlockCount: 0,
      errorCount: 0
    });
    expect(draftCanvas?.graphQuality?.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "task_missing_review_block",
        count: 100
      })
    );

    const preview = await previewPackageDraftImport({ draftRoot, projectRoot: root });

    expect(preview.ok).toBe(true);
    expect(preview.summary.changed).toBeGreaterThan(0);
    expect(preview.summary.added).toBeGreaterThan(0);
    expect(preview.effects).toEqual(
      expect.arrayContaining([
        { type: "replace_package", path: "package" },
        { type: "reset_state", path: "state.json" },
        { type: "reset_results", path: "results" }
      ])
    );
    expect(await readManifestTitle(init.workspace.packageDir)).toBe("Test Plan");
    await expect(
      access(join(init.workspace.packageDir, "nodes", taskId(100), "prompt.md"))
    ).rejects.toThrow();

    const applied = await applyPackageDraftImport({ draftRoot, projectRoot: root });
    expect(applied).toMatchObject({ ok: true, applied: true, target: { canvasId: "default" } });

    const draftTasks = draftManifest.nodes.filter(
      (node): node is ManifestTaskNode => node.type === "task"
    );
    const reviewUpdates = draftTasks.map((node) => reviewPipelineUpdate(node));
    await expect(bulkApplyReviewPipeline(root, reviewUpdates)).resolves.toMatchObject({
      ok: true,
      affectedTasks: draftTasks.map((node) => node.id)
    });
    await expect(bulkApplyReviewPipeline(root, reviewUpdates)).resolves.toMatchObject({ ok: true });

    const validation = await validatePackage({ projectRoot: root });
    const quality = await validateGraphQuality({ projectRoot: root });
    const summary = await inspectGraph({ projectRoot: root, view: "summary", limit: 5 });
    const finalTaskSlice = await inspectGraph({
      projectRoot: root,
      view: "slice",
      taskId: taskId(100),
      limit: 5
    });

    expect(validation.ok).toBe(true);
    expect(quality.ok).toBe(true);
    expect(quality.summary).toMatchObject({
      taskCount: 100,
      blockCount: 200,
      taskDependencyCount: 99,
      reviewBlockCount: 100,
      errorCount: 0
    });
    expect(summary.counts).toMatchObject({
      taskCount: 100,
      blockCount: 200,
      taskDependencyCount: 99,
      reviewBlockCount: 100,
      diagnosticCount: 0
    });
    expect(summary.tasksPreview).toHaveLength(5);
    expect(summary.page).toMatchObject({ total: 100, nextCursor: "next:5", truncated: true });
    expect(JSON.stringify(summary)).not.toContain("writes a verifiable runtime result");
    expect(finalTaskSlice.center.dependsOn).toEqual([taskId(99)]);
    expect(finalTaskSlice.edges.items).toEqual([
      { from: taskId(100), to: taskId(99), type: "depends_on" }
    ]);
    expect(finalTaskSlice.blocks.items).toEqual([
      expect.objectContaining({
        ref: `${taskId(100)}#B-001`,
        type: "implementation",
        dependsOn: []
      }),
      expect.objectContaining({ type: "review", dependsOn: [`${taskId(100)}#B-001`] })
    ]);

    const appliedManifest = JSON.parse(
      await readFile(join(init.workspace.packageDir, "manifest.json"), "utf8")
    ) as PlanPackageManifest;
    const tasks = appliedManifest.nodes.filter(
      (node): node is ManifestTaskNode => node.type === "task"
    );

    expect(tasks).toHaveLength(100);
    expect(appliedManifest.edges).toHaveLength(99);
    expect(appliedManifest.edges).toContainEqual({
      from: taskId(2),
      to: taskId(1),
      type: "depends_on"
    });
    expect(appliedManifest.edges).toContainEqual({
      from: taskId(100),
      to: taskId(99),
      type: "depends_on"
    });
    for (const task of tasks) {
      const implementations = task.blocks.filter((block) => block.type === "implementation");
      const reviews = task.blocks.filter((block) => block.type === "review");

      expect(task.title.trim()).not.toBe("");
      expect(task.acceptance.length).toBeGreaterThan(0);
      expect(task.acceptance.every((item) => item.trim() !== "")).toBe(true);
      expect(implementations).toHaveLength(1);
      expect(reviews).toHaveLength(1);
      const implementation = implementations[0];
      const review = reviews[0];
      if (!implementation || !review) {
        throw new Error(`Task '${task.id}' is missing implementation or review block.`);
      }
      expect(review.depends_on).toEqual([implementation.id]);
    }
  });
});
