import { join } from "node:path";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "../json.js";
import { feedbackStatuses, type ProjectWorkspace } from "../types.js";

export const feedbackArtifactSchema = z
  .object({
    feedbackId: z.string().min(1),
    sourceReviewBlockRef: z.string().min(1),
    content: z.string(),
    sourceReviewAttemptId: z.string().min(1),
    status: z.enum(feedbackStatuses),
    createdAt: z.string().datetime(),
    latestSubmissionId: z.string().min(1).nullable().optional(),
    resolvedAt: z.string().datetime().optional()
  })
  .strict();

export type FeedbackArtifact = z.infer<typeof feedbackArtifactSchema>;

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
  const parsed = feedbackArtifactSchema.parse(artifact);
  await writeJsonFile(feedbackArtifactPath(workspace, taskId, parsed.feedbackId), parsed);
}

export async function readFeedbackArtifact(
  workspace: ProjectWorkspace,
  taskId: string,
  feedbackId: string
): Promise<FeedbackArtifact> {
  return feedbackArtifactSchema.parse(
    await readJsonFile<unknown>(feedbackArtifactPath(workspace, taskId, feedbackId))
  );
}

export async function patchFeedbackArtifact(
  workspace: ProjectWorkspace,
  taskId: string,
  feedbackId: string,
  patch: Pick<FeedbackArtifact, "status"> &
    Partial<Pick<FeedbackArtifact, "latestSubmissionId" | "resolvedAt">>
): Promise<void> {
  const path = feedbackArtifactPath(workspace, taskId, feedbackId);
  const current = feedbackArtifactSchema.parse(await readJsonFile<unknown>(path));
  await writeJsonFile(path, {
    ...current,
    ...patch
  });
}
