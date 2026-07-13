/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  DesktopAutoRunRetrospectiveSummary,
  DesktopAutoRunState,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { AutoRunMiniPanel } from "../renderer/run/AutoRunMiniPanel";
import type { AutoRunNextActionDescriptor } from "../renderer/run/autoRunNextActions";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const t = createTranslator("en");

const project: DesktopProjectSummary = {
  projectId: "P-001",
  name: "Demo",
  rootPath: "/tmp/demo",
  workspaceRoot: "/tmp/demo",
  activeCanvasId: "default",
  taskCanvases: []
};

function createFailedAutoRunState(): DesktopAutoRunState {
  return {
    runId: "RUN-001",
    runSessionId: "SESSION-001",
    projectRoot: "/tmp/demo",
    canvasId: "default",
    phase: "failed",
    scope: { kind: "project" },
    currentRef: "T-001#B-001",
    currentExecutor: "codex",
    stepCount: 2,
    stepLimit: 20,
    elapsedMs: 1500,
    latestRecordId: "record-1",
    latestRecordPath: "/tmp/demo/results/record.json",
    latestOutputSummary: "Command failed",
    statePath: "/tmp/demo/state.json",
    eventLogPath: "/tmp/demo/events.ndjson",
    options: { tmuxEnabled: true },
    error: "Executor failed",
    startedAt: "2026-05-23T00:00:00.000Z",
    updatedAt: "2026-05-23T00:00:02.000Z",
    explanation: {
      phase: "failed",
      currentRef: "T-001#B-001",
      currentExecutor: "codex",
      latestRecordId: "record-1",
      latestRecordPath: "/tmp/demo/results/record.json",
      latestOutputSummary: "Command failed",
      error: "Executor failed",
      nextAction: {
        kind: "resolve_error",
        message: "Retry the failed block.",
        command: "planweave run --scope block --block T-001#B-001",
        targetPath: "/tmp/demo/results/record.json",
        ref: "T-001#B-001"
      }
    }
  };
}

afterEach(() => {
  cleanupRendererTestEnvironment();
});

describe("AutoRunMiniPanel", () => {
  it("shows failed run details and dispatches next action and record actions", async () => {
    const handleAutoRunNextAction = vi.fn().mockResolvedValue(undefined);
    const handleRevealPathInFinder = vi.fn().mockResolvedValue(undefined);
    const resetRuntimeStateClick = vi.fn().mockResolvedValue(undefined);
    const nextAction: AutoRunNextActionDescriptor = {
      command: "retry_ref",
      disabledReason: null,
      enabled: true,
      label: "Retry failed ref",
      manualCommand: "planweave run --scope block --block T-001#B-001",
      message: "Retry the failed block.",
      nextActionKind: "resolve_error",
      recordId: "record-1",
      ref: "T-001#B-001",
      targetPath: "/tmp/demo/results/record.json"
    };

    render(
      <AutoRunMiniPanel
        autoRunNextAction={nextAction}
        autoRunRetrospective={null}
        autoRunState={createFailedAutoRunState()}
        canStop={true}
        executorPreflight={{
          error: null,
          loading: false,
          result: null,
          runPreflight: vi.fn().mockResolvedValue(null)
        }}
        handleAutoRunClick={vi.fn().mockResolvedValue(undefined)}
        handleAutoRunNextAction={handleAutoRunNextAction}
        handleRevealPathInFinder={handleRevealPathInFinder}
        hasProject={true}
        miniRunPanelOpen={true}
        preflightExecutor="codex"
        resetRuntimeStateClick={resetRuntimeStateClick}
        selectedProject={project}
        setMiniRunPanelOpen={vi.fn()}
        stopAutoRunClick={vi.fn().mockResolvedValue(undefined)}
        t={t}
      />
    );

    expect(screen.getByTestId("auto-run-mini-panel")).toBeVisible();
    expect(screen.getByTestId("auto-run-mini-status")).toHaveAttribute("data-phase", "failed");
    expect(screen.getByTestId("auto-run-action-row")).toHaveTextContent("Retry the failed block.");

    await userEvent.click(screen.getByTestId("auto-run-next-action"));
    expect(handleAutoRunNextAction).toHaveBeenCalledWith(nextAction);

    await userEvent.click(
      within(screen.getByTestId("auto-run-failure-section")).getByRole("button", {
        name: "Failure details"
      })
    );
    expect(screen.getByTestId("auto-run-error")).toHaveTextContent("Executor failed");
    expect(screen.getByTestId("auto-run-command")).toHaveTextContent(
      "planweave run --scope block --block T-001#B-001"
    );

    await userEvent.click(screen.getByTestId("auto-run-open-record"));
    expect(handleRevealPathInFinder).toHaveBeenCalledWith("/tmp/demo/results/record.json");

    await userEvent.click(screen.getByRole("button", { name: "Reset runtime state" }));
    expect(resetRuntimeStateClick).toHaveBeenCalledTimes(1);
  });

  it("shows the latest effective metrics while preserving a newer no-work outcome", () => {
    const noWorkState = createFailedAutoRunState();
    noWorkState.phase = "completed";
    noWorkState.runId = "DESKTOP-RUN-0002";
    noWorkState.runSessionId = "SESSION-0002";
    noWorkState.stepCount = 0;
    noWorkState.elapsedMs = 37;
    noWorkState.latestOutputSummary = "no_claimable_blocks";
    noWorkState.explanation = {
      ...noWorkState.explanation,
      phase: "completed",
      latestOutputSummary: "no_claimable_blocks"
    };
    const retrospective: DesktopAutoRunRetrospectiveSummary = {
      runId: "DESKTOP-RUN-0001",
      runSessionId: "SESSION-0001",
      projectRoot: project.rootPath,
      canvasId: "default",
      phase: "completed",
      scope: { kind: "project" },
      startedAt: noWorkState.startedAt,
      updatedAt: noWorkState.updatedAt,
      elapsedMs: 164_000,
      stepCount: 4,
      completedBlockRefs: ["T-001#B-001", "T-001#R-001"],
      blockedRef: null,
      failedReason: null,
      reviewVerdicts: [],
      latestRecordId: "T-001#R-001::RUN-001",
      latestRecordPath: "/tmp/metadata.json",
      latestReportPath: "/tmp/report.md",
      nextAction: noWorkState.explanation.nextAction,
      diagnostics: []
    };

    render(
      <AutoRunMiniPanel
        autoRunNextAction={null}
        autoRunRetrospective={retrospective}
        autoRunState={noWorkState}
        canStop={false}
        executorPreflight={{
          error: null,
          loading: false,
          result: null,
          runPreflight: vi.fn().mockResolvedValue(null)
        }}
        handleAutoRunClick={vi.fn().mockResolvedValue(undefined)}
        handleAutoRunNextAction={vi.fn().mockResolvedValue(undefined)}
        handleRevealPathInFinder={vi.fn().mockResolvedValue(undefined)}
        hasProject={true}
        miniRunPanelOpen={true}
        preflightExecutor={null}
        resetRuntimeStateClick={vi.fn().mockResolvedValue(undefined)}
        selectedProject={project}
        setMiniRunPanelOpen={vi.fn()}
        stopAutoRunClick={vi.fn().mockResolvedValue(undefined)}
        t={t}
      />
    );

    expect(screen.getByTestId("auto-run-elapsed")).toHaveTextContent("2m 44s");
    expect(screen.getByTestId("auto-run-step-count")).toHaveTextContent("4");
    expect(screen.getByTestId("auto-run-session-id")).toHaveTextContent("SESSION-0001");
    expect(screen.getByText(/no_claimable_blocks/)).toBeInTheDocument();
  });

  it("ticks elapsed time locally while a long-running step has no runtime event", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-23T00:00:05.000Z"));
    const runningState = createFailedAutoRunState();
    runningState.phase = "running";
    runningState.elapsedMs = 0;
    runningState.explanation = { ...runningState.explanation, phase: "running" };

    render(
      <AutoRunMiniPanel
        autoRunNextAction={null}
        autoRunRetrospective={null}
        autoRunState={runningState}
        canStop={true}
        executorPreflight={{
          error: null,
          loading: false,
          result: null,
          runPreflight: vi.fn().mockResolvedValue(null)
        }}
        handleAutoRunClick={vi.fn().mockResolvedValue(undefined)}
        handleAutoRunNextAction={vi.fn().mockResolvedValue(undefined)}
        handleRevealPathInFinder={vi.fn().mockResolvedValue(undefined)}
        hasProject={true}
        miniRunPanelOpen={true}
        preflightExecutor={null}
        resetRuntimeStateClick={vi.fn().mockResolvedValue(undefined)}
        selectedProject={project}
        setMiniRunPanelOpen={vi.fn()}
        stopAutoRunClick={vi.fn().mockResolvedValue(undefined)}
        t={t}
      />
    );

    expect(screen.getByTestId("auto-run-elapsed")).toHaveTextContent("5s");
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByTestId("auto-run-elapsed")).toHaveTextContent("7s");
  });
});
