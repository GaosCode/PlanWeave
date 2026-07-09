import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "../json.js";
import type { FeedbackStatus, ProjectWorkspace } from "../types.js";

export type FeedbackArtifact = {
  feedbackId: string;
  sourceReviewBlockRef: string;
  content: string;
  sourceReviewAttemptId: string;
  status: FeedbackStatus;
  createdAt: string;
  latestSubmissionId?: string | null;
  resolvedAt?: string;
};

function feedbackArtifactPath(
  workspace: ProjectWorkspace,
  taskId: string,
  feedbackId: string
): string {
  return join(workspace.resultsDir, taskId, "feedback", feedbackId, "feedback.json");
}

export async function writeFeedbackArtifact(
  workspace: ProjectWorkspace,
  taskId: string,
  artifact: FeedbackArtifact
): Promise<void> {
  await writeJsonFile(feedbackArtifactPath(workspace, taskId, artifact.feedbackId), artifact);
}

export async function patchFeedbackArtifact(
  workspace: ProjectWorkspace,
  taskId: string,
  feedbackId: string,
  patch: Pick<FeedbackArtifact, "status"> &
    Partial<Pick<FeedbackArtifact, "latestSubmissionId" | "resolvedAt">>
): Promise<void> {
  const path = feedbackArtifactPath(workspace, taskId, feedbackId);
  const current = await readJsonFile<FeedbackArtifact>(path);
  await writeJsonFile(path, {
    ...current,
    ...patch
  });
}
