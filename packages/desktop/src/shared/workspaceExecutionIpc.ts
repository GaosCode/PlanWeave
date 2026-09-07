import { z } from "zod";
import { desktopWorkspaceExecutionResponseSchema } from "./workspaceExecution.js";

export const workspaceExecutionInvokeChannels = {
  conversation: "planweave:workspaceExecution:conversation",
  start: "planweave:workspaceExecution:start",
  follow: "planweave:workspaceExecution:follow",
  respond: "planweave:workspaceExecution:respond",
  cancel: "planweave:workspaceExecution:cancel"
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
  "workspace_execution_request_failed"
]);

export const workspaceExecutionIpcResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: desktopWorkspaceExecutionResponseSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: workspaceExecutionIpcErrorCodeSchema }).strict()
    })
    .strict()
]);

export type WorkspaceExecutionIpcErrorCode = z.infer<typeof workspaceExecutionIpcErrorCodeSchema>;
