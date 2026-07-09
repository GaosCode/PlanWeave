import { access, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claimNext,
  getExecutionStatus,
  submitBlockResult,
  submitFeedback,
  submitReviewResult
} from "../taskManager/index.js";
import { readJsonFile } from "../json.js";
import type { TaskResultIndex } from "../types.js";
import {
  basicManifest,
  createTestWorkspace,
  writeReport,
  writeReviewResult
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

describe("submitReviewResult recovery", () => {
  it("treats retrying the same needs_changes review result as idempotent", async () => {
    const { root, init } = await createTestWorkspace();
    await completeImplementation(root);
    const resultPath = await writeReviewResult(root, "needs_changes", "Fix the edge case.");

    const first = await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath });
    const second = await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath });
    const status = await getExecutionStatus({ projectRoot: root });

    expect(first).toMatchObject({
      reviewAttemptId: "REV-001",
      feedbackId: "FE-001",
      status: "in_progress"
    });
    expect(second).toEqual(first);
    expect(status.currentFeedbackId).toBe("FE-001");
    expect(status.blocks.find((block) => block.ref === "T-001#R-001")).toMatchObject({
      status: "in_progress",
      latestReviewAttemptId: "REV-001",
      activeFeedbackId: "FE-001",
      completionReason: null
    });
    await expect(
      access(join(init.workspace.resultsDir, "T-001", "reviews", "R-001", "attempts", "REV-002"))
    ).rejects.toThrow();
    await expect(
      access(join(init.workspace.resultsDir, "T-001", "feedback", "FE-002"))
    ).rejects.toThrow();
    await expect(
      readJsonFile(join(init.workspace.resultsDir, "T-001", "feedback", "FE-001", "feedback.json"))
    ).resolves.toMatchObject({
      status: "open",
      sourceReviewAttemptId: "REV-001"
    });
    await expect(
      readJsonFile<TaskResultIndex>(join(init.workspace.resultsDir, "T-001", "index.json"))
    ).resolves.toMatchObject({
      latestReviewAttemptByBlock: { "T-001#R-001": "REV-001" },
      latestFeedbackByReviewBlock: { "T-001#R-001": "FE-001" },
      feedbackStatusById: { "FE-001": "open" },
      counts: { runs: 1, reviewAttempts: 1, feedbackEnvelopes: 1 }
    });
  });

  it("does not advance review state when retrying the same needs_changes after feedback is resolved", async () => {
    const { root, init } = await createTestWorkspace();
    await completeImplementation(root);
    const resultPath = await writeReviewResult(root, "needs_changes", "Fix the edge case.");

    const first = await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath });
    await claimNext({ projectRoot: root });
    await submitFeedback({
      projectRoot: root,
      reportPath: await writeReport(root, "feedback.md", "Fixed edge case.\n")
    });
    const retry = await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath });
    const status = await getExecutionStatus({ projectRoot: root });
    const taskIndex = await readJsonFile<TaskResultIndex>(
      join(init.workspace.resultsDir, "T-001", "index.json")
    );

    expect(retry).toEqual(first);
    expect(status.currentRefs).toEqual(["T-001#R-001"]);
    expect(status.currentFeedbackId).toBeNull();
    expect(status.blocks.find((block) => block.ref === "T-001#R-001")).toMatchObject({
      status: "in_progress",
      latestReviewAttemptId: "REV-001",
      activeFeedbackId: null,
      completionReason: null
    });
    expect(status.warnings.map((warning) => warning.code)).not.toContain(
      "review_max_cycles_reached"
    );
    await expect(
      access(join(init.workspace.resultsDir, "T-001", "reviews", "R-001", "attempts", "REV-002"))
    ).rejects.toThrow();
    await expect(
      access(join(init.workspace.resultsDir, "T-001", "feedback", "FE-002"))
    ).rejects.toThrow();
    await expect(
      readJsonFile(join(init.workspace.resultsDir, "T-001", "feedback", "FE-001", "feedback.json"))
    ).resolves.toMatchObject({
      status: "resolved",
      sourceReviewAttemptId: "REV-001",
      latestSubmissionId: "FS-001"
    });
    expect(taskIndex.latestReviewAttemptByBlock).toMatchObject({ "T-001#R-001": "REV-001" });
    expect(taskIndex.latestFeedbackByReviewBlock).toMatchObject({ "T-001#R-001": "FE-001" });
    expect(taskIndex.feedbackStatusById).toMatchObject({ "FE-001": "resolved" });
    expect(taskIndex.counts).toMatchObject({
      runs: 1,
      reviewAttempts: 1,
      feedbackEnvelopes: 1,
      feedbackSubmissions: 1
    });
    expect(taskIndex.reviewCompletionReasonByBlock?.["T-001#R-001"]).toBeUndefined();
  });

  it("creates a new feedback cycle when re-review reuses the same result path and content", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ reviewMaxFeedbackCycles: 2 }));
    await completeImplementation(root);
    const resultPath = await writeReviewResult(root, "needs_changes", "Fix the edge case.");

    const first = await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath });
    await claimNext({ projectRoot: root });
    await submitFeedback({
      projectRoot: root,
      reportPath: await writeReport(root, "feedback.md", "Fixed edge case.\n")
    });
    await claimNext({ projectRoot: root });
    const second = await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath });
    const status = await getExecutionStatus({ projectRoot: root });
    const taskIndex = await readJsonFile<TaskResultIndex>(
      join(init.workspace.resultsDir, "T-001", "index.json")
    );

    expect(first).toMatchObject({
      reviewAttemptId: "REV-001",
      feedbackId: "FE-001",
      status: "in_progress"
    });
    expect(second).toMatchObject({
      reviewAttemptId: "REV-002",
      feedbackId: "FE-002",
      status: "in_progress"
    });
    expect(status.currentRefs).toEqual([]);
    expect(status.currentFeedbackId).toBe("FE-002");
    expect(status.openFeedback).toEqual([
      { feedbackId: "FE-002", sourceReviewBlockRef: "T-001#R-001", status: "open" }
    ]);
    expect(status.blocks.find((block) => block.ref === "T-001#R-001")).toMatchObject({
      status: "in_progress",
      latestReviewAttemptId: "REV-002",
      activeFeedbackId: "FE-002",
      completionReason: null
    });
    await expect(
      readJsonFile(join(init.workspace.resultsDir, "T-001", "feedback", "FE-001", "feedback.json"))
    ).resolves.toMatchObject({
      status: "resolved",
      sourceReviewAttemptId: "REV-001",
      latestSubmissionId: "FS-001"
    });
    await expect(
      readJsonFile(join(init.workspace.resultsDir, "T-001", "feedback", "FE-002", "feedback.json"))
    ).resolves.toMatchObject({
      status: "open",
      sourceReviewAttemptId: "REV-002"
    });
    expect(taskIndex.latestReviewAttemptByBlock).toMatchObject({ "T-001#R-001": "REV-002" });
    expect(taskIndex.latestFeedbackByReviewBlock).toMatchObject({ "T-001#R-001": "FE-002" });
    expect(taskIndex.feedbackStatusById).toMatchObject({ "FE-001": "resolved", "FE-002": "open" });
    expect(taskIndex.counts).toMatchObject({
      runs: 1,
      reviewAttempts: 2,
      feedbackEnvelopes: 2,
      feedbackSubmissions: 1
    });
    expect(taskIndex.reviewCompletionReasonByBlock?.["T-001#R-001"]).toBeUndefined();
  });

  it("creates a new feedback cycle when a fixed-path re-review rewrites the same needs_changes content", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ reviewMaxFeedbackCycles: 2 }));
    await completeImplementation(root);
    const resultPath = await writeReviewResult(root, "needs_changes", "Fix the edge case.");

    const first = await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath });
    await claimNext({ projectRoot: root });
    await submitFeedback({
      projectRoot: root,
      reportPath: await writeReport(root, "feedback.md", "Fixed edge case.\n")
    });
    await claimNext({ projectRoot: root });
    await writeFile(
      resultPath,
      JSON.stringify({
        reviewBlockRef: "T-001#R-001",
        taskId: "T-001",
        verdict: "needs_changes",
        content: "Fix the edge case."
      }),
      "utf8"
    );
    const future = new Date(Date.now() + 10_000);
    await utimes(resultPath, future, future);

    const second = await submitReviewResult({ projectRoot: root, ref: "T-001#R-001", resultPath });
    const status = await getExecutionStatus({ projectRoot: root });
    const taskIndex = await readJsonFile<TaskResultIndex>(
      join(init.workspace.resultsDir, "T-001", "index.json")
    );

    expect(first).toMatchObject({
      reviewAttemptId: "REV-001",
      feedbackId: "FE-001",
      status: "in_progress"
    });
    expect(second).toMatchObject({
      reviewAttemptId: "REV-002",
      feedbackId: "FE-002",
      status: "in_progress"
    });
    expect(status.currentRefs).toEqual([]);
    expect(status.currentFeedbackId).toBe("FE-002");
    expect(status.openFeedback).toEqual([
      { feedbackId: "FE-002", sourceReviewBlockRef: "T-001#R-001", status: "open" }
    ]);
    expect(status.blocks.find((block) => block.ref === "T-001#R-001")).toMatchObject({
      status: "in_progress",
      latestReviewAttemptId: "REV-002",
      activeFeedbackId: "FE-002",
      completionReason: null
    });
    await expect(
      readJsonFile(join(init.workspace.resultsDir, "T-001", "feedback", "FE-001", "feedback.json"))
    ).resolves.toMatchObject({
      status: "resolved",
      sourceReviewAttemptId: "REV-001",
      latestSubmissionId: "FS-001"
    });
    await expect(
      readJsonFile(join(init.workspace.resultsDir, "T-001", "feedback", "FE-002", "feedback.json"))
    ).resolves.toMatchObject({
      status: "open",
      sourceReviewAttemptId: "REV-002"
    });
    expect(taskIndex.latestReviewAttemptByBlock).toMatchObject({ "T-001#R-001": "REV-002" });
    expect(taskIndex.latestFeedbackByReviewBlock).toMatchObject({ "T-001#R-001": "FE-002" });
    expect(taskIndex.feedbackStatusById).toMatchObject({ "FE-001": "resolved", "FE-002": "open" });
    expect(taskIndex.counts).toMatchObject({
      runs: 1,
      reviewAttempts: 2,
      feedbackEnvelopes: 2,
      feedbackSubmissions: 1
    });
    expect(taskIndex.reviewCompletionReasonByBlock?.["T-001#R-001"]).toBeUndefined();
  });

  it("creates a new feedback cycle for the same needs_changes content on a new work revision", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ reviewMaxFeedbackCycles: 2 }));
    await completeImplementation(root);
    const firstResultPath = await writeReviewResult(root, "needs_changes", "Fix it.");

    const first = await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: firstResultPath
    });
    await claimNext({ projectRoot: root });
    await submitFeedback({
      projectRoot: root,
      reportPath: await writeReport(root, "feedback.md", "Tried to fix it.\n")
    });
    await claimNext({ projectRoot: root });
    const second = await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Fix it.")
    });
    const status = await getExecutionStatus({ projectRoot: root });
    const taskIndex = await readJsonFile<TaskResultIndex>(
      join(init.workspace.resultsDir, "T-001", "index.json")
    );

    expect(first).toMatchObject({
      reviewAttemptId: "REV-001",
      feedbackId: "FE-001",
      status: "in_progress"
    });
    expect(second).toMatchObject({
      reviewAttemptId: "REV-002",
      feedbackId: "FE-002",
      status: "in_progress"
    });
    expect(status.currentRefs).toEqual([]);
    expect(status.currentFeedbackId).toBe("FE-002");
    expect(status.openFeedback).toEqual([
      { feedbackId: "FE-002", sourceReviewBlockRef: "T-001#R-001", status: "open" }
    ]);
    expect(status.blocks.find((block) => block.ref === "T-001#R-001")).toMatchObject({
      status: "in_progress",
      latestReviewAttemptId: "REV-002",
      activeFeedbackId: "FE-002",
      completionReason: null
    });
    await expect(
      readJsonFile(join(init.workspace.resultsDir, "T-001", "feedback", "FE-001", "feedback.json"))
    ).resolves.toMatchObject({
      status: "resolved",
      sourceReviewAttemptId: "REV-001",
      latestSubmissionId: "FS-001"
    });
    await expect(
      readJsonFile(join(init.workspace.resultsDir, "T-001", "feedback", "FE-002", "feedback.json"))
    ).resolves.toMatchObject({
      status: "open",
      sourceReviewAttemptId: "REV-002"
    });
    expect(taskIndex.latestReviewAttemptByBlock).toMatchObject({ "T-001#R-001": "REV-002" });
    expect(taskIndex.latestFeedbackByReviewBlock).toMatchObject({ "T-001#R-001": "FE-002" });
    expect(taskIndex.feedbackStatusById).toMatchObject({ "FE-001": "resolved", "FE-002": "open" });
    expect(taskIndex.counts).toMatchObject({
      runs: 1,
      reviewAttempts: 2,
      feedbackEnvelopes: 2,
      feedbackSubmissions: 1
    });
  });

  it("allows the configured re-review feedback cycles after the initial needs_changes feedback", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ reviewMaxFeedbackCycles: 3 }));
    await completeImplementation(root);

    const first = await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Initial feedback.")
    });
    let latest = first;
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await claimNext({ projectRoot: root });
      await submitFeedback({
        projectRoot: root,
        reportPath: await writeReport(root, `feedback-${cycle}.md`, `Handled feedback ${cycle}.\n`)
      });
      await claimNext({ projectRoot: root });
      latest = await submitReviewResult({
        projectRoot: root,
        ref: "T-001#R-001",
        resultPath: await writeReviewResult(root, "needs_changes", `Re-review feedback ${cycle}.`)
      });
    }
    const status = await getExecutionStatus({ projectRoot: root });
    const taskIndex = await readJsonFile<TaskResultIndex>(
      join(init.workspace.resultsDir, "T-001", "index.json")
    );

    expect(first).toMatchObject({
      reviewAttemptId: "REV-001",
      feedbackId: "FE-001",
      status: "in_progress"
    });
    expect(latest).toMatchObject({
      reviewAttemptId: "REV-004",
      feedbackId: "FE-004",
      status: "in_progress"
    });
    expect(status.currentFeedbackId).toBe("FE-004");
    expect(status.warnings.map((warning) => warning.code)).not.toContain(
      "review_max_cycles_reached"
    );
    await expect(
      readJsonFile(join(init.workspace.resultsDir, "T-001", "feedback", "FE-004", "feedback.json"))
    ).resolves.toMatchObject({
      status: "open",
      sourceReviewAttemptId: "REV-004"
    });
    expect(taskIndex.latestReviewAttemptByBlock).toMatchObject({ "T-001#R-001": "REV-004" });
    expect(taskIndex.latestFeedbackByReviewBlock).toMatchObject({ "T-001#R-001": "FE-004" });
    expect(taskIndex.counts).toMatchObject({
      runs: 1,
      reviewAttempts: 4,
      feedbackEnvelopes: 4,
      feedbackSubmissions: 3
    });
    expect(taskIndex.reviewCompletionReasonByBlock?.["T-001#R-001"]).toBeUndefined();
  });
});
