/* @vitest-environment jsdom */

import { act, render, waitFor } from "@testing-library/react";
import type { DesktopBlockDetail } from "@planweave-ai/runtime";
import type { Edge, ReactFlowInstance, Viewport } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
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
afterEach(() => window.history.replaceState(null, ""));

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
  for (const name of ["useSelectedBlock", "useDesktopProjectSession"]) {
    vi.doUnmock(`../renderer/hooks/${name}`);
  }
  vi.doUnmock("../renderer/task-workspace/useTaskWorkspaceGraphNavigation");
  vi.doUnmock("../renderer/controllers/GraphWorkspaceController");
  vi.resetModules();
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

async function mountSource(source: GraphNavigationSnapshot = snapshot) {
  const { ProjectWorkspaceProvider, useProjectWorkspace } = await import(
    "../renderer/ProjectWorkspaceProvider"
  );
  window.history.replaceState(
    {
      planweaveRoute: { view: "graph", graphSnapshot: source },
      planweaveHistoryIndex: 1,
      planweaveHistoryMaxIndex: 1
    },
    ""
  );
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
    return null;
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
    <Harness>
      <Probe />
    </Harness>
  );
  await waitFor(() =>
    expect(current.projectSidebar.selectedProject?.rootPath).toBe(project.rootPath)
  );
  let viewport: Viewport = { x: 12, y: 34, zoom: 0.8 };
  const flow = {
    getViewport: vi.fn(() => viewport),
    setViewport: vi.fn(async (next: Viewport) => {
      viewport = next;
      return true;
    })
  } as ReactFlowInstance<AppFlowNode, Edge>;
  return {
    startRestore: () => act(() => current.graphWorkspace.setFlowInstance(flow)),
    get current() {
      return current;
    },
    get history() {
      return history;
    },
    setActiveView,
    flow,
    setError,
    ...rendered
  };
}

describe("Task Workspace source selection through ProjectWorkspaceProvider", () => {
  it("keeps a newer Block and viewport when the old graph source detail completes", async () => {
    const pending = deferred<DesktopBlockDetail>();
    const getBlockDetail = vi.fn((_canvas, ref) =>
      ref === alpha.ref ? pending.promise : Promise.resolve(beta)
    );
    bridges.desktop.target.getBlockDetail = getBlockDetail;
    const probe = await mountSource();
    probe.startRestore();
    await waitFor(() => expect(getBlockDetail).toHaveBeenCalledWith(expect.anything(), alpha.ref));
    const route = probe.history.route;
    const historyIndex = probe.history.historyIndex;
    await act(async () => probe.current.graphWorkspace.handleOpenBlockInspector(beta.ref));
    expect(probe.current.projectSidebar.selectedTaskPanelId).toBe(beta.taskId);
    expect(probe.history.route).toBe(route);
    expect(probe.history.historyIndex).toBe(historyIndex);
    const newerViewport = { x: -300, y: 210, zoom: 0.65 };
    await probe.flow.setViewport(newerViewport, { duration: 0 });
    vi.mocked(probe.flow.setViewport).mockClear();
    probe.setError.mockClear();
    await act(async () => {
      pending.resolve(alpha);
      await pending.promise;
    });
    expect(probe.current.projectSidebar.selectedTaskPanelId).toBe(beta.taskId);
    expect(probe.history.route).toBe(route);
    expect(probe.history.historyIndex).toBe(historyIndex);
    expect(probe.setError).not.toHaveBeenCalled();
    expect(probe.flow.getViewport()).toEqual(newerViewport);
    expect(probe.flow.setViewport).not.toHaveBeenCalled();
    act(() => probe.current.graphWorkspace.setFlowInstance({ ...probe.flow }));
    await act(async () => undefined);
    expect(probe.flow.setViewport).not.toHaveBeenCalled();
    expect(getBlockDetail.mock.calls.filter(([, ref]) => ref === alpha.ref)).toHaveLength(1);
  });
  it.each([
    ["Block", snapshot],
    ["Task", { ...snapshot, selectedBlockRef: null }],
    ["clear", { ...snapshot, selectedTaskId: null, selectedBlockRef: null }]
  ] as const)("restores a current %s source and its viewport", async (_label, source) => {
    bridges.desktop.target.getBlockDetail = vi.fn().mockResolvedValue(alpha);
    const probe = await mountSource(source);
    probe.startRestore();
    await waitFor(() =>
      expect(probe.flow.setViewport).toHaveBeenCalledWith(source.viewport, { duration: 0 })
    );
    expect(probe.current.projectSidebar.selectedTaskPanelId).toBe(source.selectedTaskId);
    expect(probe.current.graphWorkspace.selectedBlockPresent).toBe(
      Boolean(source.selectedBlockRef)
    );
    expect(probe.flow.getViewport()).toEqual(source.viewport);
    expect(probe.setError.mock.calls.filter(([message]) => message !== null)).toEqual([]);
  });

  it.each([
    ["Task", { ...snapshot, selectedBlockRef: null }],
    ["clear", { ...snapshot, selectedTaskId: null, selectedBlockRef: null }]
  ] as const)("retires the %s source before applying its viewport when a user selects a Block", async (_label, source) => {
    bridges.desktop.target.getBlockDetail = vi.fn().mockResolvedValue(beta);
    const probe = await mountSource(source);
    probe.startRestore();
    const route = probe.history.route;
    const newerViewport = { x: -300, y: 210, zoom: 0.65 };
    let selection: Promise<void> | undefined;
    act(() => {
      selection = probe.current.graphWorkspace.handleOpenBlockInspector(beta.ref);
    });
    await probe.flow.setViewport(newerViewport, { duration: 0 });
    vi.mocked(probe.flow.setViewport).mockClear();
    await act(async () => selection);
    expect(probe.current.projectSidebar.selectedTaskPanelId).toBe(beta.taskId);
    expect(probe.history.route).toBe(route);
    expect(probe.flow.getViewport()).toEqual(newerViewport);
    expect(probe.flow.setViewport).not.toHaveBeenCalled();
  });

  it("retires a pending Block source when the user selects another Task on the same graph", async () => {
    const pending = deferred<DesktopBlockDetail>();
    bridges.desktop.target.getBlockDetail = vi.fn(() => pending.promise);
    const probe = await mountSource();
    probe.startRestore();
    act(() => probe.current.projectSidebar.handleTaskPanelSelect(beta.taskId));
    await act(async () => {
      pending.resolve(alpha);
      await pending.promise;
    });
    expect(probe.current.projectSidebar.selectedTaskPanelId).toBe(beta.taskId);
    expect(probe.flow.setViewport).not.toHaveBeenCalled();
  });

  it("does not apply a pending source viewport after leaving its graph route", async () => {
    const pending = deferred<DesktopBlockDetail>();
    bridges.desktop.target.getBlockDetail = vi.fn(() => pending.promise);
    const probe = await mountSource();
    probe.startRestore();
    act(() => probe.setActiveView("canvas-map"));
    await act(async () => {
      pending.resolve(alpha);
      await pending.promise;
    });
    expect(probe.history.route.view).toBe("canvas-map");
    expect(probe.flow.setViewport).not.toHaveBeenCalled();
  });

  it.each([
    "same-ID reopen",
    "another project",
    "another canvas"
  ] as const)("retires a pending source across %s without changing the graph route", async (scopeChange) => {
    const pending = deferred<DesktopBlockDetail>();
    bridges.desktop.target.getBlockDetail = vi.fn(() => pending.promise);
    const probe = await mountSource();
    probe.startRestore();
    const route = probe.history.route;
    const nextProject =
      scopeChange === "another project"
        ? { ...project, projectId: "P-002", rootPath: "/tmp/other", workspaceRoot: "/tmp/other" }
        : scopeChange === "another canvas"
          ? {
              ...project,
              taskCanvases: [
                ...project.taskCanvases,
                { ...project.taskCanvases[0]!, canvasId: "canvas-other" }
              ]
            }
          : project;
    const nextCanvas = scopeChange === "another canvas" ? "canvas-other" : "canvas-main";
    await act(async () => probe.current.projectSidebar.loadProject(nextProject, nextCanvas));
    const newerViewport = { x: -300, y: 210, zoom: 0.65 };
    await probe.flow.setViewport(newerViewport, { duration: 0 });
    vi.mocked(probe.flow.setViewport).mockClear();
    await act(async () => {
      pending.resolve(alpha);
      await pending.promise;
    });
    expect(probe.current.projectSidebar.selectedProject?.rootPath).toBe(nextProject.rootPath);
    expect(probe.current.projectSidebar.selectedCanvasId).toBe(nextCanvas);
    expect(probe.history.route).toBe(route);
    expect(probe.flow.getViewport()).toEqual(newerViewport);
    expect(probe.flow.setViewport).not.toHaveBeenCalled();
  });

  it.each([
    "resolve",
    "reject"
  ] as const)("keeps a newer selection after a pending viewport %s and does not retry the retired source", async (outcome) => {
    bridges.desktop.target.getBlockDetail = vi
      .fn()
      .mockImplementation((_canvas, ref) => Promise.resolve(ref === alpha.ref ? alpha : beta));
    const probe = await mountSource();
    const viewportCompletion = deferred<boolean>();
    vi.mocked(probe.flow.setViewport).mockImplementationOnce(() => viewportCompletion.promise);
    probe.startRestore();
    await waitFor(() => expect(probe.flow.setViewport).toHaveBeenCalledOnce());
    await act(async () => probe.current.graphWorkspace.handleOpenBlockInspector(beta.ref));
    probe.setError.mockClear();
    await act(async () => {
      if (outcome === "resolve") viewportCompletion.resolve(true);
      else viewportCompletion.reject(new Error("old viewport failed"));
    });
    act(() => probe.current.graphWorkspace.setFlowInstance({ ...probe.flow }));
    await act(async () => undefined);
    expect(probe.current.projectSidebar.selectedTaskPanelId).toBe(beta.taskId);
    expect(probe.flow.setViewport).toHaveBeenCalledOnce();
    expect(probe.setError).not.toHaveBeenCalled();
  });
});
