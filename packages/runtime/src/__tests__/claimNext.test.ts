import { describe, expect, it } from "vitest";
import {
  claimBlock,
  claimBlockType,
  claimNext,
  claimTask,
  getExecutionStatus,
  renderPrompt,
  submitBlockResult,
  submitReviewResult,
  submitFeedback
} from "../taskManager/index.js";
import { basicManifest, createTestWorkspace, writeReport, writeReviewResult } from "./promptTestHelpers.js";

describe("claimNext", () => {
  it("returns JSON block claims in execution order", async () => {
    const { root } = await createTestWorkspace();

    const first = await claimNext({ projectRoot: root });

    expect(first).toEqual({
      kind: "block",
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      blockType: "implementation",
      reason: "claimed"
    });
  });

  it("continues the same review block after feedback is resolved", async () => {
    const { root } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "b.md") });
    await claimNext({ projectRoot: root });
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Please update tests.")
    });

    expect(await claimNext({ projectRoot: root })).toEqual({
      kind: "feedback",
      feedbackId: "FE-001",
      sourceReviewBlockRef: "T-001#R-001",
      taskId: "T-001",
      content: "Please update tests."
    });
    await submitFeedback({ projectRoot: root, reportPath: await writeReport(root, "feedback.md", "Tests updated.\n") });

    const reviewClaim = await claimNext({ projectRoot: root });
    const prompt = await renderPrompt({ projectRoot: root, ref: "T-001#R-001" });

    expect(reviewClaim).toMatchObject({ kind: "block", ref: "T-001#R-001", reason: "feedback_resolved" });
    expect(prompt).toContain("Focused Re-review Context");
    expect(prompt).toContain("Please update tests.");
    expect(prompt).toContain("Tests updated.");
  });

  it("reports blocked claims before returning none", async () => {
    const { root } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "b.md") });
    await claimNext({ projectRoot: root });

    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.blocks.find((block) => block.ref === "T-001#R-001")?.status).toBe("in_progress");
  });

  it("does not auto-claim optional review blocks", async () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    const reviewBlock = task?.blocks.find((block) => block.type === "review");
    expect(reviewBlock?.type).toBe("review");
    if (reviewBlock?.type === "review") {
      reviewBlock.review.required = false;
    }

    const { root } = await createTestWorkspace(manifest);
    await claimNext({ projectRoot: root });
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "b.md") });

    expect(await claimNext({ projectRoot: root })).toEqual({ kind: "none", reason: "no_claimable_blocks" });

    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.tasks.find((taskStatus) => taskStatus.taskId === "T-001")?.status).toBe("implemented");
    expect(status.blocks.find((block) => block.ref === "T-001#R-001")?.status).toBe("ready");
    expect(status.nextClaimable).not.toContain("T-001#R-001");
  });

  it("falls back to a sequential review claim when no parallel implementation block is available", async () => {
    const { root } = await createTestWorkspace(basicManifest({ parallel: true }));
    await claimNext({ projectRoot: root, parallel: true });
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "b.md") });

    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.nextClaimable).toEqual(["T-001#R-001"]);

    expect(await claimNext({ projectRoot: root, parallel: true, dryRun: true })).toEqual({
      kind: "block",
      ref: "T-001#R-001",
      taskId: "T-001",
      blockId: "R-001",
      blockType: "review",
      reason: "claimed",
      requestedMode: "parallel",
      parallelFallbackReason: "review_requires_sequential_claim",
      nextParallelClaimable: []
    });
    expect(await claimNext({ projectRoot: root, parallel: true })).toEqual({
      kind: "block",
      ref: "T-001#R-001",
      taskId: "T-001",
      blockId: "R-001",
      blockType: "review",
      reason: "claimed"
    });
  });

  it("reports sequential-only work when a parallel claim has no safe blocks", async () => {
    const manifest = basicManifest({ parallel: true });
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    const implementationBlock = task?.type === "task" ? task.blocks.find((block) => block.id === "B-001") : null;
    if (implementationBlock?.type !== "implementation") {
      throw new Error("missing implementation block");
    }
    implementationBlock.parallel.safe = false;

    const { root } = await createTestWorkspace(manifest);
    const status = await getExecutionStatus({ projectRoot: root });

    expect(status.nextClaimable).toEqual(["T-001#B-001"]);
    expect(status.nextParallelClaimable).toEqual([]);
    expect(status.nextSequentialClaimable).toEqual(["T-001#B-001"]);
    expect(await claimNext({ projectRoot: root, parallel: true })).toEqual({
      kind: "none",
      reason: "no_parallel_blocks",
      nextSequentialClaimable: ["T-001#B-001"]
    });
  });

  it("claims an explicit ready block by ref", async () => {
    const { root } = await createTestWorkspace();

    expect(await claimBlock({ projectRoot: root, ref: "T-001#B-001" })).toMatchObject({
      kind: "block",
      ref: "T-001#B-001",
      reason: "claimed"
    });
  });

  it("dispatches a parallel-safe implementation block without replacing the current review claim", async () => {
    const { root } = await createTestWorkspace(basicManifest({ includeSecondTask: true, parallel: true, maxConcurrent: 2 }));
    await claimNext({ projectRoot: root });
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "b.md") });
    await claimBlock({ projectRoot: root, ref: "T-001#R-001" });

    const dispatch = await claimBlock({ projectRoot: root, ref: "T-002#B-001", dispatch: true });
    const status = await getExecutionStatus({ projectRoot: root });

    expect(dispatch).toMatchObject({
      kind: "block",
      ref: "T-002#B-001",
      reason: "dispatched"
    });
    expect(status.currentRefs).toEqual(["T-001#R-001", "T-002#B-001"]);
    expect(status.blocks.find((block) => block.ref === "T-002#B-001")?.status).toBe("in_progress");
  });

  it("claims the next executable block inside an explicit task", async () => {
    const { root } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));

    expect(await claimTask({ projectRoot: root, taskId: "T-002" })).toMatchObject({
      kind: "block",
      ref: "T-002#B-001",
      reason: "claimed"
    });
  });

  it("claims an explicit review type without selecting implementation blocks", async () => {
    const { root } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "b.md") });

    expect(await claimBlockType({ projectRoot: root, blockType: "review" })).toMatchObject({
      kind: "block",
      ref: "T-001#R-001",
      blockType: "review",
      reason: "claimed"
    });
  });

  it("implements a task after required implementation blocks complete when no review block exists", async () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("missing task");
    }
    task.blocks = task.blocks.filter((block) => block.type !== "review");

    const { root } = await createTestWorkspace(manifest);
    await claimNext({ projectRoot: root });
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "b.md") });

    expect(await claimNext({ projectRoot: root })).toEqual({ kind: "none", reason: "no_claimable_blocks" });

    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.tasks.find((taskStatus) => taskStatus.taskId === "T-001")?.status).toBe("implemented");
    expect(status.blocks.map((block) => block.ref)).toEqual(["T-001#B-001"]);
    expect(status.nextClaimable).toEqual([]);
  });
});
