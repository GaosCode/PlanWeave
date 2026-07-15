import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonFile } from "../json.js";
import { editBlock, editTask } from "../package/manifestEdit.js";
import type { PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

function taskById(manifest: PlanPackageManifest, taskId: string) {
  const task = manifest.nodes.find((node) => node.type === "task" && node.id === taskId);
  if (!task || task.type !== "task") {
    throw new Error(`Missing task '${taskId}'.`);
  }
  return task;
}

function blockById(manifest: PlanPackageManifest, taskId: string, blockId: string) {
  const block = taskById(manifest, taskId).blocks.find((item) => item.id === blockId);
  if (!block) {
    throw new Error(`Missing block '${taskId}#${blockId}'.`);
  }
  return block;
}

describe("manifest edit commands", () => {
  it("edits a task by exact task id and writes its prompt file", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));

    const result = await editTask({
      projectRoot: root,
      taskId: "T-001",
      title: "Updated task title",
      promptMarkdown: "# Updated task prompt\n",
      executor: "manual",
      acceptance: ["Updated acceptance one.", "Updated acceptance two."]
    });
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);

    expect(result).toMatchObject({
      ok: true,
      taskId: "T-001",
      updatedFields: ["title", "prompt", "executor", "acceptance"]
    });
    expect(taskById(manifest, "T-001")).toMatchObject({
      title: "Updated task title",
      executor: "manual",
      acceptance: ["Updated acceptance one.", "Updated acceptance two."]
    });
    expect(taskById(manifest, "T-002").title).toBe("Second task");
    await expect(
      readFile(join(init.workspace.packageDir, "nodes/T-001/prompt.md"), "utf8")
    ).resolves.toBe("# Updated task prompt\n");
  });

  it("edits only the review block addressed by the full block ref", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));

    const result = await editBlock({
      projectRoot: root,
      ref: "T-001#R-001",
      title: "Updated review",
      promptMarkdown: "# Updated review prompt\n",
      reviewRequired: false,
      maxFeedbackCycles: 4,
      reviewHook: {
        id: "strict-review",
        type: "executable",
        command: "node",
        args: ["scripts/review.js"],
        executionPolicy: "trusted-local"
      }
    });
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const edited = blockById(manifest, "T-001", "R-001");
    const untouchedSameId = blockById(manifest, "T-002", "R-001");

    expect(result).toMatchObject({
      ok: true,
      ref: "T-001#R-001",
      blockType: "review",
      updatedFields: [
        "title",
        "prompt",
        "review.required",
        "review.maxFeedbackCycles",
        "review.hook"
      ]
    });
    expect(edited).toMatchObject({
      title: "Updated review",
      review: {
        required: false,
        maxFeedbackCycles: 4,
        hook: {
          id: "strict-review",
          command: "node"
        }
      }
    });
    expect(untouchedSameId).toMatchObject({
      title: "Review second task",
      review: {
        required: true
      }
    });
    await expect(
      readFile(join(init.workspace.packageDir, "nodes/T-001/blocks/R-001.prompt.md"), "utf8")
    ).resolves.toBe("# Updated review prompt\n");
  });

  it("edits implementation parallel policy without accepting review-only fields", async () => {
    const { root, init } = await createTestWorkspace();

    await expect(
      editBlock({
        projectRoot: root,
        ref: "T-001#B-001",
        reviewRequired: false
      })
    ).resolves.toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: "command_validation_failed",
          message: "review fields can only be edited on review blocks."
        }
      ]
    });

    const result = await editBlock({
      projectRoot: root,
      ref: "T-001#B-001",
      dependsOn: [],
      sharedResources: ["db", "api", "db"]
    });
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);

    expect(result).toMatchObject({
      ok: true,
      ref: "T-001#B-001",
      blockType: "implementation",
      updatedFields: ["depends_on", "parallel.sharedResources"]
    });
    expect(blockById(manifest, "T-001", "B-001")).toMatchObject({
      depends_on: [],
      parallel: { sharedResources: ["db", "api"] }
    });
  });
});
