import { z } from "zod";
import { acpRunRecoveryExecutionSchema } from "../../autoRun/acpRunRecovery.js";

export const desktopAutoRunScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project") }).strict(),
  z
    .object({
      kind: z.literal("task"),
      taskId: z.string().min(1)
    })
    .strict(),
  z
    .object({
      kind: z.literal("block"),
      blockRef: z.string().min(1)
    })
    .strict()
]);

/**
 * Transport options only. Defaults (tmuxEnabled=true, acpRecovery=null) stay in runtime.
 */
export const desktopAutoRunOptionsSchema = z
  .object({
    tmuxEnabled: z.boolean().optional(),
    acpRecovery: acpRunRecoveryExecutionSchema.nullable().optional()
  })
  .strict();

/** Optional explicit step limit; undefined keeps runtime default (20). */
export const desktopAutoRunStepLimitSchema = z.number().int().positive().max(10_000);

export const desktopRuntimeResetOptionsSchema = z
  .object({
    force: z.boolean().optional(),
    reason: z.string().optional()
  })
  .strict();

export type DesktopAutoRunScopeInput = z.infer<typeof desktopAutoRunScopeSchema>;
export type DesktopAutoRunOptionsInput = z.infer<typeof desktopAutoRunOptionsSchema>;
export type DesktopRuntimeResetOptionsInput = z.infer<typeof desktopRuntimeResetOptionsSchema>;
