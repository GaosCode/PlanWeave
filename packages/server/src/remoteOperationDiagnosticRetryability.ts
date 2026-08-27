const RETRYABLE_DIAGNOSTIC_CODES = [
  "agent_endpoint_unavailable",
  "host_offline",
  "no_compatible_agent_host",
  "runtime_not_attached",
  "runtime_host_unavailable",
  "runtime_reconciliation_conflict"
] as const;

const NON_RETRYABLE_DIAGNOSTIC_CODES = [
  "agent_endpoint_incompatible",
  "agent_endpoint_unknown",
  "protocol_error",
  "remote_block_executor_not_acp",
  "remote_block_not_dispatchable",
  "remote_block_not_executable",
  "remote_block_not_found",
  "remote_block_result_conflict",
  "remote_block_source_changed",
  "remote_completion_evidence_missing",
  "remote_dispatch_not_awaiting_writeback",
  "remote_dispatch_not_found",
  "remote_failure_evidence_missing",
  "remote_operation_candidate_missing",
  "remote_operation_endpoint_selection_missing",
  "remote_operation_runtime_capability_mismatch",
  "remote_ownership_activation_conflict",
  "remote_ownership_not_active",
  "remote_ownership_not_preparing",
  "remote_ownership_operation_conflict",
  "remote_ownership_requires_executable_block",
  "remote_ownership_requires_implementation",
  "remote_ownership_requires_ready_block",
  "remote_ownership_source_conflict",
  "remote_ownership_source_drift",
  "remote_ownership_status_conflict",
  "remote_ownership_terminal_conflict",
  "remote_persistence_inconsistent",
  "remote_reenter_operation_failed",
  "remote_source_changed",
  "remote_terminal_attempt_not_bound",
  "remote_terminal_persistence_conflict",
  "runtime_activation_conflict",
  "runtime_binding_reset",
  "runtime_claim_conflict",
  "work_auth_forbidden",
  "work_auth_project_mismatch",
  "work_auth_unauthenticated",
  "work_cross_project_forbidden",
  "work_dispatch_host_mismatch",
  "work_host_capability_mismatch",
  "work_host_not_authorized",
  "work_host_not_found",
  "work_host_not_ready",
  "work_host_revoked",
  "work_human_not_member",
  "work_input_invalid",
  "work_item_kind_target_mismatch",
  "work_item_not_found",
  "work_not_agent_assigned",
  "work_revision_conflict",
  "work_role_insufficient",
  "work_runtime_unavailable"
] as const;

const retryableCodes = new Set<string>(RETRYABLE_DIAGNOSTIC_CODES);
const nonRetryableCodes = new Set<string>(NON_RETRYABLE_DIAGNOSTIC_CODES);

export function classifyRemoteOperationDiagnosticRetryability(code: string): boolean | undefined {
  if (retryableCodes.has(code)) return true;
  if (nonRetryableCodes.has(code)) return false;
  return undefined;
}

export function requireRemoteOperationDiagnosticRetryability(code: string): boolean {
  const retryable = classifyRemoteOperationDiagnosticRetryability(code);
  if (retryable === undefined) {
    throw new Error(`remote_operation_diagnostic_retryability_unknown:${code}`);
  }
  return retryable;
}

function sqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(",");
}

/** SQL expression generated from the same classifier lists used by live diagnostic writes. */
export function remoteOperationDiagnosticRetryabilitySql(column: string): string {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(column)) {
    throw new Error("remote_operation_diagnostic_retryability_sql_column_invalid");
  }
  return `CASE
    WHEN ${column} IN (${sqlStringList(RETRYABLE_DIAGNOSTIC_CODES)}) THEN 1
    WHEN ${column} IN (${sqlStringList(NON_RETRYABLE_DIAGNOSTIC_CODES)}) THEN 0
    ELSE NULL
  END`;
}
