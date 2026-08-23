import type { CanvasRuntimeAvailability } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import {
  canvasRuntimeInitializeRequestSchema,
  type CanvasRuntimeInitializeOutcome,
  canvasRuntimeResetRequestSchema,
  type CanvasRuntimeResetOutcome
} from "@planweave-ai/collaboration-protocol/canvas/runtime-control";
import { z } from "zod";
import type { RemoteCollaborationCanvasBindingInput } from "./collaborationCanvasBinding.js";
import { workspaceCanvasLocatorSchema } from "./canvasLocator.js";

export const workspaceCanvasRuntimeResetRequestSchema = canvasRuntimeResetRequestSchema.omit({
  expectedContentRevision: true
});
export type WorkspaceCanvasRuntimeResetRequest = z.infer<
  typeof workspaceCanvasRuntimeResetRequestSchema
>;

export const workspaceCanvasRuntimeResetInputSchema = z
  .object({
    locator: workspaceCanvasLocatorSchema,
    ...workspaceCanvasRuntimeResetRequestSchema.shape
  })
  .strict();
export type WorkspaceCanvasRuntimeResetInput = z.infer<
  typeof workspaceCanvasRuntimeResetInputSchema
>;

export const workspaceCanvasRuntimeInitializeRequestSchema =
  canvasRuntimeInitializeRequestSchema.omit({ expectedContentRevision: true });
export type WorkspaceCanvasRuntimeInitializeRequest = z.infer<
  typeof workspaceCanvasRuntimeInitializeRequestSchema
>;

export const workspaceCanvasRuntimeInitializeInputSchema = z
  .object({
    locator: workspaceCanvasLocatorSchema,
    ...workspaceCanvasRuntimeInitializeRequestSchema.shape
  })
  .strict();
export type WorkspaceCanvasRuntimeInitializeInput = z.infer<
  typeof workspaceCanvasRuntimeInitializeInputSchema
>;

export type PlanWeaveCollaborationRuntimeAvailabilityApi = {
  readCollaborationCanvasBindingRuntimeAvailability: (
    input: RemoteCollaborationCanvasBindingInput
  ) => Promise<CanvasRuntimeAvailability | null>;
  initializeWorkspaceCanvasRuntime: (
    input: WorkspaceCanvasRuntimeInitializeInput
  ) => Promise<CanvasRuntimeInitializeOutcome>;
  resetWorkspaceCanvasRuntime: (
    input: WorkspaceCanvasRuntimeResetInput
  ) => Promise<CanvasRuntimeResetOutcome>;
};
