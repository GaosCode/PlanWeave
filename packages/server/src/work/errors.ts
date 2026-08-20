import { z } from "zod";

/**
 * Stable error codes for work assignment contracts and pure policy decisions.
 * Application layers map these to HTTP/status without leaking secrets or package paths.
 */
export const workAssignmentErrorCodeSchema = z.enum([
  "work_auth_unauthenticated",
  "work_auth_forbidden",
  "work_auth_project_mismatch",
  "work_role_insufficient",
  "work_input_invalid",
  "work_item_not_found",
  "work_item_kind_target_mismatch",
  "work_human_not_member",
  "work_host_not_found",
  "work_host_revoked",
  "work_host_not_authorized",
  "work_host_not_ready",
  "work_host_capability_mismatch",
  "work_revision_conflict",
  "work_not_agent_assigned",
  "work_dispatch_host_mismatch",
  "execution_target_read_only",
  "work_runtime_unavailable",
  "work_cross_project_forbidden"
]);

export type WorkAssignmentErrorCode = z.infer<typeof workAssignmentErrorCodeSchema>;

export type WorkAssignmentDenial = {
  allowed: false;
  code: WorkAssignmentErrorCode;
  message: string;
};

export type WorkAssignmentAllowance = {
  allowed: true;
};

export type WorkAssignmentAuthDecision = WorkAssignmentAllowance | WorkAssignmentDenial;

export function denyWorkAssignment(
  code: WorkAssignmentErrorCode,
  message: string
): WorkAssignmentDenial {
  return { allowed: false, code, message };
}

export function allowWorkAssignment(): WorkAssignmentAllowance {
  return { allowed: true };
}

/** Safe messages; never include tokens, digests, filesystem paths, or full package dumps. */
export const WORK_ASSIGNMENT_ERROR_MESSAGES: Readonly<Record<WorkAssignmentErrorCode, string>> = {
  work_auth_unauthenticated: "Authentication required to change work assignment.",
  work_auth_forbidden: "Work assignment action is not permitted.",
  work_auth_project_mismatch: "Authenticated project scope does not match the assignment project.",
  work_role_insufficient: "Project role is insufficient to change work assignment.",
  work_input_invalid: "Work assignment input failed validation.",
  work_item_not_found: "Work item was not found in the current Plan Package.",
  work_item_kind_target_mismatch:
    "Assignment target is not valid for this work item kind (Tasks cannot target Hosts).",
  work_human_not_member: "Human target is not a current active project member.",
  work_host_not_found: "Exact Host target was not found.",
  work_host_revoked: "Exact Host target has been revoked.",
  work_host_not_authorized: "Exact Host is not authorized to serve this project.",
  work_host_not_ready: "Exact Host has not reported ready workspace and ACP profile state.",
  work_host_capability_mismatch:
    "Exact Host does not satisfy the Block's current capability requirements.",
  work_revision_conflict: "Assignment revision does not match the expected revision.",
  work_not_agent_assigned:
    "Block is not assigned to an Agent Host target; remote dispatch requires an agent assignment or explicit override.",
  work_dispatch_host_mismatch: "Dispatch Host does not match the current exact Host assignment.",
  execution_target_read_only:
    "Legacy Host execution targets are read-only; choose a local or remote Agent Endpoint.",
  work_runtime_unavailable: "No Runtime is currently available for this collaboration scope.",
  work_cross_project_forbidden: "Cross-project work assignment access is not permitted."
};
