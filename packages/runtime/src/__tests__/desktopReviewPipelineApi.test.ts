import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getReviewPipeline, updateReviewPipeline } from "../desktop/index.js";
import { readJsonFile } from "../json.js";
import type { PlanPackageManifest } from "../types.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

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
});
