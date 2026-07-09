import { z } from "zod";
import {
  blockStatuses,
  feedbackStatuses,
  taskStatuses,
  type RuntimeState
} from "../types/state.js";

const taskStateSchema = z
  .object({
    status: z.enum(taskStatuses),
    openFeedbackCount: z.number().int()
  })
  .strict();

const blockStateSchema = z
  .object({
    status: z.enum(blockStatuses),
    lastRunId: z.string().nullable().optional(),
    latestReviewAttemptId: z.string().nullable().optional(),
    activeFeedbackId: z.string().nullable().optional(),
    pendingFeedbackId: z.string().nullable().optional(),
    blockedReason: z.string().nullable().optional(),
    divergenceReason: z.string().nullable().optional(),
    completionReason: z.enum(["passed", "max_cycles_reached"]).nullable().optional(),
    passedWorkRevision: z.string().nullable().optional()
  })
  .strict();

const feedbackEnvelopeSchema = z
  .object({
    status: z.enum(feedbackStatuses),
    sourceReviewBlockRef: z.string(),
    latestSubmissionId: z.string().nullable(),
    content: z.string()
  })
  .strict();

/**
 * Runtime validation for on-disk `state.json`.
 * Hand-written `RuntimeState` remains the TS source of truth; this schema must stay aligned
 * via the compile-time `satisfies` check (z.infer re-export would cascade across consumers).
 */
export const runtimeStateSchema = z
  .object({
    currentRefs: z.array(z.string()),
    currentFeedbackId: z.string().nullable(),
    currentReviewBlockRef: z.string().nullable(),
    tasks: z.record(z.string(), taskStateSchema),
    blocks: z.record(z.string(), blockStateSchema),
    feedback: z.record(z.string(), feedbackEnvelopeSchema)
  })
  .strict() satisfies z.ZodType<RuntimeState>;
