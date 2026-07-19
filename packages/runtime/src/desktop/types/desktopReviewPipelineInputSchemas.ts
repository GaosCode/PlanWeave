import { z } from "zod";
import { reviewTriggerConditions } from "../../types.js";

/**
 * Bridge DTO schemas for updateReviewPipeline IPC.
 * Does not parse manifest reviewBlockSchema; domain rewrite stays in runtime.
 */
export const desktopReviewHookSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("executable"),
    command: z.string().min(1),
    args: z.array(z.string()),
    executionPolicy: z.literal("trusted-local")
  })
  .strict();

export const desktopReviewPipelineStepInputSchema = z
  .object({
    blockRef: z.string().nullable().optional(),
    blockId: z.string(),
    title: z.string(),
    enabled: z.boolean(),
    preset: z.string(),
    triggerCondition: z.enum(reviewTriggerConditions),
    inputContext: z.string(),
    passCriteria: z.string(),
    feedbackFormat: z.string(),
    maxFeedbackCycles: z.number(),
    hook: desktopReviewHookSchema.nullable(),
    promptMarkdown: z.string()
  })
  .strict();

export const desktopReviewPipelinePackageDefaultsSchema = z
  .object({
    maxFeedbackCycles: z.number(),
    completionPolicy: z.literal("strict")
  })
  .strict();

export const desktopUpdateReviewPipelineInputSchema = z
  .object({
    packageDefaults: desktopReviewPipelinePackageDefaultsSchema.optional(),
    steps: z.array(desktopReviewPipelineStepInputSchema)
  })
  .strict();

export type DesktopUpdateReviewPipelineInputParsed = z.infer<
  typeof desktopUpdateReviewPipelineInputSchema
>;
