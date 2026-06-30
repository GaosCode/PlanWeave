/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  DesktopAutoRunState,
  DesktopBlockDetail,
  DesktopGraphViewModel,
  DesktopProjectSummary,
  DesktopTaskDetail,
  ExecutorPreflightResult
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { defaultDesktopSettings } from "../renderer/settings";
import { SettingsAgentsSection } from "../renderer/settings/SettingsAgentsSection";
import { BlockInspector } from "../renderer/inspector/BlockInspector";
import { TaskInspector } from "../renderer/inspector/TaskInspector";
import { FloatingAutoRunControl } from "../renderer/run/FloatingAutoRunControl";

const bridgeMock = vi.hoisted(() => ({
  api: {
    testExecutorProfile: vi.fn()
  }
}));

vi.mock("../renderer/bridge", () => ({
  bridge: bridgeMock.api,
  desktopCanvasReference: (project: DesktopProjectSummary, canvasId?: string | null) => ({
    projectRoot: project.rootPath,
    canvasId
  })
}));

const t = createTranslator("en");
const canvasRef = { projectRoot: "/tmp/project", canvasId: "canvas-main" };

const graph: DesktopGraphViewModel = {
  projectId: "P-001",
  projectTitle: "Project",
  graphVersion: "pgv-test",
  packageFingerprint: "pkg-test",
  executorOptions: ["codex"],
  autoRunPreflightExecutorHint: "codex",
  tasks: [],
  edges: [],
  diagnostics: [],
  dirtyPromptRefs: []
};

function graphWithExecutors(executorOptions: string[], patch: Partial<DesktopGraphViewModel> = {}): DesktopGraphViewModel {
  return {
    ...graph,
    executorOptions,
    ...patch
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

const preflightResult: ExecutorPreflightResult = {
  name: "codex",
  adapter: "codex-exec",
  ok: false,
  message: "Command 'codex' could not be started: missing",
  checks: [
    {
      check: "profile_exists",
      status: "passed",
      message: "Executor profile 'codex' exists."
    },
    {
      check: "command_started",
      status: "failed",
      message: "Command 'codex' could not be started: missing",
      command: "codex",
      cwd: "/tmp/project"
    }
  ]
};

const project: DesktopProjectSummary = {
  projectId: "P-001",
  name: "Project",
  rootPath: "/tmp/project",
  workspaceRoot: "/tmp/.planweave/project",
  activeCanvasId: "canvas-main",
  taskCanvases: []
};

function blockDetail(patch: Partial<DesktopBlockDetail> = {}): DesktopBlockDetail {
  return {
    ref: "T-001#B-001",
    taskId: "T-001",
    blockId: "B-001",
    type: "implementation",
    title: "Implement",
    status: "ready",
    executor: "codex",
    effectiveExecutor: "codex",
    promptMarkdown: "# Prompt",
    promptMissing: false,
    promptSurfaceMarkdown: "# Effective",
    promptSources: [],
    dependencies: [],
    latestRunId: null,
    latestReviewAttemptId: null,
    activeFeedbackId: null,
    exceptionReason: null,
    reviewGate: null,
    ...patch
  };
}

function taskDetail(patch: Partial<DesktopTaskDetail> = {}): DesktopTaskDetail {
  return {
    taskId: "T-001",
    graphVersion: "pgv-test",
    title: "Task",
    status: "ready",
    executor: null,
    promptMarkdown: "# Task",
    promptHash: "hash",
    promptMissing: false,
    acceptance: [],
    blockOrder: [],
    ...patch
  };
}

function autoRunState(): DesktopAutoRunState {
  return {
    runId: "RUN-001",
    runSessionId: "SESSION-001",
    projectRoot: project.rootPath,
    canvasId: "canvas-main",
    scope: { kind: "project" },
    phase: "running",
    stepCount: 1,
    stepLimit: 20,
    currentRef: "T-001#B-001",
    currentExecutor: "codex",
    elapsedMs: 100,
    latestOutputSummary: null,
    latestRecordId: null,
    latestRecordPath: null,
    explanation: {
      phase: "running",
      currentRef: "T-001#B-001",
      currentExecutor: "codex",
      latestRecordId: null,
      latestRecordPath: null,
      latestOutputSummary: null,
      error: null,
      nextAction: {
        kind: "wait",
        message: "Wait for the current Auto Run step to finish.",
        command: null,
        targetPath: null,
        ref: "T-001#B-001"
      }
    },
    statePath: "/tmp/state.json",
    eventLogPath: "/tmp/events.jsonl",
    options: { tmuxEnabled: false },
    error: null,
    startedAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:01.000Z"
  };
}

afterEach(() => {
  cleanup();
  bridgeMock.api.testExecutorProfile.mockReset();
});

describe("executor preflight desktop UI", () => {
  it("runs selected graph executor preflight from settings and renders the full check list", async () => {
    bridgeMock.api.testExecutorProfile.mockResolvedValue(preflightResult);

    render(
      <SettingsAgentsSection
        agentDetectionRefreshing={false}
        agents={[]}
        canvasRef={canvasRef}
        graph={graph}
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        settings={defaultDesktopSettings}
        t={t}
        updateSettings={vi.fn()}
      />
    );

    await userEvent.click(screen.getByTestId("settings-run-executor-preflight"));

    expect(bridgeMock.api.testExecutorProfile).toHaveBeenCalledWith(canvasRef, "codex");
    expect(await screen.findByTestId("executor-preflight-checks")).toHaveTextContent("profile_exists");
    expect(screen.getByTestId("executor-preflight-checks")).toHaveTextContent("command_started");
    expect(screen.getAllByText(/Command 'codex' could not be started/).length).toBeGreaterThan(0);
  });

  it("ignores stale executor preflight responses after the selected graph executor changes", async () => {
    const codex = deferred<ExecutorPreflightResult>();
    const opencode = deferred<ExecutorPreflightResult>();
    bridgeMock.api.testExecutorProfile.mockImplementation((_ref: unknown, executorName: unknown) =>
      executorName === "codex" ? codex.promise : opencode.promise
    );

    const { rerender } = render(
      <SettingsAgentsSection
        agentDetectionRefreshing={false}
        agents={[]}
        canvasRef={canvasRef}
        graph={graphWithExecutors(["codex"])}
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        settings={defaultDesktopSettings}
        t={t}
        updateSettings={vi.fn()}
      />
    );

    await userEvent.click(screen.getByTestId("settings-run-executor-preflight"));
    rerender(
      <SettingsAgentsSection
        agentDetectionRefreshing={false}
        agents={[]}
        canvasRef={canvasRef}
        graph={graphWithExecutors(["opencode"], { graphVersion: "pgv-next", packageFingerprint: "pkg-next" })}
        refreshAgentDetections={vi.fn().mockResolvedValue(undefined)}
        settings={defaultDesktopSettings}
        t={t}
        updateSettings={vi.fn()}
      />
    );
    codex.resolve({
      ...preflightResult,
      name: "codex",
      ok: true,
      message: "stale codex preflight passed",
      checks: []
    });
    await act(async () => {
      await codex.promise;
    });

    expect(screen.queryByText("stale codex preflight passed")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("settings-run-executor-preflight"));
    opencode.resolve({
      ...preflightResult,
      name: "opencode",
      ok: true,
      message: "opencode preflight passed",
      checks: []
    });
    await act(async () => {
      await opencode.promise;
    });

    expect(screen.getByText(/opencode preflight passed/)).toBeInTheDocument();
  });

  it("tests inherited effective block executors without treating inherit as an executor name", async () => {
    bridgeMock.api.testExecutorProfile.mockResolvedValue({ ...preflightResult, ok: true, message: "executor preflight passed" });

    render(
      <BlockInspector
        blockFeedbackRecords={[]}
        blockReviewAttempts={[]}
        blockRunRecords={[]}
        canvasRef={canvasRef}
        error={null}
        executorOptions={["codex"]}
        graph={graph}
        handleOpenRunRecord={vi.fn()}
        onBlockSelect={vi.fn()}
        onClose={vi.fn()}
        saveSelectedBlockExecutor={vi.fn()}
        saveSelectedBlockPrompt={vi.fn()}
        saveSelectedBlockTitle={vi.fn()}
        selectedBlock={blockDetail({ executor: null, effectiveExecutor: "codex" })}
        selectedRunRecord={null}
        setSelectedBlock={vi.fn()}
        setSelectedRunRecord={vi.fn()}
        t={t}
      />
    );

    expect(screen.getByText("Inherit: codex")).toBeInTheDocument();
    expect(screen.getByTestId("block-executor-preflight")).toHaveAccessibleName("Test preflight");
    expect(screen.getByTestId("block-executor-preflight")).not.toHaveTextContent("Test preflight");
    await userEvent.click(screen.getByTestId("block-executor-preflight"));

    expect(bridgeMock.api.testExecutorProfile).toHaveBeenCalledWith(canvasRef, "codex");
    expect(await screen.findByTestId("block-executor-preflight-status")).toHaveTextContent("Preflight passed");
  });

  it("does not preflight a task executor inferred from renderer fallback defaults", () => {
    render(
      <TaskInspector
        canvasRef={canvasRef}
        error={null}
        executorOptions={["manual", "codex"]}
        graph={graphWithExecutors(["manual", "codex"])}
        onClose={vi.fn()}
        saveSelectedTaskExecutor={vi.fn()}
        saveSelectedTaskPrompt={vi.fn()}
        saveSelectedTaskTitle={vi.fn()}
        selectedTask={taskDetail({ executor: null })}
        setSelectedTask={vi.fn()}
        t={t}
      />
    );

    expect(screen.getByTestId("task-executor-preflight")).toBeDisabled();
    expect(bridgeMock.api.testExecutorProfile).not.toHaveBeenCalled();
  });

  it("keeps Auto Run start available while executor preflight is only a manual diagnostic", async () => {
    bridgeMock.api.testExecutorProfile.mockResolvedValue(preflightResult);
    const handleAutoRunClick = vi.fn().mockResolvedValue(undefined);

    render(
      <FloatingAutoRunControl
        affectedTasks={[]}
        autoRunNextAction={null}
        autoRunRetrospective={null}
        autoRunScopeMode="project"
        autoRunState={autoRunState()}
        controlRef={vi.fn()}
        diagnostics={[]}
        dirtyPromptRefs={[]}
        dirtyPromptCount={0}
        autoRunPreflightExecutorHint="codex"
        handleAutoRunClick={handleAutoRunClick}
        handleAutoRunNextAction={vi.fn().mockResolvedValue(undefined)}
        handleRevealPathInFinder={vi.fn().mockResolvedValue(undefined)}
        miniRunPanelOpen={true}
        moveAutoRunControl={vi.fn()}
        onOpenFileSyncRef={vi.fn()}
        refreshPackageFiles={vi.fn().mockResolvedValue(undefined)}
        refreshedPromptCount={0}
        refreshConcurrency={null}
        resetRuntimeStateClick={vi.fn().mockResolvedValue(undefined)}
        selectedBlockPresent={true}
        selectedCanvasId="canvas-other"
        selectedProject={project}
        selectedTaskPanelId="T-001"
        setAutoRunScopeMode={vi.fn()}
        setMiniRunPanelOpen={vi.fn()}
        startAutoRunControlDrag={vi.fn()}
        stopAutoRunClick={vi.fn().mockResolvedValue(undefined)}
        stopAutoRunControlDrag={vi.fn()}
        style={{ right: 24, bottom: 24 }}
        t={t}
      />
    );

    await userEvent.click(within(screen.getByTestId("auto-run-executor-preflight-section")).getByRole("button", { name: "Executor preflight" }));
    await userEvent.click(screen.getByTestId("auto-run-executor-preflight"));
    expect(bridgeMock.api.testExecutorProfile).toHaveBeenCalledWith(canvasRef, "codex");
    await waitFor(() => expect(screen.getByTestId("auto-run-executor-preflight-status")).toHaveTextContent("Preflight failed"));
    expect(screen.getByTestId("auto-run-executor-preflight-status")).not.toHaveTextContent(preflightResult.message);
    expect(screen.queryByText(preflightResult.message)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Auto Run" }));
    expect(handleAutoRunClick).toHaveBeenCalledTimes(1);
  });

  it("runs startup executor preflight from the Auto Run panel with a runtime executor hint", async () => {
    bridgeMock.api.testExecutorProfile.mockResolvedValue({ ...preflightResult, ok: true, message: "executor preflight passed" });

    render(
      <FloatingAutoRunControl
        affectedTasks={[]}
        autoRunNextAction={null}
        autoRunRetrospective={null}
        autoRunScopeMode="project"
        autoRunState={null}
        controlRef={vi.fn()}
        diagnostics={[]}
        dirtyPromptRefs={[]}
        dirtyPromptCount={0}
        autoRunPreflightExecutorHint="codex"
        handleAutoRunClick={vi.fn().mockResolvedValue(undefined)}
        handleAutoRunNextAction={vi.fn().mockResolvedValue(undefined)}
        handleRevealPathInFinder={vi.fn().mockResolvedValue(undefined)}
        miniRunPanelOpen={true}
        moveAutoRunControl={vi.fn()}
        onOpenFileSyncRef={vi.fn()}
        refreshPackageFiles={vi.fn().mockResolvedValue(undefined)}
        refreshedPromptCount={0}
        refreshConcurrency={null}
        resetRuntimeStateClick={vi.fn().mockResolvedValue(undefined)}
        selectedBlockPresent={false}
        selectedCanvasId="canvas-main"
        selectedProject={project}
        selectedTaskPanelId={null}
        setAutoRunScopeMode={vi.fn()}
        setMiniRunPanelOpen={vi.fn()}
        startAutoRunControlDrag={vi.fn()}
        stopAutoRunClick={vi.fn().mockResolvedValue(undefined)}
        stopAutoRunControlDrag={vi.fn()}
        style={{ right: 24, bottom: 24 }}
        t={t}
      />
    );

    expect(screen.getByTestId("auto-run-executor-preflight-section")).toHaveTextContent("Executor preflight");
    expect(screen.queryByText("codex")).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByTestId("auto-run-executor-preflight-section")).getByRole("button", { name: "Executor preflight" }));
    expect(screen.getByText("codex")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("auto-run-executor-preflight"));

    expect(bridgeMock.api.testExecutorProfile).toHaveBeenCalledWith(canvasRef, "codex");
    await waitFor(() => expect(screen.getByTestId("auto-run-executor-preflight-status")).toHaveTextContent("Preflight passed"));
  });
});
