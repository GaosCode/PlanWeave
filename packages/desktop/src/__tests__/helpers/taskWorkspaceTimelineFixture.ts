import {
  taskWorkspaceBlockSchema,
  taskWorkspaceRunSchema,
  taskWorkspaceSchema,
  type TaskWorkspace,
  type TaskWorkspaceAnnotation,
  type TaskWorkspaceBlock
} from "@planweave-ai/runtime";

const calculatedAt = "2026-07-13T00:00:10.000Z";
const startedAt = "2026-07-13T00:00:00.000Z";
const finishedAt = "2026-07-13T00:00:05.000Z";

export const parallelWaveId = "WAVE-123e4567-e89b-42d3-a456-426614174000";
export const singletonWaveId = "WAVE-223e4567-e89b-42d3-a456-426614174000";

export type TimelineRunFixtureOptions = {
  active?: boolean;
  executionWaveId?: string | null;
  exitCode?: number | null;
  finished?: boolean;
  retryIndex?: number;
  selected?: boolean;
  startedAt?: string;
  terminalState?: "succeeded" | "failed" | "cancelled" | null;
  waiting?: boolean;
};

export function timelineRunFixture(
  blockRef: string,
  runId: string,
  options: TimelineRunFixtureOptions = {}
): TaskWorkspaceBlock["runs"][number] {
  const blockId = blockRef.slice(blockRef.indexOf("#") + 1);
  const taskId = blockRef.slice(0, blockRef.indexOf("#"));
  const recordId = `${blockRef}::${runId}`;
  const run = taskWorkspaceRunSchema.parse({
    version: "planweave.task-workspace-run/v1",
    kind: "block",
    record: { recordId, ref: blockRef, taskId, blockId, runId },
    runIdentity: {
      projectId: "project-1",
      canvasId: "canvas-main",
      taskId,
      blockId,
      claimRef: blockRef,
      runId,
      runOwner: "executor",
      runSessionId: `SESSION-${runId}`,
      desktopRunId: `DESKTOP-${runId}`,
      executorRunId: runId
    },
    metadata: {
      executor: "codex",
      adapter: "codex-acp",
      runnerKind: "acp",
      agentId: "codex",
      executionCwd: "/projects/demo",
      projectRoot: "/projects/demo",
      agentSessionId: `session-${runId}`,
      tmuxSessionId: null,
      exitCode: options.exitCode ?? null,
      terminalState: options.terminalState ?? null
    },
    executionWaveId: options.executionWaveId ?? null,
    duration: {
      startedAt: options.startedAt ?? startedAt,
      finishedAt: options.finished === false ? null : finishedAt,
      calculatedAt,
      wallClockMs: options.finished === false ? 10_000 : 5_000,
      unavailableReason: null
    },
    usage: {
      currentContext: null,
      runTokens: { available: false, totalTokens: null, reason: "Unavailable." },
      taskTokens: { available: false, totalTokens: null, reason: "Unavailable." }
    },
    actualConfiguration: {
      available: false,
      reason: "No authoritative ACP session configuration snapshot was recorded for this run."
    },
    nextActions: { version: "planweave.runner-next-actions/v1", actions: [] },
    capabilities: {
      prompt: { available: false, reason: "Unavailable.", identity: null, inFlight: false },
      cancel: { available: false, reason: "Unavailable.", identity: null },
      retry: { available: false, reason: "Unavailable.", identity: null },
      recoverAcpSession: {
        available: false,
        reason: { code: "runner_not_acp", message: "Unavailable." },
        identity: null
      },
      resume: { available: false, reason: "Unavailable.", identity: null }
    }
  });
  const waiting = options.waiting === true;
  return {
    active: options.active ?? false,
    retryIndex: options.retryIndex ?? 1,
    selected: options.selected ?? false,
    waitingInteraction: waiting
      ? { active: true, count: 1, kinds: ["permission"] }
      : { active: false, count: 0, kinds: [] },
    run
  };
}

export function timelineBlockFixture(options: {
  annotations?: TaskWorkspaceAnnotation[];
  blockId: string;
  runs?: TaskWorkspaceBlock["runs"];
  title?: string;
  type?: TaskWorkspaceBlock["type"];
}): TaskWorkspaceBlock {
  const ref = `T-001#${options.blockId}`;
  return taskWorkspaceBlockSchema.parse({
    ref,
    taskId: "T-001",
    blockId: options.blockId,
    type: options.type ?? "implementation",
    title: options.title ?? options.blockId,
    status: "in_progress",
    executor: "codex",
    effectiveExecutor: "codex",
    promptMarkdown: `# ${options.blockId} source prompt`,
    promptMissing: false,
    promptSurfaceMarkdown: `# ${options.blockId} rendered prompt`,
    promptSources: [
      {
        kind: "block",
        label: "Block Prompt",
        included: true,
        empty: false,
        missing: false,
        disabledReason: null,
        preview: `${options.blockId} source prompt`
      }
    ],
    dependencies: {
      total: 0,
      completed: 0,
      percent: 100,
      status: "not_applicable",
      blockers: []
    },
    runs: options.runs ?? [],
    annotations: options.annotations ?? []
  });
}

export function timelineWorkspaceFixture(
  blocks: TaskWorkspaceBlock[],
  patch: Partial<Pick<TaskWorkspace, "dependencyProgress" | "latestArtifact">> = {}
): TaskWorkspace {
  const items = blocks.flatMap((block) => block.runs);
  const selectedItems = items.filter((item) => item.selected);
  return taskWorkspaceSchema.parse({
    version: "planweave.task-workspace/v1",
    project: { projectId: "project-1", projectRoot: "/projects/demo", canvasId: "canvas-main" },
    task: {
      taskId: "T-001",
      title: "Timeline task",
      status: "in_progress",
      executor: "codex",
      promptMarkdown: "# Timeline task prompt",
      promptMissing: false,
      acceptance: []
    },
    dependencyProgress: patch.dependencyProgress ?? {
      total: 0,
      completed: 0,
      percent: 100,
      status: "not_applicable",
      blockers: []
    },
    blocks,
    activeRecordIds: items.filter((item) => item.active).map((item) => item.run.record.recordId),
    selectedRecordId: selectedItems[0]?.run.record.recordId ?? null,
    latestArtifact: patch.latestArtifact ?? null,
    duration: {
      wallClock: {
        available: false,
        startedAt: null,
        endedAt: null,
        calculatedAt,
        totalMs: null,
        unavailableReason: "Unavailable."
      },
      agentTime: {
        availability: "unavailable",
        totalMs: null,
        includedRunCount: 0,
        missingRunCount: items.length,
        reason: "Unavailable."
      }
    },
    usage: {
      taskTokens: { available: false, totalTokens: null, reason: "Unavailable." },
      taskCost: { available: false, totals: null, reason: "Unavailable." }
    }
  });
}

export function reviewAnnotationFixture(
  blockRef: string,
  kind: TaskWorkspaceAnnotation["kind"] = "review_attempt"
): TaskWorkspaceAnnotation {
  if (kind === "feedback") {
    return {
      annotationId: "feedback:F-001",
      associatedRunRecordId: null,
      content: "Address the missing edge case.",
      contentPreview: "Address the missing edge case.",
      feedbackId: "F-001",
      kind,
      latestSubmissionId: null,
      createdAt: startedAt,
      sourceReviewAttemptId: "A-001",
      sourceReviewBlockRef: blockRef,
      status: "open"
    };
  }
  if (kind === "feedback_run") {
    return {
      annotationId: "feedback-run:RUN-F-001",
      associatedRunRecordId: "F-001::RUN-F-001",
      contentPreview: "Address the missing edge case.",
      feedbackId: "F-001",
      finishedAt,
      kind,
      recordId: "F-001::RUN-F-001",
      reportPath: "results/feedback.md",
      sourceReviewAttemptId: "A-001",
      sourceReviewBlockRef: blockRef,
      startedAt,
      status: "open"
    };
  }
  return {
    annotationId: "review-attempt:A-001",
    associatedRunRecordId: null,
    attemptId: "A-001",
    content: "Review passed.",
    contentPreview: "Review passed.",
    kind,
    reviewedAt: startedAt,
    sourceReviewBlockRef: blockRef,
    verdict: "passed"
  };
}
