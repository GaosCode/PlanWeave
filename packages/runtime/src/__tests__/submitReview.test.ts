import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimNext, getExecutionStatus, submitBlockResult, submitFeedback, submitReviewResult } from "../taskManager/index.js";
import { readJsonFile, writeJsonFile } from "../json.js";
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

  it("recovers an already persisted review attempt without creating a duplicate", async () => {
    const { root, init } = await createTestWorkspace();
    await completeImplementation(root);
    const resultPath = await writeReviewResult(root, "passed", "Looks good.");
    const persistedResult = await readJsonFile(resultPath);
    const attemptRoot = join(init.workspace.resultsDir, "T-001", "reviews", "R-001", "attempts");
    const attemptDir = join(attemptRoot, "REV-001");
    await mkdir(attemptDir, { recursive: true });
    await writeJsonFile(join(attemptDir, "review-result.json"), persistedResult);
    await writeJsonFile(join(attemptDir, "metadata.json"), {
      reviewBlockRef: "T-001#R-001",
      attemptId: "REV-001",
      reviewedWorkRevision: "rev-placeholder",
      reviewedAt: "2026-05-25T00:00:00.000Z"
    });

    const result = await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath });

    expect(result).toMatchObject({ ref: "T-001#R-001", reviewAttemptId: "REV-001", verdict: "passed", status: "completed" });
    await expect(access(join(attemptRoot, "REV-002"))).rejects.toThrow();
    await expect(readJsonFile<TaskResultIndex>(join(init.workspace.resultsDir, "T-001", "index.json"))).resolves.toMatchObject({
      latestReviewAttemptByBlock: { "T-001#R-001": "REV-001" },
      latestReviewVerdictByBlock: { "T-001#R-001": "passed" }
    });
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

  it("treats retrying the same needs_changes review result as idempotent", async () => {
    const { root, init } = await createTestWorkspace();
    await completeImplementation(root);
    const resultPath = await writeReviewResult(root, "needs_changes", "Fix the edge case.");

    const first = await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath });
    const second = await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath });
    const status = await getExecutionStatus({ projectRoot: root });

    expect(first).toMatchObject({ reviewAttemptId: "REV-001", feedbackId: "FE-001", status: "in_progress" });
    expect(second).toEqual(first);
    expect(status.currentFeedbackId).toBe("FE-001");
    expect(status.blocks.find((block) => block.ref === "T-001#R-001")).toMatchObject({
      status: "in_progress",
      latestReviewAttemptId: "REV-001",
      activeFeedbackId: "FE-001",
      completionReason: null
    });
    await expect(access(join(init.workspace.resultsDir, "T-001", "reviews", "R-001", "attempts", "REV-002"))).rejects.toThrow();
    await expect(access(join(init.workspace.resultsDir, "T-001", "feedback", "FE-002"))).rejects.toThrow();
    await expect(readJsonFile(join(init.workspace.resultsDir, "T-001", "feedback", "FE-001", "feedback.json"))).resolves.toMatchObject({
      status: "open",
      sourceReviewAttemptId: "REV-001"
    });
    await expect(readJsonFile<TaskResultIndex>(join(init.workspace.resultsDir, "T-001", "index.json"))).resolves.toMatchObject({
      latestReviewAttemptByBlock: { "T-001#R-001": "REV-001" },
      latestFeedbackByReviewBlock: { "T-001#R-001": "FE-001" },
      feedbackStatusById: { "FE-001": "open" },
      counts: { runs: 2, reviewAttempts: 1, feedbackEnvelopes: 1 }
    });
  });

  it("does not advance review state when retrying the same needs_changes after feedback is resolved", async () => {
    const { root, init } = await createTestWorkspace();
    await completeImplementation(root);
    const resultPath = await writeReviewResult(root, "needs_changes", "Fix the edge case.");

    const first = await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath });
    await claimNext({ projectRoot: root });
    await submitFeedback({ projectRoot: root, reportPath: await writeReport(root, "feedback.md", "Fixed edge case.\n") });
    const retry = await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath });
    const status = await getExecutionStatus({ projectRoot: root });
    const taskIndex = await readJsonFile<TaskResultIndex>(join(init.workspace.resultsDir, "T-001", "index.json"));

    expect(retry).toEqual(first);
    expect(status.currentRefs).toEqual(["T-001#R-001"]);
    expect(status.currentFeedbackId).toBeNull();
    expect(status.blocks.find((block) => block.ref === "T-001#R-001")).toMatchObject({
      status: "in_progress",
      latestReviewAttemptId: "REV-001",
      activeFeedbackId: null,
      completionReason: null
    });
    expect(status.warnings.map((warning) => warning.code)).not.toContain("review_max_cycles_reached");
    await expect(access(join(init.workspace.resultsDir, "T-001", "reviews", "R-001", "attempts", "REV-002"))).rejects.toThrow();
    await expect(access(join(init.workspace.resultsDir, "T-001", "feedback", "FE-002"))).rejects.toThrow();
    await expect(readJsonFile(join(init.workspace.resultsDir, "T-001", "feedback", "FE-001", "feedback.json"))).resolves.toMatchObject({
      status: "resolved",
      sourceReviewAttemptId: "REV-001",
      latestSubmissionId: "FS-001"
    });
    expect(taskIndex.latestReviewAttemptByBlock).toMatchObject({ "T-001#R-001": "REV-001" });
    expect(taskIndex.latestFeedbackByReviewBlock).toMatchObject({ "T-001#R-001": "FE-001" });
    expect(taskIndex.feedbackStatusById).toMatchObject({ "FE-001": "resolved" });
    expect(taskIndex.counts).toMatchObject({ runs: 2, reviewAttempts: 1, feedbackEnvelopes: 1, feedbackSubmissions: 1 });
    expect(taskIndex.reviewCompletionReasonByBlock?.["T-001#R-001"]).toBeUndefined();
  });

  it("does not advance review state when retrying stale needs_changes after re-review is claimed", async () => {
    const { root, init } = await createTestWorkspace();
    await completeImplementation(root);
    const resultPath = await writeReviewResult(root, "needs_changes", "Fix the edge case.");

    const first = await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath });
    await claimNext({ projectRoot: root });
    await submitFeedback({ projectRoot: root, reportPath: await writeReport(root, "feedback.md", "Fixed edge case.\n") });
    await claimNext({ projectRoot: root });
    const retry = await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath });
    const status = await getExecutionStatus({ projectRoot: root });
    const taskIndex = await readJsonFile<TaskResultIndex>(join(init.workspace.resultsDir, "T-001", "index.json"));

    expect(retry).toEqual(first);
    expect(status.currentRefs).toEqual(["T-001#R-001"]);
    expect(status.currentFeedbackId).toBeNull();
    expect(status.blocks.find((block) => block.ref === "T-001#R-001")).toMatchObject({
      status: "in_progress",
      latestReviewAttemptId: "REV-001",
      activeFeedbackId: null,
      completionReason: null
    });
    expect(status.warnings.map((warning) => warning.code)).not.toContain("review_max_cycles_reached");
    await expect(access(join(init.workspace.resultsDir, "T-001", "reviews", "R-001", "attempts", "REV-002"))).rejects.toThrow();
    await expect(access(join(init.workspace.resultsDir, "T-001", "feedback", "FE-002"))).rejects.toThrow();
    expect(taskIndex.latestReviewAttemptByBlock).toMatchObject({ "T-001#R-001": "REV-001" });
    expect(taskIndex.latestFeedbackByReviewBlock).toMatchObject({ "T-001#R-001": "FE-001" });
    expect(taskIndex.feedbackStatusById).toMatchObject({ "FE-001": "resolved" });
    expect(taskIndex.counts).toMatchObject({ runs: 2, reviewAttempts: 1, feedbackEnvelopes: 1, feedbackSubmissions: 1 });
    expect(taskIndex.reviewCompletionReasonByBlock?.["T-001#R-001"]).toBeUndefined();
  });

  it("recovers an already persisted feedback submission without creating a duplicate", async () => {
    const { root, init } = await createTestWorkspace();
    await completeImplementation(root);
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Fix the edge case.")
    });
    await claimNext({ projectRoot: root });
    const reportPath = await writeReport(root, "feedback-retry.md", "Fixed edge case.\n");
    const submissionRoot = join(init.workspace.resultsDir, "T-001", "feedback", "FE-001", "submissions");
    const submissionDir = join(submissionRoot, "FS-001");
    await mkdir(submissionDir, { recursive: true });
    await writeFile(join(submissionDir, "report.md"), "Fixed edge case.\n", "utf8");
    await writeJsonFile(join(submissionDir, "metadata.json"), {
      feedbackId: "FE-001",
      submissionId: "FS-001",
      sourceReviewBlockRef: "T-001#R-001",
      submittedAt: "2026-05-25T00:00:00.000Z"
    });

    const result = await submitFeedback({ projectRoot: root, reportPath });

    expect(result).toMatchObject({ feedbackId: "FE-001", submissionId: "FS-001" });
    await expect(access(join(submissionRoot, "FS-002"))).rejects.toThrow();
    await expect(readJsonFile(join(init.workspace.resultsDir, "T-001", "feedback", "FE-001", "feedback.json"))).resolves.toMatchObject({
      status: "resolved",
      latestSubmissionId: "FS-001"
    });
    await expect(readJsonFile<TaskResultIndex>(join(init.workspace.resultsDir, "T-001", "index.json"))).resolves.toMatchObject({
      latestFeedbackSubmissionByFeedback: { "FE-001": "FS-001" },
      feedbackStatusById: { "FE-001": "resolved" }
    });
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
