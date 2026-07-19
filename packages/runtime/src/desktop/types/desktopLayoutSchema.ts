import { z } from "zod";

/**
 * Transport / PlanGraph desktop layout shape (strict array form).
 * Disk migration via layoutStore.normalizeLayout remains separate and is not IPC authority.
 */
export const desktopLayoutNodeSchema = z
  .object({
    nodeId: z.string(),
    x: z.number(),
    y: z.number()
  })
  .strict();

export const desktopLayoutFileSchema = z
  .object({
    version: z.literal("desktop-layout/v1"),
    projectId: z.string().min(1),
    nodes: z.array(desktopLayoutNodeSchema),
    updatedAt: z.string().min(1)
  })
  .strict();

export type DesktopLayoutNodeInput = z.infer<typeof desktopLayoutNodeSchema>;
export type DesktopLayoutFileInput = z.infer<typeof desktopLayoutFileSchema>;
