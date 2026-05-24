import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimNext, getExecutionStatus, submitBlockResult, submitFeedback, submitReviewResult } from "../taskManager/index.js";
import { readJsonFile } from "../json.js";
import type { TaskResultIndex } from "../types.js";
import { basicManifest, createTestWorkspace, writeReport, writeReviewResult } from "./promptTestHelpers.js";

async function completeImplementation(root: string): Promise<void> {
  await claimNext({ projectRoot: root });
  await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "b.md") });
  await claimNext({ projectRoot: root });
  await submitBlockResult({ projectRoot: root, ref: "T-001#C-001", reportPath: await writeReport(root, "c.md") });
  await claimNext({ projectRoot: root });
}

describe("submitReviewResult", () => {
  it("passes a review block and aggregates the task as implemented", async () => {
    const { root, init } = await createTestWorkspace();
    await completeImplementation(root);

    const result = await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "passed", "Looks good.")
    });
    const status = await getExecutionStatus({ projectRoot: root });
    const taskIndex = await readJsonFile<TaskResultIndex>(join(init.workspace.resultsDir, "T-001", "index.json"));

    expect(result).toMatchObject({ ref: "T-001#R-001", verdict: "passed", status: "completed" });
    expect(status.tasks[0]).toMatchObject({ taskId: "T-001", status: "implemented" });
    expect(taskIndex.latestRunByBlock).toMatchObject({ "T-001#B-001": "RUN-001", "T-001#C-001": "RUN-001" });
    expect(taskIndex.latestReviewAttemptByBlock).toMatchObject({ "T-001#R-001": "REV-001" });
    expect(taskIndex.latestReviewVerdictByBlock).toMatchObject({ "T-001#R-001": "passed" });
    expect(taskIndex.reviewCompletionReasonByBlock).toMatchObject({ "T-001#R-001": "passed" });
    expect(taskIndex.counts).toMatchObject({ runs: 2, reviewAttempts: 1 });
    await expect(access(join(init.workspace.resultsDir, "T-001", "reviews", "R-001", "attempts", "REV-001", "review-result.json"))).resolves.toBeUndefined();
  });

  it("routes needs_changes to feedback and then back to the same review block", async () => {
    const { root, init } = await createTestWorkspace();
    await completeImplementation(root);

    const first = await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Fix the edge case.")
    });
    const feedbackArtifactPath = join(init.workspace.resultsDir, "T-001", "feedback", "FE-001", "feedback.json");
    await expect(readJsonFile(feedbackArtifactPath)).resolves.toMatchObject({
      feedbackId: "FE-001",
      sourceReviewBlockRef: "T-001#R-001",
      sourceReviewAttemptId: "REV-001",
      status: "open"
    });
    await claimNext({ projectRoot: root });
    await expect(readJsonFile(feedbackArtifactPath)).resolves.toMatchObject({
      feedbackId: "FE-001",
      status: "in_progress"
    });
    await submitFeedback({ projectRoot: root, reportPath: await writeReport(root, "feedback.md", "Fixed edge case.\n") });
    await expect(readJsonFile(feedbackArtifactPath)).resolves.toMatchObject({
      feedbackId: "FE-001",
      status: "resolved",
      latestSubmissionId: "FS-001"
    });
    await claimNext({ projectRoot: root });
    const second = await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "passed", "Passed after fix.")
    });
    const taskIndex = await readJsonFile<TaskResultIndex>(join(init.workspace.resultsDir, "T-001", "index.json"));

    expect(first).toMatchObject({ verdict: "needs_changes", feedbackId: "FE-001", status: "in_progress" });
    expect(second).toMatchObject({ reviewAttemptId: "REV-002", verdict: "passed", status: "completed" });
    expect(taskIndex.latestReviewAttemptByBlock).toMatchObject({ "T-001#R-001": "REV-002" });
    expect(taskIndex.latestFeedbackByReviewBlock).toMatchObject({ "T-001#R-001": "FE-001" });
    expect(taskIndex.latestFeedbackSubmissionByFeedback).toMatchObject({ "FE-001": "FS-001" });
    expect(taskIndex.feedbackStatusById).toMatchObject({ "FE-001": "resolved" });
    expect(taskIndex.counts).toMatchObject({ runs: 2, reviewAttempts: 2, feedbackEnvelopes: 1, feedbackSubmissions: 1 });
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
    const taskIndex = await readJsonFile<TaskResultIndex>(join(init.workspace.resultsDir, "T-001", "index.json"));

    expect(result).toMatchObject({ verdict: "needs_changes", status: "completed" });
    expect(status.tasks[0].status).toBe("ready");
    expect(status.blocks.find((block) => block.ref === "T-001#R-001")).toMatchObject({
      activeFeedbackId: null,
      completionReason: "max_cycles_reached"
    });
    expect(status.warnings.map((warning) => warning.code)).toContain("review_max_cycles_reached");
    expect(taskIndex.reviewCompletionReasonByBlock).toMatchObject({ "T-001#R-001": "max_cycles_reached" });
    expect(taskIndex.warnings?.map((warning) => warning.code)).toContain("review_max_cycles_reached");
  });
});
