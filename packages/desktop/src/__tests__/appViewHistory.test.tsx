/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appHistoryRouteSchema,
  readAppViewHistoryAvailability,
  useAppViewHistory
} from "../renderer/hooks/useAppViewHistory";

afterEach(() => vi.restoreAllMocks());

describe("app view history", () => {
  it("keeps forward navigation available after returning to a previous app view", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    window.history.replaceState(null, "", "/");
    const { result } = renderHook(() => useAppViewHistory("graph"));

    expect(warn).not.toHaveBeenCalled();

    act(() => {
      result.current[1]("canvas-map");
    });
    expect(readAppViewHistoryAvailability()).toEqual({ canGoBack: true, canGoForward: false });

    act(() => {
      window.history.back();
    });

    await waitFor(() => {
      expect(result.current[0]).toBe("graph");
    });
    expect(readAppViewHistoryAvailability()).toEqual({ canGoBack: false, canGoForward: true });
  });

  it("restores the fallback route from an empty browser history entry", () => {
    window.history.replaceState(null, "", "/");
    const { result } = renderHook(() => useAppViewHistory("graph"));

    act(() => {
      result.current[1]("canvas-map");
    });
    expect(result.current[0]).toBe("canvas-map");

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });

    expect(result.current[0]).toBe("graph");
    expect(result.current[2].historyError).toBeNull();
  });

  it("stores a strict Task Workspace route and restores its graph source", async () => {
    window.history.replaceState(null, "", "/");
    const { result } = renderHook(() => useAppViewHistory("graph"));
    const graphSnapshot = {
      projectRoot: "/projects/demo",
      canvasId: "canvas-main",
      viewport: { x: 12, y: -8, zoom: 0.75 },
      selectedTaskId: "T-001",
      selectedBlockRef: "T-001#B-001"
    };

    act(() => {
      result.current[2].openTaskWorkspace(
        {
          projectRoot: "/projects/demo",
          canvasId: "canvas-main",
          taskId: "T-001",
          blockRef: "T-001#B-001"
        },
        { view: "graph", graphSnapshot }
      );
    });

    expect(result.current[0]).toBe("task-workspace");
    expect(result.current[2].taskWorkspaceNavigation).toMatchObject({
      taskId: "T-001",
      blockRef: "T-001#B-001",
      source: { view: "graph", graphSnapshot }
    });

    act(() => window.history.back());
    await waitFor(() => expect(result.current[0]).toBe("graph"));
    expect(result.current[2].graphSnapshot).toEqual(graphSnapshot);
  });

  it("keeps string/function setters compatible and rejects malformed Task Workspace history", () => {
    window.history.replaceState(null, "", "/");
    const { result } = renderHook(() => useAppViewHistory("graph"));

    act(() => result.current[1](() => "canvas-map"));
    expect(result.current[0]).toBe("canvas-map");
    expect(() => result.current[1]("task-workspace")).toThrow("openTaskWorkspace");

    act(() => {
      window.dispatchEvent(
        new PopStateEvent("popstate", {
          state: {
            planweaveRoute: { view: "task-workspace" },
            planweaveHistoryIndex: 1,
            planweaveHistoryMaxIndex: 1
          }
        })
      );
    });
    expect(result.current[0]).toBe("canvas-map");
    expect(result.current[2].historyError).toContain("invalid PlanWeave route");
  });

  it("migrates legacy history once and keeps every later write canonical-only", () => {
    window.history.replaceState(
      {
        retainedState: "keep",
        planweaveAppView: "canvas-map",
        planweaveHistoryIndex: 2,
        planweaveHistoryMaxIndex: 2
      },
      "",
      "/"
    );

    const { result } = renderHook(() => useAppViewHistory("graph"));

    expect(result.current[0]).toBe("canvas-map");
    expect(window.history.state).toMatchObject({
      retainedState: "keep",
      planweaveRoute: { view: "canvas-map" },
      planweaveHistoryIndex: 2,
      planweaveHistoryMaxIndex: 2
    });
    expect(window.history.state).not.toHaveProperty("planweaveAppView");

    window.history.replaceState({ ...window.history.state, planweaveAppView: "todo" }, "", "/");
    act(() => result.current[1]("statistics"));
    expect(window.history.state).toMatchObject({ planweaveRoute: { view: "statistics" } });
    expect(window.history.state).not.toHaveProperty("planweaveAppView");
  });

  it("recovers an invalid startup route without reviving legacy navigation state", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    window.history.replaceState(
      {
        retainedState: "keep",
        planweaveRoute: { view: "not-a-view" },
        planweaveAppView: "canvas-map",
        planweaveHistoryIndex: 1,
        planweaveHistoryMaxIndex: 1
      },
      "",
      "/"
    );

    const { result } = renderHook(() => useAppViewHistory("graph"));

    expect(result.current[0]).toBe("graph");
    expect(result.current[2].historyError).toBeNull();
    expect(window.history.state).toMatchObject({
      retainedState: "keep",
      planweaveRoute: { view: "graph" },
      planweaveHistoryIndex: 0,
      planweaveHistoryMaxIndex: 0
    });
    expect(window.history.state).not.toHaveProperty("planweaveAppView");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid PlanWeave route"));
  });

  it("rejects graph snapshots on non-graph history routes", () => {
    expect(
      appHistoryRouteSchema.safeParse({
        view: "search",
        graphSnapshot: {
          projectRoot: "/projects/demo",
          canvasId: "canvas-main",
          viewport: { x: 0, y: 0, zoom: 1 },
          selectedTaskId: null,
          selectedBlockRef: null
        }
      }).success
    ).toBe(false);
  });
});
