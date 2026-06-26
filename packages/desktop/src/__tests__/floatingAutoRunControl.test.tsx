/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesktopAutoRunRetrospectiveSummary, DesktopAutoRunState, DesktopProjectSummary } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { FloatingAutoRunControl } from "../renderer/run/FloatingAutoRunControl";
import type { AutoRunNextActionDescriptor } from "../renderer/run/autoRunNextActions";

const t = createTranslator("en");

const project: DesktopProjectSummary = {
  projectId: "P-001",
  name: "Demo",
  rootPath: "/tmp/demo",
  workspaceRoot: "/tmp/demo",
  activeCanvasId: "canvas-main",
  taskCanvases: [
    {
      canvasId: "canvas-main",
      name: "Main canvas",
      taskCount: 2,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z"
    }
  ]
};

function createAutoRunState(patch: Partial<Omit<DesktopAutoRunState, "explanation">> & { explanation?: DesktopAutoRunState["explanation"] } = {}): DesktopAutoRunState {
  const state = {
    runId: "RUN-001",
    projectRoot: "/tmp/project",
    canvasId: "canvas-main",
    phase: "running",
    scope: { kind: "project" },
    currentRef: null,
    currentExecutor: null,
    stepCount: 0,
    stepLimit: 20,
    elapsedMs: 0,
    latestRecordId: null,
    latestRecordPath: null,
    latestOutputSummary: null,
    statePath: "/tmp/state.json",
    eventLogPath: "/tmp/events.ndjson",
    options: { tmuxEnabled: true },
    error: null,
    startedAt: "2026-05-23T00:00:00.000Z",
    updatedAt: "2026-05-23T00:00:00.000Z",
    ...patch
  } satisfies Omit<DesktopAutoRunState, "explanation">;
  return {
    ...state,
    explanation: patch.explanation ?? {
      phase: state.phase,
      currentRef: state.currentRef,
      currentExecutor: state.currentExecutor,
      latestRecordId: state.latestRecordId,
      latestRecordPath: state.latestRecordPath,
      latestOutputSummary: state.latestOutputSummary,
      error: state.error,
      nextAction: {
        kind: "wait",
        message: "Wait for the current Auto Run step to finish.",
        command: null,
        targetPath: null,
        ref: state.currentRef
      }
    }
  };
}

function installPointerMocks(): void {
  class ResizeObserverMock {
    disconnect = vi.fn();
    observe = vi.fn();
    unobserve = vi.fn();
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  Object.defineProperty(window.HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: vi.fn(() => false) });
  Object.defineProperty(window.HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(window.HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FloatingAutoRunControl", () => {
  it("shows Auto Run runtime state and dispatches scope, sync, run, and record actions", async () => {
    installPointerMocks();
    const autoRunState = createAutoRunState({
      currentRef: "T-001#B-001",
      currentExecutor: "codex",
      latestRecordId: "T-001#B-001::RUN-001",
      latestRecordPath: "/tmp/result.json"
    });
    const handleAutoRunClick = vi.fn().mockResolvedValue(undefined);
    const handleRevealPathInFinder = vi.fn().mockResolvedValue(undefined);
    const handleAutoRunNextAction = vi.fn().mockResolvedValue(undefined);
    const onOpenFileSyncRef = vi.fn();
    const refreshPackageFiles = vi.fn().mockResolvedValue(undefined);
    const setAutoRunScopeMode = vi.fn();
    const resetRuntimeStateClick = vi.fn().mockResolvedValue(undefined);
    const stopAutoRunClick = vi.fn().mockResolvedValue(undefined);
    const waitAction: AutoRunNextActionDescriptor = {
      command: "wait",
      disabledReason: "Wait.",
      enabled: false,
      label: "Wait",
      manualCommand: null,
      message: "Wait.",
      nextActionKind: "wait",
      recordId: "r",
      ref: "T-001#B-001",
      targetPath: "/tmp/result.json"
    };
    const retrospective: DesktopAutoRunRetrospectiveSummary = {
      runId: "RUN-001",
      projectRoot: project.rootPath,
      canvasId: "canvas-main",
      phase: "running",
      scope: { kind: "project" },
      startedAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:01.000Z",
      elapsedMs: 1000,
      stepCount: 1,
      completedBlockRefs: ["T-001#B-001"],
      blockedRef: null,
      failedReason: null,
      reviewVerdicts: [{ ref: "T-001#R-001", attemptId: "r1", verdict: "passed", contentPreview: "ok" }],
      latestRecordId: "r",
      latestRecordPath: "/tmp/result.json",
      latestReportPath: "/tmp/report.md",
      nextAction: autoRunState.explanation.nextAction,
      diagnostics: []
    };

    const { rerender } = render(
      <FloatingAutoRunControl
        affectedTasks={["T-002"]}
        autoRunNextAction={waitAction}
        autoRunRetrospective={retrospective}
        autoRunScopeMode="project"
        autoRunState={autoRunState}
        diagnostics={[{ code: "prompt_changed", message: "Prompt changed on disk.", path: "nodes/T-001/prompt.md" }]}
        dirtyPromptRefs={["T-001#B-001"]}
        dirtyPromptCount={2}
        handleAutoRunClick={handleAutoRunClick}
        handleAutoRunNextAction={handleAutoRunNextAction}
        handleRevealPathInFinder={handleRevealPathInFinder}
        miniRunPanelOpen={true}
        moveAutoRunControl={vi.fn()}
        onOpenFileSyncRef={onOpenFileSyncRef}
        refreshPackageFiles={refreshPackageFiles}
        refreshedPromptCount={3}
        refreshConcurrency={4}
        resetRuntimeStateClick={resetRuntimeStateClick}
        selectedBlockPresent={true}
        selectedProject={project}
        selectedTaskPanelId="T-001"
        setAutoRunScopeMode={setAutoRunScopeMode}
        setMiniRunPanelOpen={vi.fn()}
        startAutoRunControlDrag={vi.fn()}
        stopAutoRunClick={stopAutoRunClick}
        stopAutoRunControlDrag={vi.fn()}
        style={{ right: 24, bottom: 24 }}
        t={t}
      />
    );

    expect(screen.getByTestId("auto-run-mini-panel")).toBeVisible();
    expect(screen.getByTestId("auto-run-mini-status")).toHaveAttribute("data-phase", "running");
    expect(screen.getByTestId("auto-run-mini-status")).toHaveAttribute("data-run-id", "RUN-001");
    expect(screen.getByText("Current block: T-001#B-001")).toBeInTheDocument();
    expect(screen.getByText("Agent: codex")).toBeInTheDocument();
    expect(screen.getByTestId("auto-run-action-row")).toHaveTextContent("Wait.");
    expect(screen.getByTestId("auto-run-next-action")).toBeDisabled();
    expect(screen.getByTestId("auto-run-retrospective")).toHaveTextContent("Completed refs");
    expect(screen.getByTestId("auto-run-completed-refs")).toHaveTextContent("1");
    expect(screen.getByTestId("auto-run-latest-report-path")).toHaveTextContent("/tmp/report.md");
    expect(screen.getByTestId("file-sync-unread-count")).toHaveTextContent("4");
    await userEvent.click(screen.getByRole("button", { name: "View file sync changes" }));
    expect(screen.getByTestId("file-sync-popover")).toBeVisible();
    expect(screen.queryByTestId("file-sync-unread-count")).not.toBeInTheDocument();
    expect(screen.getByText("Dirty Prompts")).toBeInTheDocument();
    expect(screen.getByText("T-001#B-001")).toBeInTheDocument();
    expect(screen.getByText("Affected tasks")).toBeInTheDocument();
    expect(screen.getByText("T-002")).toBeInTheDocument();
    expect(screen.getByTestId("file-sync-diagnostic")).toHaveTextContent("Prompt changed on disk.");
    expect(screen.getByTestId("file-sync-refreshed-prompt-count")).toHaveTextContent("3");
    expect(screen.getByTestId("file-sync-refresh-concurrency")).toHaveTextContent("4");
    await userEvent.click(screen.getByRole("button", { name: "T-001#B-001" }));
    expect(onOpenFileSyncRef).toHaveBeenCalledWith("T-001#B-001");
    expect(refreshPackageFiles).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Recheck files" }));
    await userEvent.click(screen.getByRole("button", { name: "Auto Run" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Reset runtime state" })[0]);
    await userEvent.click(screen.getAllByRole("button", { name: "Stop" })[0]);
    expect(screen.getByTestId("auto-run-open-record")).toHaveAttribute("data-record-path", "/tmp/result.json");
    expect(screen.getByTestId("auto-run-open-record")).toHaveAttribute("data-run-id", "RUN-001");
    await userEvent.click(screen.getByTestId("auto-run-open-record"));

    expect(refreshPackageFiles).toHaveBeenCalledTimes(1);
    expect(handleAutoRunClick).toHaveBeenCalledTimes(1);
    expect(resetRuntimeStateClick).toHaveBeenCalledTimes(1);
    expect(stopAutoRunClick).toHaveBeenCalledTimes(1);
    expect(handleRevealPathInFinder).toHaveBeenCalledWith("/tmp/result.json");

    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "Selected Task" }));
    expect(setAutoRunScopeMode).toHaveBeenCalledWith("selectedTask");

    rerender(
      <FloatingAutoRunControl
        affectedTasks={[]}
        autoRunNextAction={null}
        autoRunRetrospective={null}
        autoRunScopeMode="project"
        autoRunState={createAutoRunState({
          runId: "RUN-FAILED",
          phase: "failed",
          currentRef: "T-001#B-001",
          currentExecutor: "codex",
          latestRecordId: "T-001#B-001::RUN-FAILED",
          latestRecordPath: "/tmp/failed-result.json",
          latestOutputSummary: "Executor failed",
          explanation: {
            phase: "failed",
            currentRef: "T-001#B-001",
            currentExecutor: "codex",
            latestRecordId: "T-001#B-001::RUN-FAILED",
            latestRecordPath: "/tmp/failed-result.json",
            latestOutputSummary: "Executor failed",
            error: "Executor exited with code 1.",
            nextAction: {
              kind: "inspect_record",
              message: "Open the latest record and fix the failure.",
              command: null,
              targetPath: "/tmp/failed-result.json",
              ref: "T-001#B-001"
            }
          },
          error: "Executor exited with code 1."
        })}
        diagnostics={[]}
        dirtyPromptRefs={[]}
        dirtyPromptCount={0}
        handleAutoRunClick={handleAutoRunClick}
        handleAutoRunNextAction={handleAutoRunNextAction}
        handleRevealPathInFinder={handleRevealPathInFinder}
        miniRunPanelOpen={true}
        moveAutoRunControl={vi.fn()}
        onOpenFileSyncRef={onOpenFileSyncRef}
        refreshPackageFiles={refreshPackageFiles}
        refreshedPromptCount={0}
        refreshConcurrency={null}
        resetRuntimeStateClick={resetRuntimeStateClick}
        selectedBlockPresent={true}
        selectedProject={project}
        selectedTaskPanelId="T-001"
        setAutoRunScopeMode={setAutoRunScopeMode}
        setMiniRunPanelOpen={vi.fn()}
        startAutoRunControlDrag={vi.fn()}
        stopAutoRunClick={stopAutoRunClick}
        stopAutoRunControlDrag={vi.fn()}
        style={{ right: 24, bottom: 24 }}
        t={t}
      />
    );

    expect(screen.getByTestId("auto-run-mini-status")).toHaveAttribute("data-phase", "failed");
    expect(screen.getByTestId("auto-run-mini-status")).toHaveAttribute("data-run-id", "RUN-FAILED");
    expect(screen.getByTestId("auto-run-error")).toHaveTextContent("Executor exited with code 1.");
    expect(screen.getByTestId("auto-run-failure-details")).toHaveTextContent("Next action");
    expect(screen.getByTestId("auto-run-failure-details")).toHaveTextContent("Open the latest record and fix the failure.");
    expect(screen.getByTestId("auto-run-open-record")).toHaveAttribute("data-record-path", "/tmp/failed-result.json");
    expect(screen.getByTestId("auto-run-open-record")).toHaveAttribute("data-run-id", "RUN-FAILED");
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("auto-run-open-record"));

    expect(handleRevealPathInFinder).toHaveBeenCalledWith("/tmp/failed-result.json");
  });

  it("keeps Auto Run visible but disabled when no project is open", () => {
    render(
      <FloatingAutoRunControl
        affectedTasks={[]}
        autoRunNextAction={null}
        autoRunRetrospective={null}
        autoRunScopeMode="project"
        autoRunState={null}
        diagnostics={[]}
        dirtyPromptRefs={[]}
        dirtyPromptCount={0}
        handleAutoRunClick={vi.fn().mockResolvedValue(undefined)}
        handleAutoRunNextAction={vi.fn().mockResolvedValue(undefined)}
        handleRevealPathInFinder={vi.fn().mockResolvedValue(undefined)}
        miniRunPanelOpen={false}
        moveAutoRunControl={vi.fn()}
        onOpenFileSyncRef={vi.fn()}
        refreshPackageFiles={vi.fn().mockResolvedValue(undefined)}
        refreshedPromptCount={0}
        refreshConcurrency={null}
        resetRuntimeStateClick={vi.fn().mockResolvedValue(undefined)}
        selectedBlockPresent={false}
        selectedProject={null}
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

    expect(screen.getByText("Open a project before running Auto Run.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Auto Run" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset runtime state" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "View file sync changes" })).toBeDisabled();
  });
});
