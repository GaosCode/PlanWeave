import {
  WorkspaceExecutionError,
  type WorkspaceExecutionFailureKind,
  type WorkspaceExecutionCoordinatorResult
} from "@planweave-ai/runtime";

export type WorkspaceExecutionCliErrorCode =
  | "workspace_connection_required"
  | "workspace_connection_selection_required"
  | "workspace_connection_invalid"
  | "workspace_credential_required"
  | "workspace_credential_invalid"
  | "workspace_http_unauthorized"
  | "workspace_http_forbidden"
  | "workspace_http_not_found"
  | "workspace_http_conflict"
  | "workspace_http_unavailable"
  | "workspace_http_invalid_response"
  | "local_execution_probe_failed"
  | "remote_interaction_not_found"
  | "remote_interaction_expired"
  | "remote_interaction_already_settled"
  | "workspace_execution_usage_invalid"
  | (string & {});

export class WorkspaceExecutionCliError extends Error {
  readonly name = "WorkspaceExecutionCliError";

  constructor(
    readonly code: WorkspaceExecutionCliErrorCode,
    readonly exitCode: number,
    readonly retryable = false,
    options?: ErrorOptions,
    readonly failureKind?: WorkspaceExecutionFailureKind
  ) {
    super(code, options);
  }
}

export function workspaceExecutionExitCode(error: unknown): number {
  if (error instanceof WorkspaceExecutionCliError) return error.exitCode;
  if (!(error instanceof WorkspaceExecutionError)) return 1;
  if (error.retryable) return 9;
  if (
    error.code === "remote_interaction_not_found" ||
    error.code === "remote_interaction_expired" ||
    error.code === "remote_interaction_already_settled"
  ) {
    return 7;
  }
  if (error.failureKind === "usage") return 2;
  if (error.failureKind === "authentication") return 4;
  if (
    error.failureKind === "authorization" ||
    error.failureKind === "not_found" ||
    error.failureKind === "conflict"
  ) {
    return 5;
  }
  if (error.failureKind === "unavailable") return 9;
  if (error.failureKind === "execution") return 8;
  if (error.code === "agent_endpoint_selection_required") return 6;
  if (error.code === "agent_endpoint_unavailable") return 6;
  if (error.code === "human_cross_project_forbidden") return 5;
  if (error.code === "workspace_execution_authority_mismatch") return 5;
  if (error.code.includes("revision_mismatch") || error.code.includes("fingerprint_mismatch")) {
    return 5;
  }
  return 8;
}

export function workspaceExecutionResultExitCode(
  result: WorkspaceExecutionCoordinatorResult
): 0 | 7 | 8 {
  if (result.events.some((event) => event.type === "action_required")) return 7;
  if (
    result.events.some(
      (event) => event.type === "runner_diagnostic" && event.data.code === "remote_writeback_failed"
    )
  ) {
    return 8;
  }
  for (let index = result.events.length - 1; index >= 0; index -= 1) {
    const event = result.events[index];
    if (event?.type === "run_terminal") {
      return event.data.outcome === "completed" ? 0 : 8;
    }
  }
  return result.session.phase === "failed" || result.session.phase === "stopped" ? 8 : 0;
}
