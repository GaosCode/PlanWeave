import {
  runnerRecordReadModelSchema,
  runnerRunIdentitySchema,
  type DesktopCanvasReference,
  type DesktopRunRecord,
  type RunnerRecordReadModel,
  type TaskWorkspaceBlock,
  type TaskWorkspaceRun
} from "@planweave-ai/runtime";
import { vi } from "vitest";
import type {
  TaskWorkspaceConversationSlotProps,
  TaskWorkspaceSelectedRun
} from "../../renderer/task-workspace/contracts";

export const recordId = "T-001#B-001::RUN-001";
export const timestamp = "2026-07-13T00:00:00.000Z";

export function activeIdentity(requestId: string) {
  return {
    scope: "/projects/demo",
    executorRunId: "RUN-001",
    desktopRunId: "DESKTOP-001",
    runSessionId: "RUN-SESSION-001",
    claimRef: "T-001#B-001",
    sessionId: "ACP-SESSION-001",
    requestId
  };
}

export function readModel(options: {
  activeRequests?: unknown[];
  afterSequence?: number;
  prompt?: boolean;
  terminal?: boolean;
  timeline?: RunnerRecordReadModel["timeline"];
} = {}): RunnerRecordReadModel {
  const terminal = options.terminal ?? false;
  const promptAvailable = options.prompt ?? true;
  return runnerRecordReadModelSchema.parse({
    events: [],
    conversation: [],
    timeline: options.timeline ?? [{
      sequence: 1,
      timestamp,
      kind: "message",
      role: "assistant",
      content: "## Result\n\n- shared projected timeline\n\n`safe markdown`"
    }],
    diagnostics: [],
    actualConfiguration: { available: false, reason: "Unavailable." },
    cursor: {
      version: "planweave.runner-event-cursor/v1",
      runId: "RUN-001",
      afterSequence: options.afterSequence ?? 1,
      canonicalIdentity: null,
      terminal
    },
    terminal,
    intervention: {
      prompt: {
        available: promptAvailable,
        reason: promptAvailable ? null : "Prompt unavailable.",
        identity: promptAvailable ? {
          ref: { projectRoot: "/projects/demo", canvasId: "canvas-main" },
          recordId,
          executorRunId: "RUN-001",
          claimRef: "T-001#B-001",
          sessionId: "ACP-SESSION-001"
        } : null,
        inFlight: false
      },
      cancel: {
        available: !terminal,
        reason: terminal ? "Run finished." : null,
        identity: terminal ? null : {
          scope: "/projects/demo",
          executorRunId: "RUN-001",
          desktopRunId: "DESKTOP-001",
          runSessionId: "RUN-SESSION-001",
          claimRef: "T-001#B-001",
          sessionId: "ACP-SESSION-001"
        }
      }
    },
    interaction: {
      persisted: Boolean(options.activeRequests?.length),
      active: Boolean(options.activeRequests?.length),
      stale: false,
      activeRequests: options.activeRequests ?? []
    }
  });
}

export function selection(options: {
  active?: boolean;
  model?: RunnerRecordReadModel | null;
  runnerKind?: "acp" | "cli";
} = {}): TaskWorkspaceSelectedRun {
  const model = options.model === undefined ? readModel() : options.model;
  const runnerKind = options.runnerKind ?? "acp";
  const prompt = model?.intervention.prompt ?? {
    available: false,
    reason: "No ACP read model.",
    identity: null,
    inFlight: false
  };
  const cancel = model?.intervention.cancel ?? {
    available: false,
    reason: "No ACP read model.",
    identity: null
  };
  const runIdentity = runnerRunIdentitySchema.parse({
    projectId: "project-1",
    canvasId: "canvas-main",
    taskId: "T-001",
    blockId: "B-001",
    claimRef: "T-001#B-001",
    runId: "RUN-001",
    runOwner: "executor",
    runSessionId: runnerKind === "acp" ? "RUN-SESSION-001" : null,
    desktopRunId: runnerKind === "acp" ? "DESKTOP-001" : null,
    executorRunId: "RUN-001"
  });
  const run: TaskWorkspaceRun = {
    version: "planweave.task-workspace-run/v1",
    kind: "block",
    record: { recordId, ref: "T-001#B-001", taskId: "T-001", blockId: "B-001", runId: "RUN-001" },
    runIdentity,
    metadata: {
      executor: runnerKind === "acp" ? "codex-acp" : "codex",
      adapter: runnerKind,
      runnerKind,
      agentId: runnerKind === "acp" ? "codex" : null,
      executionCwd: "/projects/demo",
      projectRoot: "/projects/demo",
      agentSessionId: runnerKind === "acp" ? "ACP-SESSION-001" : null,
      tmuxSessionId: null,
      exitCode: null,
      terminalState: null
    },
    executionWaveId: null,
    duration: {
      startedAt: timestamp,
      finishedAt: null,
      calculatedAt: timestamp,
      wallClockMs: 0,
      unavailableReason: null
    },
    usage: {
      currentContext: null,
      runTokens: { available: false, totalTokens: null, reason: "Unavailable." },
      taskTokens: { available: false, totalTokens: null, reason: "Unavailable." }
    },
    actualConfiguration: { available: false, reason: "Unavailable." },
    capabilities: {
      prompt,
      cancel,
      retry: { available: false, reason: "Retry API unavailable.", identity: null },
      resume: { available: false, reason: "Resume API unavailable.", identity: null }
    }
  };
  const block: TaskWorkspaceBlock = {
    ref: run.record.ref,
    taskId: run.record.taskId,
    blockId: run.record.blockId,
    type: "implementation",
    title: "Implement workspace",
    status: options.active === false ? "completed" : "in_progress",
    effectiveExecutor: run.metadata.executor,
    dependencies: { total: 0, completed: 0, percent: 100, status: "not_applicable", blockers: [] },
    runs: [],
    annotations: []
  };
  const item = {
    retryIndex: 1,
    active: options.active ?? true,
    selected: true,
    waitingInteraction: model?.interaction.activeRequests.length
      ? {
          active: true as const,
          count: model.interaction.activeRequests.length,
          kinds: [...new Set(model.interaction.activeRequests.map((request) => request.kind))]
        }
      : { active: false as const, count: 0 as const, kinds: [] },
    run
  };
  block.runs.push(item);
  return { block, item };
}

export function record(model: RunnerRecordReadModel | null, patch: Partial<DesktopRunRecord> = {}): DesktopRunRecord {
  return {
    recordId,
    kind: "block",
    ref: "T-001#B-001",
    taskId: "T-001",
    blockId: "B-001",
    runId: "RUN-001",
    executor: model ? "codex-acp" : "codex",
    adapter: model ? "acp" : "cli",
    executionCwd: "/projects/demo",
    projectRoot: "/projects/demo",
    agentSessionId: model ? "ACP-SESSION-001" : null,
    codexSessionId: null,
    tmuxSessionId: null,
    tmuxAttachCommand: null,
    tmuxReadOnlyAttachCommand: null,
    exitCode: null,
    startedAt: timestamp,
    finishedAt: null,
    promptPath: null,
    reportPath: null,
    metadataPath: "/records/metadata.json",
    stdoutSummary: "real stdout summary",
    stderrSummary: "real stderr summary",
    promptMarkdown: "",
    reportMarkdown: "",
    displayMarkdown: "## CLI result\n\nRendered from the persisted display projection.",
    displayMarkdownSource: "live-output",
    metadata: {},
    runnerReadModel: model,
    ...patch
  };
}

export function conversationProps(
  selectedRun: TaskWorkspaceSelectedRun,
  model: RunnerRecordReadModel | null,
  patch: Partial<TaskWorkspaceConversationSlotProps> = {}
): TaskWorkspaceConversationSlotProps & { canvasRef: DesktopCanvasReference } {
  return {
    canvasRef: { projectRoot: "/projects/demo", canvasId: "canvas-main" },
    getRunScrollTop: () => 0,
    liveStatus: model ? "live" : "unavailable",
    liveUnavailableReason: null,
    onRunScrollTopChange: vi.fn(),
    recordError: null,
    runnerModel: model,
    selectedRecord: record(model),
    selectedRun,
    subscriptionError: null,
    ...patch
  };
}
