import type { ClaimHint, getExecutionStatus } from "@planweave-ai/runtime";

type ExecutionStatus = Awaited<ReturnType<typeof getExecutionStatus>>;

export function formatClaimHint(hint: ClaimHint): string {
  const blockers = [...hint.blockedByTasks.map((taskId) => `task:${taskId}`), ...hint.blockedByBlocks.map((ref) => `block:${ref}`)];
  const reason = hint.ready
    ? hint.readyReason
    : blockers.length > 0
      ? `blocked by ${blockers.join(", ")}`
      : hint.statusReason
        ? `${hint.status}: ${hint.statusReason}`
        : `status ${hint.status}`;
  const gate = hint.reviewGate ? "review gate, " : "";
  const mode = hint.sequentialOnly ? "sequential-only" : "parallel-safe";
  const command = hint.recommendedCommand ? `, run: ${hint.recommendedCommand}` : hint.dispatchCommand ? `, dispatch: ${hint.dispatchCommand}` : "";
  return `- ${hint.ref}: ${reason}, executor=${hint.effectiveExecutor}, ${gate}${mode}${command}`;
}

export function formatExecutionStatusHuman(status: ExecutionStatus): string {
  const lines = [
    `Project: ${status.projectId}`,
    `Root: ${status.projectRoot}`,
    `Tasks: ${status.taskTotal}`,
    `Blocks: ${status.blockTotal}`,
    `Current refs: ${status.currentRefs.join(", ") || "none"}`,
    `Current feedback: ${status.currentFeedbackId ?? "none"}`,
    `Next claimable: ${status.nextClaimable.join(", ") || "none"}`,
    `Next parallel claimable: ${status.nextParallelClaimable.join(", ") || "none"}`,
    `Next sequential claimable: ${status.nextSequentialClaimable.join(", ") || "none"}`,
    `Next parallel dispatchable: ${status.nextParallelDispatchable.join(", ") || "none"}`,
    "Claim hints:",
    ...status.claimHints.map(formatClaimHint),
    "Task counts:",
    ...Object.entries(status.counts.tasks).map(([key, value]) => `- ${key}: ${value}`),
    "Block counts:",
    ...Object.entries(status.counts.blocks).map(([key, value]) => `- ${key}: ${value}`)
  ];
  if (status.warnings.length > 0) {
    lines.push("Warnings:");
    lines.push(...status.warnings.map((warning) => `- ${warning.code}: ${warning.message}`));
  }
  return lines.join("\n");
}
