import { describe, expect, it } from "vitest";
import { claimNext, explainBlock, getCurrentWork, getExecutionStatus, submitBlockResult, submitReviewResult } from "../taskManager/index.js";
import { basicManifest, createTestWorkspace, writeReport, writeReviewResult } from "./promptTestHelpers.js";

describe("executor API helpers", () => {
  it("previews claim-next without mutating state", async () => {
    const { root } = await createTestWorkspace(basicManifest({ parallel: true }));

    const preview = await claimNext({ projectRoot: root, parallel: true, dryRun: true });
    const status = await getExecutionStatus({ projectRoot: root });

    expect(preview).toEqual({ kind: "batch", refs: ["T-001#B-001"] });
    expect(status.currentRefs).toEqual([]);
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")?.status).toBe("ready");
  });

  it("explains why a block is or is not claimable", async () => {
    const { root } = await createTestWorkspace(basicManifest({ includeSecondTask: true, taskDependsOn: ["T-002"] }));

    const explanation = await explainBlock({ projectRoot: root, ref: "T-001#B-001" });

    expect(explanation).toMatchObject({
      ref: "T-001#B-001",
      ready: false,
      blockedByTasks: ["T-002"],
      recommendedCommand: null,
      submitCommand: "planweave submit-result T-001#B-001 --report <report.md>"
    });
    expect(explanation.promptPath).toContain("nodes/T-001/blocks/B-001.prompt.md");
  });

  it("reports the current executable block with prompt and submit command", async () => {
    const { root } = await createTestWorkspace();

    await claimNext({ projectRoot: root });

    expect(await getCurrentWork({ projectRoot: root })).toMatchObject({
      currentRefs: ["T-001#B-001"],
      currentFeedbackId: null,
      owner: {
        canvasId: null,
        taskIds: ["T-001"]
      },
      items: [
        {
          kind: "block",
          ref: "T-001#B-001",
          promptPath: expect.stringContaining("nodes/T-001/blocks/B-001.prompt.md"),
          reportPath: "<report.md>",
          submitCommand: "planweave submit-result T-001#B-001 --report <report.md>"
        }
      ]
    });
  });

  it("reports review submit commands for current review blocks", async () => {
    const { root } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "b.md") });
    await claimNext({ projectRoot: root });
    await submitBlockResult({ projectRoot: root, ref: "T-001#C-001", reportPath: await writeReport(root, "c.md") });
    await claimNext({ projectRoot: root });

    expect(await getCurrentWork({ projectRoot: root })).toMatchObject({
      currentRefs: ["T-001#R-001"],
      items: [
        {
          kind: "block",
          ref: "T-001#R-001",
          reportPath: "<review-result.json>",
          submitCommand: "planweave submit-review T-001#R-001 --result <review-result.json>"
        }
      ]
    });
  });

  it("reports active feedback as executable current work", async () => {
    const { root } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "b.md") });
    await claimNext({ projectRoot: root });
    await submitBlockResult({ projectRoot: root, ref: "T-001#C-001", reportPath: await writeReport(root, "c.md") });
    await claimNext({ projectRoot: root });
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Fix the implementation.")
    });
    await claimNext({ projectRoot: root });

    expect(await getCurrentWork({ projectRoot: root })).toMatchObject({
      currentRefs: [],
      currentFeedbackId: "FE-001",
      owner: {
        canvasId: null,
        taskIds: ["T-001"]
      },
      items: [
        {
          kind: "feedback",
          feedbackId: "FE-001",
          sourceReviewBlockRef: "T-001#R-001",
          taskId: "T-001",
          promptPath: expect.stringContaining("results/T-001/feedback/FE-001/feedback.json"),
          reportPath: "<feedback-report.md>",
          submitCommand: "planweave submit-feedback --report <feedback-report.md>"
        }
      ]
    });
  });

  it("explains review blocks as gates", async () => {
    const { root } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "b.md") });
    await claimNext({ projectRoot: root });
    await submitBlockResult({ projectRoot: root, ref: "T-001#C-001", reportPath: await writeReport(root, "c.md") });

    expect(await explainBlock({ projectRoot: root, ref: "T-001#R-001" })).toMatchObject({
      reviewGate: {
        isGate: true,
        required: true,
        requiredReason: "Required review gate for task completion.",
        executorRole: "reviewer",
        needsChangesReturnsTo: ["T-001#B-001", "T-001#C-001"]
      }
    });
  });
});
