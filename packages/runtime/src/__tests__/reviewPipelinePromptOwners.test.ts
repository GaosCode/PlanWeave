import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getGraphViewModel,
  getReviewPipeline,
  redoDesktopPlanGraphCommand,
  undoDesktopPlanGraphCommand,
  updateReviewPipeline
} from "../desktop/index.js";
import {
  createSqlitePlanGraphStore,
  executePlanGraphCommand,
  redoPlanGraphCommand,
  undoPlanGraphCommand
} from "../plangraph/index.js";
import { defaultPlanGraphCommandDependencies } from "../plangraph/adapters.js";
import { openDatabase } from "../plangraph/sqlite/connection.js";
import { loadPackage } from "../package/loadPackage.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
});

async function historyPosition(root: string) {
  const store = await createSqlitePlanGraphStore({ projectRoot: root });
  const undo = await store.log.latestUndoable();
  const redo = await store.log.latestRedoable();
  return { cursor: undo?.id ?? null, redo: redo?.id ?? null, canUndo: !!undo, canRedo: !!redo };
}

describe("review writes to prompts owned outside the review pipeline", () => {
  it.each([
    "../outside.md",
    "/tmp/outside.md",
    "nodes/../../outside.md"
  ])("rejects restore outside the package at %s before mutation", async (packagePath) => {
    const f = await createTestWorkspace();
    const before = (await loadPackage(f.root)).manifest;
    const versionBefore = (await getGraphViewModel(f.root)).graphVersion;
    const task = before.nodes[0];
    if (task?.type !== "task") throw new Error("Task missing.");
    const path = join(f.init.workspace.packageDir, task.prompt);
    const bytesBefore = await readFile(path);
    const rejected = await executePlanGraphCommand({
      projectRoot: f.root,
      command: {
        type: "updateReviewPipeline",
        taskId: task.id,
        packageDefaults: before.review,
        reviewBlocks: [],
        promptMarkdownByBlockId: [],
        promptFileRestores: [{ packagePath, markdown: "# Escaped write\n" }]
      }
    });
    expect(rejected).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: "command_validation_failed",
          message: expect.stringMatching(/package directory|must be relative/)
        }
      ]
    });
    expect((await loadPackage(f.root)).manifest).toEqual(before);
    expect((await getGraphViewModel(f.root)).graphVersion).toBe(versionBefore);
    await expect(readFile(path)).resolves.toEqual(bytesBefore);
    expect(await historyPosition(f.root)).toEqual({
      cursor: null,
      redo: null,
      canUndo: false,
      canRedo: false
    });
  });

  it("rejects a corrupted persisted file snapshot without advancing history or changing files", async () => {
    const f = await createTestWorkspace();
    const target = "nodes/T-001/blocks/R-002.prompt.md";
    const path = join(f.init.workspace.packageDir, target);
    const before = "# Existing orphan before\r\n";
    await writeFile(path, before);
    const pipeline = await getReviewPipeline(f.root, "T-001");
    const step = pipeline.steps[0];
    if (!step) throw new Error("Review missing.");
    expect(
      (
        await updateReviewPipeline(f.root, "T-001", {
          packageDefaults: pipeline.packageDefaults,
          steps: [
            ...pipeline.steps,
            { ...step, blockId: "", blockRef: null, promptMarkdown: "# Forward\n" }
          ]
        })
      ).ok
    ).toBe(true);
    const store = await createSqlitePlanGraphStore({ projectRoot: f.root });
    const entry = await store.log.latestUndoable();
    if (!entry || Array.isArray(entry.inverse) || entry.inverse.type !== "updateReviewPipeline")
      throw new Error("Pipeline inverse missing.");
    expect(entry.inverse.promptFileRestores).toEqual([{ packagePath: target, markdown: before }]);
    const manifestAfter = (await loadPackage(f.root)).manifest;
    const positionAfter = await historyPosition(f.root);
    const db = await openDatabase(store.indexPath);
    try {
      db.prepare("UPDATE operation_log SET inverse_json = ? WHERE id = ?").run(
        JSON.stringify({
          ...entry.inverse,
          promptFileRestores: [{ packagePath: target, markdown: before, unknown: true }]
        }),
        entry.id
      );
    } finally {
      db.close();
    }
    const rejected = await undoPlanGraphCommand({ projectRoot: f.root });
    expect(rejected).toMatchObject({
      ok: false,
      diagnostics: [
        { code: "history_command_invalid", message: expect.stringContaining("promptFileRestores") }
      ]
    });
    expect((await loadPackage(f.root)).manifest).toEqual(manifestAfter);
    expect((await getGraphViewModel(f.root)).graphVersion).toBe(entry.graphVersionAfter);
    await expect(readFile(path, "utf8")).resolves.toBe("# Forward\n");
    const restoredDb = await openDatabase(store.indexPath);
    try {
      restoredDb
        .prepare("UPDATE operation_log SET inverse_json = ? WHERE id = ?")
        .run(JSON.stringify(entry.inverse), entry.id);
    } finally {
      restoredDb.close();
    }
    expect(await historyPosition(f.root)).toEqual(positionAfter);
    expect((await undoPlanGraphCommand({ projectRoot: f.root })).ok).toBe(true);
    await expect(readFile(path, "utf8")).resolves.toBe(before);
    expect((await redoPlanGraphCommand({ projectRoot: f.root })).ok).toBe(true);
    await expect(readFile(path, "utf8")).resolves.toBe("# Forward\n");
  });
  it.each([
    "shared",
    "normalized",
    "symlink"
  ])("restores one physical %s file with multiple owners and ordered writes atomically", async (alias) => {
    const manifest = basicManifest({ includeSecondTask: true });
    const task = manifest.nodes[0];
    const other = manifest.nodes[1];
    if (task?.type !== "task" || other?.type !== "task") throw new Error("Tasks missing.");
    const review = task.blocks.find((block) => block.type === "review");
    const implementation = task.blocks.find((block) => block.type === "implementation");
    if (!review || !implementation) throw new Error("Blocks missing.");
    const target = "nodes/T-001/blocks/R-002.prompt.md";
    const aliasPath =
      alias === "normalized"
        ? "nodes/T-001/blocks/../blocks/R-002.prompt.md"
        : alias === "symlink"
          ? "nodes/T-001/blocks/alias.prompt.md"
          : target;
    task.prompt = target;
    implementation.prompt = target;
    other.prompt = target;
    const f = await createTestWorkspace(manifest);
    const path = join(f.init.workspace.packageDir, target);
    if (alias === "symlink")
      await symlink("R-002.prompt.md", join(f.init.workspace.packageDir, aliasPath));
    const before = "# Original multiple owner bytes\r\n中文\n";
    await writeFile(path, before);
    const manifestBefore = (await loadPackage(f.root)).manifest;
    const versionBefore = (await getGraphViewModel(f.root)).graphVersion;
    const originalReview = await readFile(join(f.init.workspace.packageDir, review.prompt), "utf8");
    const first = { ...review, id: "R-002", prompt: target };
    const last = { ...review, id: "R-003", prompt: aliasPath };
    expect(
      (
        await executePlanGraphCommand({
          projectRoot: f.root,
          command: {
            type: "updateReviewPipeline",
            taskId: task.id,
            packageDefaults: manifest.review,
            reviewBlocks: [review, first, last],
            promptMarkdownByBlockId: [
              { blockId: review.id, markdown: originalReview },
              { blockId: first.id, markdown: "# Intermediate write\n" },
              { blockId: last.id, markdown: "# Final write\n" }
            ]
          }
        })
      ).ok
    ).toBe(true);
    const manifestAfter = (await loadPackage(f.root)).manifest;
    const versionAfter = (await getGraphViewModel(f.root)).graphVersion;
    const positionAfter = await historyPosition(f.root);
    const store = await createSqlitePlanGraphStore({ projectRoot: f.root });
    const entry = await store.log.latestUndoable();
    expect(entry?.inverse).toMatchObject({
      promptFileRestores: [{ packagePath: target, markdown: before }]
    });
    await expect(readFile(path, "utf8")).resolves.toBe("# Final write\n");
    const directory = "write-failure-directory";
    await mkdir(join(f.init.workspace.packageDir, directory));
    await expect(
      undoPlanGraphCommand({
        projectRoot: f.root,
        dependencies: {
          repository: {
            ...defaultPlanGraphCommandDependencies.repository,
            commit: (options) =>
              defaultPlanGraphCommandDependencies.repository.commit({
                ...options,
                mutation: {
                  ...options.mutation,
                  sideEffects: [
                    ...options.mutation.sideEffects,
                    { kind: "writePrompt", packagePath: directory, markdown: "fails" }
                  ]
                }
              })
          }
        }
      })
    ).rejects.toMatchObject({ code: "EISDIR" });
    expect((await loadPackage(f.root)).manifest).toEqual(manifestAfter);
    expect((await getGraphViewModel(f.root)).graphVersion).toBe(versionAfter);
    expect(await historyPosition(f.root)).toEqual(positionAfter);
    await expect(readFile(path, "utf8")).resolves.toBe("# Final write\n");
    await expect(readFile(join(f.init.workspace.packageDir, review.prompt), "utf8")).resolves.toBe(
      originalReview
    );
    for (let cycle = 0; cycle < 2; cycle++) {
      expect((await undoPlanGraphCommand({ projectRoot: f.root })).ok).toBe(true);
      await expect(readFile(path, "utf8")).resolves.toBe(before);
      expect((await loadPackage(f.root)).manifest).toEqual(manifestBefore);
      expect((await getGraphViewModel(f.root)).graphVersion).toBe(versionBefore);
      expect(await historyPosition(f.root)).toEqual({
        cursor: null,
        redo: positionAfter.cursor,
        canUndo: false,
        canRedo: true
      });
      expect((await redoPlanGraphCommand({ projectRoot: f.root })).ok).toBe(true);
      await expect(readFile(path, "utf8")).resolves.toBe("# Final write\n");
      await expect(readFile(join(f.init.workspace.packageDir, aliasPath), "utf8")).resolves.toBe(
        "# Final write\n"
      );
      expect((await loadPackage(f.root)).manifest).toEqual(manifestAfter);
      expect((await getGraphViewModel(f.root)).graphVersion).toBe(versionAfter);
      expect(await historyPosition(f.root)).toEqual(positionAfter);
    }
  });
  it.each(
    ["task", "implementation", "other-task", "unreferenced", "unreferenced-symlink"].flatMap(
      (owner) => ["append", "replace"].map((mode) => ({ owner, mode }))
    )
  )("restores $owner bytes through two $mode undo/redo cycles", async ({ owner, mode }) => {
    const manifest = basicManifest({ includeSecondTask: true });
    const task = manifest.nodes[0];
    const other = manifest.nodes[1];
    if (task?.type !== "task" || other?.type !== "task") throw new Error("Tasks missing.");
    const implementation = task.blocks.find((block) => block.type === "implementation");
    if (!implementation) throw new Error("Implementation missing.");
    const target = "nodes/T-001/blocks/R-002.prompt.md";
    if (owner === "task") task.prompt = target;
    else if (owner === "implementation") implementation.prompt = target;
    else if (owner === "other-task") other.prompt = target;
    const f = await createTestWorkspace(manifest);
    const path = join(f.init.workspace.packageDir, target);
    const before = Buffer.from("# Original owner\r\n中文\n\n");
    const after = Buffer.from("# Explicit Review edit\n新正文\n");
    if (owner === "unreferenced-symlink") {
      await writeFile(join(f.init.workspace.packageDir, "original-orphan.md"), before);
      await symlink("../../../original-orphan.md", path);
    }
    await writeFile(path, before);
    const manifestBefore = (await loadPackage(f.root)).manifest;
    const versionBefore = (await getGraphViewModel(f.root)).graphVersion;
    expect(await historyPosition(f.root)).toEqual({
      cursor: null,
      redo: null,
      canUndo: false,
      canRedo: false
    });
    const pipeline = await getReviewPipeline(f.root, task.id);
    const template = pipeline.steps[0];
    if (!template) throw new Error("Review missing.");
    const step = { ...template, blockId: "", blockRef: null, promptMarkdown: after.toString() };
    const forward = await updateReviewPipeline(f.root, task.id, {
      packageDefaults: pipeline.packageDefaults,
      steps: mode === "append" ? [...pipeline.steps, step] : [step]
    });
    expect(forward.ok).toBe(true);
    const manifestAfter = (await loadPackage(f.root)).manifest;
    const review = {
      id: "R-002",
      type: "review",
      title: template.title,
      prompt: target,
      depends_on: [mode === "append" ? "R-001" : "B-001"],
      review: {
        required: template.enabled,
        maxFeedbackCycles: template.maxFeedbackCycles,
        preset: template.preset,
        triggerCondition: template.triggerCondition,
        inputContext: template.inputContext,
        passCriteria: template.passCriteria,
        feedbackFormat: template.feedbackFormat,
        hook: template.hook
      }
    };
    expect(manifestAfter).toEqual({
      ...manifestBefore,
      nodes: manifestBefore.nodes.map((node) =>
        node.id !== task.id || node.type !== "task"
          ? node
          : {
              ...node,
              blocks: [
                ...node.blocks
                  .filter((block) => mode === "append" || block.type !== "review")
                  .map((block) =>
                    block.type === "review" ? { ...block, review: review.review } : block
                  ),
                review
              ]
            }
      )
    });
    const versionAfter = (await getGraphViewModel(f.root)).graphVersion;
    expect(versionAfter).not.toBe(versionBefore);
    const positionAfter = await historyPosition(f.root);
    expect(positionAfter).toEqual({
      cursor: expect.any(Number),
      redo: null,
      canUndo: true,
      canRedo: false
    });
    await expect(readFile(path)).resolves.toEqual(after);
    for (let cycle = 0; cycle < 2; cycle++) {
      const undo = await undoDesktopPlanGraphCommand(f.root);
      expect(undo.ok).toBe(true);
      await expect(readFile(path)).resolves.toEqual(before);
      if (owner === "unreferenced-symlink") {
        expect((await lstat(path)).isSymbolicLink()).toBe(true);
        await expect(
          readFile(join(f.init.workspace.packageDir, "original-orphan.md"))
        ).resolves.toEqual(before);
      }
      expect((await loadPackage(f.root)).manifest).toEqual(manifestBefore);
      expect(undo.graphVersion).toBe(versionBefore);
      expect((await getGraphViewModel(f.root)).graphVersion).toBe(versionBefore);
      expect(await historyPosition(f.root)).toEqual({
        cursor: null,
        redo: positionAfter.cursor,
        canUndo: false,
        canRedo: true
      });
      const redo = await redoDesktopPlanGraphCommand(f.root);
      expect(redo.ok).toBe(true);
      await expect(readFile(path)).resolves.toEqual(after);
      expect((await loadPackage(f.root)).manifest).toEqual(manifestAfter);
      expect(redo.graphVersion).toBe(versionAfter);
      expect((await getGraphViewModel(f.root)).graphVersion).toBe(versionAfter);
      expect(await historyPosition(f.root)).toEqual(positionAfter);
    }
  });
});
