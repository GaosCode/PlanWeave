import { getAutoRunStatus } from "../taskManager/autoRun.js";
import type { AutoRunStepResult, ClaimScope, ProjectWorkspace, ReviewVerdict, ValidationIssue } from "../types.js";
import type { DesktopAutoRunPhase, DesktopAutoRunScope, DesktopAutoRunState } from "./types.js";

export function claimRef(step: AutoRunStepResult): string | null {
  if (step.kind === "submitted" || step.kind === "manual") {
    if (step.claim.kind === "block") {
      return step.claim.ref;
    }
    if (step.claim.kind === "feedback") {
      return step.claim.sourceReviewBlockRef;
    }
    return null;
  }
  if (step.kind === "blocked") {
    return step.claim.kind === "blocked" ? step.claim.ref ?? null : null;
  }
  if (step.kind === "batch_submitted") {
    return step.claim.refs[0] ?? null;
  }
  return null;
}

export function claimRefs(step: AutoRunStepResult): string[] {
  if (step.kind === "submitted" || step.kind === "manual") {
    if (step.claim.kind === "block") {
      return [step.claim.ref];
    }
    if (step.claim.kind === "feedback") {
      return [step.claim.sourceReviewBlockRef];
    }
    return [];
  }
  if (step.kind === "blocked") {
    return step.claim.kind === "blocked" && step.claim.ref ? [step.claim.ref] : [];
  }
  if (step.kind === "batch_submitted") {
    return [...step.claim.refs];
  }
  if (step.kind === "batch") {
    return step.claim.kind === "batch" ? [...step.claim.refs] : [];
  }
  return [];
}

export function completedRefs(step: AutoRunStepResult): string[] {
  if (step.kind === "submitted") {
    return "ref" in step.submitResult && step.submitResult.status === "completed" ? [step.submitResult.ref] : [];
  }
  if (step.kind === "batch_submitted") {
    return step.steps.flatMap((item) => completedRefs(item));
  }
  return [];
}

export function reviewAttemptId(step: AutoRunStepResult): string | null {
  if (step.kind !== "submitted") {
    return null;
  }
  return "reviewAttemptId" in step.submitResult ? step.submitResult.reviewAttemptId : null;
}

export function reviewVerdict(step: AutoRunStepResult): ReviewVerdict | null {
  if (step.kind !== "submitted") {
    return null;
  }
  return "verdict" in step.submitResult ? step.submitResult.verdict : null;
}

export function executorName(step: AutoRunStepResult): string | null {
  if (step.kind === "submitted" || step.kind === "manual") {
    return step.adapterResult.executor ?? null;
  }
  if (step.kind === "batch_submitted") {
    return step.steps.find((item) => item.adapterResult.executor)?.adapterResult.executor ?? null;
  }
  return null;
}

export function outputSummary(step: AutoRunStepResult): string | null {
  if (step.kind === "submitted") {
    return "stdout" in step.adapterResult ? step.adapterResult.stdout?.trim().slice(0, 300) || null : null;
  }
  if (step.kind === "manual") {
    return step.adapterResult.nextCommand;
  }
  if (step.kind === "batch_submitted") {
    return `${step.steps.length} block(s) submitted.`;
  }
  if (step.kind === "blocked") {
    return step.claim.kind === "blocked" ? step.claim.reason : "Auto Run blocked.";
  }
  if (step.kind === "idle") {
    return step.claim.kind === "none" ? step.claim.reason ?? "No claimable work." : "No claimable work.";
  }
  return null;
}

export function terminalPatch(step: AutoRunStepResult, warnings: ValidationIssue[] = []): Partial<DesktopAutoRunState> | null {
  if (step.kind === "idle") {
    if (warnings.length > 0) {
      return { phase: "blocked", error: warnings[0]?.message ?? "Auto Run finished with warnings." };
    }
    return { phase: "completed" };
  }
  if (step.kind === "blocked") {
    return { phase: "blocked", error: step.claim.kind === "blocked" ? step.claim.reason : "Auto Run blocked." };
  }
  if (step.kind === "manual") {
    return { phase: "manual" };
  }
  if (step.kind === "batch") {
    return { phase: "blocked", error: "Parallel batch was not submitted." };
  }
  return null;
}

export function phaseAfterStep(current: DesktopAutoRunState, patch: Partial<DesktopAutoRunState> | null): DesktopAutoRunPhase {
  if (patch?.phase && patch.phase !== "completed") {
    return patch.phase;
  }
  if (current.phase === "pausing") {
    return "paused";
  }
  if (patch?.phase) {
    return patch.phase;
  }
  return current.phase;
}

export async function latestStatus(workspace: ProjectWorkspace): Promise<{ record: { recordId: string; path: string } | null; warnings: ValidationIssue[] }> {
  const status = await getAutoRunStatus({ projectRoot: workspace });
  if (!status.explanation.latestRecordId || !status.explanation.latestRecordPath) {
    return { record: null, warnings: status.warnings };
  }
  return {
    record: {
      recordId: status.explanation.latestRecordId,
      path: status.explanation.latestRecordPath
    },
    warnings: status.warnings
  };
}

export function claimScope(scope: DesktopAutoRunScope): ClaimScope {
  if (scope.kind === "task") {
    return { kind: "task", taskId: scope.taskId };
  }
  if (scope.kind === "block") {
    return { kind: "block", blockRef: scope.blockRef };
  }
  return { kind: "project" };
}
