import { getExecutionStatus } from "../taskManager/index.js";
import type {
  ExecutionReadinessDiagnostic,
  ExecutionReadinessReport,
  PackageWorkspaceRef
} from "../types.js";

function diagnostic(input: {
  code: string;
  severity: ExecutionReadinessDiagnostic["severity"];
  message: string;
  affectedRefs?: string[];
  suggestedTool?: string;
}): ExecutionReadinessDiagnostic {
  return {
    code: input.code,
    severity: input.severity,
    message: input.message,
    affectedRefs: input.affectedRefs ?? [],
    suggestedTool: input.suggestedTool
  };
}

export async function validateExecutionReadiness(options: {
  projectRoot: PackageWorkspaceRef;
}): Promise<ExecutionReadinessReport> {
  const status = await getExecutionStatus({ projectRoot: options.projectRoot });
  const diagnostics: ExecutionReadinessDiagnostic[] = [];

  if (status.currentRefs.length > 0) {
    diagnostics.push(
      diagnostic({
        code: "current_work_active",
        severity: "warning",
        message: "There is already active current work.",
        affectedRefs: status.currentRefs,
        suggestedTool: "get_status"
      })
    );
  }

  if (status.openFeedback.length > 0) {
    diagnostics.push(
      diagnostic({
        code: "open_feedback_pending",
        severity: "warning",
        message: "Open review feedback should be resolved before unrelated execution continues.",
        affectedRefs: status.openFeedback.map((feedback) => feedback.feedbackId),
        suggestedTool: "get_status"
      })
    );
  }

  const blockedDispatchable = status.claimHints.filter((hint) => hint.ready && !hint.dispatchable);
  if (blockedDispatchable.length > 0) {
    diagnostics.push(
      diagnostic({
        code: "ready_block_not_dispatchable",
        severity: "error",
        message: "Some ready blocks cannot be dispatched with the configured executor.",
        affectedRefs: blockedDispatchable.map((hint) => hint.ref),
        suggestedTool: "update_block"
      })
    );
  }

  const completedBlocks = status.blocks.filter((block) => block.status === "completed").length;
  if (
    status.currentRefs.length === 0 &&
    status.openFeedback.length === 0 &&
    status.nextClaimable.length === 0 &&
    completedBlocks < status.blockTotal
  ) {
    diagnostics.push(
      diagnostic({
        code: "no_ready_blocks",
        severity: "error",
        message: "No blocks are currently claimable even though execution is incomplete.",
        suggestedTool: "validate_project"
      })
    );
  }

  for (const warning of status.warnings) {
    diagnostics.push(
      diagnostic({
        code: warning.code,
        severity: "warning",
        message: warning.message,
        affectedRefs: warning.path ? [warning.path] : [],
        suggestedTool: "validate_project"
      })
    );
  }

  const errorCount = diagnostics.filter((item) => item.severity === "error").length;
  const warningCount = diagnostics.filter((item) => item.severity === "warning").length;
  const infoCount = diagnostics.filter((item) => item.severity === "info").length;

  return {
    ok: errorCount === 0,
    summary: {
      taskCount: status.taskTotal,
      blockCount: status.blockTotal,
      readyBlockCount: status.nextClaimable.length,
      currentRefCount: status.currentRefs.length,
      openFeedbackCount: status.openFeedback.length,
      errorCount,
      warningCount,
      infoCount
    },
    diagnostics,
    nextClaimable: status.nextClaimable
  };
}
