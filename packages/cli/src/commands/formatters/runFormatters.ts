import type {
  AutoRunEventTailItem,
  AutoRunStatus,
  AutoRunStepResult,
  DesktopAutoRunEventLog,
  DesktopAutoRunLogEvent,
  ListRunSessionsResult,
  ResetRuntimeStateResult,
  RunSessionDetail,
  RunSessionState,
  RunWithSessionResult
} from "@planweave-ai/runtime";

export type FormattableRunResult = {
  session: RunSessionState;
  steps: AutoRunStepResult[];
  terminalReason: RunWithSessionResult["terminalReason"];
};

export type FormattableResetResult = ResetRuntimeStateResult & {
  session: RunSessionState;
};

function formatHeartbeatAge(heartbeatUpdatedAt: string | null): string {
  if (!heartbeatUpdatedAt) {
    return "none";
  }
  const updatedMs = Date.parse(heartbeatUpdatedAt);
  if (!Number.isFinite(updatedMs)) {
    return "unknown";
  }
  const ageMs = Math.max(0, Date.now() - updatedMs);
  if (ageMs < 1000) {
    return `${ageMs}ms`;
  }
  if (ageMs < 60_000) {
    return `${Math.round(ageMs / 1000)}s`;
  }
  if (ageMs < 3_600_000) {
    return `${Math.round(ageMs / 60_000)}m`;
  }
  return `${Math.round(ageMs / 3_600_000)}h`;
}

export function formatRunStatusHuman(
  status: AutoRunStatus,
  context: { defaultStartCommand: string }
): string {
  const lines = [
    `current: ${status.current.refs.join(", ") || "none"}`,
    `feedback: ${status.current.feedbackId ?? "none"}`,
    `review: ${status.current.reviewBlockRef ?? "none"}`,
    `phase: ${status.explanation.phase}`,
    `latest record: ${status.explanation.latestRecordId ?? "none"}${status.explanation.latestRecordPath ? ` (${status.explanation.latestRecordPath})` : ""}`,
    `next action: ${status.explanation.nextAction.message}`
  ];
  const nextCommand =
    status.explanation.nextAction.command ??
    (status.explanation.nextAction.kind === "start" ? context.defaultStartCommand : null);
  if (nextCommand) {
    lines.push(`next command: ${nextCommand}`);
  }
  lines.push("latest runs:");
  for (const run of status.latestRuns) {
    lines.push(
      `- ${run.ref} ${run.runId} ${run.status} executor=${run.executor ?? "unknown"} agent=${run.agentId ?? "none"} runner=${run.runnerKind ?? "none"} integration=${run.adapter ?? "unknown"}`
    );
    lines.push(
      `  liveness: status=${run.heartbeatStatus ?? "none"} age=${formatHeartbeatAge(run.heartbeatUpdatedAt)} pid=${run.heartbeatPid ?? "none"} lastActivity=${run.lastActivityAt ?? "none"}`
    );
    if (run.stdoutSummary) {
      lines.push(`  stdout: ${run.stdoutSummary}`);
    }
    if (run.stderrSummary) {
      lines.push(`  stderr: ${run.stderrSummary}`);
    }
    if (run.failureReason) {
      lines.push(`  failure: ${run.failureReason}`);
    }
  }
  return lines.join("\n");
}

export function formatAutoRunLogEventHuman(event: DesktopAutoRunLogEvent): string {
  const timestamp = event.timestamp ?? "?";
  const type = event.type ?? "?";
  const ref = event.currentRef ?? "-";
  const message =
    typeof event.data.message === "string"
      ? event.data.message
      : Object.keys(event.data).length > 0
        ? JSON.stringify(event.data)
        : "";
  return [timestamp, type, ref, message].filter((part) => part.length > 0).join(" ");
}

export function formatAutoRunEventTailItem(
  item: Exclude<AutoRunEventTailItem, { kind: "terminal" }>
): string {
  if (item.kind === "parse_error") {
    return `parse_error line=${item.line}: ${item.message}`;
  }
  return formatAutoRunLogEventHuman(item.event);
}

export function formatAutoRunEventLogHuman(log: DesktopAutoRunEventLog): string {
  const lines = [`run: ${log.runId}`, `events: ${log.events.length}`];
  for (const event of log.events) {
    lines.push(`- ${formatAutoRunLogEventHuman(event)}`);
  }
  if (log.diagnostics.length > 0) {
    lines.push("diagnostics:");
    for (const diagnostic of log.diagnostics) {
      lines.push(
        `- ${diagnostic.code}${diagnostic.line !== undefined ? ` line=${diagnostic.line}` : ""}: ${diagnostic.message}`
      );
    }
  }
  return lines.join("\n");
}

export function formatRunResult(result: FormattableRunResult): string {
  const lines = [
    `session: ${result.session.sessionId}`,
    `phase: ${result.session.phase}`,
    `steps: ${result.steps.length}`,
    `latest record: ${result.session.latestRecordId ?? "none"}${result.session.latestRecordPath ? ` (${result.session.latestRecordPath})` : ""}`,
    `terminal: ${formatTerminalReason(result.terminalReason)}`
  ];
  if (result.steps.length > 0) {
    lines.push("step summaries:");
    lines.push(...result.steps.map((step) => `- ${formatRunStep(step).replace(/\n/g, "\n  ")}`));
  }
  return lines.join("\n");
}

export function formatResetResult(result: FormattableResetResult): string {
  return [
    `session: ${result.session.sessionId}`,
    `state path: ${result.statePath}`,
    `forced: ${result.forced ? "yes" : "no"}`,
    `previous current refs: ${result.previousCurrentRefs.join(", ") || "none"}`,
    `previous in-progress refs: ${result.previousInProgressRefs.join(", ") || "none"}`
  ].join("\n");
}

export function formatRunSessions(result: ListRunSessionsResult): string {
  const lines =
    result.sessions.length === 0
      ? ["run sessions: none"]
      : ["run sessions:", ...result.sessions.map(formatRunSessionSummary)];
  if (result.diagnostics.length > 0) {
    lines.push("diagnostics:");
    lines.push(
      ...result.diagnostics.map(
        (diagnostic) => `- ${diagnostic.sessionId} ${diagnostic.code}: ${diagnostic.message}`
      )
    );
  }
  return lines.join("\n");
}

export function formatRunSessionDetail(
  detail: RunSessionDetail & { runnerReadModel?: import("@planweave-ai/runtime").RunnerRecordReadModel | null }
): string {
  const lines = [
    `session: ${detail.session.sessionId}`,
    `kind: ${detail.session.kind}`,
    `phase: ${detail.session.phase}`,
    `canvas: ${detail.session.canvasId}`,
    `started: ${detail.session.startedAt}`,
    `finished: ${detail.session.finishedAt ?? "none"}`,
    `stop reason: ${detail.session.autoRun?.stopReason ?? "none"}`,
    `effective executor: ${detail.session.autoRun?.effectiveExecutor ?? "none"}`,
    `agent: ${detail.session.autoRun?.agentId ?? "none"}`,
    `runner: ${detail.session.autoRun?.runnerKind ?? "none"}`,
    `latest record: ${detail.session.latestRecordId ?? "none"}${detail.session.latestRecordPath ? ` (${detail.session.latestRecordPath})` : ""}`,
    `error: ${detail.session.error ?? "none"}`,
    "events:"
  ];
  lines.push(...detail.events.map((event) => `- ${event.timestamp} ${event.type} ${event.phase}`));
  if (detail.runnerReadModel) {
    lines.push(
      `runner events: ${detail.runnerReadModel.events.length} terminal=${detail.runnerReadModel.terminal}`,
      `runner interaction: persisted=${detail.runnerReadModel.interaction.persisted} active=${detail.runnerReadModel.interaction.active} stale=${detail.runnerReadModel.interaction.stale}`
    );
    for (const diagnostic of detail.runnerReadModel.diagnostics) {
      lines.push(`runner diagnostic: ${diagnostic.code}: ${diagnostic.message}`);
    }
  }
  if (detail.diagnostics.length > 0) {
    lines.push("diagnostics:");
    lines.push(
      ...detail.diagnostics.map((diagnostic) => `- ${diagnostic.code}: ${diagnostic.message}`)
    );
  }
  return lines.join("\n");
}

function formatTerminalReason(reason: RunWithSessionResult["terminalReason"]): string {
  if (reason === "step_limit_reached") {
    return "completed by step limit";
  }
  return reason;
}

function formatRunStep(step: AutoRunStepResult): string {
  if (step.kind === "submitted") {
    return `submitted ${formatStepClaim(step.claim)} agent=${step.adapterResult.agentId ?? "none"} runner=${step.adapterResult.runnerKind ?? "none"}`;
  }
  if (step.kind === "batch_submitted") {
    const manualCount = step.steps.filter((item) => item.kind === "manual").length;
    if (manualCount === step.steps.length) {
      return `manual prompts generated for ${step.steps.length} blocks`;
    }
    if (manualCount > 0) {
      return `batch completed with manual prompts for ${manualCount} of ${step.steps.length} blocks`;
    }
    return `batch submitted ${step.steps.length} blocks`;
  }
  if (step.kind === "manual") {
    return `manual ${formatStepClaim(step.claim)}\nprompt: ${step.adapterResult.promptPath}\nnext: ${step.adapterResult.nextCommand}`;
  }
  return `${step.kind}: ${step.claim.kind}`;
}

function formatStepClaim(claim: AutoRunStepResult["claim"]): string {
  if (claim.kind === "block") {
    return `block ${claim.ref} executor=${claim.effectiveExecutor}`;
  }
  if (claim.kind === "feedback") {
    return `feedback ${claim.feedbackId} executor=${claim.effectiveExecutor}`;
  }
  return claim.kind;
}

function formatRunSessionSummary(session: RunSessionState): string {
  return `- ${session.sessionId} ${session.kind} ${session.phase} steps=${session.autoRun?.stepCount ?? 0} stop=${session.autoRun?.stopReason ?? "none"} started=${session.startedAt} latest=${session.latestRecordId ?? "none"}`;
}
