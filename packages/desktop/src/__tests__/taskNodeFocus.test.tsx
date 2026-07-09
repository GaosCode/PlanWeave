/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Edge, ReactFlowInstance } from "@xyflow/react";
import { focusTaskNode, useTaskNodeFocus } from "../renderer/hooks/useTaskNodeFocus";
import type { AppFlowNode } from "../renderer/types";

describe("task node focus", () => {
  it("centers the ReactFlow viewport on the selected task node", () => {
    const setCenter = vi.fn().mockResolvedValue(true);
    const flow = flowInstance({ setCenter });

    expect(focusTaskNode(flow, [taskNode("T-001", 80, 120)], "T-001")).toBe(true);
    expect(setCenter).toHaveBeenCalledWith(240, 230, {
      duration: 260,
      zoom: 1
    });
  });

  it("uses measured node dimensions when ReactFlow has them", () => {
    const setCenter = vi.fn().mockResolvedValue(true);
    const flow = flowInstance({
      getNode: vi.fn().mockReturnValue(taskNode("T-001", 40, 70, { width: 360, height: 260 })),
      setCenter
    });

    expect(focusTaskNode(flow, [], "T-001")).toBe(true);
    expect(setCenter).toHaveBeenCalledWith(220, 200, expect.any(Object));
  });

  it("focuses once when selected task state changes from another navigation path", async () => {
    const setCenter = vi.fn().mockResolvedValue(true);
    const flow = flowInstance({ setCenter });

    const { rerender } = renderHook(
      ({ selectedTaskPanelId }) =>
        useTaskNodeFocus({
          activeView: "graph",
          flowInstance: flow,
          nodes: [taskNode("T-001", 80, 120)],
          selectedTaskPanelId
        }),
      {
        initialProps: { selectedTaskPanelId: null as string | null }
      }
    );

    rerender({ selectedTaskPanelId: "T-001" });
    await waitFor(() => expect(setCenter).toHaveBeenCalledTimes(1));

    rerender({ selectedTaskPanelId: "T-001" });
    expect(setCenter).toHaveBeenCalledTimes(1);
  });

  it("waits until the graph view is active before focusing a clicked task", async () => {
    const setCenter = vi.fn().mockResolvedValue(true);
    const flow = flowInstance({ setCenter });

    const { result, rerender } = renderHook(
      ({ activeView }) =>
        useTaskNodeFocus({
          activeView,
          flowInstance: flow,
          nodes: [taskNode("T-001", 80, 120)],
          selectedTaskPanelId: "T-001"
        }),
      {
        initialProps: { activeView: "search" as const }
      }
    );

    act(() => result.current.requestTaskFocus("T-001"));
    expect(setCenter).not.toHaveBeenCalled();

    rerender({ activeView: "graph" });
    await waitFor(() => expect(setCenter).toHaveBeenCalledTimes(1));
  });

  it("refocuses when the same selected task is clicked again", async () => {
    const setCenter = vi.fn().mockResolvedValue(true);
    const flow = flowInstance({ setCenter });

    const { result } = renderHook(() =>
      useTaskNodeFocus({
        activeView: "graph",
        flowInstance: flow,
        nodes: [taskNode("T-001", 80, 120)],
        selectedTaskPanelId: "T-001"
      })
    );
    await waitFor(() => expect(setCenter).toHaveBeenCalledTimes(1));

    act(() => result.current.requestTaskFocus("T-001"));
    await waitFor(() => expect(setCenter).toHaveBeenCalledTimes(2));
  });

  it("consumes a session focus request once nodes update after a successful focus", async () => {
    const setCenter = vi.fn().mockResolvedValue(true);
    const flow = flowInstance({ setCenter });

    const { rerender } = renderHook(
      ({ nodes, taskFocusRequest }) =>
        useTaskNodeFocus({
          activeView: "graph",
          flowInstance: flow,
          nodes,
          selectedTaskPanelId: "T-001",
          taskFocusRequest
        }),
      {
        initialProps: {
          nodes: [taskNode("T-001", 80, 120)],
          taskFocusRequest: { taskId: "T-001", version: 1 }
        }
      }
    );

    await waitFor(() => expect(setCenter).toHaveBeenCalledTimes(1));

    rerender({
      nodes: [taskNode("T-001", 120, 160)],
      taskFocusRequest: { taskId: "T-001", version: 1 }
    });

    expect(setCenter).toHaveBeenCalledTimes(1);

    rerender({
      nodes: [taskNode("T-001", 120, 160)],
      taskFocusRequest: { taskId: "T-001", version: 2 }
    });

    await waitFor(() => expect(setCenter).toHaveBeenCalledTimes(2));
  });

  it("accepts the same session focus version again after selection clears outside graph view", async () => {
    const setCenter = vi.fn().mockResolvedValue(true);
    const flow = flowInstance({ setCenter });

    const { rerender } = renderHook(
      ({ activeView, selectedTaskPanelId, taskFocusRequest }) =>
        useTaskNodeFocus({
          activeView,
          flowInstance: flow,
          nodes: [taskNode("T-001", 80, 120)],
          selectedTaskPanelId,
          taskFocusRequest
        }),
      {
        initialProps: {
          activeView: "graph" as const,
          selectedTaskPanelId: "T-001" as string | null,
          taskFocusRequest: { taskId: "T-001", version: 1 } as {
            taskId: string;
            version: number;
          } | null
        }
      }
    );

    await waitFor(() => expect(setCenter).toHaveBeenCalledTimes(1));

    rerender({
      activeView: "search",
      selectedTaskPanelId: null,
      taskFocusRequest: null
    });

    rerender({
      activeView: "graph",
      selectedTaskPanelId: "T-001",
      taskFocusRequest: { taskId: "T-001", version: 1 }
    });

    await waitFor(() => expect(setCenter).toHaveBeenCalledTimes(2));
  });
});

function taskNode(
  taskId: string,
  x: number,
  y: number,
  measured?: { width: number; height: number }
) {
  return {
    id: taskId,
    type: "task",
    position: { x, y },
    measured
  };
}

function flowInstance({
  getNode = vi.fn().mockReturnValue(undefined),
  setCenter
}: {
  getNode?: ReactFlowInstance<AppFlowNode, Edge>["getNode"];
  setCenter: ReactFlowInstance<AppFlowNode, Edge>["setCenter"];
}) {
  return { getNode, setCenter };
}
