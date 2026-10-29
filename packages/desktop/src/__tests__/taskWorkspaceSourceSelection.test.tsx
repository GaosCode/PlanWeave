/* @vitest-environment jsdom */

import { act, render, waitFor } from "@testing-library/react";
import type {
  DesktopAutoRunEvent,
  DesktopBlockDetail,
  DesktopBlockRunRecordSummary,
  DesktopRunRecord,
  DesktopReviewAttemptSummary,
  DesktopFeedbackRecord
} from "@planweave-ai/runtime";
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
import { autoRunEvent, autoRunState } from "./helpers/autoRunControlHarness";

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

function sourceRun(block: DesktopBlockDetail): DesktopBlockRunRecordSummary {
  return {
    recordId: `${block.ref}::RUN-001`,
    ref: block.ref,
    taskId: block.taskId,
    blockId: block.blockId,
    runId: "RUN-001",
    executor: "codex",
    adapter: "codex",
    executionCwd: project.rootPath,
    projectRoot: project.rootPath,
    agentSessionId: null,
    codexSessionId: null,
    exitCode: 0,
    startedAt: "2026-10-28T00:00:00Z",
    finishedAt: "2026-10-28T00:01:00Z",
    promptPath: "/tmp/prompt.md",
    reportPath: "/tmp/report.md",
    metadataPath: "/tmp/metadata.json",
    stdoutSummary: "completed",
    stderrSummary: ""
  };
}
function installSourceRecords(block: DesktopBlockDetail) {
  const run = sourceRun(block);
  const review: DesktopReviewAttemptSummary = {
    ref: block.ref,
    taskId: block.taskId,
    blockId: block.blockId,
    attemptId: "REV-001",
    verdict: "needs_changes",
    resultPath: "/tmp/review.json",
    metadataPath: "/tmp/review-meta.json",
    content: "Review content",
    contentPreview: "Review content",
    reviewedAt: "2026-10-28T00:01:00Z"
  };
  const feedback: DesktopFeedbackRecord = {
    feedbackId: "FE-001",
    sourceReviewBlockRef: block.ref,
    status: "open",
    latestSubmissionId: null,
    content: "Feedback content",
    sourceReviewAttemptId: review.attemptId,
    createdAt: "2026-10-28T00:01:00Z",
    resolvedAt: null
  };
  const opened: DesktopRunRecord = {
    ...run,
    promptMarkdown: "Prompt",
    reportMarkdown: "Current report",
    displayMarkdown: "Current report",
    displayMarkdownSource: "report",
    metadata: {},
    runnerReadModel: null
  };
  bridges.desktop.target.listBlockRunRecords = vi
    .fn()
    .mockImplementation((_canvas, ref) => Promise.resolve(ref === block.ref ? [run] : []));
  bridges.desktop.target.getReviewAttempts = vi
    .fn()
    .mockImplementation((_canvas, ref) => Promise.resolve(ref === block.ref ? [review] : []));
  bridges.desktop.target.getFeedbackRecords = vi
    .fn()
    .mockImplementation((_canvas, ref) => Promise.resolve(ref === block.ref ? [feedback] : []));
  bridges.desktop.target.getRunRecord = vi.fn().mockResolvedValue(opened);
  return { run, review, feedback, opened };
}

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
  let blockState!: ReturnType<typeof import("../renderer/hooks/useSelectedBlock").useSelectedBlock>;
  vi.doMock("../renderer/hooks/useSelectedBlock", async () => {
    const actual = await vi.importActual<typeof import("../renderer/hooks/useSelectedBlock")>(
      "../renderer/hooks/useSelectedBlock"
    );
    return {
      ...actual,
      useSelectedBlock: (...args: Parameters<typeof actual.useSelectedBlock>) => {
        blockState = actual.useSelectedBlock(...args);
        return blockState;
      }
    };
  });
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
  let error: string | null = null;
  const setError = vi.fn((message: string | null) => {
    error = message;
  });
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
    get blockState() {
      return blockState;
    },
    startRestore: () => act(() => current.graphWorkspace.setFlowInstance(flow)),
    get current() {
      return current;
    },
    get history() {
      return history;
    },
    get error() {
      return error;
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

  it.each([
    "resolve",
    "reject"
  ] as const)("does not publish a retired Block source after Task selection (%s)", async (outcome) => {
    const pending = deferred<DesktopBlockDetail>();
    bridges.desktop.target.getBlockDetail = vi.fn(() => pending.promise);
    const records = installSourceRecords(alpha);
    const probe = await mountSource();
    probe.startRestore();
    act(() => probe.current.projectSidebar.handleTaskPanelSelect(beta.taskId));
    const opened: DesktopRunRecord = { ...records.opened, ...sourceRun(beta) };
    act(() => probe.blockState.setSelectedRunRecord(opened));
    probe.setError.mockClear();
    await act(async () => {
      if (outcome === "resolve") pending.resolve(alpha);
      else pending.reject(new Error("old Alpha restore failed"));
      await Promise.allSettled([pending.promise]);
    });
    expect(probe.current.projectSidebar.selectedTaskPanelId).toBe(beta.taskId);
    expect(probe.blockState.selectedBlock).toBeNull();
    expect(probe.blockState.blockRunRecords).toEqual([]);
    expect(probe.blockState.blockReviewAttempts).toEqual([]);
    expect(probe.blockState.blockFeedbackRecords).toEqual([]);
    expect(probe.blockState.selectedRunRecord).toEqual(opened);
    expect(probe.setError).not.toHaveBeenCalled();
    expect(probe.flow.setViewport).not.toHaveBeenCalled();
  });

  it.each([
    ["Task selection", "resolve"],
    ["route departure", "resolve"],
    ["route departure", "reject"]
  ] as const)("keeps an adopted Block usable after %s retires a pending source (%s)", async (retirement, outcome) => {
    const pending = deferred<DesktopBlockDetail>();
    const getBlockDetail = vi.fn((_canvas, ref) =>
      ref === alpha.ref ? pending.promise : Promise.resolve(beta)
    );
    bridges.desktop.target.getBlockDetail = getBlockDetail;
    const autoRunCallbacks = new Set<(event: DesktopAutoRunEvent) => void>();
    bridges.desktop.target.onAutoRunChanged = vi.fn((callback) => {
      autoRunCallbacks.add(callback);
      return () => autoRunCallbacks.delete(callback);
    });
    const records = installSourceRecords(beta);
    const probe = await mountSource();
    await act(async () => probe.current.graphWorkspace.handleOpenBlockInspector(beta.ref));
    await act(async () => probe.current.graphWorkspace.handleOpenRunRecord(records.run.recordId));
    const assertStableBlock = () => {
      expect.soft(probe.blockState.selectedBlock).toEqual(beta);
      expect.soft(probe.blockState.blockRunRecords).toEqual([records.run]);
      expect.soft(probe.blockState.blockReviewAttempts).toEqual([records.review]);
      expect.soft(probe.blockState.blockFeedbackRecords).toEqual([records.feedback]);
      expect.soft(probe.blockState.selectedRunRecord).toEqual(records.opened);
    };
    // Ordinary Task selection keeps an already adopted Block and its history.
    act(() => probe.current.projectSidebar.handleTaskPanelSelect(beta.taskId));
    assertStableBlock();
    probe.startRestore();
    await waitFor(() => expect(getBlockDetail).toHaveBeenCalledWith(expect.anything(), alpha.ref));
    // A pending source must not clear the adopted Block's opened run.
    assertStableBlock();
    if (retirement === "Task selection") {
      act(() => probe.current.projectSidebar.handleTaskPanelSelect(beta.taskId));
    } else {
      act(() => probe.setActiveView("canvas-map"));
      probe.setError("Current Canvas Map error");
    }
    const currentError = probe.error;
    probe.setError.mockClear();
    await act(async () => {
      if (outcome === "resolve") pending.resolve(alpha);
      else pending.reject(new Error("departed graph source failed"));
      await Promise.allSettled([pending.promise]);
    });
    expect(probe.history.route.view).toBe(retirement === "Task selection" ? "graph" : "canvas-map");
    expect.soft(probe.current.projectSidebar.selectedTaskPanelId).toBe(beta.taskId);
    expect.soft(probe.error).toBe(currentError);
    expect.soft(probe.setError).not.toHaveBeenCalled();
    assertStableBlock();
    const refreshedBeta = { ...beta, title: "Beta refreshed" };
    getBlockDetail.mockImplementation((_canvas, ref) =>
      Promise.resolve(ref === beta.ref ? refreshedBeta : alpha)
    );
    expect(probe.blockState.captureBlockSelection().isCurrent()).toBe(true);
    await act(async () => {
      const event = autoRunEvent(autoRunState({ currentRef: beta.ref }), {
        projectRoot: project.rootPath,
        workspaceRoot: project.workspaceRoot,
        canvasId: "canvas-main"
      });
      for (const callback of autoRunCallbacks) callback(event);
    });
    expect(probe.blockState.selectedBlock).toEqual(refreshedBeta);
    expect(probe.blockState.selectedRunRecord).toEqual(records.opened);
    const updateBlockPrompt = vi
      .fn()
      .mockResolvedValue({ ok: true, affectedTasks: [beta.taskId], diagnostics: [] });
    bridges.desktop.target.updateBlockPrompt = updateBlockPrompt;
    act(() =>
      probe.blockState.setSelectedBlock(
        (current) => current && { ...current, promptMarkdown: "Beta draft" }
      )
    );
    await act(async () => probe.blockState.saveSelectedBlockPrompt());
    expect(updateBlockPrompt).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      beta.ref,
      "Beta draft",
      expect.any(Object)
    );
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
