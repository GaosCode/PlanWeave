import { z } from "zod";
import {
  opaqueIdentifierSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import type {
  CollaborationCanvasBindingInput,
  LocalCollaborationCanvasBindingInput,
  RemoteCollaborationCanvasBindingInput
} from "./collaborationCanvasBinding.js";

const localCanvasLocatorSchema = z
  .object({
    kind: z.literal("local"),
    projectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema
  })
  .strict();

const workspaceCanvasLocatorSchema = z
  .object({
    kind: z.literal("workspace"),
    connectionProfileId: opaqueIdentifierSchema,
    workspaceId: workspaceIdSchema,
    projectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema
  })
  .strict();

/** Navigation identity and authority location. Does not carry graph, cache, Host, or ACL. */
export const canvasLocatorSchema = z.discriminatedUnion("kind", [
  localCanvasLocatorSchema,
  workspaceCanvasLocatorSchema
]);
export type CanvasLocator = z.infer<typeof canvasLocatorSchema>;
export type LocalCanvasLocator = Extract<CanvasLocator, { kind: "local" }>;
export type WorkspaceCanvasLocator = Extract<CanvasLocator, { kind: "workspace" }>;

export { localCanvasLocatorSchema, workspaceCanvasLocatorSchema };

export function canvasLocatorToCollaborationBinding(
  locator: CanvasLocator
): CollaborationCanvasBindingInput {
  return locator.kind === "local"
    ? localCanvasLocatorToBinding(locator)
    : workspaceCanvasLocatorToBinding(locator);
}

export function localCanvasLocatorToBinding(
  locator: LocalCanvasLocator
): LocalCollaborationCanvasBindingInput {
  return {
    kind: "local",
    localProjectId: locator.projectId,
    canvasId: locator.canvasId
  };
}

/** Desktop-only `connectionProfileId` is dropped; Server protocol never receives it. */
export function workspaceCanvasLocatorToBinding(
  locator: WorkspaceCanvasLocator
): RemoteCollaborationCanvasBindingInput {
  return {
    kind: "remote",
    workspaceId: locator.workspaceId,
    projectId: locator.projectId,
    canvasId: locator.canvasId
  };
}

export function parsePersistedWorkspaceCanvasLocator(
  value: unknown
): WorkspaceCanvasLocator | null {
  if (value === null) return null;
  const parsed = workspaceCanvasLocatorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
