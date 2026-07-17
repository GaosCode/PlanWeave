import { z } from "zod";
import { reviewResultSchema } from "../taskManager/reviewResultContract.js";

export const FINAL_ARTIFACT_MARKER = "PLANWEAVE_FINAL_ARTIFACT ";

const implementationArtifactSchema = z
  .object({
    kind: z.literal("implementation"),
    ref: z.string().min(1),
    taskId: z.string().min(1),
    reportMarkdown: z
      .string()
      .refine((value) => value.trim().length > 0, "Report must not be blank.")
  })
  .strict();

const reviewArtifactSchema = z
  .object({
    kind: z.literal("review"),
    ref: z.string().min(1),
    taskId: z.string().min(1),
    reviewResult: reviewResultSchema
  })
  .strict()
  .superRefine((artifact, context) => {
    if (
      artifact.reviewResult.reviewBlockRef !== artifact.ref ||
      artifact.reviewResult.taskId !== artifact.taskId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewResult"],
        message: "Review result identity must match the artifact ref and taskId."
      });
    }
  });

const feedbackArtifactSchema = z
  .object({
    kind: z.literal("feedback"),
    feedbackId: z.string().min(1),
    sourceReviewBlockRef: z.string().min(1),
    taskId: z.string().min(1),
    reportMarkdown: z
      .string()
      .refine((value) => value.trim().length > 0, "Report must not be blank.")
  })
  .strict();

export const finalArtifactEnvelopeSchema = z
  .object({
    version: z.literal("planweave.runner-artifact/v1"),
    artifact: z.discriminatedUnion("kind", [
      implementationArtifactSchema,
      reviewArtifactSchema,
      feedbackArtifactSchema
    ])
  })
  .strict();

export type FinalArtifactEnvelope = z.infer<typeof finalArtifactEnvelopeSchema>;
export type FinalArtifact = FinalArtifactEnvelope["artifact"];
