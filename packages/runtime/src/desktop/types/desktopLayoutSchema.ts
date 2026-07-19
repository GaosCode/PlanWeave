import { z } from "zod";

/**
 * Canonical desktop layout shape for IPC transport, Desktop DTOs, and PlanGraph commands.
 * Disk migration via layoutStore.normalizeLayout remains separate and is not this authority.
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

/** Canonical desktop layout node type (derived from schema). */
export type DesktopLayoutNode = z.infer<typeof desktopLayoutNodeSchema>;

/** Canonical desktop layout file type (derived from schema). */
export type DesktopLayout = z.infer<typeof desktopLayoutFileSchema>;

/** @deprecated Prefer DesktopLayoutNode — alias kept for existing Input-named exports. */
export type DesktopLayoutNodeInput = DesktopLayoutNode;

/** @deprecated Prefer DesktopLayout — alias kept for existing Input-named exports. */
export type DesktopLayoutFileInput = DesktopLayout;
