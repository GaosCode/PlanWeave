import { z } from "zod";
import { canvasVisibilitySchema } from "@planweave-ai/collaboration-protocol/access/project";
import { contentVersionDesktopReadModelSchema } from "@planweave-ai/collaboration-protocol/content/authority";

const opaqueIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const workspaceCanvasSharingStateSchema = z.enum([
  "local_only",
  "registered_unpublished",
  "published_outdated",
  "published_private",
  "published_shared"
]);
export type WorkspaceCanvasSharingState = z.infer<typeof workspaceCanvasSharingStateSchema>;

export const workspaceCanvasSharingCandidateSchema = z
  .object({
    localProjectId: opaqueIdSchema,
    projectName: z.string().trim().min(1).max(256),
    canvasId: opaqueIdSchema,
    canvasName: z.string().trim().min(1).max(256),
    state: workspaceCanvasSharingStateSchema,
    visibility: canvasVisibilitySchema.nullable(),
    authority: contentVersionDesktopReadModelSchema.nullable()
  })
  .strict();
export type WorkspaceCanvasSharingCandidate = z.infer<typeof workspaceCanvasSharingCandidateSchema>;

export const workspaceCanvasPublishInputSchema = z
  .object({
    localProjectId: opaqueIdSchema,
    canvasId: opaqueIdSchema
  })
  .strict();
export type WorkspaceCanvasPublishInput = z.infer<typeof workspaceCanvasPublishInputSchema>;

export type WorkspaceCanvasSharingApi = {
  listWorkspaceCanvasSharingCandidates: () => Promise<WorkspaceCanvasSharingCandidate[]>;
  publishWorkspaceCanvas: (
    input: WorkspaceCanvasPublishInput
  ) => Promise<WorkspaceCanvasSharingCandidate>;
};
