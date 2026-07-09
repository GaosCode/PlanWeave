/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import type { DesktopBlockDetail } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { project } from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

describe("desktop renderer hook interfaces", () => {
  it("stops prompt autosave when a dirty draft conflicts with an external prompt change", async () => {
    vi.useFakeTimers();
    const bridge = createDesktopBridgeMock({
      updateTaskPrompt: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePromptDrafts } = await import("../renderer/hooks/usePromptDrafts");
    const baseGraph = {
      ...graph,
      graphVersion: "pgv-before",
      tasks: graph.tasks.map((task) =>
        task.taskId === "T-ALPHA" ? { ...task, promptHash: "hash-before" } : task
      )
    };
    const changedGraph = {
      ...baseGraph,
      graphVersion: "pgv-after",
      tasks: baseGraph.tasks.map((task) =>
        task.taskId === "T-ALPHA"
          ? { ...task, promptMarkdown: "# Remote alpha", promptHash: "hash-after" }
          : task
      )
    };
    const { result, rerender } = renderHook(
      ({ currentGraph }) =>
        usePromptDrafts({
          graph: currentGraph,
          refreshGraph: vi.fn().mockResolvedValue(undefined),
          selectedCanvasId: "canvas-main",
          selectedProject: project,
          setError: vi.fn()
        }),
      {
        initialProps: { currentGraph: baseGraph }
      }
    );

    act(() => {
      result.current.handlePromptChange("T-ALPHA", "# Local alpha");
    });
    await act(async () => {
      rerender({ currentGraph: changedGraph });
      await Promise.resolve();
    });
    expect(result.current.promptConflicts.map((conflict) => conflict.taskId)).toEqual(["T-ALPHA"]);
    act(() => {
      vi.advanceTimersByTime(900);
    });

    expect(bridge.updateTaskPrompt).not.toHaveBeenCalled();
  });

  it("does not report a prompt conflict after a local prompt save succeeds", async () => {
    const bridge = createDesktopBridgeMock({
      updateTaskPrompt: vi
        .fn()
        .mockResolvedValue({ ok: true, graphVersion: "pgv-saved", diagnostics: [] })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePromptDrafts } = await import("../renderer/hooks/usePromptDrafts");
    const baseGraph = {
      ...graph,
      graphVersion: "pgv-before",
      tasks: graph.tasks.map((task) =>
        task.taskId === "T-ALPHA" ? { ...task, promptHash: "hash-before" } : task
      )
    };
    const savedGraph = {
      ...baseGraph,
      graphVersion: "pgv-saved",
      tasks: baseGraph.tasks.map((task) =>
        task.taskId === "T-ALPHA"
          ? { ...task, promptMarkdown: "# Local alpha", promptHash: "hash-saved" }
          : task
      )
    };
    const { result, rerender } = renderHook(
      ({ currentGraph }) =>
        usePromptDrafts({
          graph: currentGraph,
          refreshGraph: vi.fn().mockResolvedValue(undefined),
          selectedCanvasId: "canvas-main",
          selectedProject: project,
          setError: vi.fn()
        }),
      {
        initialProps: { currentGraph: baseGraph }
      }
    );

    act(() => {
      result.current.handlePromptChange("T-ALPHA", "# Local alpha");
    });
    await act(async () => {
      await result.current.handlePromptSave("T-ALPHA");
    });
    await act(async () => {
      rerender({ currentGraph: savedGraph });
      await Promise.resolve();
    });

    expect(result.current.promptConflicts).toEqual([]);
  });

  it("syncs clean task prompt and title drafts after graph history undo", async () => {
    const bridge = createDesktopBridgeMock({
      updateTaskPrompt: vi
        .fn()
        .mockResolvedValue({ ok: true, graphVersion: "pgv-saved", diagnostics: [] }),
      updateTaskTitle: vi
        .fn()
        .mockResolvedValue({ ok: true, graphVersion: "pgv-title-saved", diagnostics: [] })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { usePromptDrafts } = await import("../renderer/hooks/usePromptDrafts");
    const baseGraph = {
      ...graph,
      graphVersion: "pgv-before",
      tasks: graph.tasks.map((task) =>
        task.taskId === "T-ALPHA" ? { ...task, promptHash: "hash-before" } : task
      )
    };
    const savedGraph = {
      ...baseGraph,
      graphVersion: "pgv-saved",
      tasks: baseGraph.tasks.map((task) =>
        task.taskId === "T-ALPHA"
          ? {
              ...task,
              title: "Saved title",
              promptMarkdown: "# Local alpha",
              promptHash: "hash-saved"
            }
          : task
      )
    };
    const undoneGraph = {
      ...baseGraph,
      graphVersion: "pgv-undone",
      tasks: baseGraph.tasks.map((task) =>
        task.taskId === "T-ALPHA"
          ? { ...task, title: "Alpha task", promptMarkdown: "# Alpha", promptHash: "hash-before" }
          : task
      )
    };
    const { result, rerender } = renderHook(
      ({ currentGraph }) =>
        usePromptDrafts({
          graph: currentGraph,
          refreshGraph: vi.fn().mockResolvedValue(undefined),
          selectedCanvasId: "canvas-main",
          selectedProject: project,
          setError: vi.fn()
        }),
      {
        initialProps: { currentGraph: baseGraph }
      }
    );

    act(() => {
      result.current.handlePromptChange("T-ALPHA", "# Local alpha");
      result.current.handleTitleChange("T-ALPHA", "Saved title");
    });
    await act(async () => {
      await result.current.handlePromptSave("T-ALPHA");
      await result.current.handleTitleSave("T-ALPHA");
    });
    await act(async () => {
      rerender({ currentGraph: savedGraph });
      await Promise.resolve();
    });
    expect(result.current.promptDrafts["T-ALPHA"]).toBe("# Local alpha");
    expect(result.current.titleDrafts["T-ALPHA"]).toBe("Saved title");

    await act(async () => {
      rerender({ currentGraph: undoneGraph });
      await Promise.resolve();
    });

    expect(result.current.promptDrafts["T-ALPHA"]).toBe("# Alpha");
    expect(result.current.titleDrafts["T-ALPHA"]).toBe("Alpha task");
    expect(result.current.promptConflicts).toEqual([]);
  });

  it("refreshes the selected block prompt base after saving a block prompt", async () => {
    const blockBefore: DesktopBlockDetail = {
      ref: "T-ALPHA#B-001",
      graphVersion: "pgv-before",
      taskId: "T-ALPHA",
      blockId: "B-001",
      type: "implementation",
      title: "Block",
      status: "ready",
      executor: null,
      effectiveExecutor: null,
      promptMarkdown: "# Local block",
      promptHash: "hash-before",
      promptMissing: false,
      promptSurfaceMarkdown: "# Local block",
      promptSources: [],
      dependencies: [],
      latestRunId: null,
      latestReviewAttemptId: null,
      activeFeedbackId: null,
      exceptionReason: null,
      reviewGate: null
    };
    const blockAfter: DesktopBlockDetail = {
      ...blockBefore,
      graphVersion: "pgv-after",
      promptHash: "hash-after"
    };
    const bridge = createDesktopBridgeMock({
      updateBlockPrompt: vi
        .fn()
        .mockResolvedValue({ ok: true, graphVersion: "pgv-after", diagnostics: [] }),
      getBlockDetail: vi.fn().mockResolvedValue(blockAfter)
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

    act(() => {
      result.current.setSelectedBlock(blockBefore);
    });
    await act(async () => {
      await result.current.saveSelectedBlockPrompt();
    });

    expect(bridge.updateBlockPrompt).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      "T-ALPHA#B-001",
      "# Local block",
      { baseGraphVersion: "pgv-before", basePromptHash: "hash-before" }
    );
    expect(bridge.getBlockDetail).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      "T-ALPHA#B-001"
    );
    expect(result.current.selectedBlock?.graphVersion).toBe("pgv-after");
    expect(result.current.selectedBlock?.promptHash).toBe("hash-after");
    expect(refreshGraph).toHaveBeenCalledTimes(1);
  });
});
