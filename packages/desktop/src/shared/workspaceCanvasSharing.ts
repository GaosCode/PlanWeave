import { z } from "zod";
import { canvasVisibilitySchema } from "@planweave-ai/collaboration-protocol/access/project";
import { contentVersionDesktopReadModelSchema } from "@planweave-ai/collaboration-protocol/content/authority";
import {
  completedContentVersionRefSchema,
  contentVersionRevisionSchema,
  workspaceCanvasPublishOperationIdSchema,
  workspaceCanvasPublishRecoveryTokenSchema
} from "@planweave-ai/collaboration-protocol/content/version";
import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { localCanvasLocatorSchema, workspaceCanvasLocatorSchema } from "./canvasLocator.js";

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
    canvasId: opaqueIdSchema,
    operationId: workspaceCanvasPublishOperationIdSchema.optional()
  })
  .strict();
export type WorkspaceCanvasPublishInput = z.infer<typeof workspaceCanvasPublishInputSchema>;

export const workspaceCanvasPublishAuthoritySwitchSchema = z.enum(["opened", "retry_open"]);
export type WorkspaceCanvasPublishAuthoritySwitch = z.infer<
  typeof workspaceCanvasPublishAuthoritySwitchSchema
>;

/** Desktop publish result: Server authority plus a retryable Workspace locator. */
export const workspaceCanvasPublishResultSchema = z
  .object({
    outcome: z.enum(["published", "reused"]),
    operationId: workspaceCanvasPublishOperationIdSchema,
    recoveryToken: workspaceCanvasPublishRecoveryTokenSchema,
    locator: workspaceCanvasLocatorSchema,
    revision: contentVersionRevisionSchema,
    content: completedContentVersionRefSchema,
    visibility: canvasVisibilitySchema,
    authoritySwitch: workspaceCanvasPublishAuthoritySwitchSchema,
    localSourceRetained: z.literal(true),
    candidate: workspaceCanvasSharingCandidateSchema
  })
  .strict();
export type WorkspaceCanvasPublishResult = z.infer<typeof workspaceCanvasPublishResultSchema>;

export const workspaceCanvasDownloadInputSchema = z
  .object({
    workspaceId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    canvasId: opaqueIdSchema,
    revision: contentVersionRevisionSchema,
    content: completedContentVersionRefSchema,
    projectName: z.string().trim().min(1).max(256).optional()
  })
  .strict();
export type WorkspaceCanvasDownloadInput = z.infer<typeof workspaceCanvasDownloadInputSchema>;

export const workspaceCanvasDownloadLineageSchema = z
  .object({
    schemaVersion: z.literal("workspace-fork-lineage/v1"),
    writeback: z.literal(false),
    source: z
      .object({
        scope: canvasScopeRefSchema,
        revision: contentVersionRevisionSchema,
        content: completedContentVersionRefSchema
      })
      .strict()
  })
  .strict();
export type WorkspaceCanvasDownloadLineage = z.infer<typeof workspaceCanvasDownloadLineageSchema>;

export const workspaceCanvasDownloadResultSchema = z
  .object({
    locator: localCanvasLocatorSchema,
    localProjectId: opaqueIdSchema,
    localCanvasId: opaqueIdSchema,
    lineage: workspaceCanvasDownloadLineageSchema,
    writeback: z.literal(false)
  })
  .strict();
export type WorkspaceCanvasDownloadResult = z.infer<typeof workspaceCanvasDownloadResultSchema>;

export type WorkspaceCanvasSharingApi = {
  listWorkspaceCanvasSharingCandidates: () => Promise<WorkspaceCanvasSharingCandidate[]>;
  publishWorkspaceCanvas: (
    input: WorkspaceCanvasPublishInput
  ) => Promise<WorkspaceCanvasPublishResult>;
  downloadWorkspaceCanvasFork: (
    input: WorkspaceCanvasDownloadInput
  ) => Promise<WorkspaceCanvasDownloadResult>;
};
