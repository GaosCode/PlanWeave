/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AutoRunExplanation,
  DesktopAutoRunEvent,
  DesktopAutoRunState,
  DesktopGraphViewModel,
  DesktopTaskDetail
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";

vi.mock("../renderer/hooks/useDetectedAgents", () => ({
  useDetectedAgents: () => ({ executorOptions: [] })
}));

const initialTask: DesktopTaskDetail = {
  taskId: "T-ALPHA",
  title: "Initial task",
  status: "ready",
  executor: null,
  promptMarkdown: "# Initial",
  promptMissing: false,
  acceptance: [],
  blockOrder: ["T-ALPHA#B-001"]
};

const refreshedTask: DesktopTaskDetail = {
  ...initialTask,
  title: "Refreshed task",
  promptMarkdown: "# Refreshed"
};

const graph: DesktopGraphViewModel = {
  projectId: "P-001",
  projectTitle: "Demo project",
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
});
