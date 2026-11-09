/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { layout } from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { createTranslator } from "../renderer/i18n";
import { defaultDesktopSettings } from "../renderer/settings";
import type { AppFlowNode } from "../renderer/types";

afterEach(cleanupRendererTestEnvironment);

const taskIds = ["T-001", "T-002", "T-003", "T-004", "T-005"];
const fiveTasks: DesktopGraphViewModel = {
  ...graph,
  tasks: taskIds.map((taskId) => ({ ...graph.tasks[0], taskId })),
  edges: []
};

async function resetHarness(source: DesktopGraphViewModel | null, nodes: AppFlowNode[]) {
  const api = createDesktopBridgeMock();
  vi.stubGlobal("planweave", api);
  vi.resetModules();
  const { useGraphPaletteActions } = await import("../renderer/hooks/useGraphPaletteActions");
  const submit = vi.fn().mockResolvedValue({ status: "completed", ok: true });
  const setLayout = vi.fn();
  const setError = vi.fn();
  const getLayoutNodes = vi.fn(() => nodes);
  const hook = renderHook(() =>
    useGraphPaletteActions({
      captureProjectSelection: () => ({ isCurrent: () => true }),
      flowInstance: null,
      graph: source,
      layout,
      nodes: nodes.map(({ id, position }) => ({ id, position, data: {} })) as AppFlowNode[],
      getLayoutNodes,
      loadProject: vi.fn(),
      refreshProjectDerivedState: vi.fn(),
      selectedCanvasId: "default",
      selectedProject: null,
      selectedBlock: null,
      selectedTaskPanelId: null,
      setLayout,
      setError,
      selectTaskPanel: vi.fn(),
      settings: defaultDesktopSettings,
      t: createTranslator("en"),
      workspaceCanvas: {
        enabled: true,
        offline: false,
        projection: null,
        projectionStatus: null,
        initialRuntimeAvailability: null,
        submit,
        reconnect: vi.fn(),
        snapshot: {
          session: null,
          connectionPhase: "connected",
          lastError: null,
          lastStaleConflict: null,
          busy: false
        }
      }
    })
  );
  const reset = () => act(async () => hook.result.current.resetLayout());
  return { reset, submit, setLayout, setError, getLayoutNodes, api };
}

describe("shared default layout reset", () => {
  it.each(
    [5, 9].flatMap((count) =>
      (["minimum", "measured", "explicit"] as const).map((sizeSource) => ({ count, sizeSource }))
    )
  )("separates $count task rectangles using $sizeSource sizes across repeated resets", async ({
    count,
    sizeSource
  }) => {
    const scenarioIds = Array.from(
      { length: count },
      (_, index) => `T-${String(index + 1).padStart(3, "0")}`
    );
    const sizes = scenarioIds.map((_, index) => ({
      width: sizeSource === "minimum" ? 320 : index === 0 ? 720 : 320,
      height: sizeSource === "minimum" ? 220 : 620 + index * 100
    }));
    const nodes = scenarioIds.map((id, index) => ({
      id,
      type: "task",
      data: {},
      position: { x: 900, y: 800 },
      ...(sizeSource === "measured"
        ? { measured: sizes[index], width: 320, height: 220 }
        : sizeSource === "explicit"
          ? sizes[index]
          : {})
    })) as AppFlowNode[];
    const hook = await resetHarness(
      { ...fiveTasks, tasks: scenarioIds.map((taskId) => ({ ...fiveTasks.tasks[0], taskId })) },
      nodes
    );
    await hook.reset();
    expect(hook.submit).toHaveBeenCalledTimes(1);
    const submitted = hook.submit.mock.calls[0][0].intent.nodes as Array<{
      nodeId: string;
      x: number;
      y: number;
    }>;
    expect(submitted.map((node) => node.nodeId)).toEqual(scenarioIds);
    const gaps: number[] = [];
    for (let left = 0; left < submitted.length; left += 1) {
      for (let right = left + 1; right < submitted.length; right += 1) {
        const a = submitted[left];
        const b = submitted[right];
        const horizontal = Math.max(b.x - a.x - sizes[left].width, a.x - b.x - sizes[right].width);
        const vertical = Math.max(b.y - a.y - sizes[left].height, a.y - b.y - sizes[right].height);
        expect(horizontal < 0 && vertical < 0).toBe(false);
        gaps.push(Math.max(horizontal, vertical));
      }
    }
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(140);
    expect(hook.setLayout).toHaveBeenCalledWith(expect.objectContaining({ nodes: submitted }));
    expect(hook.api.resetDesktopLayout).not.toHaveBeenCalled();
    await hook.reset();
    expect(hook.submit.mock.calls[1][0].intent.nodes).toEqual(submitted);
    expect(hook.setLayout).toHaveBeenCalledTimes(2);
  });

  it("places dependencies after the widest prerequisite layer", async () => {
    const source: DesktopGraphViewModel = {
      ...fiveTasks,
      edges: [
        { from: "T-002", to: "T-001", type: "depends_on" },
        { from: "T-003", to: "T-002", type: "depends_on" }
      ]
    };
    const hook = await resetHarness(source, [
      { id: "T-001", position: { x: 0, y: 0 }, measured: { width: 720, height: 800 } }
    ] as AppFlowNode[]);
    await hook.reset();
    expect(hook.submit).toHaveBeenCalledTimes(1);
    const submitted = hook.submit.mock.calls[0][0].intent.nodes as Array<{
      nodeId: string;
      x: number;
      y: number;
    }>;
    const positions = new Map(submitted.map((node) => [node.nodeId, node]));
    expect(positions.get("T-002")!.x - positions.get("T-001")!.x).toBeGreaterThanOrEqual(860);
    expect(positions.get("T-003")!.x - positions.get("T-002")!.x).toBeGreaterThanOrEqual(460);
    expect(positions.get("T-004")!.y - positions.get("T-001")!.y).toBeGreaterThanOrEqual(940);
  });

  it.each([
    null,
    { ...graph, tasks: [] }
  ])("does not persist stale rendered nodes without current graph tasks", async (source) => {
    const hook = await resetHarness(source, [
      { id: "OLD-CANVAS-TASK", position: { x: 9, y: 8 } }
    ] as AppFlowNode[]);
    await hook.reset();
    expect(hook.submit).not.toHaveBeenCalled();
    expect(hook.setLayout).not.toHaveBeenCalled();
    expect(hook.setError).not.toHaveBeenCalled();
    expect(hook.getLayoutNodes).not.toHaveBeenCalled();
  });
});
