import { z } from "zod";
import { remoteAgentAuthorizationErrorCodeSchema } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import {
  desktopWorkspaceExecutionResponseSchema,
  desktopWorkspaceExecutionResumeResultSchema,
  desktopWorkspaceExecutionStartCancellationSchema,
  desktopWorkspaceExecutionCancellationRecoverySchema
} from "./workspaceExecution.js";

export const workspaceExecutionInvokeChannels = {
  conversation: "planweave:workspaceExecution:conversation",
  start: "planweave:workspaceExecution:start",
  cancelStart: "planweave:workspaceExecution:cancelStart",
  follow: "planweave:workspaceExecution:follow",
  resume: "planweave:workspaceExecution:resume",
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
  "local_auto_run_active",
  "remote_block_not_dispatchable",
  "remote_resume_unavailable",
  "remote_resume_status_unavailable",
  "remote_resume_execution_unavailable",
  "remote_resume_receipt_identity_mismatch",
  "remote_resume_authorization_changed",
  "remote_attempt_changed",
  "remote_action_attempt_version_conflict",
  "remote_resume_attempt_conflict",
  "remote_resume_host_unavailable",
  "remote_resume_host_capacity_exhausted",
  "operator_human_identity_unauthorized",
  "operator_human_identity_forbidden",
  "operator_unauthorized",
  "operator_resource_not_found",
  "operator_operation_conflict",
  ...remoteAgentAuthorizationErrorCodeSchema.options,
  "workspace_execution_cancel_identity_mismatch",
  "workspace_execution_cancel_unconfirmed"
]);

export const workspaceExecutionIpcResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      value: z.union([
        desktopWorkspaceExecutionStartCancellationSchema,
        desktopWorkspaceExecutionResponseSchema,
        desktopWorkspaceExecutionResumeResultSchema,
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
