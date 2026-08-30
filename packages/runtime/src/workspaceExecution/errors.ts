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
  | "remote_interaction_not_found"
  | "remote_interaction_already_settled"
  | "human_cross_project_forbidden"
  | "remote_writeback_failed"
  | "remote_observation_unavailable"
  | (string & {});

export type WorkspaceExecutionFailureKind =
  | "usage"
  | "authentication"
  | "authorization"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "execution";

export class WorkspaceExecutionError extends Error {
  readonly name = "WorkspaceExecutionError";

  constructor(
    readonly code: WorkspaceExecutionErrorCode,
    message: string = code,
    readonly retryable = false,
    options?: ErrorOptions,
    readonly failureKind?: WorkspaceExecutionFailureKind
  ) {
    super(message, options);
  }
}

export function workspaceExecutionPortError(
  error: unknown,
  code: WorkspaceExecutionErrorCode
): WorkspaceExecutionError {
  if (error instanceof WorkspaceExecutionError) return error;
  const failure =
    typeof error === "object" && error !== null
      ? (error as {
          code?: unknown;
          retryable?: unknown;
          failureKind?: unknown;
        })
      : undefined;
  const safeCode =
    typeof failure?.code === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(failure.code)
      ? failure.code
      : code;
  const failureKinds: readonly WorkspaceExecutionFailureKind[] = [
    "usage",
    "authentication",
    "authorization",
    "not_found",
    "conflict",
    "unavailable",
    "execution"
  ];
  const failureKind = failureKinds.find((candidate) => candidate === failure?.failureKind);
  return new WorkspaceExecutionError(
    safeCode,
    safeCode,
    typeof failure?.retryable === "boolean" ? failure.retryable : true,
    { cause: error },
    failureKind
  );
}
