/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { layout } from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { createTranslator } from "../renderer/i18n";
import { defaultDesktopSettings } from "../renderer/settings";
import type { AppFlowNode } from "../renderer/types";
import type { WorkspaceCanvasLocator } from "../shared/canvasLocator";
import type {
  WorkspaceCanvasProjection,
  WorkspaceCanvasProjectionSignal
} from "../shared/workspaceCanvasProjection";
import type { WorkspaceCanvasCommandBridge } from "../renderer/hooks/useWorkspaceCanvasCommands";

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
  const { useWorkspaceCanvasCommands } = await import(
    "../renderer/hooks/useWorkspaceCanvasCommands"
  );
  const t = createTranslator("en");
  const locator: WorkspaceCanvasLocator = {
    kind: "workspace",
    connectionProfileId: "profile-reset",
    workspaceId: "workspace-reset",
    projectId: graph.projectId,
    canvasId: "default"
  };
  let stored: WorkspaceCanvasProjection = {
    locator,
    status: "accepted",
    authorityMode: "server_authoritative",
    readOnly: false,
    cachedAt: null,
    initialRuntimeAvailability: null,
    conflict: null,
    rejectCode: null,
    replica: {
      authorityId: "reset-authority",
      bindingKind: "remote",
      workspaceId: locator.workspaceId,
      projectId: locator.projectId,
      canvasId: locator.canvasId,
      revision: 1,
      contentDigest: "1".padStart(64, "0"),
      canEdit: true,
      optimisticOperationIds: [],
      rejections: [],
      content: {
        ...(source ?? graph),
        tasks: source?.tasks ?? [],
        layout,
        blockDependenciesByRef: {},
        taskOpenFeedbackCountByTaskId: {},
        blockPromptMarkdownByRef: {}
      }
    }
  };
  const listeners = new Set<(signal: WorkspaceCanvasProjectionSignal) => void>();
  const submit = vi.fn<WorkspaceCanvasCommandBridge["submitWorkspaceCanvasCommand"]>(
    async ({ intent }) => {
      if (intent.kind !== "update_layout") throw new Error("Unexpected reset command");
      const revision = stored.replica.revision + 1;
      stored = {
        ...stored,
        replica: {
          ...stored.replica,
          revision,
          contentDigest: revision.toString(16).padStart(64, "0"),
          content: {
            ...stored.replica.content,
            layout: { ...layout, nodes: intent.nodes, updatedAt: intent.updatedAt }
          }
        }
      };
      for (const listener of listeners)
        listener({ type: "workspace.canvas.projection", projection: stored });
      return stored;
    }
  );
  const workspaceApi: WorkspaceCanvasCommandBridge = {
    openWorkspaceCanvasSession: vi.fn(async () => stored),
    reconnectWorkspaceCanvasSession: vi.fn(async () => stored),
    closeWorkspaceCanvasSession: vi.fn(async () => undefined),
    onWorkspaceCanvasProjectionSignal: vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    submitWorkspaceCanvasCommand: submit
  };
  const setLayout = vi.fn();
  const setError = vi.fn();
  const getLayoutNodes = vi.fn(() => nodes);
  const hook = renderHook(() => {
    const commands = useWorkspaceCanvasCommands({
      api: workspaceApi,
      authorityKey: "reset-authority",
      locator,
      sessionConnected: true,
      t
    });
    const actions = useGraphPaletteActions({
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
      t,
      workspaceCanvas: commands
    });
    return { ...actions, commands };
  });
  await waitFor(() =>
    expect(hook.result.current.commands.snapshot.connectionPhase).toBe("connected")
  );
  const reset = () => act(async () => hook.result.current.resetLayout());
  return { result: hook.result, reset, submit, setLayout, setError, getLayoutNodes, api };
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
    expect(hook.result.current.commands.projection?.content.layout.nodes).toEqual(submitted);
    expect(hook.result.current.commands.layout?.nodes).toEqual(submitted);
    expect(hook.api.resetDesktopLayout).not.toHaveBeenCalled();
    await hook.reset();
    expect(hook.submit.mock.calls[1][0].intent.nodes).toEqual(submitted);
    expect(hook.setLayout).toHaveBeenCalledTimes(2);
    expect(hook.result.current.commands.projection?.revision).toBe(3);
    expect(hook.result.current.commands.layout?.nodes).toEqual(submitted);
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
