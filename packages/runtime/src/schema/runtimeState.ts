import { z } from "zod";
import {
  blockStatuses,
  feedbackStatuses,
  taskStatuses,
  type RuntimeState
} from "../types/state.js";
import {
  remoteBlockOwnershipSchema,
  remoteInterruptionSchema,
  remoteOperationReceiptSchema
} from "./remoteOwnership.js";

const taskStateSchema = z
  .object({
    status: z.enum(taskStatuses),
    openFeedbackCount: z.number().int()
  })
  .strict();

export const blockStateSchema = z
  .object({
    status: z.enum(blockStatuses),
    lastRunId: z.string().nullable().optional(),
    latestReviewAttemptId: z.string().nullable().optional(),
    activeFeedbackId: z.string().nullable().optional(),
    pendingFeedbackId: z.string().nullable().optional(),
    blockedReason: z.string().nullable().optional(),
    divergenceReason: z.string().nullable().optional(),
    completionReason: z.enum(["passed", "max_cycles_reached"]).nullable().optional(),
    passedWorkRevision: z.string().nullable().optional(),
    remoteOwnership: remoteBlockOwnershipSchema.optional(),
    remoteInterruption: remoteInterruptionSchema.optional(),
    remoteOperationReceipt: remoteOperationReceiptSchema.optional()
  })
  .strict()
  .superRefine((block, context) => {
    if (block.remoteOwnership && block.status !== "in_progress" && block.status !== "diverged") {
      context.addIssue({
        code: "custom",
        path: ["remoteOwnership"],
        message: "remote ownership is allowed only while a block is in_progress or diverged"
      });
    }
    if (
      block.remoteInterruption &&
      (block.status !== "diverged" || block.remoteOwnership?.phase !== "active")
    ) {
      context.addIssue({
        code: "custom",
        path: ["remoteInterruption"],
        message: "remote interruption requires a diverged block with active remote ownership"
      });
    }
    if (
      block.remoteOperationReceipt &&
      ((block.remoteOperationReceipt.outcome === "completed" && block.status !== "completed") ||
        (block.remoteOperationReceipt.outcome === "failed" && block.status !== "blocked"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["remoteOperationReceipt"],
        message: "remote operation receipt must match the terminal block status"
      });
    }
    if (
      block.remoteOperationReceipt?.outcome === "completed" &&
      block.lastRunId !== block.remoteOperationReceipt.runId
    ) {
      context.addIssue({
        code: "custom",
        path: ["remoteOperationReceipt", "runId"],
        message: "completed remote operation receipt must reference lastRunId"
      });
    }
  });

const feedbackEnvelopeSchema = z
  .object({
    status: z.enum(feedbackStatuses),
    sourceReviewBlockRef: z.string(),
    latestSubmissionId: z.string().nullable(),
    content: z.string()
  })
  .strict();

export const runtimeResetReceiptSchema = z
  .object({
    operationId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    sourceRevision: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    graphFingerprint: z.string().regex(/^pkg-[a-f0-9]{64}$/),
    committedAt: z.string().datetime({ offset: true })
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
    feedback: z.record(z.string(), feedbackEnvelopeSchema),
    lastResetReceipt: runtimeResetReceiptSchema.optional()
  })
  .strict() satisfies z.ZodType<RuntimeState>;
