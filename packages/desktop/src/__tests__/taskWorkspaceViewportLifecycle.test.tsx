/* @vitest-environment jsdom */

import { act, render, waitFor, screen, cleanup } from "@testing-library/react";
import type { DesktopBlockDetail } from "@planweave-ai/runtime";
import type { Edge, ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ReactNode, Suspense } from "react";
import type { ProjectWorkspaceValue } from "../renderer/ProjectWorkspaceProvider";
import type { ProjectWorkspaceShellInput } from "../renderer/projectWorkspaceShell";
import { useAppViewHistory } from "../renderer/hooks/useAppViewHistory";
import { createTranslator } from "../renderer/i18n";
import { defaultDesktopSettings } from "../shared/desktopSettings";
import type { AppFlowNode } from "../renderer/types";
import type { GraphNavigationSnapshot } from "../renderer/taskWorkspaceNavigation";
import { bridges, installProviderHarness } from "./helpers/projectWorkspaceProviderHarness";
import { deferred, project, projectSnapshot } from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";

installProviderHarness();
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  flowLifecycle.instances = [];
  flowLifecycle.pendingInit = [];
  flowLifecycle.holdInit = false;
});

const flowLifecycle = vi.hoisted(() => ({
  instances: [] as ReactFlowInstance<AppFlowNode, Edge>[],
  pendingInit: [] as (() => void)[],
  holdInit: false
}));
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    MiniMap: () => null,
    ReactFlow: (props: import("@xyflow/react").ReactFlowProps<AppFlowNode, Edge>) => (
      <actual.ReactFlow
        {...props}
        onInit={(instance) => {
          const initialize = () => {
            vi.spyOn(instance, "setViewport");
            vi.spyOn(instance, "fitView");
            vi.spyOn(instance, "setCenter");
            flowLifecycle.instances.push(instance);
            props.onInit?.(instance);
          };
          if (flowLifecycle.holdInit) flowLifecycle.pendingInit.push(initialize);
          else initialize();
        }}
      />
    )
  };
});
vi.mock("../renderer/run/FloatingAutoRunControl", () => ({ FloatingAutoRunControl: () => null }));
vi.mock("../renderer/views/TaskWorkspaceAppRoute", () => ({
  TaskWorkspaceAppRoute: () => <div data-testid="workspace-route" />
}));

const alpha: DesktopBlockDetail = {
  ref: "T-ALPHA#B-001",
  taskId: "T-ALPHA",
  blockId: "B-001",
  type: "implementation",
  title: "Alpha",
  status: "ready",
  executor: null,
  effectiveExecutor: "codex",
  promptMarkdown: "Alpha",
  promptMissing: false,
  promptSurfaceMarkdown: "Alpha",
  promptSources: [],
  dependencies: [],
  latestRunId: null,
  latestReviewAttemptId: null,
  activeFeedbackId: null,
  exceptionReason: null,
  reviewGate: null
};
const beta: DesktopBlockDetail = { ...alpha, ref: "T-BETA#B-001", taskId: "T-BETA", title: "Beta" };
const snapshot: GraphNavigationSnapshot = {
  projectRoot: project.rootPath,
  canvasId: "canvas-main",
  viewport: { x: 120, y: -80, zoom: 1.25 },
  selectedTaskId: alpha.taskId,
  selectedBlockRef: alpha.ref
};
const graphWithBlocks = {
  ...graph,
  tasks: graph.tasks.map((task) => ({
    ...task,
    blocks: [{ ...(task.taskId === alpha.taskId ? alpha : beta), dispatchable: true }]
  }))
};

beforeEach(() => {
  for (const name of ["useSelectedBlock", "useDesktopProjectSession", "useTaskNodeFocus"]) {
    vi.doUnmock(`../renderer/hooks/${name}`);
  }
  vi.doUnmock("../renderer/task-workspace/useTaskWorkspaceGraphNavigation");
  vi.doUnmock("../renderer/controllers/GraphWorkspaceController");
  vi.doMock("../renderer/hooks/useCollaborationCanvasPresence", () => ({
    useCollaborationCanvasPresence: () => undefined
  }));
  vi.resetModules();
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(700);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback([{ target } as ResizeObserverEntry], this);
      }
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      m22 = 1;
      m11 = 1;
    }
  );
  bridges.desktop.target.getDesktopProjectSnapshot = vi
    .fn()
    .mockResolvedValue(projectSnapshot({ graph: graphWithBlocks }));
  bridges.desktop.target.getLatestAutoRunSummaryWithDiagnostics = vi.fn().mockResolvedValue({
    state: null,
    diagnostics: []
  });
  for (const method of ["listBlockRunRecords", "getReviewAttempts", "getFeedbackRecords"]) {
    bridges.desktop.target[method] = vi.fn().mockResolvedValue([]);
  }
});

async function mountGraph() {
  const { ProjectWorkspaceProvider, useProjectWorkspace } = await import(
    "../renderer/ProjectWorkspaceProvider"
  );
  const { ReactFlowProvider } = await import("@xyflow/react");
  const { WorkspaceTabs } = await import("../renderer/views/WorkspaceTabs");
  window.history.replaceState(null, "");
  let current!: ProjectWorkspaceValue;
  let history!: ReturnType<typeof useAppViewHistory>[2];
  let setActiveView!: ProjectWorkspaceShellInput["setActiveView"];
  const setError = vi.fn();
  const settings = { ...defaultDesktopSettings, runtimePath: project.workspaceRoot };
  const stableShell = {
    agentDetectionRefreshing: false,
    agentDetections: [],
    globalPromptMarkdown: null,
    language: "en",
    refreshAgentDetections: vi.fn(),
    refreshRuntimeTools: vi.fn(),
    runtimeTools: { tmux: { available: false, command: "tmux" } },
    setError,
    setSuccessMessage: vi.fn(),
    settings,
    settingsHydrated: true,
    t: createTranslator("en"),
    updateLayoutSettings: vi.fn(),
    updateGlobalPrompt: vi.fn(),
    updateSettings: vi.fn(),
    updateSettingsAndWait: vi.fn()
  } satisfies Omit<ProjectWorkspaceShellInput, "activeView" | "setActiveView" | "appHistory">;
  function Probe() {
    current = useProjectWorkspace();
    return <WorkspaceTabs />;
  }
  function Harness({ children }: { children: ReactNode }) {
    const [activeView, setView, appHistory] = useAppViewHistory("graph");
    history = appHistory;
    setActiveView = setView;
    return (
      <ProjectWorkspaceProvider
        shell={{ ...stableShell, activeView, appHistory, setActiveView: setView }}
      >
        {children}
      </ProjectWorkspaceProvider>
    );
  }
  const rendered = render(
    <ReactFlowProvider>
      <Harness>
        <Suspense>
          <Probe />
        </Suspense>
      </Harness>
    </ReactFlowProvider>
  );
  await waitFor(() =>
    expect(current.projectSidebar.selectedProject?.rootPath).toBe(project.rootPath)
  );
  await waitFor(() => expect(flowLifecycle.instances.length).toBe(1));
  const initialFlow = flowLifecycle.instances[0]!;
  await waitFor(() => expect(initialFlow.fitView).toHaveBeenCalledOnce());
  await act(async () => {
    await vi.mocked(initialFlow.fitView).mock.results[0]!.value;
  });
  return {
    initialFlow,
    get flow() {
      return flowLifecycle.instances.at(-1)!;
    },
    get current() {
      return current;
    },
    get history() {
      return history;
    },
    setActiveView,
    setError,
    ...rendered
  };
}

async function enterWorkspace(
  probe: Awaited<ReturnType<typeof mountGraph>>,
  kind: "Block" | "Task",
  taskId = alpha.taskId
) {
  if (kind === "Block") {
    act(() => probe.current.graphWorkspace.handleOpenBlockWorkspace(`${taskId}#B-001`));
  } else {
    const taskNode = probe.current.graphWorkspace.nodes.find((node) => node.id === taskId)!;
    act(() => taskNode.data.onTaskWorkspaceOpen(taskId));
  }
  await screen.findByTestId("workspace-route");
  expect(await probe.flow.setViewport(snapshot.viewport, { duration: 0 })).toBe(false);
}

describe("Graph viewport across real ReactFlow route lifecycles", () => {
  it.each([
    "Block",
    "Task"
  ] as const)("restores the saved %s source after the old flow unmounts and the new onInit runs", async (kind) => {
    bridges.desktop.target.getBlockDetail = vi.fn().mockResolvedValue(alpha);
    const probe = await mountGraph();
    await act(async () => {
      await probe.flow.setViewport(snapshot.viewport, { duration: 0 });
    });
    flowLifecycle.holdInit = true;
    await enterWorkspace(probe, kind);
    act(() => probe.history.returnToTaskWorkspaceSource());
    await waitFor(() => expect(flowLifecycle.pendingInit).toHaveLength(1));
    expect(probe.current.projectSidebar.selectedTaskPanelId).toBeNull();
    act(() => flowLifecycle.pendingInit.shift()!());
    await waitFor(() => expect(probe.flow.getViewport()).toEqual(snapshot.viewport));
    expect(probe.current.projectSidebar.selectedTaskPanelId).toBe(alpha.taskId);
    await act(async () => undefined);
    expect(probe.flow.getViewport()).toEqual(snapshot.viewport);
    expect(probe.flow.fitView).not.toHaveBeenCalled();
    expect(probe.flow.setCenter).not.toHaveBeenCalled();
    expect(probe.setError.mock.calls.filter(([message]) => message !== null)).toEqual([]);
  });
  it("fits a first graph without a history snapshot", async () => {
    const probe = await mountGraph();
    expect(probe.history.graphSnapshot).toBeNull();
    const fitted = probe.flow.getViewport();
    expect(Number.isFinite(fitted.x) && Number.isFinite(fitted.y)).toBe(true);
    expect(fitted).not.toEqual({ x: 0, y: 0, zoom: 1 });
    expect(probe.flow.fitView).toHaveBeenCalledOnce();
    expect(probe.flow.getViewport()).toEqual(fitted);
  });

  it("keeps B and its new viewport after late A, then restores B on its next normal round trip", async () => {
    const pending = deferred<DesktopBlockDetail>();
    let holdAlpha = true;
    const getBlockDetail = vi.fn((_canvas, ref) =>
      ref === alpha.ref && holdAlpha
        ? pending.promise
        : Promise.resolve(ref === alpha.ref ? alpha : beta)
    );
    bridges.desktop.target.getBlockDetail = getBlockDetail;
    const probe = await mountGraph();
    await act(async () => {
      await probe.flow.setViewport(snapshot.viewport, { duration: 0 });
    });
    await enterWorkspace(probe, "Block");
    act(() => probe.history.returnToTaskWorkspaceSource());
    await waitFor(() => expect(getBlockDetail).toHaveBeenCalledWith(expect.anything(), alpha.ref));
    await act(async () => probe.current.graphWorkspace.handleOpenBlockInspector(beta.ref));
    expect(probe.current.projectSidebar.selectedTaskPanelId).toBe(beta.taskId);
    // Explicit user focus still works on a route which retains A's history snapshot.
    expect(probe.flow.setCenter).toHaveBeenCalled();
    await act(async () => {
      await Promise.all(vi.mocked(probe.flow.setCenter).mock.results.map((result) => result.value));
    });
    const viewportB = { x: -300, y: 210, zoom: 0.65 };
    await act(async () => {
      await probe.flow.setViewport(viewportB, { duration: 0 });
    });
    const routeB = probe.history.route;
    const indexB = probe.history.historyIndex;
    await act(async () => {
      holdAlpha = false;
      pending.resolve(alpha);
      await pending.promise;
    });
    expect(probe.current.projectSidebar.selectedTaskPanelId).toBe(beta.taskId);
    expect(probe.history.route).toBe(routeB);
    expect(probe.history.historyIndex).toBe(indexB);
    expect(probe.flow.getViewport()).toEqual(viewportB);
    const alphaCalls = getBlockDetail.mock.calls.filter(([, ref]) => ref === alpha.ref).length;
    await enterWorkspace(probe, "Block", beta.taskId);
    act(() => probe.history.returnToTaskWorkspaceSource());
    await waitFor(() => expect(probe.flow.getViewport()).toEqual(viewportB));
    expect(probe.current.projectSidebar.selectedTaskPanelId).toBe(beta.taskId);
    expect(getBlockDetail.mock.calls.filter(([, ref]) => ref === alpha.ref)).toHaveLength(
      alphaCalls
    );
    expect(probe.flow.fitView).not.toHaveBeenCalled();
    expect(probe.flow.setCenter).not.toHaveBeenCalled();
  });
});
