/* @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { useCallback, useState } from "react";
import { applyNodeChanges } from "@xyflow/react";
import type { Node, NodeChange, OnNodesChange } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLerpedNodeDrag } from "../renderer/hooks/useLerpedNodeDrag";

type TestNode = Node<{ label: string }, "task">;

type MatchMediaStub = {
  mediaQueryList: MediaQueryList;
  setMatches: (matches: boolean) => void;
};

function createNode(id: string, x: number, y: number): TestNode {
  return {
    id,
    type: "task",
    position: { x, y },
    data: { label: id }
  };
}

function createDraggingNode(id: string, x: number, y: number): TestNode {
  return {
    ...createNode(id, x, y),
    dragging: true
  };
}

function dragPositionChange(id: string, x: number, y: number): NodeChange<TestNode> {
  return {
    id,
    type: "position",
    position: { x, y },
    dragging: true
  };
}

function stopDraggingChange(id: string, x: number, y: number): NodeChange<TestNode> {
  return {
    id,
    type: "position",
    position: { x, y },
    dragging: false
  };
}

function stubReducedMotion(matches: boolean): MatchMediaStub {
  let currentMatches = matches;
  const listeners = new Set<EventListener>();
  const mediaQueryList = {
    get matches() {
      return currentMatches;
    },
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: vi.fn((_event: "change", listener: EventListener) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_event: "change", listener: EventListener) => {
      listeners.delete(listener);
    }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true)
  } satisfies MediaQueryList;

  vi.stubGlobal(
    "matchMedia",
    vi.fn((): MediaQueryList => mediaQueryList)
  );

  return {
    mediaQueryList,
    setMatches(nextMatches: boolean) {
      currentMatches = nextMatches;
      const event = new Event("change");
      for (const listener of listeners) {
        listener(event);
      }
    }
  };
}

function stubAnimationFrame() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    const id = nextId;
    nextId += 1;
    callbacks.set(id, callback);
    return id;
  });
  const cancelAnimationFrame = vi.fn((id: number) => {
    callbacks.delete(id);
  });

  vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

  return {
    cancelAnimationFrame,
    get pendingFrameCount() {
      return callbacks.size;
    },
    requestAnimationFrame,
    runNextFrame(now = 16) {
      const next = callbacks.entries().next();
      if (next.done) {
        throw new Error("Expected a pending animation frame.");
      }
      const [id, callback] = next.value;
      callbacks.delete(id);
      callback(now);
    }
  };
}

function useHarness(initialNodes: TestNode[], enabled: boolean) {
  const [nodes, setNodes] = useState(initialNodes);
  const onNodesChange = useCallback<OnNodesChange<TestNode>>((changes) => {
    setNodes((currentNodes) => applyNodeChanges(changes, currentNodes));
  }, []);
  const lerpedDrag = useLerpedNodeDrag({
    nodes,
    setNodes,
    onNodesChange,
    enabled,
    alpha: 0.5,
    epsilon: 0.01
  });

  return {
    ...lerpedDrag,
    nodes,
    setNodes
  };
}

beforeEach(() => {
  stubReducedMotion(false);
  stubAnimationFrame();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useLerpedNodeDrag", () => {
  it("applies position changes directly when disabled", () => {
    const { result } = renderHook(() => useHarness([createNode("T-001", 0, 0)], false));

    act(() => {
      result.current.onNodesChange([dragPositionChange("T-001", 100, 80)]);
    });

    expect(result.current.nodes[0].position).toEqual({ x: 100, y: 80 });
    expect(result.current.isAnimating).toBe(false);
  });

  it("applies position changes directly when system reduced motion is enabled", () => {
    stubReducedMotion(true);
    const { result } = renderHook(() => useHarness([createNode("T-001", 0, 0)], true));

    act(() => {
      result.current.onNodesChange([dragPositionChange("T-001", 100, 80)]);
    });

    expect(result.current.nodes[0].position).toEqual({ x: 100, y: 80 });
    expect(result.current.isAnimating).toBe(false);
  });

  it("records dragging targets without snapping immediately", () => {
    const { result } = renderHook(() => useHarness([createNode("T-001", 0, 0)], true));

    act(() => {
      result.current.onNodesChange([dragPositionChange("T-001", 100, 80)]);
    });

    expect(result.current.nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(result.current.nodes[0].dragging).toBe(true);
    expect(result.current.isAnimating).toBe(true);
  });

  it("moves rendered positions toward active targets on animation frames", () => {
    const animationFrame = stubAnimationFrame();
    const { result } = renderHook(() => useHarness([createNode("T-001", 0, 0)], true));

    act(() => {
      result.current.onNodesChange([dragPositionChange("T-001", 100, 80)]);
    });

    act(() => {
      animationFrame.runNextFrame();
    });

    expect(result.current.nodes[0].position).toEqual({ x: 50, y: 40 });

    act(() => {
      animationFrame.runNextFrame(32);
    });

    expect(result.current.nodes[0].position).toEqual({ x: 75, y: 60 });
  });

  it("settles on exact active targets and stops scheduling frames", () => {
    const animationFrame = stubAnimationFrame();
    const { result } = renderHook(() => useHarness([createNode("T-001", 0, 0)], true));

    act(() => {
      result.current.onNodesChange([dragPositionChange("T-001", 100, 80)]);
    });

    for (let frame = 0; frame < 15; frame += 1) {
      act(() => {
        animationFrame.runNextFrame(16 * (frame + 1));
      });
    }

    expect(result.current.nodes[0].position).toEqual({ x: 100, y: 80 });
    expect(result.current.isAnimating).toBe(false);
    expect(animationFrame.pendingFrameCount).toBe(0);
  });

  it("drops active targets for externally removed nodes on the next frame", () => {
    const animationFrame = stubAnimationFrame();
    const { result } = renderHook(() => useHarness([createNode("T-001", 0, 0)], true));

    act(() => {
      result.current.onNodesChange([dragPositionChange("T-001", 100, 80)]);
    });
    expect(animationFrame.pendingFrameCount).toBe(1);

    act(() => {
      result.current.setNodes([]);
    });

    act(() => {
      animationFrame.runNextFrame();
    });

    expect(result.current.nodes).toEqual([]);
    expect(result.current.isAnimating).toBe(false);
    expect(animationFrame.pendingFrameCount).toBe(0);
    expect(animationFrame.requestAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it("commits exact active targets and clears animation state", () => {
    const animationFrame = stubAnimationFrame();
    const { result } = renderHook(() => useHarness([createNode("T-001", 0, 0)], true));

    act(() => {
      result.current.onNodesChange([dragPositionChange("T-001", 100, 80)]);
    });
    act(() => {
      animationFrame.runNextFrame();
    });

    let committedNodes: TestNode[] = [];
    act(() => {
      committedNodes = result.current.commitDragTargets();
    });

    expect(committedNodes[0].position).toEqual({ x: 100, y: 80 });
    expect(result.current.nodes[0].position).toEqual({ x: 100, y: 80 });
    expect(result.current.isAnimating).toBe(false);
    expect(animationFrame.cancelAnimationFrame).toHaveBeenCalled();
    expect(animationFrame.pendingFrameCount).toBe(0);
  });

  it("preserves stop-change metadata when committing active targets in the same tick", () => {
    const { result } = renderHook(() => useHarness([createNode("T-001", 0, 0)], true));

    act(() => {
      result.current.onNodesChange([dragPositionChange("T-001", 100, 80)]);
    });
    expect(result.current.nodes[0].dragging).toBe(true);

    let committedNodes: TestNode[] = [];
    act(() => {
      result.current.onNodesChange([stopDraggingChange("T-001", 100, 80)]);
      committedNodes = result.current.commitDragTargets();
    });

    expect(committedNodes[0]).toMatchObject({
      dragging: false,
      position: { x: 100, y: 80 }
    });
    expect(result.current.nodes[0]).toMatchObject({
      dragging: false,
      position: { x: 100, y: 80 }
    });
  });

  it("uses a drag stop fallback when there are no active targets", () => {
    const { result } = renderHook(() => useHarness([createNode("T-001", 0, 0)], true));

    let committedNodes: TestNode[] = [];
    act(() => {
      committedNodes = result.current.commitDragTargets({ id: "T-001", position: { x: 100, y: 80 } });
    });

    expect(committedNodes[0].position).toEqual({ x: 100, y: 80 });
    expect(result.current.nodes[0].position).toEqual({ x: 100, y: 80 });
    expect(result.current.isAnimating).toBe(false);
  });

  it("preserves stop-change metadata when committing a fallback node in the same tick", () => {
    const { result } = renderHook(() => useHarness([createDraggingNode("T-001", 50, 40)], true));

    let committedNodes: TestNode[] = [];
    act(() => {
      result.current.onNodesChange([stopDraggingChange("T-001", 50, 40)]);
      committedNodes = result.current.commitDragTargets({ id: "T-001", position: { x: 100, y: 80 } });
    });

    expect(committedNodes[0]).toMatchObject({
      dragging: false,
      position: { x: 100, y: 80 }
    });
    expect(result.current.nodes[0]).toMatchObject({
      dragging: false,
      position: { x: 100, y: 80 }
    });
  });

  it("keeps non-dragging position changes on the standard ReactFlow path", () => {
    const { result } = renderHook(() => useHarness([createNode("T-001", 0, 0)], true));

    act(() => {
      result.current.onNodesChange([stopDraggingChange("T-001", 100, 80)]);
    });

    expect(result.current.nodes[0].position).toEqual({ x: 100, y: 80 });
    expect(result.current.nodes[0].dragging).toBe(false);
    expect(result.current.isAnimating).toBe(false);
  });

  it("cancels pending animation work on unmount", () => {
    const animationFrame = stubAnimationFrame();
    const { result, unmount } = renderHook(() => useHarness([createNode("T-001", 0, 0)], true));

    act(() => {
      result.current.onNodesChange([dragPositionChange("T-001", 100, 80)]);
    });

    expect(animationFrame.pendingFrameCount).toBe(1);

    unmount();

    expect(animationFrame.cancelAnimationFrame).toHaveBeenCalled();
    expect(animationFrame.pendingFrameCount).toBe(0);
  });
});
