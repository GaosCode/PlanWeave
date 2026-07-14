import type { createTranslator } from "../i18n";
import type { TaskWorkspaceLabels } from "./contracts";
import type { TaskWorkspaceInspectorLabels } from "./inspector/TaskWorkspaceInspector";
import type { TaskWorkspaceUsageLabels } from "./inspector/TaskWorkspaceUsage";
import type { TaskWorkspaceTimelineLabels } from "./timeline";

type Translator = ReturnType<typeof createTranslator>;

function interpolate(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template
  );
}

function locale(t: Translator): string {
  return t("taskWorkspaceLocale");
}

function formatDuration(t: Translator, milliseconds: number): string {
  const seconds = milliseconds / 1_000;
  return interpolate(t("taskWorkspaceDurationSeconds"), {
    seconds: new Intl.NumberFormat(locale(t), {
      maximumFractionDigits: seconds < 10 ? 1 : 0
    }).format(seconds)
  });
}

function usageLabels(t: Translator): TaskWorkspaceUsageLabels {
  return {
    agent: t("agent"),
    agentTime: t("taskWorkspaceAgentTime"),
    contextSnapshot: t("taskWorkspaceContextSnapshot"),
    contextUnavailable: t("taskWorkspaceContextUnavailable"),
    contextUsage: t("taskWorkspaceContextUsage"),
    cost: t("taskWorkspaceCost"),
    currentContext: t("taskWorkspaceCurrentContext"),
    currentRun: t("taskWorkspaceCurrentRun"),
    formatCost: (amount, currency) =>
      new Intl.NumberFormat(locale(t), {
        currency,
        style: "currency"
      }).format(amount),
    formatDateTime: (value) =>
      new Intl.DateTimeFormat(locale(t), {
        dateStyle: "medium",
        timeStyle: "medium"
      }).format(new Date(value)),
    formatDuration: (milliseconds) => formatDuration(t, milliseconds),
    formatNumber: (value) => new Intl.NumberFormat(locale(t)).format(value),
    mode: t("taskWorkspaceMode"),
    model: t("taskWorkspaceModel"),
    noSnapshotCost: t("taskWorkspaceNoSnapshotCost"),
    observedAt: t("taskWorkspaceObservedAt"),
    partialAgentTime: (included, missing) =>
      interpolate(t("taskWorkspacePartialAgentTime"), {
        included,
        missing
      }),
    permission: t("taskWorkspacePermission"),
    reasoning: t("taskWorkspaceReasoning"),
    reportedSnapshotCost: t("taskWorkspaceReportedSnapshotCost"),
    runCost: t("taskWorkspaceRunCost"),
    runCostUnavailable: t("taskWorkspaceRunCostUnavailable"),
    runWallClock: t("taskWorkspaceRunWallClock"),
    taskCost: t("taskWorkspaceTaskCost"),
    taskTotal: t("taskWorkspaceTaskTotal"),
    taskTokens: t("taskWorkspaceTaskTokens"),
    taskWallClock: t("taskWorkspaceTaskWallClock"),
    tokens: t("taskWorkspaceTokens"),
    tokensUsed: (used, contextWindow) =>
      interpolate(t("taskWorkspaceTokensUsed"), {
        contextWindow,
        used
      }),
    unavailable: t("unavailable"),
    usagePercent: (percent) => interpolate(t("taskWorkspaceUsagePercent"), { percent })
  };
}

export function taskWorkspaceLabels(t: Translator): TaskWorkspaceLabels {
  return {
    acceptanceCriteria: t("acceptanceCriteria"),
    activeRuns: (count) => interpolate(t("taskWorkspaceActiveRuns"), { count }),
    agent: t("agent"),
    backToCanvas: t("taskWorkspaceBackToCanvas"),
    blocks: t("blocks"),
    booleanFalse: t("taskWorkspaceFalse"),
    booleanTrue: t("taskWorkspaceTrue"),
    composer: t("taskWorkspaceComposer"),
    conversation: t("taskWorkspaceConversation"),
    dependencies: t("dependencies"),
    dependencyProgress: (completed, total, percent) =>
      interpolate(t("taskWorkspaceDependencyProgress"), { completed, percent, total }),
    elapsed: t("taskWorkspaceElapsed"),
    expandTimeline: t("taskWorkspaceExpandTimeline"),
    formatDuration: (milliseconds) => formatDuration(t, milliseconds),
    inspector: t("taskWorkspaceInspector"),
    latestArtifact: t("taskWorkspaceLatestArtifact"),
    liveUnavailable: t("taskWorkspaceLiveUnavailable"),
    loading: t("taskWorkspaceLoading"),
    mode: t("taskWorkspaceMode"),
    model: t("taskWorkspaceModel"),
    noActiveRuns: t("taskWorkspaceNoActiveRuns"),
    noArtifact: t("taskWorkspaceNoArtifact"),
    noConversation: t("taskWorkspaceNoConversation"),
    noInspector: t("taskWorkspaceNoInspector"),
    noRuns: t("taskWorkspaceNoRuns"),
    noTask: t("taskWorkspaceNoTask"),
    overview: t("taskWorkspaceOverview"),
    permission: t("taskWorkspacePermission"),
    reasoning: t("taskWorkspaceReasoning"),
    runStatus: {
      active: t("taskWorkspaceRunning"),
      cancelled: t("taskWorkspaceCancelled"),
      completed: t("taskWorkspaceCompleted"),
      failed: t("taskWorkspaceFailed"),
      waiting: t("taskWorkspaceWaiting")
    },
    status: t("taskWorkspaceStatus"),
    taskStatus: {
      implemented: t("taskWorkspaceTaskImplemented"),
      in_progress: t("taskWorkspaceTaskInProgress"),
      planned: t("taskWorkspaceTaskPlanned"),
      ready: t("taskWorkspaceTaskReady")
    },
    timeline: t("taskWorkspaceTimeline"),
    unavailable: t("unavailable")
  };
}

export function taskWorkspaceTimelineLabels(t: Translator): TaskWorkspaceTimelineLabels {
  return {
    agent: t("agent"),
    activeRuns: (count) => interpolate(t("taskWorkspaceActiveRuns"), { count }),
    annotationKinds: {
      feedback: t("taskWorkspaceAnnotationFeedback"),
      feedback_run: t("taskWorkspaceAnnotationFeedbackRun"),
      review_attempt: t("taskWorkspaceAnnotationReviewAttempt")
    },
    cancelled: t("taskWorkspaceCancelled"),
    completed: t("taskWorkspaceCompleted"),
    dependencies: t("dependencies"),
    dependencyProgress: (completed, total, percent) =>
      interpolate(t("taskWorkspaceDependencyProgress"), { completed, percent, total }),
    elapsed: t("taskWorkspaceElapsed"),
    empty: t("taskWorkspaceNoRuns"),
    failed: t("taskWorkspaceFailed"),
    formatDateTime: (value) =>
      new Intl.DateTimeFormat(locale(t), {
        dateStyle: "short",
        timeStyle: "medium"
      }).format(new Date(value)),
    formatDuration: (milliseconds) => formatDuration(t, milliseconds),
    latestArtifact: t("taskWorkspaceLatestArtifact"),
    noActiveRuns: t("taskWorkspaceNoActiveRuns"),
    noArtifact: t("taskWorkspaceNoArtifact"),
    overview: t("taskWorkspaceOverview"),
    parallelWave: (waveId, index, total) =>
      interpolate(t("taskWorkspaceParallelWave"), {
        index,
        total,
        waveId
      }),
    resizeTimeline: t("taskWorkspaceResizeTimeline"),
    retry: (retryIndex) => interpolate(t("taskWorkspaceRetry"), { retryIndex }),
    run: (blockTitle, retryIndex) =>
      interpolate(t("taskWorkspaceRunLabel"), {
        blockTitle,
        retryIndex
      }),
    runId: t("taskWorkspaceRunId"),
    running: t("taskWorkspaceRunning"),
    startedAt: t("taskWorkspaceStartedAt"),
    timeline: t("taskWorkspaceTimeline"),
    unavailable: t("unavailable"),
    waiting: t("taskWorkspaceWaiting")
  };
}

export function taskWorkspaceInspectorLabels(t: Translator): TaskWorkspaceInspectorLabels {
  return {
    actualConfiguration: t("taskWorkspaceActualConfiguration"),
    artifactKinds: {
      feedback: t("taskWorkspaceArtifactFeedback"),
      implementation: t("taskWorkspaceArtifactImplementation"),
      review: t("taskWorkspaceArtifactReview")
    },
    artifacts: t("taskWorkspaceArtifacts"),
    block: t("taskWorkspaceBlock"),
    closeInspector: t("taskWorkspaceCloseInspector"),
    configurationUnavailable: t("taskWorkspaceConfigurationUnavailable"),
    currentMode: t("taskWorkspaceCurrentMode"),
    diagnostics: t("diagnostics"),
    emptyDiagnostics: t("taskWorkspaceEmptyDiagnostics"),
    emptyEvents: t("taskWorkspaceEmptyEvents"),
    eventKinds: {
      artifact: t("taskWorkspaceEventArtifact"),
      diagnostic: t("taskWorkspaceEventDiagnostic"),
      interaction: t("taskWorkspaceEventInteraction"),
      interaction_result: t("taskWorkspaceEventInteractionResult"),
      lifecycle: t("taskWorkspaceEventLifecycle"),
      message: t("taskWorkspaceEventMessage"),
      output: t("taskWorkspaceEventOutput"),
      plan_update: t("taskWorkspaceEventPlanUpdate"),
      session_config_options_update: t("taskWorkspaceEventConfigOptionsUpdate"),
      session_configuration_snapshot: t("taskWorkspaceEventConfigurationSnapshot"),
      session_mode_update: t("taskWorkspaceEventModeUpdate"),
      terminal: t("taskWorkspaceEventTerminal"),
      terminal_output: t("taskWorkspaceEventTerminalOutput"),
      tool_call: t("taskWorkspaceEventToolCall"),
      tool_update: t("taskWorkspaceEventToolUpdate"),
      usage_update: t("taskWorkspaceEventUsageUpdate")
    },
    events: t("taskWorkspaceEvents"),
    false: t("taskWorkspaceFalse"),
    fileChangesUnavailable: t("taskWorkspaceFileChangesUnavailable"),
    files: t("taskWorkspaceFiles"),
    formatDateTime: (value) =>
      new Intl.DateTimeFormat(locale(t), {
        dateStyle: "medium",
        timeStyle: "medium"
      }).format(new Date(value)),
    historyUnavailable: t("taskWorkspaceHistoryUnavailable"),
    latestTaskArtifact: t("taskWorkspaceLatestTaskArtifact"),
    metadataFile: t("taskWorkspaceMetadataFile"),
    mode: t("taskWorkspaceMode"),
    model: t("taskWorkspaceModel"),
    noArtifact: t("taskWorkspaceNoArtifact"),
    noSelection: t("taskWorkspaceNoSelection"),
    observedAt: t("taskWorkspaceObservedAt"),
    options: t("taskWorkspaceOptions"),
    overview: t("taskWorkspaceInspectorOverview"),
    permission: t("taskWorkspacePermission"),
    promptFile: t("taskWorkspacePromptFile"),
    protocolDetails: t("taskWorkspaceProtocolDetails"),
    reasoning: t("taskWorkspaceReasoning"),
    reportFile: t("taskWorkspaceReportFile"),
    resizeInspector: t("taskWorkspaceResizeInspector"),
    run: t("taskWorkspaceRun"),
    runArtifact: t("taskWorkspaceRunArtifact"),
    runStatus: {
      cancelled: t("taskWorkspaceCancelled"),
      completed: t("taskWorkspaceCompleted"),
      failed: t("taskWorkspaceFailed"),
      recorded: t("taskWorkspaceRecorded"),
      running: t("taskWorkspaceRunning")
    },
    sequence: (sequence) => `#${sequence}`,
    session: t("taskWorkspaceSession"),
    showingLatest: (visible, total) =>
      interpolate(t("taskWorkspaceShowingLatest"), {
        total,
        visible
      }),
    status: t("taskWorkspaceStatus"),
    task: t("taskWorkspaceTask"),
    true: t("taskWorkspaceTrue"),
    unavailable: t("unavailable"),
    usage: t("taskWorkspaceUsage"),
    usageLabels: usageLabels(t),
    workingDirectory: t("taskWorkspaceWorkingDirectory")
  };
}

export { usageLabels as taskWorkspaceUsageLabels };
