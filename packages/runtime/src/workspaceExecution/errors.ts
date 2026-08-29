export type WorkspaceExecutionErrorCode =
  | "workspace_execution_authority_mismatch"
  | "workspace_content_revision_mismatch"
  | "workspace_graph_fingerprint_mismatch"
  | "workspace_execution_binding_unvalidated"
  | "workspace_execution_remote_binding_required"
  | "workspace_execution_resume_mismatch"
  | "work_authority_unavailable"
  | "agent_endpoint_unavailable"
  | "agent_endpoint_selection_required"
  | "agent_endpoint_executor_mismatch"
  | "remote_catalog_unavailable"
  | "remote_dispatch_unavailable"
  | "remote_dispatch_acceptance_mismatch"
  | "remote_dispatch_conflict"
  | "remote_operation_not_found"
  | "remote_attempt_changed"
  | "remote_attempt_revision_stale"
  | "remote_operation_revision_missing"
  | "remote_operation_observation_stale"
  | "remote_event_cursor_gap"
  | "remote_event_retention_gap"
  | "remote_replay_unavailable"
  | "remote_interactions_unavailable"
  | "remote_interaction_snapshot_unstable"
  | "remote_interaction_response_unavailable"
  | "remote_interaction_expired"
  | "remote_writeback_failed"
  | "remote_observation_unavailable";

export class WorkspaceExecutionError extends Error {
  readonly name = "WorkspaceExecutionError";

  constructor(
    readonly code: WorkspaceExecutionErrorCode,
    message: string = code,
    readonly retryable = false,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export function workspaceExecutionPortError(
  error: unknown,
  code: WorkspaceExecutionErrorCode
): WorkspaceExecutionError {
  return error instanceof WorkspaceExecutionError
    ? error
    : new WorkspaceExecutionError(code, code, true, { cause: error });
}
