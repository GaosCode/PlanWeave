import {
  normalizedRunnerEventSchema,
  runnerRecordReadModelSchema,
  taskWorkspaceBlockSchema,
  taskWorkspaceRunSchema,
  taskWorkspaceSchema,
  type DesktopRunRecord,
  type RunnerRecordReadModel
} from "@planweave-ai/runtime";
import type { TaskWorkspaceSelectedRun } from "../../renderer/task-workspace/contracts";
import type { TaskWorkspaceUsageLabels } from "../../renderer/task-workspace/inspector/TaskWorkspaceUsage";

const startedAt = "2026-07-13T00:00:00.000Z";
const finishedAt = "2026-07-13T00:02:00.000Z";
const calculatedAt = "2026-07-13T00:03:00.000Z";
const runId = "RUN-001";
const ref = "T-001#B-001";
const recordId = `${ref}::${runId}`;

const identity = {
  projectId: "project-1",
  canvasId: "canvas-main",
  taskId: "T-001",
  blockId: "B-001",
  claimRef: ref,
  runId,
  runOwner: "executor" as const,
  runSessionId: "SESSION-001",
  desktopRunId: "DESKTOP-001",
  executorRunId: runId
};

function runnerModel(): RunnerRecordReadModel {
  const runner = {
    version: "planweave.runner/v1" as const,
    runnerKind: "acp" as const,
    agentId: "codex" as const
  };
  const event = normalizedRunnerEventSchema.parse({
    version: "planweave.runner-event/v1",
    sequence: 1,
    timestamp: "2026-07-13T00:00:01.000Z",
    identity,
    runner,
    correlation: { sessionId: "session-1" },
    body: { kind: "lifecycle", state: "running", message: "Runner started." }
  });
  return runnerRecordReadModelSchema.parse({
    events: [event],
    conversation: [],
    timeline: [],
    diagnostics: [{ code: "sequence_gap", line: 4, message: "Sequence 2 was missing." }],
    cursor: {
      version: "planweave.runner-event-cursor/v1",
      runId,
      afterSequence: 1,
      canonicalIdentity: { identity, runner },
      terminal: false
    },
    terminal: false,
    actualConfiguration: {
      available: false,
      reason: "The live read model is not the Inspector configuration source."
    },
    intervention: {
      prompt: { available: false, reason: "Unavailable.", identity: null, inFlight: false },
      cancel: { available: false, reason: "Unavailable.", identity: null }
    },
    interaction: {
      persisted: false,
      active: false,
      stale: false,
      activeRequests: []
    }
  });
}

export function taskWorkspaceInspectorFixture(options: {
  contextSnapshot?: boolean;
  includeRunnerModel?: boolean;
  zeroMetrics?: boolean;
} = {}) {
  const zeroMetrics = options.zeroMetrics === true;
  const effectiveFinishedAt = zeroMetrics ? startedAt : finishedAt;
  const run = taskWorkspaceRunSchema.parse({
    version: "planweave.task-workspace-run/v1",
    kind: "block",
    record: { recordId, ref, taskId: "T-001", blockId: "B-001", runId },
    runIdentity: identity,
    metadata: {
      executor: "codex",
      adapter: "codex-acp",
      runnerKind: "acp",
      agentId: "codex",
      executionCwd: "/projects/demo",
      projectRoot: "/projects/demo",
      agentSessionId: "session-1",
      tmuxSessionId: null,
      exitCode: 0
    },
    executionWaveId: null,
    duration: {
      startedAt,
      finishedAt: effectiveFinishedAt,
      calculatedAt,
      wallClockMs: zeroMetrics ? 0 : 120_000,
      unavailableReason: null
    },
    usage: {
      currentContext: options.contextSnapshot === false
        ? null
        : {
            aggregation: "snapshot",
            sequence: 9,
            observedAt: "2026-07-13T00:01:30.000Z",
            usedTokens: zeroMetrics ? 0 : 18_300,
            contextWindowTokens: 25_800,
            cost: { amount: zeroMetrics ? 0 : 0.42, currency: "USD" }
          },
      runTokens: {
        available: false,
        totalTokens: null,
        reason: "Current-context snapshots are not cumulative run tokens."
      },
      taskTokens: {
        available: false,
        totalTokens: null,
        reason: "No authoritative task token total exists."
      }
    },
    actualConfiguration: {
      available: true,
      sequence: 7,
      observedAt: "2026-07-13T00:00:30.000Z",
      sessionId: "session-1",
      protocol: {
        modes: {
          currentModeId: "code",
          availableModes: [{ id: "code", name: "Code", description: "Edit the workspace." }]
        },
        configOptions: [
          {
            id: "model",
            type: "select",
            name: "Model selection",
            description: "Session model.",
            category: "model",
            currentValue: "gpt-5",
            options: [
              {
                value: "gpt-5",
                name: "GPT-5",
                description: null,
                group: null
              }
            ]
          },
          {
            id: "thought",
            type: "select",
            name: "Reasoning level",
            description: null,
            category: "thought_level",
            currentValue: "high",
            options: [
              { value: "high", name: "High", description: null, group: null }
            ]
          }
        ]
      },
      fields: {
        model: {
          available: true,
          value: "gpt-5",
          source: { kind: "config_option", optionId: "model" },
          reason: null
        },
        reasoning: {
          available: true,
          value: "high",
          source: { kind: "config_option", optionId: "thought" },
          reason: null
        },
        mode: {
          available: true,
          value: "code",
          source: { kind: "session_mode", optionId: null },
          reason: null
        },
        permission: {
          available: false,
          value: null,
          source: null,
          reason: "ACP does not define a portable permission field."
        }
      }
    },
    capabilities: {
      prompt: { available: false, reason: "Unavailable.", identity: null, inFlight: false },
      cancel: { available: false, reason: "Unavailable.", identity: null },
      retry: { available: false, reason: "Unavailable.", identity: null },
      resume: { available: false, reason: "Unavailable.", identity: null }
    }
  });
  const item = {
    active: false,
    retryIndex: 1,
    selected: true,
    waitingInteraction: { active: false as const, count: 0 as const, kinds: [] },
    run
  };
  const block = taskWorkspaceBlockSchema.parse({
    ref,
    taskId: "T-001",
    blockId: "B-001",
    type: "implementation",
    title: "Implement inspector",
    status: "completed",
    effectiveExecutor: "codex",
    dependencies: {
      total: 0,
      completed: 0,
      percent: 100,
      status: "not_applicable",
      blockers: []
    },
    runs: [item],
    annotations: []
  });
  const workspace = taskWorkspaceSchema.parse({
    version: "planweave.task-workspace/v1",
    project: { projectId: "project-1", projectRoot: "/projects/demo", canvasId: "canvas-main" },
    task: {
      taskId: "T-001",
      title: "Build the right inspector",
      status: "implemented",
      executor: "codex",
      acceptance: []
    },
    dependencyProgress: {
      total: 0,
      completed: 0,
      percent: 100,
      status: "not_applicable",
      blockers: []
    },
    blocks: [block],
    activeRecordIds: [],
    selectedRecordId: recordId,
    latestArtifact: {
      recordId,
      blockRef: ref,
      runId,
      reportPath: "/projects/demo/results/implementation.md",
      reference: {
        version: "planweave.runner/v1",
        kind: "implementation",
        relativePath: "implementation.md",
        sha256: "a".repeat(64),
        sizeBytes: 512,
        mediaType: "text/markdown"
      },
      legacy: false
    },
    duration: {
      wallClock: {
        available: true,
        startedAt,
        endedAt: zeroMetrics ? startedAt : "2026-07-13T00:05:00.000Z",
        calculatedAt,
        totalMs: zeroMetrics ? 0 : 300_000,
        unavailableReason: null
      },
      agentTime: {
        availability: "partial",
        totalMs: zeroMetrics ? 0 : 120_000,
        includedRunCount: 1,
        missingRunCount: 1,
        reason: "One historical run lacks timing data."
      }
    },
    usage: {
      taskTokens: {
        available: false,
        totalTokens: null,
        reason: "No authoritative task token total exists."
      },
      taskCost: {
        available: false,
        totals: null,
        reason: "No authoritative task cost total exists."
      }
    }
  });
  const selectedRun: TaskWorkspaceSelectedRun = {
    block,
    item: block.runs[0]!
  };
  const selectedRecord: DesktopRunRecord = {
    recordId,
    kind: "block",
    ref,
    taskId: "T-001",
    blockId: "B-001",
    runId,
    executor: "codex",
    adapter: "codex-acp",
    executionCwd: "/projects/demo",
    projectRoot: "/projects/demo",
    agentSessionId: "session-1",
    codexSessionId: null,
    tmuxSessionId: null,
    exitCode: 0,
    startedAt,
    finishedAt: effectiveFinishedAt,
    promptPath: "/projects/demo/prompts/run.md",
    reportPath: "/projects/demo/results/implementation.md",
    metadataPath: "/projects/demo/.planweave/run.json",
    stdoutSummary: "",
    stderrSummary: "",
    promptMarkdown: "Prompt",
    reportMarkdown: "Report",
    displayMarkdown: "Report",
    displayMarkdownSource: "report",
    metadata: {},
    runnerReadModel: options.includeRunnerModel === false ? null : runnerModel()
  };
  return { selectedRecord, selectedRun, workspace };
}

export const taskWorkspaceUsageLabelsFixture: TaskWorkspaceUsageLabels = {
  agentTime: "Agent time",
  contextSnapshot: "Latest snapshot only",
  contextUnavailable: "No authoritative current-context snapshot was recorded.",
  contextUsage: "Context usage",
  cost: "Cost",
  currentContext: "Current context",
  currentRun: "Current run",
  formatCost: (amount, currency) => `${currency} ${amount.toFixed(2)}`,
  formatDateTime: (value) => value,
  formatDuration: (milliseconds) => `${milliseconds / 1_000}s`,
  formatNumber: (value) => new Intl.NumberFormat("en-US").format(value),
  noSnapshotCost: "No cost was reported with the latest context snapshot.",
  observedAt: "Observed at",
  partialAgentTime: (included, missing) => `${included} included, ${missing} missing`,
  reportedSnapshotCost: "Reported session cost snapshot; not final run cost",
  runCost: "Run cost",
  runCostUnavailable: "No authoritative completed-run cost exists.",
  runWallClock: "Run wall-clock",
  taskCost: "Task cost",
  taskTotal: "Task total",
  taskTokens: "Task tokens",
  taskWallClock: "Task wall-clock",
  tokens: "Tokens",
  tokensUsed: (used, window) => `${used} / ${window} tokens`,
  unavailable: "Unavailable",
  usagePercent: (percent) => `${percent}% used`
};
