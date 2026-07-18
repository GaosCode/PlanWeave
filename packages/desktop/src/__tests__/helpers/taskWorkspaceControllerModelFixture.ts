import type {
  DesktopRunRecord,
  RunnerRecordReadModel,
  TaskWorkspace,
  TaskWorkspaceRun
} from "@planweave-ai/runtime";
import {
  taskWorkspaceNavigationIdentity,
  type TaskWorkspaceNavigationIdentity
} from "../../renderer/taskWorkspaceNavigation";

const taskWorkspaceSource = {
  view: "graph",
  graphSnapshot: {
    projectRoot: "/projects/demo",
    canvasId: "canvas-main",
    viewport: { x: 20, y: -10, zoom: 0.9 },
    selectedTaskId: "T-001",
    selectedBlockRef: "T-001#B-001"
  }
};

function navigation(recordId = "T-001#B-001::RUN-001"): TaskWorkspaceNavigationIdentity {
  return taskWorkspaceNavigationIdentity(
    {
      projectRoot: "/projects/demo",
      canvasId: "canvas-main",
      taskId: "T-001",
      blockRef: "T-001#B-001",
      recordId
    },
    taskWorkspaceSource
  );
}

function runnerModel(runId: string): RunnerRecordReadModel {
  const identity = projectedRun(runId).runIdentity;
  return {
    events: [],
    conversation: [],
    timeline: [],
    diagnostics: [],
    cursor: {
      version: "planweave.runner-event-cursor/v1",
      runId,
      afterSequence: 0,
      canonicalIdentity: {
        identity,
        runner: {
          version: "planweave.runner/v1",
          runnerKind: "acp",
          agentId: "codex"
        }
      },
      terminal: false
    },
    terminal: false,
    actualConfiguration: { available: false, reason: "Unavailable." },
    intervention: {
      prompt: {
        available: false,
        reason: "No prompt capability.",
        identity: null,
        inFlight: false
      },
      cancel: { available: false, reason: "No cancel capability.", identity: null }
    },
    interaction: {
      persisted: false,
      active: false,
      stale: false,
      activeRequests: []
    }
  };
}

function projectedRun(runId: string): TaskWorkspaceRun {
  const recordId = `T-001#B-001::${runId}`;
  return {
    version: "planweave.task-workspace-run/v1",
    kind: "block",
    record: { recordId, ref: "T-001#B-001", taskId: "T-001", blockId: "B-001", runId },
    runIdentity: {
      projectId: "project-1",
      canvasId: "canvas-main",
      taskId: "T-001",
      blockId: "B-001",
      claimRef: "T-001#B-001",
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
      exitCode: null,
      terminalState: null
    },
    executionWaveId: null,
    duration: {
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: null,
      calculatedAt: "2026-07-13T00:00:01.000Z",
      wallClockMs: 1000,
      unavailableReason: null
    },
    usage: {
      currentContext: null,
      runTokens: { available: false, totalTokens: null, reason: "Unavailable." },
      taskTokens: { available: false, totalTokens: null, reason: "Unavailable." }
    },
    nextActions: { version: "planweave.runner-next-actions/v1", actions: [] },
    capabilities: {
      prompt: {
        available: false,
        reason: "No prompt capability.",
        identity: null,
        inFlight: false
      },
      cancel: { available: false, reason: "No cancel capability.", identity: null },
      retry: { available: false, reason: "Retry unavailable.", identity: null },
      recoverAcpSession: {
        available: false,
        reason: { code: "runner_not_acp", message: "ACP recovery unavailable." },
        identity: null
      },
      resume: { available: false, reason: "Resume unavailable.", identity: null }
    },
    actualConfiguration: { available: false, reason: "Unavailable." }
  };
}

function runItems(selectedRecordId: string | null) {
  return ["RUN-001", "RUN-002"].map((runId, index) => {
    const run = projectedRun(runId);
    return {
      blockRef: "T-001#B-001" as const,
      retryIndex: index + 1,
      active: false,
      selected: selectedRecordId !== null && run.record.recordId === selectedRecordId,
      waitingInteraction: { active: false as const, count: 0 as const, kinds: [] },
      run
    };
  });
}

function workspaceHeader(selectedRecordId: string | null): TaskWorkspace {
  return {
    version: "planweave.task-workspace/v1",
    project: { projectId: "project-1", projectRoot: "/projects/demo", canvasId: "canvas-main" },
    task: {
      taskId: "T-001",
      title: "Task workspace",
      status: "in_progress",
      executor: "codex",
      promptMarkdown: "# Task workspace",
      promptMissing: false,
      acceptance: []
    },
    dependencyProgress: {
      total: 0,
      completed: 0,
      percent: 100,
      status: "not_applicable",
      blockers: []
    },
    blocks: [
      {
        ref: "T-001#B-001",
        taskId: "T-001",
        blockId: "B-001",
        type: "implementation",
        title: "Implement",
        status: "in_progress",
        executor: "codex",
        effectiveExecutor: "codex",
        promptMarkdown: "# Implement",
        promptMissing: false,
        promptSurfaceMarkdown: "# Rendered implement prompt",
        promptSources: [],
        dependencies: {
          total: 0,
          completed: 0,
          percent: 100,
          status: "not_applicable",
          blockers: []
        },
        runs: [],
        annotations: []
      }
    ],
    activeRecordIds: [],
    selectedRecordId,
    latestArtifact: null,
    duration: {
      wallClock: {
        available: false,
        startedAt: null,
        endedAt: null,
        calculatedAt: "2026-07-13T00:00:01.000Z",
        totalMs: null,
        unavailableReason: "Unavailable."
      },
      agentTime: {
        availability: "unavailable",
        totalMs: null,
        includedRunCount: 0,
        missingRunCount: 0,
        reason: "Unavailable."
      }
    },
    usage: {
      taskTokens: { available: false, totalTokens: null, reason: "Unavailable." },
      taskCost: { available: false, totals: null, reason: "Unavailable." }
    }
  };
}

function record(recordId: string, readModel: RunnerRecordReadModel | null): DesktopRunRecord {
  const runId = recordId.split("::")[1] ?? "";
  return {
    recordId,
    ref: "T-001#B-001",
    taskId: "T-001",
    blockId: "B-001",
    runId,
    executor: "codex",
    adapter: "codex-acp",
    executionCwd: "/projects/demo",
    projectRoot: "/projects/demo",
    agentSessionId: `session-${runId}`,
    codexSessionId: null,
    tmuxSessionId: null,
    tmuxAttachCommand: null,
    tmuxReadOnlyAttachCommand: null,
    exitCode: null,
    startedAt: "2026-07-13T00:00:00.000Z",
    finishedAt: null,
    promptPath: null,
    reportPath: null,
    metadataPath: "/projects/demo/metadata.json",
    stdoutSummary: "",
    stderrSummary: "",
    promptMarkdown: "",
    reportMarkdown: "",
    displayMarkdown: "",
    displayMarkdownSource: "none",
    metadata: {},
    runnerReadModel: readModel
  };
}

export {
  navigation,
  projectedRun,
  record,
  runItems,
  runnerModel,
  taskWorkspaceSource,
  workspaceHeader
};
