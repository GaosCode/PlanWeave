/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AutoRunExplanation,
  DesktopAutoRunEvent,
  DesktopAutoRunState,
  DesktopBlockDetail,
  DesktopGraphViewModel,
  DesktopTaskDetail
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";

const initialTask: DesktopTaskDetail = {
  taskId: "T-ALPHA",
  graphVersion: "pgv-task",
  title: "Initial task",
  status: "ready",
  executor: null,
  promptMarkdown: "# Initial",
  promptHash: "hash-task",
  promptMissing: false,
  acceptance: [],
  blockOrder: ["T-ALPHA#B-001"]
};

const initialBlock: DesktopBlockDetail = {
  ref: "T-ALPHA#B-001",
  graphVersion: "pgv-block",
  taskId: "T-ALPHA",
  blockId: "B-001",
  type: "implementation",
  title: "Initial block",
  status: "ready",
  executor: null,
  effectiveExecutor: null,
  promptMarkdown: "# Initial block",
  promptHash: "hash-block",
  promptMissing: false,
  promptSurfaceMarkdown: "# Initial block",
  promptSources: [],
  dependencies: [],
  latestRunId: null,
  latestReviewAttemptId: null,
  activeFeedbackId: null,
  exceptionReason: null,
  reviewGate: null
};

const refreshedTask: DesktopTaskDetail = {
  ...initialTask,
  title: "Refreshed task",
  promptMarkdown: "# Refreshed"
};

const graph: DesktopGraphViewModel = {
  projectId: "P-001",
  projectTitle: "Demo project",
  graphVersion: "pgv-test",
  packageFingerprint: "pkg-test",
  executorOptions: ["codex"],
  tasks: [
    {
      taskId: "T-ALPHA",
      title: "Alpha task",
      status: "ready",
      executor: null,
      executorLabel: "inherit",
      promptMarkdown: "# Alpha",
      promptMissing: false,
      promptPreview: "Alpha",
      blocks: [
        {
          ref: "T-ALPHA#B-001",
          blockId: "B-001",
          type: "implementation",
          title: "Implement alpha",
          status: "ready",
          executor: null,
          promptMissing: false,
          exceptionReason: null
        }
      ],
      blockPreview: [],
      hiddenBlockRefs: [],
      overflowBlockCount: 0,
      exceptions: []
    }
  ],
  edges: [],
  diagnostics: [],
  dirtyPromptRefs: []
};

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("inspector auto-run event refresh", () => {
  it("does not commit a task auto-refresh result after the draft becomes dirty", async () => {
    const pendingGraph = deferred<DesktopGraphViewModel>();
    const pendingTask = deferred<DesktopTaskDetail>();
    let onAutoRunChangedCallback: ((event: DesktopAutoRunEvent) => void) | null = null;
    const bridge = createDesktopBridgeMock({
      getGraphViewModel: vi.fn().mockResolvedValueOnce(graph).mockReturnValueOnce(pendingGraph.promise),
      getTaskDetail: vi.fn().mockResolvedValueOnce(initialTask).mockReturnValueOnce(pendingTask.promise),
      onAutoRunChanged: vi.fn((callback: (event: DesktopAutoRunEvent) => void) => {
        onAutoRunChangedCallback = callback;
        return () => undefined;
      })
    });
    window.history.pushState({}, "", "/?projectRoot=%2Ftmp%2Fdemo&taskId=T-ALPHA&canvasId=canvas-main&language=en");
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { TaskInspectorWindow } = await import("../renderer/TaskInspectorWindow");

    render(<TaskInspectorWindow />);

    await waitFor(() => expect(screen.getByDisplayValue("# Initial")).toBeTruthy());

    const eventStateBase = {
      runId: "RUN-001",
      projectRoot: "/tmp/demo",
      canvasId: "canvas-main",
      scope: { kind: "project" },
      phase: "running",
      stepCount: 1,
      stepLimit: 20,
      currentRef: "T-ALPHA#B-001",
      currentExecutor: "codex",
      elapsedMs: 100,
      latestOutputSummary: null,
      latestRecordId: null,
      latestRecordPath: null,
      statePath: "/tmp/state.json",
      eventLogPath: "/tmp/events.ndjson",
      options: { tmuxEnabled: true },
      error: null,
      startedAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:01.000Z"
    };
    const eventState: DesktopAutoRunState = { ...eventStateBase, explanation: explanationFor(eventStateBase) };

    onAutoRunChangedCallback?.(autoRunEvent(eventState));
    await waitFor(() => expect(bridge.getTaskDetail).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByDisplayValue("# Initial"), { target: { value: "# Local draft" } });
    pendingGraph.resolve(graph);
    pendingTask.resolve(refreshedTask);

    await waitFor(() => expect(screen.getByDisplayValue("# Local draft")).toBeTruthy());
    expect(screen.queryByDisplayValue("# Refreshed")).toBeNull();
  });

  it("saves task inspector prompt drafts with prompt base options", async () => {
    const bridge = createDesktopBridgeMock({
      getGraphViewModel: vi.fn().mockResolvedValue(graph),
      getTaskDetail: vi.fn().mockResolvedValue(initialTask),
      updateTaskPrompt: vi.fn().mockResolvedValue({ ok: true, graphVersion: "pgv-task-next", diagnostics: [] }),
      onAutoRunChanged: vi.fn(() => () => undefined)
    });
    window.history.pushState({}, "", "/?projectRoot=%2Ftmp%2Fdemo&taskId=T-ALPHA&canvasId=canvas-main&language=en");
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { TaskInspectorWindow } = await import("../renderer/TaskInspectorWindow");

    render(<TaskInspectorWindow />);
    await waitFor(() => expect(screen.getByDisplayValue("# Initial")).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue("# Initial"), { target: { value: "# Local task prompt" } });

    await waitFor(() => expect(bridge.updateTaskPrompt).toHaveBeenCalled());
    expect(bridge.updateTaskPrompt).toHaveBeenCalledWith(
      { projectRoot: "/tmp/demo", canvasId: "canvas-main" },
      "T-ALPHA",
      "# Local task prompt",
      { baseGraphVersion: "pgv-task", basePromptHash: "hash-task" }
    );
  });

  it("saves block inspector prompt drafts with prompt base options", async () => {
    const bridge = createDesktopBridgeMock({
      getGraphViewModel: vi.fn().mockResolvedValue(graph),
      getBlockDetail: vi.fn().mockResolvedValue(initialBlock),
      listBlockRunRecords: vi.fn().mockResolvedValue([]),
      getReviewAttempts: vi.fn().mockResolvedValue([]),
      getFeedbackRecords: vi.fn().mockResolvedValue([]),
      updateBlockPrompt: vi.fn().mockResolvedValue({ ok: true, graphVersion: "pgv-block-next", diagnostics: [] }),
      onAutoRunChanged: vi.fn(() => () => undefined)
    });
    window.history.pushState({}, "", "/?projectRoot=%2Ftmp%2Fdemo&blockRef=T-ALPHA%23B-001&canvasId=canvas-main&language=en");
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { BlockInspectorWindow } = await import("../renderer/BlockInspectorWindow");

    render(<BlockInspectorWindow />);
    const blockPrompt = await screen.findByLabelText("Source Prompt");
    expect((blockPrompt as HTMLTextAreaElement).value).toBe("# Initial block");
    fireEvent.change(blockPrompt, { target: { value: "# Local block prompt" } });

    await waitFor(() => expect(bridge.updateBlockPrompt).toHaveBeenCalled());
    expect(bridge.updateBlockPrompt).toHaveBeenCalledWith(
      { projectRoot: "/tmp/demo", canvasId: "canvas-main" },
      "T-ALPHA#B-001",
      "# Local block prompt",
      { baseGraphVersion: "pgv-block", basePromptHash: "hash-block" }
    );
  });
});
