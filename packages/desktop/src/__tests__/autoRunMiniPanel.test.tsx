/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesktopAutoRunState, DesktopProjectSummary } from "@planweave-ai/runtime";
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
        executorPreflight={{ error: null, loading: false, result: null, runPreflight: vi.fn().mockResolvedValue(null) }}
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

    await userEvent.click(within(screen.getByTestId("auto-run-failure-section")).getByRole("button", { name: "Failure details" }));
    expect(screen.getByTestId("auto-run-error")).toHaveTextContent("Executor failed");
    expect(screen.getByTestId("auto-run-command")).toHaveTextContent("planweave run --scope block --block T-001#B-001");

    await userEvent.click(screen.getByTestId("auto-run-open-record"));
    expect(handleRevealPathInFinder).toHaveBeenCalledWith("/tmp/demo/results/record.json");

    await userEvent.click(screen.getByRole("button", { name: "Reset runtime state" }));
    expect(resetRuntimeStateClick).toHaveBeenCalledTimes(1);
  });
});
