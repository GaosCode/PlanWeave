import { z } from "zod";
import {
  desktopWorkspaceExecutionResponseSchema,
  desktopWorkspaceExecutionCancellationRecoverySchema
} from "./workspaceExecution.js";

export const workspaceExecutionInvokeChannels = {
  conversation: "planweave:workspaceExecution:conversation",
  start: "planweave:workspaceExecution:start",
  follow: "planweave:workspaceExecution:follow",
  respond: "planweave:workspaceExecution:respond",
  cancel: "planweave:workspaceExecution:cancel",
  recoverCancellation: "planweave:workspaceExecution:recoverCancellation"
} as const;

export const workspaceExecutionIpcErrorCodeSchema = z.enum([
  "human_auth_unauthenticated",
  "human_cross_project_forbidden",
  "human_remote_resource_not_found",
  "human_remote_operation_conflict",
  "collaboration_workspace_connection_mismatch",
  "workspace_execution_authority_mismatch",
  "workspace_execution_scope_mismatch",
  "workspace_execution_resume_mismatch",
  "workspace_execution_locator_mismatch",
  "workspace_execution_request_failed",
  "workspace_execution_cancel_identity_mismatch",
  "workspace_execution_cancel_unconfirmed"
]);

export const workspaceExecutionIpcResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      value: z.union([
        desktopWorkspaceExecutionResponseSchema,
        desktopWorkspaceExecutionCancellationRecoverySchema
      ])
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: workspaceExecutionIpcErrorCodeSchema }).strict()
    })
    .strict()
]);

export type WorkspaceExecutionIpcErrorCode = z.infer<typeof workspaceExecutionIpcErrorCodeSchema>;
