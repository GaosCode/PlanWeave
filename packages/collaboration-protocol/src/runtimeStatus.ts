import { z } from "zod";
import { canvasScopeRefSchema, timestampSchema } from "./primitives.js";

export const canvasRuntimeStatusSchemaVersion = "canvas-runtime-status/v2" as const;
export const canvasRuntimeTaskStatuses = [
  "planned",
  "ready",
  "in_progress",
  "implemented"
] as const;
export const canvasRuntimeBlockStatuses = [
  "planned",
  "ready",
  "in_progress",
  "completed",
  "needs_changes",
  "blocked",
  "diverged"
] as const;

const runtimeIdentitySchema = z.string().trim().min(1).max(256);
export const canvasRuntimePackageFingerprintSchema = z.string().regex(/^pkg-[a-f0-9]{64}$/);
export type CanvasRuntimePackageFingerprint = z.infer<typeof canvasRuntimePackageFingerprintSchema>;
const taskStatusSchema = z
  .object({
    taskId: runtimeIdentitySchema,
    status: z.enum(canvasRuntimeTaskStatuses),
    openFeedbackCount: z.number().int().nonnegative()
  })
  .strict();
const blockStatusSchema = z
  .object({
    ref: runtimeIdentitySchema,
    status: z.enum(canvasRuntimeBlockStatuses),
    completionReason: z.enum(["passed", "max_cycles_reached"]).nullable(),
    blockedReason: z.string().max(2_000).nullable(),
    divergenceReason: z.string().max(2_000).nullable(),
    dispatchable: z.boolean()
  })
  .strict();

export const canvasRuntimeStatusProjectionSchema = z
  .object({
    schemaVersion: z.literal(canvasRuntimeStatusSchemaVersion),
    scope: canvasScopeRefSchema,
    packageFingerprint: canvasRuntimePackageFingerprintSchema,
    capturedAt: timestampSchema,
    tasks: z.array(taskStatusSchema).max(10_000),
    blocks: z.array(blockStatusSchema).max(50_000)
  })
  .strict()
  .superRefine((value, context) => {
    const taskIds = value.tasks.map((task) => task.taskId);
    if (new Set(taskIds).size !== taskIds.length) {
      context.addIssue({ code: "custom", path: ["tasks"], message: "duplicate_task_status" });
    }
    const blockRefs = value.blocks.map((block) => block.ref);
    if (new Set(blockRefs).size !== blockRefs.length) {
      context.addIssue({ code: "custom", path: ["blocks"], message: "duplicate_block_status" });
    }
  });

export type CanvasRuntimeStatusProjection = z.infer<typeof canvasRuntimeStatusProjectionSchema>;
