import { z } from "zod";
import {
  opaqueIdentifierSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";

export const collaborationCanvasSessionInputSchema = z
  .object({
    localProjectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema
  })
  .strict();
export type CollaborationCanvasSessionInput = z.infer<typeof collaborationCanvasSessionInputSchema>;

export const collaborationContentAuthorityCanvasInputSchema = collaborationCanvasSessionInputSchema;
export type CollaborationContentAuthorityCanvasInput = CollaborationCanvasSessionInput;

const localCollaborationCanvasBindingInputSchema = z
  .object({
    kind: z.literal("local"),
    localProjectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema
  })
  .strict();

const remoteCollaborationCanvasBindingInputSchema = z
  .object({
    kind: z.literal("remote"),
    workspaceId: workspaceIdSchema,
    projectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema
  })
  .strict();

/** Exact Canvas identity. Remote bindings never carry or synthesize local package identity. */
export const collaborationCanvasBindingInputSchema = z.discriminatedUnion("kind", [
  localCollaborationCanvasBindingInputSchema,
  remoteCollaborationCanvasBindingInputSchema
]);
export type CollaborationCanvasBindingInput = z.infer<typeof collaborationCanvasBindingInputSchema>;
export type LocalCollaborationCanvasBindingInput = Extract<
  CollaborationCanvasBindingInput,
  { kind: "local" }
>;
export type RemoteCollaborationCanvasBindingInput = Extract<
  CollaborationCanvasBindingInput,
  { kind: "remote" }
>;

export function asLocalCollaborationCanvasBinding(
  input: CollaborationCanvasSessionInput
): LocalCollaborationCanvasBindingInput {
  return localCollaborationCanvasBindingInputSchema.parse({ kind: "local", ...input });
}
