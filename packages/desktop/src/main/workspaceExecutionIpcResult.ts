import {
  workspaceExecutionIpcErrorCodeSchema,
  workspaceExecutionIpcResultSchema,
  type WorkspaceExecutionIpcErrorCode
} from "../shared/workspaceExecutionIpc.js";

function safeWorkspaceExecutionErrorCode(error: unknown): WorkspaceExecutionIpcErrorCode {
  const candidate = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const parsed = workspaceExecutionIpcErrorCodeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : "workspace_execution_request_failed";
}

export async function workspaceExecutionHandlerResult<T>(operation: () => Promise<T>) {
  try {
    return workspaceExecutionIpcResultSchema.parse({ ok: true, value: await operation() });
  } catch (error) {
    return workspaceExecutionIpcResultSchema.parse({
      ok: false,
      error: { code: safeWorkspaceExecutionErrorCode(error) }
    });
  }
}
