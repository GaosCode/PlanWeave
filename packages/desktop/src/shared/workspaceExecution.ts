import {
  effectiveWorkspaceExecutorSchema,
  workspaceExecutionCoordinatorViewSchema
} from "@planweave-ai/runtime/browser";
import { z } from "zod";
import { remoteInteractionResponseSchema } from "@planweave-ai/collaboration-protocol/remote-run";
import { workspaceCanvasLocatorSchema } from "./canvasLocator.js";

const identifierSchema = z.string().trim().min(1).max(256);

export const desktopWorkspaceExecutionStartInputSchema = z
  .object({
    locator: workspaceCanvasLocatorSchema,
    blockRef: z.string().trim().min(3).max(512),
    agentEndpointId: identifierSchema,
    effectiveExecutor: effectiveWorkspaceExecutorSchema
  })
  .strict();

const desktopWorkspaceExecutionSessionFollowInputSchema = desktopWorkspaceExecutionStartInputSchema
  .extend({ sessionId: z.string().regex(/^SESSION-\d{4,}$/) })
  .strict();

const desktopWorkspaceExecutionExistingFollowInputSchema = z
  .object({
    locator: workspaceCanvasLocatorSchema,
    blockRef: z.string().trim().min(3).max(512),
    operationId: identifierSchema
  })
  .strict();

export const desktopWorkspaceExecutionFollowInputSchema = z.union([
  desktopWorkspaceExecutionSessionFollowInputSchema,
  desktopWorkspaceExecutionExistingFollowInputSchema
]);

export const desktopWorkspaceExecutionCancelInputSchema =
  desktopWorkspaceExecutionSessionFollowInputSchema
    .extend({ actionId: identifierSchema, reason: z.string().trim().min(1).max(2_048) })
    .strict();

export const desktopWorkspaceExecutionRespondInputSchema =
  desktopWorkspaceExecutionSessionFollowInputSchema
    .extend({ response: remoteInteractionResponseSchema })
    .strict();

export const desktopWorkspaceExecutionResponseSchema = workspaceExecutionCoordinatorViewSchema;

export type DesktopWorkspaceExecutionStartInput = z.infer<
  typeof desktopWorkspaceExecutionStartInputSchema
>;
export type DesktopWorkspaceExecutionFollowInput = z.infer<
  typeof desktopWorkspaceExecutionFollowInputSchema
>;
export type DesktopWorkspaceExecutionCancelInput = z.infer<
  typeof desktopWorkspaceExecutionCancelInputSchema
>;
export type DesktopWorkspaceExecutionRespondInput = z.infer<
  typeof desktopWorkspaceExecutionRespondInputSchema
>;
export type DesktopWorkspaceExecutionResponse = z.infer<
  typeof desktopWorkspaceExecutionResponseSchema
>;

export interface PlanWeaveWorkspaceExecutionApi {
  startWorkspaceExecution(
    input: DesktopWorkspaceExecutionStartInput
  ): Promise<DesktopWorkspaceExecutionResponse>;
  followWorkspaceExecution(
    input: DesktopWorkspaceExecutionFollowInput
  ): Promise<DesktopWorkspaceExecutionResponse>;
  cancelWorkspaceExecution(
    input: DesktopWorkspaceExecutionCancelInput
  ): Promise<DesktopWorkspaceExecutionResponse>;
  respondWorkspaceExecution(
    input: DesktopWorkspaceExecutionRespondInput
  ): Promise<DesktopWorkspaceExecutionResponse>;
}
