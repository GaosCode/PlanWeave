import { z } from "zod";

/**
 * Shared Desktop canvas reference used by graph/layout/run IPC mutators.
 * Path existence and canvas resolution remain runtime domain ownership.
 */
export const desktopCanvasReferenceSchema = z
  .object({
    projectRoot: z.string().min(1),
    canvasId: z.string().min(1).nullable().optional()
  })
  .strict();

export type DesktopCanvasReferenceInput = z.infer<typeof desktopCanvasReferenceSchema>;

export const desktopPromptSaveOptionsSchema = z
  .object({
    baseGraphVersion: z.string().optional(),
    basePromptHash: z.string().optional()
  })
  .strict();

export type DesktopPromptSaveOptionsInput = z.infer<typeof desktopPromptSaveOptionsSchema>;
