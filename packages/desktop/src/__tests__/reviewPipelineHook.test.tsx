/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type { DesktopGraphViewModel, DesktopReviewPipeline } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { project } from "./helpers/desktopProjectFixtures";
import { graph, reviewPipeline } from "./helpers/graphFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

describe("desktop renderer hook interfaces", () => {
  it("reloads the current Desktop Project Session after saving a review pipeline", async () => {
    const bridge = createDesktopBridgeMock({
      getLatestAutoRunSummary: vi.fn().mockResolvedValue(null),
      getReviewPipeline: vi.fn().mockResolvedValue(reviewPipeline),
      updateReviewPipeline: vi.fn().mockResolvedValue({ ok: true, diagnostics: [] })
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const [{ useReviewPipeline }, { createTranslator }] = await Promise.all([
      import("../renderer/hooks/useReviewPipeline"),
      import("../renderer/i18n")
    ]);

    const reloadCurrentCanvas = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useReviewPipeline({
        graph,
        reloadCurrentCanvas,
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn(),
        t: createTranslator("en")
      })
    );

    await waitFor(() => expect(result.current.reviewPipeline).toEqual(reviewPipeline));

    await act(async () => {
      await result.current.saveReviewPipeline();
    });

    expect(bridge.updateReviewPipeline).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      "T-ALPHA",
      {
        packageDefaults: {
          maxFeedbackCycles: 1,
          completionPolicy: "strict"
        },
        steps: reviewPipeline.steps
      }
    );
    expect(reloadCurrentCanvas).toHaveBeenCalled();
  });

  it("normalizes review pipeline draft values before saving", async () => {
    const reviewHook = {
      id: "review-hook",
      type: "executable" as const,
      command: "node",
      args: ["--message", "hello world", ""],
      executionPolicy: "trusted-local" as const
    };
    const pipelineWithHook: DesktopReviewPipeline = {
      ...reviewPipeline,
      packageDefaults: {
        maxFeedbackCycles: 2,
        completionPolicy: "strict"
      },
      steps: [
        {
          ...reviewPipeline.steps[0],
          maxFeedbackCycles: 2,
          hook: reviewHook
        }
      ]
    };
    const updateReviewPipeline = vi.fn().mockResolvedValue({ ok: true, diagnostics: [] });
    const bridge = createDesktopBridgeMock({
      getLatestAutoRunSummary: vi.fn().mockResolvedValue(null),
      getReviewPipeline: vi.fn().mockResolvedValue(pipelineWithHook),
      updateReviewPipeline
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const [{ useReviewPipeline }, { createTranslator }] = await Promise.all([
      import("../renderer/hooks/useReviewPipeline"),
      import("../renderer/i18n")
    ]);

    const { result } = renderHook(() =>
      useReviewPipeline({
        graph,
        reloadCurrentCanvas: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError: vi.fn(),
        t: createTranslator("en")
      })
    );

    await waitFor(() => expect(result.current.reviewPipeline).toEqual(pipelineWithHook));

    act(() => {
      result.current.setReviewDefaultCyclesDraft(Number.NaN);
      result.current.updateReviewStep(0, {
        maxFeedbackCycles: -3,
        hook: reviewHook
      });
    });

    await act(async () => {
      await result.current.saveReviewPipeline();
    });

    expect(updateReviewPipeline).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      "T-ALPHA",
      {
        packageDefaults: {
          maxFeedbackCycles: 0,
          completionPolicy: "strict"
        },
        steps: [
          {
            ...pipelineWithHook.steps[0],
            maxFeedbackCycles: 0,
            hook: {
              ...reviewHook,
              args: ["--message", "hello world"]
            }
          }
        ]
      }
    );
  });

  it("normalizes non-finite review pipeline numbers to non-negative integers", async () => {
    const { normalizeNonNegativeInteger } = await import("../renderer/hooks/reviewPipelineDraft");

    expect(normalizeNonNegativeInteger(Number.NaN)).toBe(0);
    expect(normalizeNonNegativeInteger(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeNonNegativeInteger(-1)).toBe(0);
    expect(normalizeNonNegativeInteger(3.9)).toBe(3);
  });

  it("resets the review pipeline task when the graph changes to a canvas without the previous task", async () => {
    const getReviewPipeline = vi.fn((_canvas, taskId: string) =>
      Promise.resolve({
        ...reviewPipeline,
        taskId,
        taskTitle: `${taskId} title`
      })
    );
    const bridge = createDesktopBridgeMock({
      getReviewPipeline
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const [{ useReviewPipeline }, { createTranslator }] = await Promise.all([
      import("../renderer/hooks/useReviewPipeline"),
      import("../renderer/i18n")
    ]);
    const nextGraph: DesktopGraphViewModel = {
      ...graph,
      tasks: [
        {
          ...graph.tasks[0],
          taskId: "T-GAMMA",
          title: "Gamma task"
        }
      ]
    };

    const { result, rerender } = renderHook(
      ({ graphValue, canvasId }: { graphValue: DesktopGraphViewModel; canvasId: string }) =>
        useReviewPipeline({
          graph: graphValue,
          reloadCurrentCanvas: vi.fn().mockResolvedValue(undefined),
          selectedCanvasId: canvasId,
          selectedProject: project,
          setError: vi.fn(),
          t: createTranslator("en")
        }),
      {
        initialProps: {
          graphValue: graph,
          canvasId: "canvas-main"
        }
      }
    );

    await waitFor(() =>
      expect(getReviewPipeline).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" }, "T-ALPHA")
    );

    rerender({
      graphValue: nextGraph,
      canvasId: "canvas-alt"
    });

    await waitFor(() => expect(result.current.reviewTaskId).toBe("T-GAMMA"));
    await waitFor(() =>
      expect(getReviewPipeline).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-alt" }, "T-GAMMA")
    );
    expect(getReviewPipeline).not.toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-alt" }, "T-ALPHA");
  });

  it("clears stale review task selection when the selected task was deleted before the graph refreshes", async () => {
    let rejectReviewPipeline: (error: Error) => void = () => undefined;
    const getReviewPipeline = vi.fn(
      () =>
        new Promise<DesktopReviewPipeline>((_, reject) => {
          rejectReviewPipeline = reject;
        })
    );
    const bridge = createDesktopBridgeMock({
      getReviewPipeline
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const [{ useReviewPipeline }, { createTranslator }] = await Promise.all([
      import("../renderer/hooks/useReviewPipeline"),
      import("../renderer/i18n")
    ]);
    const setError = vi.fn();
    const { result } = renderHook(() =>
      useReviewPipeline({
        graph,
        reloadCurrentCanvas: vi.fn().mockResolvedValue(undefined),
        selectedCanvasId: "canvas-main",
        selectedProject: project,
        setError,
        t: createTranslator("en")
      })
    );

    await waitFor(() =>
      expect(getReviewPipeline).toHaveBeenCalledWith({ projectRoot: project.rootPath, canvasId: "canvas-main" }, "T-ALPHA")
    );

    await act(async () => {
      rejectReviewPipeline(new Error("Error invoking remote method 'planweave:getReviewPipeline': Error: Task 'T-ALPHA' does not exist."));
    });

    await waitFor(() => expect(result.current.reviewTaskId).toBeNull());
    expect(result.current.reviewPipeline).toBeNull();
    expect(setError).not.toHaveBeenCalled();
  });
});
