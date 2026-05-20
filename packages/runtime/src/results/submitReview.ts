import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadPackage } from "../package/loadPackage.js";
import { ensureStateForManifest, readState, taskNodes, writeState } from "../state.js";
import { appendTaskEvent } from "./events.js";
import { readResultIndex, writeResultIndex } from "./indexFile.js";
import { reviewStatuses, type ResultIndex, type ReviewStatus, type SubmitReviewResult } from "../types.js";

function assertReviewStatus(status: string): asserts status is ReviewStatus {
  if (!(reviewStatuses as readonly string[]).includes(status)) {
    throw new Error(`Unsupported submit-review status '${status}'. Expected one of: ${reviewStatuses.join(", ")}.`);
  }
}

export async function submitReview(options: {
  projectRoot: string;
  taskId: string;
  reportPath: string;
  status: ReviewStatus;
}): Promise<SubmitReviewResult> {
  assertReviewStatus(options.status);
  const { workspace, manifest } = await loadPackage(options.projectRoot);
  if (!taskNodes(manifest).some((task) => task.id === options.taskId)) {
    throw new Error(`Task '${options.taskId}' does not exist.`);
  }

  const taskResultDir = join(workspace.resultsDir, options.taskId);
  const previous = await readResultIndex(join(taskResultDir, "index.json"));
  const state = ensureStateForManifest(manifest, await readState(workspace.stateFile));
  await writeState(workspace.stateFile, state);
  if (!previous?.latestRunId || state.tasks[options.taskId]?.status !== "implemented") {
    throw new Error(`submit-review requires an implemented run for task '${options.taskId}'.`);
  }

  await mkdir(taskResultDir, { recursive: true });
  const reviewId = `REVIEW-${String((previous.reviewHistory?.length ?? 0) + 1).padStart(3, "0")}`;
  const reviewHistoryPath = join("reviews", `${reviewId}.md`);
  await mkdir(join(taskResultDir, "reviews"), { recursive: true });
  await copyFile(options.reportPath, join(taskResultDir, reviewHistoryPath));
  await copyFile(options.reportPath, join(taskResultDir, "review.md"));

  const taskStatus = options.status === "passed" ? "verified" : "needs_changes";
  const reviewedAt = new Date().toISOString();
  const reviewHistory = [
    ...(previous.reviewHistory ?? []),
    {
      reviewId,
      status: options.status,
      reviewedAt,
      reviewer: "human" as const,
      path: reviewHistoryPath,
      runId: previous.latestRunId
    }
  ];
  const index: ResultIndex = {
    taskId: options.taskId,
    status: taskStatus,
    latestRunId: previous.latestRunId,
    runCount: previous.runCount,
    review: {
      status: options.status,
      reviewedAt,
      reviewer: "human",
      reviewId,
      path: reviewHistoryPath
    },
    reviewHistory,
    ...(previous.divergence ? { divergence: previous.divergence } : {}),
    ...(options.status === "passed" ? { verification: { source: "review" as const, verifiedAt: reviewedAt } } : {}),
    events: [
      ...appendTaskEvent(previous, {
        type: "review_submitted",
        taskId: options.taskId,
        reviewId,
        status: options.status,
        taskStatus,
        reviewer: "human",
        at: reviewedAt
      }),
      ...(options.status === "passed"
        ? [{ type: "verified" as const, taskId: options.taskId, source: "review" as const, at: reviewedAt }]
        : [])
    ]
  };
  await writeResultIndex(join(taskResultDir, "index.json"), index);

  state.tasks[options.taskId] = {
    ...state.tasks[options.taskId],
    status: taskStatus,
    claimedBy: null,
    ...(options.status === "passed" ? { divergence: undefined, blockage: undefined } : {})
  };
  state.currentTaskId = state.currentTaskId === options.taskId ? null : state.currentTaskId;
  await writeState(workspace.stateFile, state);

  return {
    taskId: options.taskId,
    status: options.status,
    taskStatus,
    index
  };
}
