import { access, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  claimNext,
  getExecutionStatus,
  resetMaxCycleReviewsForRetry,
  retryReview,
  submitBlockResult,
  submitReviewResult
} from "../taskManager/index.js";
import { loadPackage } from "../package/loadPackage.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { readState } from "../state.js";
import type { PlanPackageManifest, TaskResultIndex } from "../types.js";
import {
  basicManifest,
  createTestWorkspace,
  writeReport,
  writeReviewResult,
  writePromptFiles
} from "./promptTestHelpers.js";

async function completeImplementation(root: string): Promise<void> {
  await claimNext({ projectRoot: root });
  await submitBlockResult({
    projectRoot: root,
    ref: "T-001#B-001",
    reportPath: await writeReport(root, "b.md")
  });
  await claimNext({ projectRoot: root });
}

describe("submitReviewResult max feedback cycles", () => {
  it("does not create feedback when retrying rewritten same-hash max-cycle review after retry reset", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ reviewMaxFeedbackCycles: 0 }));
    await completeImplementation(root);
    const resultPath = await writeReviewResult(root, "needs_changes", "No cycles allowed.");

    const first = await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath });
    await resetMaxCycleReviewsForRetry({ projectRoot: root, scope: { kind: "project" } });
    await claimNext({ projectRoot: root });
    await writeFile(
      resultPath,
      JSON.stringify({
        reviewBlockRef: "T-001#R-001",
        taskId: "T-001",
        verdict: "needs_changes",
        content: "No cycles allowed."
      }),
      "utf8"
    );
    const future = new Date(Date.now() + 10_000);
    await utimes(resultPath, future, future);

    const retry = await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath });
    const status = await getExecutionStatus({ projectRoot: root });
    const taskIndex = await readJsonFile<TaskResultIndex>(
      join(init.workspace.resultsDir, "T-001", "index.json")
    );

    expect(retry).toEqual(first);
    expect(status.currentRefs).toEqual([]);
    expect(status.currentFeedbackId).toBeNull();
    expect(status.blocks.find((block) => block.ref === "T-001#R-001")).toMatchObject({
      status: "completed",
      latestReviewAttemptId: "REV-001",
      activeFeedbackId: null,
      completionReason: "max_cycles_reached"
    });
    await expect(
      access(join(init.workspace.resultsDir, "T-001", "reviews", "R-001", "attempts", "REV-002"))
    ).rejects.toThrow();
    await expect(
      access(join(init.workspace.resultsDir, "T-001", "feedback", "FE-001"))
    ).rejects.toThrow();
    expect(taskIndex.latestReviewAttemptByBlock).toMatchObject({ "T-001#R-001": "REV-001" });
    expect(taskIndex.reviewCompletionReasonByBlock).toMatchObject({
      "T-001#R-001": "max_cycles_reached"
    });
    expect(taskIndex.counts).toMatchObject({ runs: 1, reviewAttempts: 1 });
    expect(taskIndex.counts?.feedbackEnvelopes).toBeUndefined();
  });

  it("enforces max feedback cycles in the Task Manager", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ reviewMaxFeedbackCycles: 0 }));
    await completeImplementation(root);

    const result = await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "No cycles allowed.")
    });
    const status = await getExecutionStatus({ projectRoot: root });
    const taskIndex = await readJsonFile<TaskResultIndex>(
      join(init.workspace.resultsDir, "T-001", "index.json")
    );

    expect(result).toMatchObject({ verdict: "needs_changes", status: "completed" });
    expect(status.tasks[0].status).toBe("in_progress");
    expect(status.blocks.find((block) => block.ref === "T-001#R-001")).toMatchObject({
      activeFeedbackId: null,
      completionReason: "max_cycles_reached"
    });
    expect(status.warnings.map((warning) => warning.code)).toContain("review_max_cycles_reached");
    expect(taskIndex.reviewCompletionReasonByBlock).toMatchObject({
      "T-001#R-001": "max_cycles_reached"
    });
    expect(taskIndex.warnings?.map((warning) => warning.code)).toContain(
      "review_max_cycles_reached"
    );
    expect(result).toMatchObject({
      completionReason: "max_cycles_reached",
      feedbackCreated: false,
      message: "No feedback envelope was created because max feedback cycles were reached."
    });
  });

  it("raises max feedback cycles and resets an exhausted review for retry", async () => {
    const { root } = await createTestWorkspace(basicManifest({ reviewMaxFeedbackCycles: 0 }));
    await completeImplementation(root);
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "No cycles allowed.")
    });

    const retry = await retryReview({
      projectRoot: root,
      ref: "T-001#R-001",
      maxFeedbackCycles: 3
    });
    const status = await getExecutionStatus({ projectRoot: root });
    const { manifest } = await loadPackage(root);
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    const reviewBlock =
      task?.type === "task" ? task.blocks.find((block) => block.id === "R-001") : null;

    expect(retry).toMatchObject({
      ref: "T-001#R-001",
      status: "ready",
      maxFeedbackCycles: 3,
      reset: true
    });
    expect(reviewBlock?.type).toBe("review");
    expect(reviewBlock?.type === "review" ? reviewBlock.review.maxFeedbackCycles : null).toBe(3);
    expect(status.blocks.find((block) => block.ref === "T-001#R-001")).toMatchObject({
      status: "ready",
      completionReason: null
    });
    expect(status.warnings.map((warning) => warning.code)).not.toContain(
      "review_max_cycles_reached"
    );
    await expect(claimNext({ projectRoot: root })).resolves.toMatchObject({
      kind: "block",
      ref: "T-001#R-001"
    });
  });

  it("does not persist derived state before retry-review acquires the canvas lock", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ reviewMaxFeedbackCycles: 0 }));
    await completeImplementation(root);
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "No cycles allowed.")
    });

    const expandedManifest = basicManifest({
      reviewMaxFeedbackCycles: 0,
      includeSecondTask: true
    });
    await writeJsonFile(init.workspace.manifestFile, expandedManifest);
    await writePromptFiles(init.workspace.packageDir, expandedManifest);
    expect((await readState(init.workspace.stateFile)).blocks["T-002#B-001"]).toBeUndefined();

    const lockPath = join(dirname(init.workspace.stateFile), ".planweave.lock");
    await mkdir(lockPath);
    const retry = retryReview({
      projectRoot: root,
      ref: "T-001#R-001",
      maxFeedbackCycles: 3
    });
    try {
      await vi.waitFor(async () => {
        const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
        const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
        let reviewMaxFeedbackCycles: number | null = null;
        if (task?.type === "task") {
          const review = task.blocks.find((block) => block.id === "R-001");
          if (review?.type === "review") {
            reviewMaxFeedbackCycles = review.review.maxFeedbackCycles;
          }
        }
        expect(reviewMaxFeedbackCycles).toBe(3);
      });

      const stateWhileLocked = await readState(init.workspace.stateFile);
      expect(stateWhileLocked.blocks["T-002#B-001"]).toBeUndefined();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }

    await expect(retry).resolves.toMatchObject({
      ref: "T-001#R-001",
      status: "ready",
      maxFeedbackCycles: 3,
      reset: true
    });
    expect((await readState(init.workspace.stateFile)).blocks["T-002#B-001"]).toMatchObject({
      status: "ready"
    });
  });
});
