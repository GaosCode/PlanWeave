import {
  effectiveWorkspaceExecutorSchema,
  workspaceExecutionCoordinatorViewSchema
} from "@planweave-ai/runtime/browser";
import { z } from "zod";
import { remoteInteractionResponseSchema } from "@planweave-ai/collaboration-protocol/remote-run";
import { workspaceCanvasLocatorSchema } from "./canvasLocator.js";

const identifierSchema = z.string().trim().min(1).max(256);
const blockExecutionShape = {
  blockRef: z.string().trim().min(3).max(512),
  agentEndpointId: identifierSchema,
  effectiveExecutor: effectiveWorkspaceExecutorSchema
};

const desktopWorkspaceCanvasExecutionStartInputSchema = z
  .object({
    locator: workspaceCanvasLocatorSchema,
    ...blockExecutionShape
  })
  .strict();

export const desktopOwnerCanvasExecutionLocatorSchema = z
  .object({
    kind: z.literal("owner_canvas"),
    operatorProfileId: identifierSchema,
    humanPrincipalId: identifierSchema,
    projectRoot: z.string().trim().min(1).max(4_096),
    projectId: identifierSchema,
    canvasId: identifierSchema
  })
  .strict();

const desktopOwnerCanvasExecutionStartInputSchema = z
  .object({ locator: desktopOwnerCanvasExecutionLocatorSchema, ...blockExecutionShape })
  .strict();

export const desktopWorkspaceExecutionStartInputSchema = z.union([
  desktopWorkspaceCanvasExecutionStartInputSchema,
  desktopOwnerCanvasExecutionStartInputSchema
]);

const sessionIdShape = { sessionId: z.string().regex(/^SESSION-\d{4,}$/) };
const desktopWorkspaceExecutionSessionFollowInputSchema = z.union([
  desktopWorkspaceCanvasExecutionStartInputSchema.extend(sessionIdShape).strict(),
  desktopOwnerCanvasExecutionStartInputSchema.extend(sessionIdShape).strict()
]);

const desktopWorkspaceExecutionExistingFollowInputSchema = z.union([
  z
    .object({
      locator: workspaceCanvasLocatorSchema,
      blockRef: z.string().trim().min(3).max(512),
      operationId: identifierSchema
    })
    .strict(),
  z
    .object({
      locator: desktopOwnerCanvasExecutionLocatorSchema,
      blockRef: z.string().trim().min(3).max(512),
      operationId: identifierSchema
    })
    .strict()
]);

export const desktopWorkspaceExecutionFollowInputSchema = z.union([
  desktopWorkspaceExecutionSessionFollowInputSchema,
  desktopWorkspaceExecutionExistingFollowInputSchema
]);

const cancellationShape = {
  ...sessionIdShape,
  actionId: identifierSchema,
  reason: z.string().trim().min(1).max(2_048)
};
export const desktopWorkspaceExecutionCancelInputSchema = z.union([
  desktopWorkspaceCanvasExecutionStartInputSchema.extend(cancellationShape).strict(),
  desktopOwnerCanvasExecutionStartInputSchema.extend(cancellationShape).strict()
]);

const responseShape = { ...sessionIdShape, response: remoteInteractionResponseSchema };
export const desktopWorkspaceExecutionRespondInputSchema = z.union([
  desktopWorkspaceCanvasExecutionStartInputSchema.extend(responseShape).strict(),
  desktopOwnerCanvasExecutionStartInputSchema.extend(responseShape).strict()
]);

export const desktopWorkspaceExecutionResponseSchema = workspaceExecutionCoordinatorViewSchema;

export type DesktopWorkspaceExecutionStartInput = z.infer<
  typeof desktopWorkspaceExecutionStartInputSchema
>;
export type DesktopOwnerCanvasExecutionLocator = z.infer<
  typeof desktopOwnerCanvasExecutionLocatorSchema
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
