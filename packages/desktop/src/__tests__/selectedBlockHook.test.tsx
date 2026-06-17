/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  AutoRunExplanation,
  DesktopAutoRunEvent,
  DesktopAutoRunState,
  DesktopBlockDetail,
  DesktopBlockRunRecordSummary,
  DesktopProjectSummary,
  DesktopRunRecord
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";

const project: DesktopProjectSummary = {
  projectId: "P-001",
  name: "Demo project",
  rootPath: "/tmp/demo",
  workspaceRoot: "/tmp/demo",
  activeCanvasId: "canvas-main",
  taskCanvases: []
};

const blockDetail: DesktopBlockDetail = {
  ref: "T-ALPHA#B-001",
  taskId: "T-ALPHA",
  blockId: "B-001",
  type: "implementation",
  title: "Implement alpha",
  status: "ready",
  executor: null,
  effectiveExecutor: "codex",
  promptMarkdown: "# Implement alpha",
  promptMissing: false,
  promptSurfaceMarkdown: "# Effective implement alpha",
  promptSources: [],
  dependencies: [],
  latestRunId: null,
  latestReviewAttemptId: null,
  activeFeedbackId: null,
  exceptionReason: null,
  reviewGate: null
};

const runRecordSummary: DesktopBlockRunRecordSummary = {
  recordId: "T-ALPHA#B-001::RUN-001",
  ref: "T-ALPHA#B-001",
  taskId: "T-ALPHA",
  blockId: "B-001",
  runId: "RUN-001",
  executor: "codex",
  adapter: "codex",
  executionCwd: "/tmp/demo",
  projectRoot: project.rootPath,
  agentSessionId: null,
  codexSessionId: null,
  tmuxSessionId: null,
  tmuxAttachCommand: null,
  tmuxReadOnlyAttachCommand: null,
  exitCode: null,
  startedAt: "2026-05-23T00:00:00.000Z",
  finishedAt: null,
  promptPath: "/tmp/prompt.md",
  reportPath: null,
  metadataPath: "/tmp/metadata.json",
  stdoutSummary: "",
  stderrSummary: ""
};

function runRecord(patch: Partial<DesktopRunRecord> = {}): DesktopRunRecord {
  return {
    ...runRecordSummary,
    promptMarkdown: "# Prompt",
    reportMarkdown: "",
    displayMarkdown: "",
    displayMarkdownSource: "none",
    metadata: {},
    ...patch
  };
}

function autoRunEvent(state: DesktopAutoRunState): DesktopAutoRunEvent {
  return {
    projectRoot: state.projectRoot,
    canvasId: state.canvasId,
    runId: state.runId,
    phase: state.phase,
    state,
    currentRef: state.currentRef,
    latestRecordId: state.latestRecordId,
    latestRecordPath: state.latestRecordPath,
    eventType: "step_finish",
    triggeredAt: state.updatedAt
  };
}

function explanationFor(state: Omit<DesktopAutoRunState, "explanation">): AutoRunExplanation {
  return {
    phase: state.phase,
    currentRef: state.currentRef,
    currentExecutor: state.currentExecutor,
    latestRecordId: state.latestRecordId,
    latestRecordPath: state.latestRecordPath,
    latestOutputSummary: state.latestOutputSummary,
    error: state.error,
    nextAction: {
      kind: "wait",
      message: "Wait for the current Auto Run step to finish.",
      command: null,
      targetPath: null,
      ref: state.currentRef
    }
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("selected block hook auto-run events", () => {
  it("refreshes selected block records from matching auto-run events", async () => {
    const refreshedRecord = runRecord({
      displayMarkdown: "Updated report",
      displayMarkdownSource: "report",
      finishedAt: "2026-05-23T00:00:02.000Z",
      reportMarkdown: "Updated report"
    });
    let onAutoRunChangedCallback: ((event: DesktopAutoRunEvent) => void) | null = null;
    const bridge = createDesktopBridgeMock({
      getBlockDetail: vi.fn().mockResolvedValue(blockDetail),
      getFeedbackRecords: vi.fn().mockResolvedValue([]),
      getReviewAttempts: vi.fn().mockResolvedValue([]),
      getRunRecord: vi.fn().mockResolvedValueOnce(runRecord()).mockResolvedValueOnce(refreshedRecord),
      listBlockRunRecords: vi.fn().mockResolvedValue([runRecordSummary]),
      onAutoRunChanged: vi.fn((callback: (event: DesktopAutoRunEvent) => void) => {
        onAutoRunChangedCallback = callback;
        return () => undefined;
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useSelectedBlock } = await import("../renderer/hooks/useSelectedBlock");
    const refreshGraph = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useSelectedBlock({
        refreshGraph,
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setActiveView: vi.fn(),
        setError: vi.fn()
      })
    );

    await act(async () => {
      await result.current.handleBlockSelect(blockDetail.ref);
      await result.current.handleOpenRunRecord(runRecordSummary.recordId);
    });

    const eventStateBase = {
      runId: "RUN-001",
      projectRoot: project.rootPath,
      canvasId: "canvas-main",
      scope: { kind: "project" },
      phase: "running",
      stepCount: 1,
      stepLimit: 20,
      currentRef: blockDetail.ref,
      currentExecutor: "codex",
      elapsedMs: 100,
      latestOutputSummary: null,
      latestRecordId: runRecordSummary.recordId,
      latestRecordPath: runRecordSummary.metadataPath,
      statePath: "/tmp/state.json",
      eventLogPath: "/tmp/events.ndjson",
      options: { tmuxEnabled: true },
      error: null,
      startedAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:01.000Z"
    };
    const eventState: DesktopAutoRunState = { ...eventStateBase, explanation: explanationFor(eventStateBase) };

    await act(async () => {
      onAutoRunChangedCallback?.(autoRunEvent(eventState));
    });

    await waitFor(() => expect(result.current.selectedRunRecord).toEqual(refreshedRecord));
    expect(bridge.getRunRecord).toHaveBeenCalledTimes(2);
    expect(bridge.listBlockRunRecords).toHaveBeenCalledTimes(2);
    expect(refreshGraph).toHaveBeenCalledTimes(1);
  });

  it("refreshes selected block records when a new latest record id only matches by block ref prefix", async () => {
    const newRecordSummary: DesktopBlockRunRecordSummary = {
      ...runRecordSummary,
      recordId: "T-ALPHA#B-001::RUN-002",
      runId: "RUN-002",
      startedAt: "2026-05-23T00:00:03.000Z"
    };
    let onAutoRunChangedCallback: ((event: DesktopAutoRunEvent) => void) | null = null;
    const bridge = createDesktopBridgeMock({
      getBlockDetail: vi.fn().mockResolvedValue(blockDetail),
      getFeedbackRecords: vi.fn().mockResolvedValue([]),
      getReviewAttempts: vi.fn().mockResolvedValue([]),
      listBlockRunRecords: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([newRecordSummary]),
      onAutoRunChanged: vi.fn((callback: (event: DesktopAutoRunEvent) => void) => {
        onAutoRunChangedCallback = callback;
        return () => undefined;
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useSelectedBlock } = await import("../renderer/hooks/useSelectedBlock");
    const refreshGraph = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useSelectedBlock({
        refreshGraph,
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setActiveView: vi.fn(),
        setError: vi.fn()
      })
    );

    await act(async () => {
      await result.current.handleBlockSelect(blockDetail.ref);
    });

    const eventStateBase = {
      runId: "RUN-002",
      projectRoot: project.rootPath,
      canvasId: "canvas-main",
      scope: { kind: "project" },
      phase: "running",
      stepCount: 1,
      stepLimit: 20,
      currentRef: null,
      currentExecutor: "codex",
      elapsedMs: 100,
      latestOutputSummary: null,
      latestRecordId: newRecordSummary.recordId,
      latestRecordPath: newRecordSummary.metadataPath,
      statePath: "/tmp/state-2.json",
      eventLogPath: "/tmp/events-2.ndjson",
      options: { tmuxEnabled: true },
      error: null,
      startedAt: "2026-05-23T00:00:03.000Z",
      updatedAt: "2026-05-23T00:00:04.000Z"
    };
    const eventState: DesktopAutoRunState = { ...eventStateBase, explanation: explanationFor(eventStateBase) };

    await act(async () => {
      onAutoRunChangedCallback?.(autoRunEvent(eventState));
    });

    await waitFor(() => expect(result.current.blockRunRecords).toEqual([newRecordSummary]));
    expect(bridge.listBlockRunRecords).toHaveBeenCalledTimes(2);
    expect(refreshGraph).toHaveBeenCalledTimes(1);
  });
});
