/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AutoRunExplanation,
  DesktopAutoRunActivity,
  DesktopAutoRunActivityEvent,
  DesktopAutoRunEvent,
  DesktopAutoRunState,
  DesktopBlockDetail,
  DesktopBlockRunRecordSummary,
  DesktopBridgeApi,
  DesktopGraphViewModel,
  DesktopRunRecord,
  DesktopTaskDetail
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { autoRunActivityChangedChannel, desktopBridgeInvokeChannels } from "../shared/ipcChannels";
import { createDesktopBridgeMock } from "./desktopBridgeMock";

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() }
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => electron.exposed.set(key, api)
  },
  ipcRenderer: electron.ipcRenderer
}));

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
  dispatchable: false,
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
      sharedResources: [],
      blocks: [
        {
          ref: "T-ALPHA#B-001",
          blockId: "B-001",
          type: "implementation",
          title: "Implement alpha",
          status: "ready",
          executor: null,
          promptMissing: false,
          exceptionReason: null,
          dispatchable: false
        }
      ],
      blockPreview: [],
      hiddenBlockRefs: [],
      overflowBlockCount: 0,
      exceptions: []
    }
  ],
  edges: [],
  sharedResourceGroups: [],
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
    workspaceRoot: state.projectRoot,
    planweaveHome: "/tmp/home",
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
  electron.exposed.clear();
  electron.ipcRenderer.invoke.mockReset();
  electron.ipcRenderer.on.mockReset();
  electron.ipcRenderer.off.mockReset();
});

describe("inspector auto-run event refresh", () => {
  it("keeps untimed run history visible without reporting a local Auto Run", async () => {
    const history: DesktopBlockRunRecordSummary = {
      recordId: `${initialBlock.ref}::RUN-001`,
      ref: initialBlock.ref,
      taskId: initialBlock.taskId,
      blockId: initialBlock.blockId,
      runId: "RUN-001",
      executor: null,
      adapter: null,
      executionCwd: null,
      projectRoot: null,
      agentSessionId: null,
      codexSessionId: null,
      exitCode: null,
      startedAt: null,
      finishedAt: null,
      promptPath: null,
      reportPath: null,
      metadataPath: "metadata.json",
      stdoutSummary: "",
      stderrSummary: ""
    };
    const bridge = createDesktopBridgeMock({
      getGraphViewModel: vi.fn().mockResolvedValue(graph),
      getBlockDetail: vi.fn().mockResolvedValue({ ...initialBlock, latestRunId: history.runId }),
      listBlockRunRecords: vi.fn().mockResolvedValue([history]),
      getReviewAttempts: vi.fn().mockResolvedValue([]),
      getFeedbackRecords: vi.fn().mockResolvedValue([])
    });
    window.history.pushState(
      {},
      "",
      "/?projectRoot=%2Ftmp%2Fdemo&blockRef=T-ALPHA%23B-001&canvasId=canvas-main&language=en"
    );
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { BlockInspectorWindow } = await import("../renderer/BlockInspectorWindow");

    render(<BlockInspectorWindow />);

    await screen.findByRole("button", { name: /Latest run.*RUN-001/ });
    expect(screen.queryByTestId("remote-run-local-coexistence")).toBeNull();
  });

  it.each([
    "/tmp/demo",
    "/private/tmp/demo"
  ])("updates the open Inspector at %s across activity and navigation", async (projectRoot) => {
    const pendingInitial = deferred<DesktopAutoRunActivity>();
    const pendingOldRefresh = deferred<DesktopAutoRunActivity>();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const getActivity = vi.fn().mockReturnValueOnce(pendingInitial.promise);
    const nextRef = "T-BETA#B-001";
    const canvas = { projectRoot, canvasId: "canvas-main" };
    const scope = { projectId: graph.projectId, canvasKey: "canvases/canvas-main/state.json" };
    const activity = (activeBlockRefs: string[]): DesktopAutoRunActivity => ({
      scope,
      activeBlockRefs
    });
    type ActivityListener = (event: object, payload: DesktopAutoRunActivityEvent) => void;
    const activeListeners = new Set<ActivityListener>();
    electron.ipcRenderer.invoke.mockImplementation((channel, ...args) => {
      expect(channel).toBe(desktopBridgeInvokeChannels.getAutoRunActivity);
      return getActivity(...args);
    });
    electron.ipcRenderer.on.mockImplementation((channel, listener) => {
      if (channel === autoRunActivityChangedChannel) activeListeners.add(listener);
    });
    electron.ipcRenderer.off.mockImplementation((channel, listener) => {
      if (channel === autoRunActivityChangedChannel) activeListeners.delete(listener);
    });
    vi.resetModules();
    await import("../preload/preload");
    const preload = electron.exposed.get("planweave") as DesktopBridgeApi;
    const notify = (source = scope) => {
      for (const listener of activeListeners)
        listener({}, { scope: source, planweaveHome: "/tmp/home" });
    };
    const bridge = createDesktopBridgeMock({
      getGraphViewModel: vi.fn().mockResolvedValue(graph),
      getBlockDetail: vi.fn(async (_canvas, ref) => ({
        ...initialBlock,
        ref,
        remoteDispatchable: true,
        promptMarkdown: ref
      })),
      listBlockRunRecords: vi.fn().mockResolvedValue([]),
      getReviewAttempts: vi.fn().mockResolvedValue([]),
      getFeedbackRecords: vi.fn().mockResolvedValue([]),
      getAutoRunActivity: preload.getAutoRunActivity,
      onAutoRunActivityChanged: preload.onAutoRunActivityChanged
    });
    function navigate(projectRoot: string, canvasId: string, blockRef: string) {
      window.history.replaceState(
        {},
        "",
        `/?${new URLSearchParams({ projectRoot, canvasId, blockRef, language: "en" })}`
      );
    }
    navigate(canvas.projectRoot, canvas.canvasId, initialBlock.ref);
    vi.stubGlobal("planweave", bridge);
    const { BlockInspectorWindow } = await import("../renderer/BlockInspectorWindow");
    const { rerender } = render(<BlockInspectorWindow />);

    await screen.findByTestId("remote-run-local-activity");
    expect(screen.queryByTestId("remote-run-local-coexistence")).toBeNull();
    await waitFor(() => expect(getActivity).toHaveBeenCalledExactlyOnceWith(canvas));
    getActivity.mockResolvedValueOnce(activity([initialBlock.ref]));
    await act(async () => {
      notify();
      notify();
    });
    expect(getActivity).toHaveBeenCalledTimes(1);
    await act(async () => pendingInitial.resolve(activity([])));
    await screen.findByTestId("remote-run-local-coexistence");
    expect(getActivity).toHaveBeenCalledTimes(2);

    await act(async () => {
      notify({ ...scope, projectId: "different-project" });
      notify({ ...scope, canvasKey: "canvases/other/state.json" });
    });
    expect(getActivity).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("remote-run-local-coexistence")).toBeTruthy();

    getActivity.mockResolvedValueOnce(activity([]));
    await act(async () => notify());
    expect(screen.queryByTestId("remote-run-local-coexistence")).toBeNull();

    const newScope = { projectId: "P-002", canvasKey: "canvases/canvas-other/state.json" };
    getActivity
      .mockReturnValueOnce(pendingOldRefresh.promise)
      .mockRejectedValueOnce(new Error("Workspace activity read failed"))
      .mockResolvedValue({ scope: newScope, activeBlockRefs: [nextRef] });
    await act(async () => notify());
    navigate("/tmp/other", "canvas-other", nextRef);
    rerender(<BlockInspectorWindow />);
    await screen.findByDisplayValue(nextRef);
    await screen.findByText("Could not check local Auto Run activity. Refresh to try again.");
    await act(async () => pendingOldRefresh.resolve(activity([nextRef])));
    expect(getActivity).toHaveBeenLastCalledWith({
      projectRoot: "/tmp/other",
      canvasId: "canvas-other"
    });
    expect(screen.queryByTestId("remote-run-local-coexistence")).toBeNull();
    await act(async () => notify(newScope));
    await screen.findByTestId("remote-run-local-coexistence");
    expect(screen.queryByTestId("remote-run-local-activity")).toBeNull();
  });

  it("does not commit a task auto-refresh result after the draft becomes dirty", async () => {
    const pendingGraph = deferred<DesktopGraphViewModel>();
    const pendingTask = deferred<DesktopTaskDetail>();
    let onAutoRunChangedCallback: ((event: DesktopAutoRunEvent) => void) | null = null;
    const bridge = createDesktopBridgeMock({
      getGraphViewModel: vi
        .fn()
        .mockResolvedValueOnce(graph)
        .mockReturnValueOnce(pendingGraph.promise),
      getTaskDetail: vi
        .fn()
        .mockResolvedValueOnce(initialTask)
        .mockReturnValueOnce(pendingTask.promise),
      onAutoRunChanged: vi.fn((callback: (event: DesktopAutoRunEvent) => void) => {
        onAutoRunChangedCallback = callback;
        return () => undefined;
      })
    });
    window.history.pushState(
      {},
      "",
      "/?projectRoot=%2Ftmp%2Fdemo&taskId=T-ALPHA&canvasId=canvas-main&language=en"
    );
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
    const eventState: DesktopAutoRunState = {
      ...eventStateBase,
      explanation: explanationFor(eventStateBase)
    };

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
      updateTaskPrompt: vi
        .fn()
        .mockResolvedValue({ ok: true, graphVersion: "pgv-task-next", diagnostics: [] }),
      onAutoRunChanged: vi.fn(() => () => undefined)
    });
    window.history.pushState(
      {},
      "",
      "/?projectRoot=%2Ftmp%2Fdemo&taskId=T-ALPHA&canvasId=canvas-main&language=en"
    );
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { TaskInspectorWindow } = await import("../renderer/TaskInspectorWindow");

    render(<TaskInspectorWindow />);
    await waitFor(() => expect(screen.getByDisplayValue("# Initial")).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue("# Initial"), {
      target: { value: "# Local task prompt" }
    });

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
      updateBlockPrompt: vi
        .fn()
        .mockResolvedValue({ ok: true, graphVersion: "pgv-block-next", diagnostics: [] }),
      onAutoRunChanged: vi.fn(() => () => undefined)
    });
    window.history.pushState(
      {},
      "",
      "/?projectRoot=%2Ftmp%2Fdemo&blockRef=T-ALPHA%23B-001&canvasId=canvas-main&language=en"
    );
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

  it("limits block terminal availability checks to selected and latest tmux candidate records", async () => {
    const blockRunRecords: DesktopBlockRunRecordSummary[] = Array.from(
      { length: 130 },
      (_value, index) => {
        const hasTmuxSession = index >= 70;
        return {
          recordId: `T-ALPHA#B-001::RUN-${index}`,
          ref: "T-ALPHA#B-001",
          taskId: "T-ALPHA",
          blockId: "B-001",
          runId: `RUN-${index}`,
          executor: "codex",
          adapter: "codex-exec",
          executionCwd: "/tmp/demo",
          projectRoot: "/tmp/demo",
          agentSessionId: null,
          codexSessionId: null,
          tmuxSessionId: hasTmuxSession ? `planweave-T-ALPHA-B-001-RUN-${index}` : null,
          tmuxAttachCommand: hasTmuxSession
            ? `tmux attach-session -t planweave-T-ALPHA-B-001-RUN-${index}`
            : null,
          tmuxReadOnlyAttachCommand: hasTmuxSession
            ? `tmux attach-session -r -t planweave-T-ALPHA-B-001-RUN-${index}`
            : null,
          exitCode: 0,
          startedAt: "2026-05-23T00:00:00.000Z",
          finishedAt: "2026-05-23T00:01:00.000Z",
          promptPath: null,
          reportPath: null,
          metadataPath: `/tmp/demo/.planweave/results/T-ALPHA/blocks/B-001/runs/RUN-${index}/metadata.json`,
          stdoutSummary: "",
          stderrSummary: ""
        };
      }
    );
    const selectedRunRecord: DesktopRunRecord = {
      recordId: "T-ALPHA#B-001::RUN-0",
      ref: "T-ALPHA#B-001",
      taskId: "T-ALPHA",
      blockId: "B-001",
      runId: "RUN-0",
      executor: "codex",
      adapter: "codex-exec",
      executionCwd: "/tmp/demo",
      projectRoot: "/tmp/demo",
      agentSessionId: null,
      codexSessionId: null,
      tmuxSessionId: null,
      tmuxAttachCommand: null,
      tmuxReadOnlyAttachCommand: null,
      exitCode: 0,
      startedAt: "2026-05-23T00:00:00.000Z",
      finishedAt: "2026-05-23T00:01:00.000Z",
      promptPath: null,
      reportPath: null,
      metadataPath: "/tmp/demo/.planweave/results/T-ALPHA/blocks/B-001/runs/RUN-0/metadata.json",
      stdoutSummary: "",
      stderrSummary: "",
      promptMarkdown: "",
      reportMarkdown: "",
      displayMarkdown: "",
      displayMarkdownSource: "none",
      metadata: {}
    };
    const getRunTerminalAvailability = vi.fn().mockResolvedValue([]);
    const bridge = createDesktopBridgeMock({
      getGraphViewModel: vi.fn().mockResolvedValue(graph),
      getBlockDetail: vi.fn().mockResolvedValue(initialBlock),
      getRunRecord: vi.fn().mockResolvedValue(selectedRunRecord),
      listBlockRunRecords: vi.fn().mockResolvedValue(blockRunRecords),
      getReviewAttempts: vi.fn().mockResolvedValue([]),
      getFeedbackRecords: vi.fn().mockResolvedValue([]),
      getRunTerminalAvailability,
      onAutoRunChanged: vi.fn(() => () => undefined)
    });
    window.history.pushState(
      {},
      "",
      "/?projectRoot=%2Ftmp%2Fdemo&blockRef=T-ALPHA%23B-001&canvasId=canvas-main&language=en"
    );
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { BlockInspectorWindow } = await import("../renderer/BlockInspectorWindow");

    render(<BlockInspectorWindow />);

    await waitFor(() => expect(getRunTerminalAvailability).toHaveBeenCalled());
    expect(getRunTerminalAvailability).toHaveBeenCalledWith({
      ref: { projectRoot: "/tmp/demo", canvasId: "canvas-main" },
      recordIds: Array.from({ length: 50 }, (_value, offset) => `T-ALPHA#B-001::RUN-${offset + 70}`)
    });

    fireEvent.click(screen.getByRole("button", { name: /Latest run/ }));
    await waitFor(() => expect(getRunTerminalAvailability).toHaveBeenCalledTimes(2));
    expect(getRunTerminalAvailability).toHaveBeenLastCalledWith({
      ref: { projectRoot: "/tmp/demo", canvasId: "canvas-main" },
      recordIds: [
        "T-ALPHA#B-001::RUN-0",
        ...Array.from({ length: 50 }, (_value, offset) => `T-ALPHA#B-001::RUN-${offset + 70}`)
      ]
    });
  });
});
