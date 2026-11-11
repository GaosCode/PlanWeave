import { act, renderHook, waitFor } from "@testing-library/react";
import type * as React from "react";
import { useMemo } from "react";
import type { DesktopLayout } from "@planweave-ai/runtime";
import { vi } from "vitest";
import { createDesktopBridgeMock } from "../desktopBridgeMock";
import { deferred, layout, project } from "./desktopProjectFixtures";
import { graph } from "./graphFixtures";
import { createTranslator } from "../../renderer/i18n";
import { defaultDesktopSettings } from "../../renderer/settings";
import type { AppFlowNode } from "../../renderer/types";
import type { WorkspaceCanvasLocator } from "../../shared/canvasLocator";
import type { WorkspaceCanvasProjection } from "../../shared/workspaceCanvasProjection";
import type { WorkspaceCanvasCommandBridge } from "../../renderer/hooks/useWorkspaceCanvasCommands";

const t = createTranslator("en");

export type LayoutSelection = {
  canvasId: string;
  projectRoot: string;
  home: string;
  authority: string;
};
export const initialLayoutSelection: LayoutSelection = {
  canvasId: "canvas-a",
  projectRoot: project.rootPath,
  home: "home-a",
  authority: "authority-a"
};

function projection(locator: WorkspaceCanvasLocator): WorkspaceCanvasProjection {
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
      revision: 1,
      contentDigest: "a".repeat(64),
      canEdit: true,
      optimisticOperationIds: [],
      rejections: [],
      content: {
        ...graph,
        layout,
        blockDependenciesByRef: {},
        taskOpenFeedbackCountByTaskId: {},
        blockPromptMarkdownByRef: {}
      }
    }
  };
}

export async function layoutOwnerHarness(shared: boolean) {
  const writes: Array<{
    layout: DesktopLayout;
    done: ReturnType<typeof deferred<void>>;
  }> = [];
  const write = async (value: DesktopLayout) => {
    const done = deferred<void>();
    writes.push({ layout: value, done });
    await done.promise;
    return value;
  };
  const api = createDesktopBridgeMock({
    saveDesktopLayout: vi.fn((_reference, value) => write(value)),
    resetDesktopLayout: vi.fn(() => write({ ...layout, nodes: [] }))
  });
  let nextOpen: ReturnType<typeof deferred<void>> | null = null;
  const workspaceApi: WorkspaceCanvasCommandBridge = {
    openWorkspaceCanvasSession: vi.fn(async (locator) => {
      const pending = nextOpen;
      nextOpen = null;
      if (pending) await pending.promise;
      return projection(locator);
    }),
    reconnectWorkspaceCanvasSession: vi.fn(async (locator) => projection(locator)),
    closeWorkspaceCanvasSession: vi.fn(async () => undefined),
    onWorkspaceCanvasProjectionSignal: vi.fn(() => () => undefined),
    submitWorkspaceCanvasCommand: vi.fn(async ({ locator, intent }) => {
      if (intent.kind !== "update_layout") throw new Error("Unexpected layout intent");
      const saved = await write({ ...layout, nodes: intent.nodes, updatedAt: intent.updatedAt });
      const accepted = projection(locator);
      return {
        ...accepted,
        replica: {
          ...accepted.replica,
          revision: 2 + writes.length,
          contentDigest: "b".repeat(64),
          content: { ...accepted.replica.content, layout: saved }
        }
      };
    })
  };
  vi.stubGlobal("planweave", api);
  vi.resetModules();
  const { useDesktopProjectSnapshot } = await import(
    "../../renderer/hooks/useDesktopProjectSnapshot"
  );
  const { useWorkspaceCanvasCommands } = await import(
    "../../renderer/hooks/useWorkspaceCanvasCommands"
  );
  const { useGraphPaletteActions } = await import("../../renderer/hooks/useGraphPaletteActions");
  const setLayout = vi.fn();
  const setError = vi.fn();
  const hook = renderHook(
    (selection: LayoutSelection) => {
      const snapshot = useDesktopProjectSnapshot({
        planweaveHome: selection.home,
        graph,
        selectedCanvasId: selection.canvasId,
        selectedProjectRoot: selection.projectRoot,
        setLayout,
        setExecutionPlan: vi.fn(),
        setGraph: vi.fn(),
        setGraphDiagnostics: vi.fn(),
        setPendingImportRecoveries: vi.fn(),
        setProjectDiagnostics: vi.fn(),
        setProjectPromptMarkdown: vi.fn(),
        setProjectPromptPolicy: vi.fn(),
        setRuntimeDiagnostics: vi.fn(),
        setRuntimeRefreshSnapshot: vi.fn(),
        setStatistics: vi.fn(),
        setTodoGroups: vi.fn()
      });
      const locator = useMemo<WorkspaceCanvasLocator | null>(
        () =>
          shared
            ? {
                kind: "workspace",
                connectionProfileId: "profile-a",
                workspaceId: "workspace-a",
                projectId: selection.projectRoot,
                canvasId: selection.canvasId
              }
            : null,
        [selection.canvasId, selection.projectRoot]
      );
      const commands = useWorkspaceCanvasCommands({
        api: workspaceApi,
        authorityKey: selection.authority,
        locator,
        sessionConnected: true,
        t
      });
      const actions = useGraphPaletteActions({
        captureProjectSelection: snapshot.captureProjectSelection,
        canvasLocator: locator,
        flowInstance: null,
        graph,
        layout,
        nodes: [{ id: "T-ALPHA", position: { x: 0, y: 0 } }] as AppFlowNode[],
        loadProject: vi.fn(),
        refreshProjectDerivedState: vi.fn(),
        selectedCanvasId: selection.canvasId,
        selectedProject: { ...project, rootPath: selection.projectRoot },
        selectedBlock: null,
        selectedTaskPanelId: null,
        setLayout,
        setError,
        selectTaskPanel: vi.fn(),
        settings: defaultDesktopSettings,
        workspaceCanvas: shared ? commands : null,
        t
      });
      return { actions, commands };
    },
    { initialProps: initialLayoutSelection }
  );
  const ready = async () => {
    if (shared)
      await waitFor(() => {
        if (hook.result.current.commands.snapshot.connectionPhase !== "connected")
          throw new Error("Workspace session not ready");
      });
  };
  await ready();
  const invoke = (kind: "save" | "reset", x = 240) => {
    if (kind === "reset") return hook.result.current.actions.resetLayout();
    const node = { id: "T-ALPHA", position: { x, y: 180 }, data: {} };
    return hook.result.current.actions.handleNodeDragStop({} as React.MouseEvent, node, [node]);
  };
  const finish = async (index: number, failure = false) => {
    await act(async () => {
      const pending = writes[index];
      if (!pending) throw new Error(`Missing layout write ${index}`);
      if (failure) pending.done.reject(new Error(`layout failure ${index}`));
      else pending.done.resolve();
    });
  };
  return {
    ...hook,
    writes,
    invoke,
    finish,
    ready,
    setLayout,
    setError,
    holdNextOpen: () => {
      const pending = deferred<void>();
      nextOpen = pending;
      return pending;
    }
  };
}
