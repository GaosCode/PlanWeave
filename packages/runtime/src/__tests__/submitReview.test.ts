import { access, mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claimNext,
  getExecutionStatus,
  submitBlockResult,
  submitFeedback,
  submitReviewResult
} from "../taskManager/index.js";
import { loadRuntime } from "../taskManager/runtimeContext.js";
import { computeWorkRevision } from "../taskManager/selectors.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { readState, writeState } from "../state.js";
import type { RuntimeState, TaskResultIndex } from "../types.js";
import { createTestWorkspace, writeReport, writeReviewResult } from "./promptTestHelpers.js";

async function completeImplementation(root: string): Promise<void> {
  await claimNext({ projectRoot: root });
  await submitBlockResult({
    projectRoot: root,
    ref: "T-001#B-001",
    reportPath: await writeReport(root, "b.md")
  });
  await claimNext({ projectRoot: root });
}

async function readWorkRevision(root: string, reviewBlockRef = "T-001#R-001"): Promise<string> {
  const { graph, state } = await loadRuntime({ projectRoot: root });
  return computeWorkRevision(graph, state, reviewBlockRef);
}

describe("submitReviewResult", () => {
  it.each([
    "passed",
    "needs_changes"
  ] as const)("rejects blank %s review content before advancing state", async (verdict) => {
    const { root } = await createTestWorkspace();
    await completeImplementation(root);
    const resultPath = join(root, `blank-${verdict}.json`);
    await writeJsonFile(resultPath, {
      reviewBlockRef: "T-001#R-001",
      taskId: "T-001",
      verdict,
      content: " \n\t "
    });

    await expect(
      submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath })
    ).rejects.toThrow("blank");
    await expect(getExecutionStatus({ projectRoot: root })).resolves.toMatchObject({
      blocks: expect.arrayContaining([
        expect.objectContaining({ ref: "T-001#R-001", status: "in_progress" })
      ])
    });
  });

  it("passes a review block and aggregates the task as implemented", async () => {
    const { root, init } = await createTestWorkspace();
    await completeImplementation(root);

    const result = await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "passed", "Looks good.")
    });
    const status = await getExecutionStatus({ projectRoot: root });
    const taskIndex = await readJsonFile<TaskResultIndex>(
      join(init.workspace.resultsDir, "T-001", "index.json")
    );

    expect(result).toMatchObject({ ref: "T-001#R-001", verdict: "passed", status: "completed" });
    expect(status.tasks[0]).toMatchObject({ taskId: "T-001", status: "implemented" });
    expect(taskIndex.latestRunByBlock).toMatchObject({ "T-001#B-001": "RUN-001" });
    expect(taskIndex.latestReviewAttemptByBlock).toMatchObject({ "T-001#R-001": "REV-001" });
    expect(taskIndex.latestReviewVerdictByBlock).toMatchObject({ "T-001#R-001": "passed" });
    expect(taskIndex.reviewCompletionReasonByBlock).toMatchObject({ "T-001#R-001": "passed" });
    expect(taskIndex.counts).toMatchObject({ runs: 1, reviewAttempts: 1 });
    await expect(
      access(
        join(
          init.workspace.resultsDir,
          "T-001",
          "reviews",
          "R-001",
          "attempts",
          "REV-001",
          "review-result.json"
        )
      )
    ).resolves.toBeUndefined();
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
      reviewedWorkRevision: await readWorkRevision(root),
      sourceResultPath: resultPath,
      reviewedAt: "2026-05-25T00:00:00.000Z"
    });

    const result = await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath });

    expect(result).toMatchObject({
      ref: "T-001#R-001",
      reviewAttemptId: "REV-001",
      verdict: "passed",
      status: "completed"
    });
    await expect(access(join(attemptRoot, "REV-002"))).rejects.toThrow();
    await expect(
      readJsonFile<TaskResultIndex>(join(init.workspace.resultsDir, "T-001", "index.json"))
    ).resolves.toMatchObject({
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
    const feedbackArtifactPath = join(
      init.workspace.resultsDir,
      "T-001",
      "feedback",
      "FE-001",
      "feedback.json"
    );
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
    await submitFeedback({
      projectRoot: root,
      reportPath: await writeReport(root, "feedback.md", "Fixed edge case.\n")
    });
    await expect(readJsonFile<RuntimeState>(init.workspace.stateFile)).resolves.toMatchObject({
      currentFeedbackId: null,
      currentReviewBlockRef: "T-001#R-001"
    });
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
    const taskIndex = await readJsonFile<TaskResultIndex>(
      join(init.workspace.resultsDir, "T-001", "index.json")
    );

    expect(first).toMatchObject({
      verdict: "needs_changes",
      feedbackId: "FE-001",
      status: "in_progress"
    });
    expect(second).toMatchObject({
      reviewAttemptId: "REV-002",
      verdict: "passed",
      status: "completed"
    });
    expect(taskIndex.latestReviewAttemptByBlock).toMatchObject({ "T-001#R-001": "REV-002" });
    expect(taskIndex.latestFeedbackByReviewBlock).toMatchObject({ "T-001#R-001": "FE-001" });
    expect(taskIndex.latestFeedbackSubmissionByFeedback).toMatchObject({ "FE-001": "FS-001" });
    expect(taskIndex.feedbackStatusById).toMatchObject({ "FE-001": "resolved" });
    expect(taskIndex.counts).toMatchObject({
      runs: 1,
      reviewAttempts: 2,
      feedbackEnvelopes: 1,
      feedbackSubmissions: 1
    });
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
    const submissionRoot = join(
      init.workspace.resultsDir,
      "T-001",
      "feedback",
      "FE-001",
      "submissions"
    );
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
    await expect(
      readJsonFile(join(init.workspace.resultsDir, "T-001", "feedback", "FE-001", "feedback.json"))
    ).resolves.toMatchObject({
      status: "resolved",
      latestSubmissionId: "FS-001"
    });
    await expect(
      readJsonFile<TaskResultIndex>(join(init.workspace.resultsDir, "T-001", "index.json"))
    ).resolves.toMatchObject({
      latestFeedbackSubmissionByFeedback: { "FE-001": "FS-001" },
      feedbackStatusById: { "FE-001": "resolved" }
    });
  });

  it("rejects a feedback submission directory linked outside Results before allocating FS-001", async () => {
    const { root, init } = await createTestWorkspace();
    await completeImplementation(root);
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Fix the edge case.")
    });
    await claimNext({ projectRoot: root });
    const { resultsDir, stateFile } = init.workspace;
    const taskIndex = join(resultsDir, "T-001", "index.json");
    const taskFeedback = join(resultsDir, "T-001", "feedback", "FE-001");
    const feedbackArtifact = join(taskFeedback, "feedback.json");
    const submissionsDir = join(taskFeedback, "submissions");
    const outside = `${resultsDir}-outside`;
    await mkdir(outside);
    const sentinel = await writeReport(outside, "sentinel", "outside feedback\n");
    await symlink(outside, submissionsDir, process.platform === "win32" ? "junction" : "dir");
    const historicalState = await readState(stateFile);
    await writeState(stateFile, { ...historicalState, tasks: {} });
    const observedPaths = [stateFile, taskIndex, feedbackArtifact, sentinel];
    const readObserved = () => Promise.all(observedPaths.map((path) => readFile(path)));
    const before = await readObserved();
    const options = {
      projectRoot: root,
      reportPath: await writeReport(root, "feedback-boundary.md", "The edge case is fixed.\n")
    };

    await expect(submitFeedback(options)).rejects.toMatchObject({
      code: "results_path_outside",
      message: expect.stringContaining(submissionsDir)
    });
    await expect(readObserved()).resolves.toEqual(before);
    await expect(readdir(outside)).resolves.toEqual(["sentinel"]);

    await unlink(submissionsDir);
    await expect(submitFeedback(options)).resolves.toMatchObject({
      status: "accepted",
      feedbackId: "FE-001",
      submissionId: "FS-001"
    });
    await expect(readFile(join(submissionsDir, "FS-001", "report.md"), "utf8")).resolves.toBe(
      "The edge case is fixed.\n"
    );
  });
});
