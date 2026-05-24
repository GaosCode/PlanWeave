import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile } from "../json.js";
import { writeState } from "../state.js";
import type { ExecutionGraphSession, PackageWorkspaceRef, SubmitFeedbackResult } from "../types.js";
import { patchFeedbackArtifact } from "./feedbackArtifacts.js";
import { loadRuntime, refreshDerivedState } from "./runtimeContext.js";
import { incrementTaskIndexCount, listDirCount, nextId, updateTaskIndex } from "./resultIndex.js";

export async function submitFeedback(options: {
  projectRoot: PackageWorkspaceRef;
  reportPath: string;
  session?: ExecutionGraphSession;
}): Promise<SubmitFeedbackResult> {
  const context = await loadRuntime(options);
  const { workspace, manifest, graph } = context;
  let { state } = context;
  const feedbackId = state.currentFeedbackId;
  if (!feedbackId || !state.feedback[feedbackId]) {
    throw new Error("submit-feedback requires an active feedback event.");
  }
  const feedback = state.feedback[feedbackId];
  const taskId = graph.blockTaskByRef.get(feedback.sourceReviewBlockRef);
  if (!taskId) {
    throw new Error(`Feedback '${feedbackId}' points to an unknown review block.`);
  }
  const submissionRoot = join(workspace.resultsDir, taskId, "feedback", feedbackId, "submissions");
  const submissionId = nextId("FS", await listDirCount(submissionRoot));
  const submissionDir = join(submissionRoot, submissionId);
  await mkdir(submissionDir, { recursive: true });
  await copyFile(options.reportPath, join(submissionDir, "report.md"));
  await writeJsonFile(join(submissionDir, "metadata.json"), {
    feedbackId,
    submissionId,
    sourceReviewBlockRef: feedback.sourceReviewBlockRef,
    submittedAt: new Date().toISOString()
  });
  await updateTaskIndex(workspace, taskId, (index) => ({
    ...index,
    latestFeedbackSubmissionByFeedback: {
      ...(index.latestFeedbackSubmissionByFeedback ?? {}),
      [feedbackId]: submissionId
    },
    feedbackStatusById: {
      ...(index.feedbackStatusById ?? {}),
      [feedbackId]: "resolved"
    },
    counts: incrementTaskIndexCount(index, "feedbackSubmissions")
  }));
  await patchFeedbackArtifact(workspace, taskId, feedbackId, {
    status: "resolved",
    latestSubmissionId: submissionId,
    resolvedAt: new Date().toISOString()
  });
  state.feedback[feedbackId] = {
    ...feedback,
    status: "resolved",
    latestSubmissionId: submissionId
  };
  state.blocks[feedback.sourceReviewBlockRef] = {
    ...state.blocks[feedback.sourceReviewBlockRef],
    status: "in_progress",
    activeFeedbackId: null
  };
  state.currentFeedbackId = feedbackId;
  state.currentReviewBlockRef = feedback.sourceReviewBlockRef;
  state.currentRefs = [feedback.sourceReviewBlockRef];
  state = refreshDerivedState(manifest, state);
  await writeState(workspace.stateFile, state);
  return {
    status: "accepted",
    nextCommand: "planweave claim-next",
    message: "Feedback submitted. Run `planweave claim-next` to continue the review loop.",
    feedbackId,
    submissionId
  };
}
