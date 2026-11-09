import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getReviewPipeline,
  undoDesktopPlanGraphCommand,
  updateReviewPipeline
} from "../desktop/index.js";
import { executePlanGraphCommand } from "../plangraph/executeCommand.js";
import { createSqlitePlanGraphStore } from "../plangraph/index.js";
import { readJsonFile } from "../json.js";
import type { PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("desktop review pipeline API", () => {
  it("updates review pipeline steps through generic review blocks", async () => {
    const { root, init } = await createTestWorkspace();

    const pipeline = await getReviewPipeline(root, "T-001");
    expect(pipeline).toMatchObject({
      taskId: "T-001",
      packageDefaults: { maxFeedbackCycles: 1, completionPolicy: "strict" },
      steps: [
        expect.objectContaining({
          blockRef: "T-001#R-001",
          enabled: true,
          preset: "general",
          triggerCondition: "after_required_work_completed"
        })
      ]
    });

    await expect(
      updateReviewPipeline(root, "T-001", {
        packageDefaults: {
          maxFeedbackCycles: 3,
          completionPolicy: "strict"
        },
        steps: [
          {
            ...pipeline.steps[0],
            title: "Architecture review",
            enabled: false,
            preset: "architecture",
            triggerCondition: "manual",
            inputContext: "implementation reports and changed files",
            passCriteria: "Architecture boundaries remain clear.",
            feedbackFormat: "Concrete changes by file.",
            maxFeedbackCycles: 2,
            promptMarkdown: "# Architecture review\n"
          },
          {
            blockId: "",
            title: "Security review",
            enabled: true,
            preset: "security",
            triggerCondition: "after_required_work_completed",
            inputContext: "implementation reports",
            passCriteria: "No obvious security regression.",
            feedbackFormat: "Security findings with severity.",
            maxFeedbackCycles: 1,
            hook: {
              id: "security-hook",
              type: "executable",
              command: "node",
              args: ["security-check.js"],
              executionPolicy: "trusted-local"
            },
            promptMarkdown: "# Security review\n"
          }
        ]
      })
    ).resolves.toMatchObject({ ok: true, affectedTasks: ["T-001"] });

    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.review).toEqual({ maxFeedbackCycles: 3, completionPolicy: "strict" });
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    const reviews = task.blocks.filter((block) => block.type === "review");
    expect(reviews).toHaveLength(2);
    expect(reviews[0]).toMatchObject({
      id: "R-001",
      title: "Architecture review",
      depends_on: ["B-001"],
      review: {
        required: false,
        maxFeedbackCycles: 2,
        preset: "architecture",
        triggerCondition: "manual",
        passCriteria: "Architecture boundaries remain clear."
      }
    });
    expect(reviews[1]).toMatchObject({
      id: "R-002",
      title: "Security review",
      depends_on: ["R-001"],
      review: {
        required: true,
        hook: { id: "security-hook", command: "node" }
      }
    });
    await expect(
      readFile(
        join(init.workspace.packageDir, "nodes", "T-001", "blocks", "R-001.prompt.md"),
        "utf8"
      )
    ).resolves.toBe("# Architecture review\n");
    await expect(
      readFile(
        join(init.workspace.packageDir, "nodes", "T-001", "blocks", "R-002.prompt.md"),
        "utf8"
      )
    ).resolves.toBe("# Security review\n");
  });

  it("allows clearing all review steps from a task", async () => {
    const { root, init } = await createTestWorkspace();

    await expect(
      updateReviewPipeline(root, "T-001", {
        packageDefaults: {
          maxFeedbackCycles: 1,
          completionPolicy: "strict"
        },
        steps: []
      })
    ).resolves.toMatchObject({ ok: true, affectedTasks: ["T-001"] });

    await expect(getReviewPipeline(root, "T-001")).resolves.toMatchObject({
      taskId: "T-001",
      steps: []
    });
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(task.blocks.map((block) => block.type)).toEqual(["implementation"]);
    await expect(
      readFile(
        join(init.workspace.packageDir, "nodes", "T-001", "blocks", "R-001.prompt.md"),
        "utf8"
      )
    ).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it.each([
    "task",
    "block",
    "normalized",
    "symlink"
  ])("replays a removed review pipeline inverse without overwriting a surviving %s reference", async (reference) => {
    const manifest = basicManifest({ includeSecondTask: true });
    const task = manifest.nodes[0];
    const survivor = manifest.nodes[1];
    if (task?.type !== "task" || survivor?.type !== "task")
      throw new Error("Fixture tasks missing.");
    const review = task.blocks.find((block) => block.type === "review");
    const survivorBlock = survivor.blocks[0];
    if (!review || !survivorBlock) throw new Error("Fixture blocks missing.");
    if (reference === "block") survivorBlock.prompt = review.prompt;
    else
      survivor.prompt =
        reference === "normalized"
          ? "nodes/T-002/../T-001/blocks/R-001.prompt.md"
          : reference === "symlink"
            ? "nodes/T-002/prompt.md"
            : review.prompt;
    const { root, init } = await createTestWorkspace(manifest);
    const reviewPath = join(init.workspace.packageDir, review.prompt);
    if (reference === "symlink") {
      const alias = join(init.workspace.packageDir, survivor.prompt);
      await rm(alias);
      await symlink("../T-001/blocks/R-001.prompt.md", alias);
    }
    await expect(
      updateReviewPipeline(root, task.id, { packageDefaults: manifest.review, steps: [] })
    ).resolves.toMatchObject({ ok: true });
    const store = await createSqlitePlanGraphStore({ projectRoot: root });
    const entry = await store.log.latestUndoable();
    if (!entry || Array.isArray(entry.inverse)) throw new Error("Saved pipeline inverse missing.");
    expect(entry.inverse.type).toBe("updateReviewPipeline");
    const expected = "# Surviving review reference edited after deletion\n中文\n";
    await writeFile(reviewPath, expected);

    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "graph_version_conflict" })]
    });
    await expect(readFile(reviewPath, "utf8")).resolves.toBe(expected);
    await expect(
      executePlanGraphCommand({ projectRoot: root, command: entry.inverse })
    ).resolves.toMatchObject({ ok: true });
    await expect(readFile(reviewPath, "utf8")).resolves.toBe(expected);
    const survivorPath = reference === "block" ? survivorBlock.prompt : survivor.prompt;
    await expect(readFile(join(init.workspace.packageDir, survivorPath), "utf8")).resolves.toBe(
      expected
    );
    const restored = await getReviewPipeline(root, task.id);
    expect(restored.steps).toEqual([
      expect.objectContaining({ blockId: review.id, promptMarkdown: expected })
    ]);
    const restoredManifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const restoredTask = restoredManifest.nodes.find(
      (node) => node.type === "task" && node.id === task.id
    );
    expect(restoredTask?.blocks).toContainEqual(review);
  });

  it.each([
    "task",
    "block"
  ])("writes explicit pipeline prompt edits even when an existing review shares a %s reference", async (reference) => {
    const manifest = basicManifest({ includeSecondTask: true });
    const task = manifest.nodes[0];
    const survivor = manifest.nodes[1];
    if (task?.type !== "task" || survivor?.type !== "task")
      throw new Error("Fixture tasks missing.");
    const review = task.blocks.find((block) => block.type === "review");
    const survivorBlock = survivor.blocks[0];
    if (!review || !survivorBlock) throw new Error("Fixture blocks missing.");
    if (reference === "task") survivor.prompt = review.prompt;
    else survivorBlock.prompt = review.prompt;
    const { root, init } = await createTestWorkspace(manifest);
    const pipeline = await getReviewPipeline(root, task.id);
    const expected = "# Explicit current review edit\n中文\n";
    await expect(
      updateReviewPipeline(root, task.id, {
        packageDefaults: pipeline.packageDefaults,
        steps: pipeline.steps.map((step) => ({ ...step, promptMarkdown: expected }))
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(init.workspace.packageDir, review.prompt), "utf8")).resolves.toBe(
      expected
    );
    const survivorPath = reference === "task" ? survivor.prompt : survivorBlock.prompt;
    await expect(readFile(join(init.workspace.packageDir, survivorPath), "utf8")).resolves.toBe(
      expected
    );
  });

  it.each([
    "existing-path-change",
    "replace-review"
  ])("writes an explicit %s pipeline prompt", async (mode) => {
    const manifest = basicManifest({ includeSecondTask: true });
    const task = manifest.nodes[0];
    const survivor = manifest.nodes[1];
    if (task?.type !== "task" || survivor?.type !== "task")
      throw new Error("Fixture tasks missing.");
    const review = task.blocks.find((block) => block.type === "review");
    if (!review) throw new Error("Fixture review missing.");
    const { root, init } = await createTestWorkspace(manifest);
    const nextReview =
      mode === "existing-path-change"
        ? { ...review, prompt: survivor.prompt }
        : { ...review, id: "R-002" };
    const expected = "# Explicit pipeline target content\n中文\n";
    await expect(
      executePlanGraphCommand({
        projectRoot: root,
        command: {
          type: "updateReviewPipeline",
          taskId: task.id,
          packageDefaults: manifest.review,
          reviewBlocks: [nextReview],
          promptMarkdownByBlockId: [{ blockId: nextReview.id, markdown: expected }]
        }
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      readFile(join(init.workspace.packageDir, nextReview.prompt), "utf8")
    ).resolves.toBe(expected);
    await expect(getReviewPipeline(root, task.id)).resolves.toMatchObject({
      steps: [expect.objectContaining({ blockId: nextReview.id, promptMarkdown: expected })]
    });
  });

  it.each(
    ["shared", "normalized", "symlink"].flatMap((reference) => [
      { reference, reverse: false },
      { reference, reverse: true }
    ])
  )("restores same-pipeline $reference snapshots safely (reverse: $reverse)", async ({
    reference,
    reverse
  }) => {
    const manifest = basicManifest();
    const task = manifest.nodes[0];
    if (task?.type !== "task") throw new Error("Fixture task missing.");
    const removed = task.blocks.find((block) => block.type === "review");
    const implementation = task.blocks.find((block) => block.type === "implementation");
    if (!removed || !implementation) throw new Error("Fixture blocks missing.");
    const survivor = {
      ...removed,
      id: "R-002",
      title: "Surviving review",
      prompt:
        reference === "normalized"
          ? "nodes/T-001/blocks/../blocks/R-001.prompt.md"
          : reference === "symlink"
            ? "nodes/T-001/blocks/alias.prompt.md"
            : removed.prompt
    };
    task.blocks = [implementation, ...(reverse ? [survivor, removed] : [removed, survivor])];
    const { root, init } = await createTestWorkspace(manifest);
    const shared = join(init.workspace.packageDir, removed.prompt);
    if (reference === "symlink") {
      const alias = join(init.workspace.packageDir, survivor.prompt);
      await rm(alias);
      await symlink("R-001.prompt.md", alias);
    }
    const before = await readFile(shared, "utf8");
    await expect(
      executePlanGraphCommand({
        projectRoot: root,
        command: {
          type: "updateReviewPipeline",
          taskId: task.id,
          packageDefaults: manifest.review,
          reviewBlocks: [survivor],
          promptMarkdownByBlockId: [{ blockId: survivor.id, markdown: before }]
        }
      })
    ).resolves.toMatchObject({ ok: true });
    const store = await createSqlitePlanGraphStore({ projectRoot: root });
    const entry = await store.log.latestUndoable();
    if (!entry || Array.isArray(entry.inverse)) throw new Error("Saved inverse missing.");
    const expected = "# Surviving same-pipeline review edited after deletion\n中文\n";
    await writeFile(shared, expected);
    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "graph_version_conflict" })]
    });
    await expect(
      executePlanGraphCommand({ projectRoot: root, command: entry.inverse })
    ).resolves.toMatchObject({ ok: true });
    await expect(readFile(shared, "utf8")).resolves.toBe(expected);
    await expect(readFile(join(init.workspace.packageDir, survivor.prompt), "utf8")).resolves.toBe(
      expected
    );
    const restored = await getReviewPipeline(root, task.id);
    expect(restored.steps.map((step) => step.blockId)).toEqual(
      reverse ? [survivor.id, removed.id] : [removed.id, survivor.id]
    );
    expect(restored.steps.map((step) => step.promptMarkdown)).toEqual([expected, expected]);
  });

  it.each([
    false,
    true
  ])("writes explicit simultaneous new-review and surviving-review edits (reverse: %s)", async (reverse) => {
    const manifest = basicManifest();
    const task = manifest.nodes[0];
    if (task?.type !== "task") throw new Error("Fixture task missing.");
    const survivor = task.blocks.find((block) => block.type === "review");
    if (!survivor) throw new Error("Fixture review missing.");
    const added = {
      ...survivor,
      id: "R-002",
      prompt: "nodes/T-001/blocks/../blocks/R-001.prompt.md"
    };
    const { root, init } = await createTestWorkspace(manifest);
    const expected = "# Explicit added and retained review edit\n中文\n";
    const reviews = reverse ? [added, survivor] : [survivor, added];
    await expect(
      executePlanGraphCommand({
        projectRoot: root,
        command: {
          type: "updateReviewPipeline",
          taskId: task.id,
          packageDefaults: manifest.review,
          reviewBlocks: reviews,
          promptMarkdownByBlockId: reviews.map((block) => ({
            blockId: block.id,
            markdown: expected
          }))
        }
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(init.workspace.packageDir, survivor.prompt), "utf8")).resolves.toBe(
      expected
    );
  });
});
