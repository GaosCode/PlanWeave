import {
  feedbackArtifactEnvelope,
  implementationArtifactEnvelope,
  materializeFinalArtifact,
  reviewArtifactEnvelope
} from "./finalArtifactContract.js";
import { reviewResultSchema } from "../taskManager/reviewResultContract.js";
import { basename, dirname } from "node:path";
import type { ArtifactReference } from "./runnerContractSchemas.js";

export async function materializeImplementationArtifact(input: {
  ref: string;
  taskId: string;
  reportMarkdown: string;
  path: string;
}): Promise<ArtifactReference> {
  const envelope = implementationArtifactEnvelope({
    ref: input.ref,
    taskId: input.taskId,
    reportMarkdown: input.reportMarkdown
  });
  return materializeFinalArtifact({
    envelope,
    expected: { kind: "implementation", ref: input.ref, taskId: input.taskId },
    rootDir: dirname(input.path),
    relativePath: basename(input.path)
  });
}

export async function materializeReviewArtifact(input: {
  ref: string;
  taskId: string;
  reviewResult: unknown;
  path: string;
}): Promise<ArtifactReference> {
  const envelope = reviewArtifactEnvelope({
    ref: input.ref,
    taskId: input.taskId,
    reviewResult: reviewResultSchema.parse(input.reviewResult)
  });
  return materializeFinalArtifact({
    envelope,
    expected: { kind: "review", ref: input.ref, taskId: input.taskId },
    rootDir: dirname(input.path),
    relativePath: basename(input.path)
  });
}

export async function materializeFeedbackArtifact(input: {
  feedbackId: string;
  sourceReviewBlockRef: string;
  taskId: string;
  reportMarkdown: string;
  path: string;
}): Promise<ArtifactReference> {
  const envelope = feedbackArtifactEnvelope({
    feedbackId: input.feedbackId,
    sourceReviewBlockRef: input.sourceReviewBlockRef,
    taskId: input.taskId,
    reportMarkdown: input.reportMarkdown
  });
  return materializeFinalArtifact({
    envelope,
    expected: {
      kind: "feedback",
      feedbackId: input.feedbackId,
      sourceReviewBlockRef: input.sourceReviewBlockRef,
      taskId: input.taskId
    },
    rootDir: dirname(input.path),
    relativePath: basename(input.path)
  });
}
