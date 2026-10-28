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
import { deferred } from "./helpers/desktopProjectFixtures";

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
    workspaceRoot: project.workspaceRoot,
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("selected block hook selection", () => {
  it("keeps the latest foreground block and navigation when the earlier selection finishes last", async () => {
    let finishAlpha!: (block: DesktopBlockDetail) => void;
    const alpha = new Promise<DesktopBlockDetail>((resolve) => {
      finishAlpha = resolve;
    });
    const beta = { ...blockDetail, ref: "T-BETA#B-001", taskId: "T-BETA", title: "Beta" };
    const betaRecords = [
      { ...runRecordSummary, ref: beta.ref, taskId: beta.taskId, recordId: `${beta.ref}::RUN-001` }
    ];
    const bridge = createDesktopBridgeMock({
      getBlockDetail: vi.fn((_canvas, ref) =>
        ref === blockDetail.ref ? alpha : Promise.resolve(beta)
      ),
      listBlockRunRecords: vi.fn((_canvas, ref) =>
        Promise.resolve(ref === beta.ref ? betaRecords : [runRecordSummary])
      ),
      getFeedbackRecords: vi.fn().mockResolvedValue([]),
      getReviewAttempts: vi.fn().mockResolvedValue([])
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useSelectedBlock } = await import("../renderer/hooks/useSelectedBlock");
    const setActiveView = vi.fn();
    const { result } = renderHook(() =>
      useSelectedBlock({
        captureSelectionScope: () => ({ isCurrent: () => true }),
        refreshGraph: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setActiveView,
        setError: vi.fn()
      })
    );
    let earlier!: ReturnType<typeof result.current.handleBlockSelect>;
    act(() => {
      earlier = result.current.handleBlockSelect(blockDetail.ref);
    });
    await act(async () => {
      await result.current.handleBlockSelect(beta.ref);
    });
    expect(result.current.selectedBlock).toEqual(beta);
    let stale: Awaited<typeof earlier>;
    await act(async () => {
      finishAlpha(blockDetail);
      stale = await earlier;
    });
    expect(result.current.selectedBlock).toEqual(beta);
    expect(result.current.blockRunRecords).toEqual(betaRecords);
    expect(stale).toBeUndefined();
    expect(setActiveView).toHaveBeenCalledTimes(1);
  });

  it("preserves newer prompt and title edits when a saved prompt detail read finishes", async () => {
    let finishDetail!: (block: DesktopBlockDetail) => void;
    const detail = new Promise<DesktopBlockDetail>((resolve) => {
      finishDetail = resolve;
    });
    const bridge = createDesktopBridgeMock({
      getBlockDetail: vi.fn(() => detail),
      updateBlockPrompt: vi
        .fn()
        .mockResolvedValue({ ok: true, affectedTasks: [blockDetail.taskId], diagnostics: [] })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useSelectedBlock } = await import("../renderer/hooks/useSelectedBlock");
    const refreshGraph = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useSelectedBlock({
        captureSelectionScope: () => ({ isCurrent: () => true }),
        refreshGraph,
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setActiveView: vi.fn(),
        setError: vi.fn()
      })
    );
    act(() => {
      result.current.setSelectedBlock(blockDetail);
    });
    let saving!: ReturnType<typeof result.current.saveSelectedBlockPrompt>;
    await act(async () => {
      saving = result.current.saveSelectedBlockPrompt();
    });
    expect(bridge.getBlockDetail).toHaveBeenCalledOnce();
    act(() => {
      result.current.setSelectedBlock(
        (current) => current && { ...current, title: "New title", promptMarkdown: "# New draft" }
      );
    });
    await act(async () => {
      finishDetail({ ...blockDetail, graphVersion: "saved-version", promptHash: "saved-hash" });
      await saving;
    });
    expect(result.current.selectedBlock).toMatchObject({
      title: "New title",
      promptMarkdown: "# New draft",
      graphVersion: "saved-version",
      promptHash: "saved-hash"
    });
    expect(refreshGraph).toHaveBeenCalledOnce();
  });

  it("restores a delayed block selection without navigating while direct selection opens graph", async () => {
    let resolveBlockDetail!: (block: DesktopBlockDetail) => void;
    const delayedBlockDetail = new Promise<DesktopBlockDetail>((resolve) => {
      resolveBlockDetail = resolve;
    });
    const bridge = createDesktopBridgeMock({
      getBlockDetail: vi
        .fn()
        .mockImplementationOnce(() => delayedBlockDetail)
        .mockResolvedValue(blockDetail),
      getFeedbackRecords: vi.fn().mockResolvedValue([]),
      getReviewAttempts: vi.fn().mockResolvedValue([]),
      getRunRecord: vi.fn().mockResolvedValue(runRecord()),
      listBlockRunRecords: vi.fn().mockResolvedValue([runRecordSummary])
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useSelectedBlock } = await import("../renderer/hooks/useSelectedBlock");
    const setActiveView = vi.fn();

    const { result } = renderHook(() =>
      useSelectedBlock({
        captureSelectionScope: () => ({ isCurrent: () => true }),
        refreshGraph: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setActiveView,
        setError: vi.fn()
      })
    );

    await act(async () => {
      await result.current.handleOpenRunRecord(runRecordSummary.recordId);
    });
    expect(result.current.selectedRunRecord).toEqual(runRecord());

    let restorePromise: ReturnType<typeof result.current.restoreBlockSelection> | undefined;
    act(() => {
      restorePromise = result.current.restoreBlockSelection(blockDetail.ref);
    });
    expect(setActiveView).not.toHaveBeenCalled();

    await act(async () => {
      resolveBlockDetail(blockDetail);
      await restorePromise;
    });
    expect(result.current.selectedBlock).toEqual(blockDetail);
    expect(result.current.blockRunRecords).toEqual([runRecordSummary]);
    expect(result.current.selectedRunRecord).toBeNull();
    expect(setActiveView).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.handleBlockSelect(blockDetail.ref);
    });
    expect(setActiveView).toHaveBeenCalledOnce();
    expect(setActiveView).toHaveBeenCalledWith("graph");
  });
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
      getRunRecord: vi
        .fn()
        .mockResolvedValueOnce(runRecord())
        .mockResolvedValueOnce(refreshedRecord),
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
        captureSelectionScope: () => ({ isCurrent: () => true }),
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
    const eventState: DesktopAutoRunState = {
      ...eventStateBase,
      explanation: explanationFor(eventStateBase)
    };

    await act(async () => {
      onAutoRunChangedCallback?.(autoRunEvent(eventState));
    });

    await waitFor(() => expect(result.current.selectedRunRecord).toEqual(refreshedRecord));
    expect(bridge.getRunRecord).toHaveBeenCalledTimes(2);
    expect(bridge.listBlockRunRecords).toHaveBeenCalledTimes(2);
    expect(refreshGraph).not.toHaveBeenCalled();
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
      listBlockRunRecords: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([newRecordSummary]),
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
        captureSelectionScope: () => ({ isCurrent: () => true }),
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
    const eventState: DesktopAutoRunState = {
      ...eventStateBase,
      explanation: explanationFor(eventStateBase)
    };

    await act(async () => {
      onAutoRunChangedCallback?.(autoRunEvent(eventState));
    });

    await waitFor(() => expect(result.current.blockRunRecords).toEqual([newRecordSummary]));
    expect(bridge.listBlockRunRecords).toHaveBeenCalledTimes(2);
    expect(refreshGraph).not.toHaveBeenCalled();
  });
});

describe("selected block asynchronous ownership", () => {
  const beta: DesktopBlockDetail = {
    ...blockDetail,
    ref: "T-BETA#B-001",
    taskId: "T-BETA",
    title: "Beta"
  };

  async function setup(overrides: Parameters<typeof createDesktopBridgeMock>[0] = {}) {
    const callbacks = new Set<(event: DesktopAutoRunEvent) => void>();
    const bridge = createDesktopBridgeMock({
      getBlockDetail: vi.fn((_canvas, ref) =>
        Promise.resolve(ref === beta.ref ? beta : blockDetail)
      ),
      listBlockRunRecords: vi.fn().mockResolvedValue([runRecordSummary]),
      getReviewAttempts: vi.fn().mockResolvedValue([]),
      getFeedbackRecords: vi.fn().mockResolvedValue([]),
      getRunRecord: vi.fn().mockResolvedValue(runRecord()),
      onAutoRunChanged: vi.fn((callback) => {
        callbacks.add(callback);
        return () => {
          callbacks.delete(callback);
        };
      }),
      ...overrides
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useSelectedBlock } = await import("../renderer/hooks/useSelectedBlock");
    const setError = vi.fn();
    const setActiveView = vi.fn();
    const refreshGraph = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(
      ({ selectedProject, canvasId }) =>
        useSelectedBlock({
          captureSelectionScope: () => ({ isCurrent: () => true }),
          selectedProject,
          selectedCanvasId: canvasId,
          refreshGraph,
          setActiveView,
          setError
        }),
      { initialProps: { selectedProject: project, canvasId: "canvas-main" } }
    );
    let lastEvent: DesktopAutoRunEvent | undefined;
    const emit = () => {
      const stateBase = {
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
      lastEvent = autoRunEvent({ ...stateBase, explanation: explanationFor(stateBase) });
      for (const callback of callbacks) callback(lastEvent);
    };
    return {
      ...hook,
      bridge,
      setError,
      setActiveView,
      refreshGraph,
      emit,
      callbacks,
      getLastEvent: () => lastEvent!
    };
  }

  it.each([
    "resolve",
    "reject"
  ] as const)("keeps a cleared selection empty when a pending selection %s", async (completion) => {
    const pending = deferred<DesktopBlockDetail>();
    const { result, setActiveView, setError } = await setup({
      getBlockDetail: vi.fn(() => pending.promise)
    });
    let selecting!: ReturnType<typeof result.current.handleBlockSelect>;
    act(() => {
      selecting = result.current.handleBlockSelect(blockDetail.ref);
    });
    act(() => {
      result.current.setSelectedBlock(null);
    });
    await act(async () => {
      if (completion === "resolve") pending.resolve(blockDetail);
      else pending.reject(new Error("cleared selection failed"));
      expect(await selecting).toBeUndefined();
    });
    expect(result.current.selectedBlock).toBeNull();
    expect(result.current.blockRunRecords).toEqual([]);
    expect(setActiveView).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it.each([
    {
      boundary: "project",
      selectedProject: { ...project, projectId: "P-002", rootPath: "/tmp/other" },
      canvasId: "canvas-main"
    },
    {
      boundary: "same project ID with another workspace",
      selectedProject: { ...project, workspaceRoot: "/tmp/reopened" },
      canvasId: "canvas-main"
    },
    { boundary: "canvas", selectedProject: project, canvasId: "canvas-next" }
  ])("retires pending reads across $boundary changes", async ({ selectedProject, canvasId }) => {
    const pending = deferred<DesktopBlockDetail>();
    const { result, rerender, setError, setActiveView } = await setup({
      getBlockDetail: vi
        .fn()
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValue(beta)
    });
    let selecting!: ReturnType<typeof result.current.handleBlockSelect>;
    act(() => {
      selecting = result.current.handleBlockSelect(blockDetail.ref);
    });
    rerender({ selectedProject, canvasId });
    await act(async () => {
      await result.current.handleBlockSelect(beta.ref);
    });
    await act(async () => {
      pending.resolve(blockDetail);
      expect(await selecting).toBeUndefined();
    });
    expect(result.current.selectedBlock).toEqual(beta);
    expect(setActiveView).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
  });

  it("keeps an explicit canvas override for selection, history and prompt writes", async () => {
    const { result, bridge } = await setup({
      updateBlockPrompt: vi.fn().mockResolvedValue({ ok: true, affectedTasks: [], diagnostics: [] })
    });
    await act(async () => {
      await result.current.handleBlockSelect(blockDetail.ref, "canvas-override");
    });
    await act(async () => {
      await result.current.handleOpenRunRecord(runRecordSummary.recordId);
    });
    await act(async () => {
      await result.current.saveSelectedBlockPrompt();
    });
    const canvas = { projectRoot: project.rootPath, canvasId: "canvas-override" };
    expect(bridge.getBlockDetail).toHaveBeenCalledWith(canvas, blockDetail.ref);
    expect(bridge.listBlockRunRecords).toHaveBeenCalledWith(canvas, blockDetail.ref);
    expect(bridge.getRunRecord).toHaveBeenCalledWith(canvas, runRecordSummary.recordId);
    expect(bridge.updateBlockPrompt).toHaveBeenCalledWith(
      canvas,
      blockDetail.ref,
      blockDetail.promptMarkdown,
      expect.any(Object)
    );
    expect(result.current.selectedBlock).toEqual(blockDetail);
  });

  it.each([
    "background-first",
    "foreground-first"
  ] as const)("does not let a background refresh supersede a new selection (%s)", async (order) => {
    const background = deferred<DesktopBlockDetail>();
    const foreground = deferred<DesktopBlockDetail>();
    const betaRecord = {
      ...runRecordSummary,
      ref: beta.ref,
      taskId: beta.taskId,
      recordId: `${beta.ref}::RUN-002`
    };
    const { result, bridge, emit } = await setup({
      listBlockRunRecords: vi.fn((_canvas, ref) =>
        Promise.resolve([ref === beta.ref ? betaRecord : runRecordSummary])
      ),
      getBlockDetail: vi
        .fn()
        .mockResolvedValueOnce(blockDetail)
        .mockImplementationOnce(() => background.promise)
        .mockImplementationOnce(() => foreground.promise)
    });
    await act(async () => {
      await result.current.handleBlockSelect(blockDetail.ref);
    });
    act(emit);
    expect(bridge.getBlockDetail).toHaveBeenCalledTimes(2);
    let selecting!: ReturnType<typeof result.current.handleBlockSelect>;
    act(() => {
      selecting = result.current.handleBlockSelect(beta.ref);
    });
    const finishBackground = async () => {
      await act(async () => {
        background.resolve({ ...blockDetail, title: "Background alpha" });
        await background.promise;
      });
    };
    const finishForeground = async () => {
      await act(async () => {
        foreground.resolve(beta);
        await selecting;
      });
    };
    if (order === "background-first") {
      await finishBackground();
      await finishForeground();
    } else {
      await finishForeground();
      await finishBackground();
    }
    expect(result.current.selectedBlock).toEqual(beta);
    expect(result.current.blockRunRecords).toEqual([betaRecord]);
  });

  it("keeps an adopted Block refreshable on its own canvas after an override source is retired", async () => {
    const pending = deferred<DesktopBlockDetail>();
    const refreshed = { ...blockDetail, title: "Current refreshed" };
    const { result, bridge, emit, setError } = await setup({
      getBlockDetail: vi
        .fn()
        .mockResolvedValueOnce(blockDetail)
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValue(refreshed)
    });
    await act(async () => {
      await result.current.handleBlockSelect(blockDetail.ref);
      await result.current.handleOpenRunRecord(runRecordSummary.recordId);
    });
    let sourceCurrent = true;
    let restoring!: ReturnType<typeof result.current.restoreBlockSelection>;
    act(() => {
      restoring = result.current.restoreBlockSelection(beta.ref, "canvas-override", {
        isCurrent: () => sourceCurrent
      });
    });
    sourceCurrent = false;
    await act(async () => {
      pending.resolve(beta);
      expect(await restoring).toBeUndefined();
    });
    expect(result.current.selectedBlock).toEqual(blockDetail);
    expect(result.current.selectedRunRecord).toEqual(runRecord());
    act(emit);
    await waitFor(() => expect(result.current.selectedBlock).toEqual(refreshed));
    expect(bridge.getBlockDetail).toHaveBeenLastCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      blockDetail.ref
    );
    expect(result.current.selectedRunRecord).toEqual(runRecord());
    expect(setError).not.toHaveBeenCalled();
  });

  it("preserves record-only clearing while retaining the selected block and opened history", async () => {
    const pending = deferred<DesktopBlockRunRecordSummary[]>();
    const { result, emit } = await setup({
      listBlockRunRecords: vi
        .fn()
        .mockResolvedValueOnce([runRecordSummary])
        .mockImplementationOnce(() => pending.promise)
    });
    await act(async () => {
      await result.current.handleBlockSelect(blockDetail.ref);
      await result.current.handleOpenRunRecord(runRecordSummary.recordId);
    });
    act(emit);
    act(() => {
      result.current.clearSelectedBlockRecords();
    });
    await act(async () => {
      pending.resolve([runRecordSummary]);
      await pending.promise;
    });
    expect(result.current.blockRunRecords).toEqual([]);
    expect(result.current.selectedBlock).toEqual(blockDetail);
    expect(result.current.selectedRunRecord).toEqual(runRecord());
  });

  it.each([
    "resolve",
    "reject"
  ] as const)("keeps a newer run record after an older read %s", async (completion) => {
    const pending = deferred<DesktopRunRecord>();
    const newer = runRecord({
      recordId: `${blockDetail.ref}::RUN-002`,
      reportMarkdown: "New history"
    });
    const { result, setError } = await setup({
      getRunRecord: vi
        .fn()
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValue(newer)
    });
    await act(async () => {
      await result.current.handleBlockSelect(blockDetail.ref);
    });
    let opening!: Promise<void>;
    act(() => {
      opening = result.current.handleOpenRunRecord(runRecordSummary.recordId);
    });
    await act(async () => {
      await result.current.handleOpenRunRecord(newer.recordId);
    });
    await act(async () => {
      if (completion === "resolve") pending.resolve(runRecord());
      else pending.reject(new Error("old history failure"));
      await opening;
    });
    expect(result.current.selectedRunRecord).toEqual(newer);
    expect(setError).not.toHaveBeenCalled();
  });

  it("ignores Auto Run completions and retained callbacks after a scope change", async () => {
    const detail = deferred<DesktopBlockDetail>();
    const history = deferred<DesktopRunRecord>();
    const { result, rerender, bridge, emit, callbacks, getLastEvent, setError } = await setup({
      getBlockDetail: vi
        .fn()
        .mockResolvedValueOnce(blockDetail)
        .mockImplementationOnce(() => detail.promise)
        .mockResolvedValue(beta),
      getRunRecord: vi
        .fn()
        .mockResolvedValueOnce(runRecord())
        .mockImplementationOnce(() => history.promise)
    });
    await act(async () => {
      await result.current.handleBlockSelect(blockDetail.ref);
      await result.current.handleOpenRunRecord(runRecordSummary.recordId);
    });
    const retained = [...callbacks];
    act(emit);
    expect(bridge.getRunRecord).toHaveBeenCalledTimes(2);
    rerender({
      selectedProject: { ...project, workspaceRoot: "/tmp/other-workspace" },
      canvasId: "canvas-main"
    });
    await act(async () => {
      await result.current.handleBlockSelect(beta.ref);
    });
    await act(async () => {
      detail.resolve({ ...blockDetail, title: "Stale refreshed alpha" });
      history.reject(new Error("stale Auto Run history"));
      await Promise.allSettled([detail.promise, history.promise]);
    });
    const detailCalls = vi.mocked(bridge.getBlockDetail).mock.calls.length;
    // A queued callback may already have escaped subscription cleanup.
    const state = getLastEvent();
    act(() => {
      for (const callback of retained) callback(state);
    });
    expect(bridge.getBlockDetail).toHaveBeenCalledTimes(detailCalls);
    expect(result.current.selectedBlock).toEqual(beta);
    expect(result.current.selectedRunRecord).toBeNull();
    expect(setError).not.toHaveBeenCalled();
  });

  it("retires pending success and failure continuations when unmounted", async () => {
    const detail = deferred<DesktopBlockDetail>();
    const history = deferred<DesktopRunRecord>();
    const { result, unmount, setActiveView, setError } = await setup({
      getBlockDetail: vi.fn(() => detail.promise),
      getRunRecord: vi.fn(() => history.promise)
    });
    let selecting!: ReturnType<typeof result.current.handleBlockSelect>;
    let opening!: Promise<void>;
    act(() => {
      selecting = result.current.handleBlockSelect(blockDetail.ref);
      opening = result.current.handleOpenRunRecord(runRecordSummary.recordId);
    });
    unmount();
    await act(async () => {
      detail.resolve(blockDetail);
      history.reject(new Error("unmounted history"));
      expect(await selecting).toBeUndefined();
      await opening;
    });
    expect(setActiveView).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("keeps a new block draft when a previous prompt save detail returns", async () => {
    const detail = deferred<DesktopBlockDetail>();
    const { result, refreshGraph } = await setup({
      getBlockDetail: vi
        .fn()
        .mockResolvedValueOnce(blockDetail)
        .mockImplementationOnce(() => detail.promise)
        .mockResolvedValue(beta),
      updateBlockPrompt: vi.fn().mockResolvedValue({ ok: true, affectedTasks: [], diagnostics: [] })
    });
    await act(async () => {
      await result.current.handleBlockSelect(blockDetail.ref);
    });
    let saving!: Promise<void>;
    await act(async () => {
      saving = result.current.saveSelectedBlockPrompt();
    });
    await act(async () => {
      await result.current.handleBlockSelect(beta.ref);
    });
    act(() => {
      result.current.setSelectedBlock(
        (current) => current && { ...current, promptMarkdown: "# Beta draft" }
      );
    });
    await act(async () => {
      detail.resolve({ ...blockDetail, promptHash: "saved-alpha" });
      await saving;
    });
    expect(result.current.selectedBlock).toEqual({ ...beta, promptMarkdown: "# Beta draft" });
    expect(refreshGraph).not.toHaveBeenCalled();
  });
});
