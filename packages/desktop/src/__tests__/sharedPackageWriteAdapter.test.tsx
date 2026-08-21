/* @vitest-environment jsdom */

/**
 * Regression: while shared canvas is connected, inspector/prompt/executor/
 * review-pipeline/reset-layout paths must not invoke local package writers.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { createTranslator } from "../renderer/i18n";
import type { AppFlowNode, DesktopUiSettings } from "../renderer/types";
import { layout, project } from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import type { SharedCanvasCommandsResult } from "../renderer/hooks/useSharedCanvasCommands";

afterEach(cleanupRendererTestEnvironment);

function sharedCanvasMock(
  submit: SharedCanvasCommandsResult["submit"] = vi.fn().mockResolvedValue({
    ok: true,
    error: null,
    staleConflict: null
  })
): SharedCanvasCommandsResult {
  return {
    enabled: true,
    authorityMode: "shared",
    snapshot: {
      session: {
        canvasId: "canvas-main",
        revision: 1,
        contentDigest: "a".repeat(64),
        lastOperationId: null,
        lastJournalEntryId: null,
        pendingOperationId: null,
        lastConflict: null,
        lastRejectCode: null
      },
      lastError: null,
      lastStaleConflict: null,
      busy: false
    },
    submit,
    reconnect: vi.fn().mockResolvedValue(true)
  };
}

const paletteSettings = {
  defaultExecutor: "",
  palette: {
    defaultBlockSet: ["implementation"],
    dragHint: true,
    visible: { task: true, implementation: true, review: true }
  }
} as unknown as DesktopUiSettings;

describe("shared-mode package write gate", () => {
  it("routes prompt/title saves through shared intents and skips bridge writers", async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true, error: null, staleConflict: null });
    const bridge = createDesktopBridgeMock({
      updateTaskTitle: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] }),
      updateTaskPrompt: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePromptDrafts } = await import("../renderer/hooks/usePromptDrafts");
    const refreshGraph = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      usePromptDrafts({
        graph,
        refreshGraph,
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn(),
        sharedCanvas: sharedCanvasMock(submit)
      })
    );

    await act(async () => {
      await result.current.handleTitleSave("T-ALPHA");
    });
    await act(async () => {
      result.current.handlePromptChange("T-ALPHA", "# Shared prompt\n");
      await result.current.handlePromptSave("T-ALPHA");
    });

    expect(bridge.updateTaskTitle).not.toHaveBeenCalled();
    expect(bridge.updateTaskPrompt).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalled();
    expect(submit.mock.calls.some((call) => call[0].intent.kind === "update_task_fields")).toBe(
      true
    );
    expect(submit.mock.calls.some((call) => call[0].intent.kind === "update_task_prompt")).toBe(
      true
    );
  });

  it("routes selected-block field writes through shared intents", async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true, error: null, staleConflict: null });
    const bridge = createDesktopBridgeMock({
      updateBlockTitle: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] }),
      updateBlockExecutor: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] }),
      updateBlockPrompt: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] }),
      getBlockDetail: vi.fn().mockResolvedValue({
        ref: "T-ALPHA#B-001",
        taskId: "T-ALPHA",
        blockId: "B-001",
        type: "implementation",
        title: "Block",
        status: "ready",
        executor: null,
        effectiveExecutor: null,
        promptMarkdown: "# Block\n",
        promptHash: "hash",
        graphVersion: "pgv",
        promptMissing: false,
        promptSurfaceMarkdown: "# Block\n",
        promptSources: [],
        dependencies: [],
        latestRunId: null,
        latestReviewAttemptId: null,
        activeFeedbackId: null,
        exceptionReason: null,
        reviewGate: null
      })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useSelectedBlock } = await import("../renderer/hooks/useSelectedBlock");
    const { result } = renderHook(() =>
      useSelectedBlock({
        refreshGraph: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setActiveView: vi.fn(),
        setError: vi.fn(),
        sharedCanvas: sharedCanvasMock(submit)
      })
    );

    act(() => {
      result.current.setSelectedBlock({
        ref: "T-ALPHA#B-001",
        taskId: "T-ALPHA",
        blockId: "B-001",
        type: "implementation",
        title: "Block title",
        status: "ready",
        executor: null,
        effectiveExecutor: null,
        promptMarkdown: "# Block prompt\n",
        promptHash: "hash",
        graphVersion: "pgv",
        promptMissing: false,
        promptSurfaceMarkdown: "# Block prompt\n",
        promptSources: [],
        dependencies: [],
        latestRunId: null,
        latestReviewAttemptId: null,
        activeFeedbackId: null,
        exceptionReason: null,
        reviewGate: null
      });
    });

    await act(async () => {
      await result.current.saveSelectedBlockTitle();
      await result.current.saveSelectedBlockPrompt();
    });

    expect(bridge.updateBlockTitle).not.toHaveBeenCalled();
    expect(bridge.updateBlockPrompt).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("routes task executor changes through shared intents", async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true, error: null, staleConflict: null });
    const bridge = createDesktopBridgeMock({
      updateTaskExecutor: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useTaskExecutorActions } = await import("../renderer/hooks/useTaskExecutorActions");
    const { result } = renderHook(() =>
      useTaskExecutorActions({
        refreshGraph: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn(),
        sharedCanvas: sharedCanvasMock(submit)
      })
    );

    await act(async () => {
      await result.current.handleTaskExecutorChange("T-ALPHA", "codex");
    });

    expect(bridge.updateTaskExecutor).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith({
      intent: {
        kind: "update_task_fields",
        taskId: "T-ALPHA",
        fields: { executor: "codex" }
      }
    });
  });

  it("refuses review-pipeline local writes while shared is enabled", async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true, error: null, staleConflict: null });
    const bridge = createDesktopBridgeMock({
      updateReviewPipeline: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] }),
      getReviewPipeline: vi.fn().mockResolvedValue(null)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useReviewPipeline } = await import("../renderer/hooks/useReviewPipeline");
    const setError = vi.fn();
    const { result } = renderHook(() =>
      useReviewPipeline({
        graph,
        reloadCurrentCanvas: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError,
        t: createTranslator("en"),
        sharedCanvas: sharedCanvasMock(submit)
      })
    );

    await act(async () => {
      result.current.setReviewTaskId("T-ALPHA");
      await result.current.saveReviewPipeline();
    });

    expect(bridge.updateReviewPipeline).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("routes resetLayout through update_layout and skips resetDesktopLayout", async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true, error: null, staleConflict: null });
    const bridge = createDesktopBridgeMock({
      resetDesktopLayout: vi.fn().mockResolvedValue(layout)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useGraphPaletteActions } = await import("../renderer/hooks/useGraphPaletteActions");
    const setLayout = vi.fn();
    const { result } = renderHook(() =>
      useGraphPaletteActions({
        flowInstance: null,
        graph,
        layout,
        loadProject: vi.fn().mockResolvedValue(undefined),
        nodes: [
          { id: "T-ALPHA", position: { x: 1, y: 2 } },
          { id: "T-BETA", position: { x: 3, y: 4 } }
        ] as AppFlowNode[],
        refreshProjectDerivedState: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedBlock: null,
        selectedProject: project,
        selectedTaskPanelId: null,
        setError: vi.fn(),
        setLayout,
        selectTaskPanel: vi.fn(),
        settings: paletteSettings,
        t: createTranslator("en"),
        sharedCanvas: sharedCanvasMock(submit)
      })
    );

    await act(async () => {
      await result.current.resetLayout();
    });

    expect(bridge.resetDesktopLayout).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith({
      intent: expect.objectContaining({ kind: "update_layout" })
    });
    expect(setLayout).toHaveBeenCalled();
  });

  it("routes task-workspace prompt/executor writes through shared intents", async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true, error: null, staleConflict: null });
    const updateTaskPrompt = vi.fn().mockResolvedValue({ ok: true, diagnostics: [] });
    const updateTaskExecutor = vi.fn().mockResolvedValue({ ok: true, diagnostics: [] });
    const updateBlockPrompt = vi.fn().mockResolvedValue({ ok: true, diagnostics: [] });
    const updateBlockExecutor = vi.fn().mockResolvedValue({ ok: true, diagnostics: [] });
    const api = {
      getTaskDetail: vi.fn().mockResolvedValue({
        taskId: "T-ALPHA",
        title: "Alpha",
        promptMarkdown: "# base\n",
        graphVersion: "pgv",
        promptHash: "hash"
      }),
      getBlockDetail: vi.fn().mockResolvedValue({
        ref: "T-ALPHA#B-001",
        taskId: "T-ALPHA",
        promptMarkdown: "# block base\n",
        graphVersion: "pgv",
        promptHash: "hash"
      }),
      updateTaskPrompt,
      updateTaskExecutor,
      updateBlockPrompt,
      updateBlockExecutor
    };
    const { useTaskWorkspaceExecutorActions } = await import(
      "../renderer/task-workspace/useTaskWorkspaceExecutorActions"
    );
    const { result } = renderHook(() =>
      useTaskWorkspaceExecutorActions({
        api: api as never,
        navigation: {
          projectRoot: project.rootPath,
          canvasId: "canvas-main",
          taskId: "T-ALPHA"
        },
        onSaved: vi.fn(),
        sharedCanvas: sharedCanvasMock(submit)
      })
    );

    await act(async () => {
      await result.current.saveTaskExecutor("codex");
      await result.current.saveBlockExecutor("T-ALPHA#B-001", "codex");
    });

    expect(updateTaskExecutor).not.toHaveBeenCalled();
    expect(updateBlockExecutor).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(2);
  });
});
