import { z } from "zod";
import { canvasCommandSubmissionIntentSchema } from "@planweave-ai/collaboration-protocol/canvas/commands";
import { workspaceCanvasLocatorSchema } from "./canvasLocator.js";
import { collaborationRemoteCanvasReplicaProjectionSchema } from "./canvasReplicaIpc.js";

/** Command result for one Workspace Canvas. Not mixed with Runtime availability. */
export const workspaceCanvasProjectionStatusSchema = z.enum([
  "pending",
  "accepted",
  "conflicted",
  "rejected"
]);
export type WorkspaceCanvasProjectionStatus = z.infer<typeof workspaceCanvasProjectionStatusSchema>;

export const workspaceCanvasConflictSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    authoritativeRevision: z.number().int().nonnegative(),
    authoritativeContentDigest: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
export type WorkspaceCanvasConflict = z.infer<typeof workspaceCanvasConflictSchema>;

/**
 * Renderer-facing Workspace Canvas view. `locator.connectionProfileId` is Desktop-only identity.
 * `replica` is the in-memory Server projection; pending ops are never a Local Canvas write.
 */
export const workspaceCanvasProjectionSchema = z
  .object({
    locator: workspaceCanvasLocatorSchema,
    status: workspaceCanvasProjectionStatusSchema,
    conflict: workspaceCanvasConflictSchema.nullable(),
    rejectCode: z.string().nullable(),
    replica: collaborationRemoteCanvasReplicaProjectionSchema
  })
  .strict();
export type WorkspaceCanvasProjection = z.infer<typeof workspaceCanvasProjectionSchema>;

export const workspaceCanvasProjectionSignalSchema = z
  .object({
    type: z.literal("workspace.canvas.projection"),
    projection: workspaceCanvasProjectionSchema
  })
  .strict();
export type WorkspaceCanvasProjectionSignal = z.infer<typeof workspaceCanvasProjectionSignalSchema>;

export const workspaceCanvasCommandSubmitInputSchema = z
  .object({
    locator: workspaceCanvasLocatorSchema,
    intent: canvasCommandSubmissionIntentSchema
  })
  .strict();
export type WorkspaceCanvasCommandSubmitInput = z.infer<
  typeof workspaceCanvasCommandSubmitInputSchema
>;

export function workspaceCanvasProjectionStatus(input: {
  optimisticOperationIds: readonly string[];
  conflict: WorkspaceCanvasConflict | null;
  rejectCode: string | null;
}): WorkspaceCanvasProjectionStatus {
  if (input.optimisticOperationIds.length > 0) return "pending";
  if (input.conflict) return "conflicted";
  if (input.rejectCode) return "rejected";
  return "accepted";
}
