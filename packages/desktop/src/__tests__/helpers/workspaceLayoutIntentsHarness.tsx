import { act, renderHook, waitFor } from "@testing-library/react";
import { useMemo } from "react";
import type * as React from "react";
import { useEdgesState, useNodesState } from "@xyflow/react";
import { vi } from "vitest";
import { useGraphFlowModel } from "../../renderer/hooks/useGraphFlowModel";
import { useGraphPaletteActions } from "../../renderer/hooks/useGraphPaletteActions";
import { useLerpedNodeDrag } from "../../renderer/hooks/useLerpedNodeDrag";
import {
  useWorkspaceCanvasCommands,
  type WorkspaceCanvasCommandBridge
} from "../../renderer/hooks/useWorkspaceCanvasCommands";
import { defaultDesktopSettings } from "../../renderer/settings";
import { createTranslator } from "../../renderer/i18n";
import type { AppFlowNode } from "../../renderer/types";
import type { WorkspaceCanvasLocator } from "../../shared/canvasLocator";
import type {
  WorkspaceCanvasProjection,
  WorkspaceCanvasProjectionSignal
} from "../../shared/workspaceCanvasProjection";
import { deferred } from "./desktopProjectFixtures";
import { graph as fixture } from "./graphFixtures";

const graph = {
  ...fixture,
  tasks: ["T-001", "T-002", "T-003"].map((taskId) => ({ ...fixture.tasks[0], taskId }))
};
const t = createTranslator("en");
const noop = vi.fn();
const runtimeAvailability = { kind: "not_applicable" as const };
const agentEndpoints: [] = [];
const flow: Omit<Parameters<typeof useGraphFlowModel>[0], "source" | "flowState"> = {
  drafts: { promptDrafts: {}, titleDrafts: {}, saveStates: {} },
  taskActions: {
    handleDeleteBlock: noop,
    handleDeleteTaskNode: noop,
    handleOpenBlockInspector: noop,
    handleOpenBlockWorkspace: noop,
    handleOpenRunRecord: noop,
    handleOpenTaskInspector: noop,
    handleOpenTaskWorkspace: noop,
    handleCopyAgentPrompt: noop,
    handleRevealTaskInFinder: noop,
    handlePromptChange: noop,
    handlePromptHistoryRedo: noop,
    handlePromptHistoryUndo: noop,
    handlePromptSave: noop,
    handleTaskAgentEndpointChange: noop,
    handleTitleChange: noop,
    handleTitleSave: noop,
    startAutoRunWithScope: noop
  },
  blockActions: { saveSelectedBlockPrompt: noop, saveSelectedBlockTitle: noop }
};
export const selection = { canvasId: "canvas-a", authority: "authority-a", connected: true };

export async function workspaceLayoutHarness() {
  const listeners = new Set<(signal: WorkspaceCanvasProjectionSignal) => void>();
  const pending: Array<{
    input: Parameters<WorkspaceCanvasCommandBridge["submitWorkspaceCanvasCommand"]>[0];
    done: ReturnType<typeof deferred<WorkspaceCanvasProjection>>;
  }> = [];
  function projection(locator: WorkspaceCanvasLocator, revision = 1): WorkspaceCanvasProjection {
    return {
      locator,
      status: "accepted",
      authorityMode: "server_authoritative",
      readOnly: false,
      cachedAt: null,
      initialRuntimeAvailability: null,
      conflict: null,
      rejectCode: null,
      replica: {
        authorityId: JSON.stringify(locator),
        bindingKind: "remote",
        workspaceId: locator.workspaceId,
        projectId: locator.projectId,
        canvasId: locator.canvasId,
        revision,
        contentDigest: revision.toString(16).padStart(64, "0"),
        canEdit: true,
        optimisticOperationIds: [],
        rejections: [],
        content: {
          ...graph,
          layout: {
            version: "desktop-layout/v1",
            projectId: graph.projectId,
            nodes: graph.tasks.map((task, index) => ({
              nodeId: task.taskId,
              x: 80,
              y: 80 + index * 360
            })),
            updatedAt: "2026-11-09T00:00:00.000Z"
          },
          blockDependenciesByRef: {},
          taskOpenFeedbackCountByTaskId: {},
          blockPromptMarkdownByRef: {}
        }
      }
    };
  }
  const authoritative = new Map<string, WorkspaceCanvasProjection>();
  const current = (locator: WorkspaceCanvasLocator) =>
    authoritative.get(locator.canvasId) ?? projection(locator);
  const api: WorkspaceCanvasCommandBridge = {
    openWorkspaceCanvasSession: vi.fn(async (locator) => current(locator)),
    reconnectWorkspaceCanvasSession: vi.fn(async (locator) => current(locator)),
    closeWorkspaceCanvasSession: vi.fn(async () => undefined),
    onWorkspaceCanvasProjectionSignal: vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    submitWorkspaceCanvasCommand: vi.fn((input) => {
      const done = deferred<WorkspaceCanvasProjection>();
      pending.push({ input, done });
      return done.promise;
    })
  };
  const setError = vi.fn();
  const hook = renderHook(
    (props: typeof selection) => {
      const locator = useMemo<WorkspaceCanvasLocator>(
        () => ({
          kind: "workspace",
          connectionProfileId: "profile-a",
          workspaceId: "workspace-a",
          projectId: graph.projectId,
          canvasId: props.canvasId
        }),
        [props.canvasId]
      );
      const commands = useWorkspaceCanvasCommands({
        api,
        authorityKey: props.authority,
        locator,
        sessionConnected: props.connected,
        t
      });
      const [nodes, setNodes, onNodesChange] = useNodesState<AppFlowNode>([]);
      const [, setEdges] = useEdgesState([]);
      const layout = commands.layout ?? commands.projection?.content.layout ?? null;
      const drag = useLerpedNodeDrag({ nodes, setNodes, onNodesChange, enabled: false });
      const actions = useGraphPaletteActions({
        captureProjectSelection: () => ({ isCurrent: () => true }),
        canvasLocator: locator,
        getLayoutNodes: drag.commitDragTargets,
        graph,
        layout,
        nodes,
        selectedCanvasId: props.canvasId,
        selectedProject: null,
        flowInstance: null,
        loadProject: noop,
        refreshProjectDerivedState: noop,
        selectedBlock: null,
        selectedTaskPanelId: null,
        selectTaskPanel: noop,
        settings: defaultDesktopSettings,
        setError,
        setLayout: noop,
        workspaceCanvas: commands,
        t
      });
      useGraphFlowModel({
        ...flow,
        taskActions: { ...flow.taskActions, handleDeleteTaskNode: actions.handleDeleteTaskNode },
        source: {
          graph,
          layout,
          agentEndpoints,
          selectedAgentEndpointIdForTask: noop,
          selectedBlock: null,
          t,
          runtimeAvailability
        },
        flowState: { setNodes, setEdges, setSelectedBlock: noop }
      });
      return { nodes, commands, actions };
    },
    { initialProps: selection }
  );
  const ready = () =>
    waitFor(() => {
      if (hook.result.current.commands.snapshot.connectionPhase !== "connected")
        throw Error("Session not ready");
    });
  await ready();
  const drag = (task: number, x: number) => {
    let result!: Promise<void>;
    act(() => {
      result = hook.result.current.actions.handleNodeDragStop({} as React.MouseEvent, {
        id: `T-00${task}`,
        position: { x, y: 80 + (task - 1) * 360 },
        data: {}
      });
    });
    return result;
  };
  const signal = (value: WorkspaceCanvasProjection) =>
    act(() => {
      authoritative.set(value.locator.canvasId, value);
      for (const listener of listeners)
        listener({ type: "workspace.canvas.projection", projection: value });
    });
  const accepted = (index: number) => {
    const { input } = pending[index];
    if (input.intent.kind !== "update_layout") throw Error("Unexpected intent");
    const previous = current(input.locator);
    return {
      ...previous,
      status: "accepted" as const,
      rejectCode: null,
      replica: {
        ...previous.replica,
        revision: previous.replica.revision + 1,
        contentDigest: (previous.replica.revision + 1).toString(16).padStart(64, "0"),
        content: {
          ...previous.replica.content,
          layout: {
            ...previous.replica.content.layout,
            nodes: input.intent.nodes,
            updatedAt: input.intent.updatedAt
          }
        }
      }
    };
  };
  const finish = async (index: number, result = accepted(index)) => {
    signal(result);
    await act(async () => {
      pending[index].done.resolve(result);
      await pending[index].done.promise;
    });
    return result;
  };
  const position = (task: number) =>
    hook.result.current.nodes.find((node) => node.id === `T-00${task}`)?.position.x;
  const payload = (index: number, task: number) => {
    const intent = pending[index].input.intent;
    if (intent.kind !== "update_layout") throw Error("Unexpected intent");
    return intent.nodes.find((node) => node.nodeId === `T-00${task}`)?.x;
  };
  return {
    ...hook,
    pending,
    drag,
    signal,
    accepted,
    finish,
    position,
    payload,
    ready,
    setError,
    authoritative
  };
}
