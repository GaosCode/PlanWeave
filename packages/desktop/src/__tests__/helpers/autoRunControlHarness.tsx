import { cleanup, renderHook } from "@testing-library/react";
import { useState } from "react";
import type {
  AutoRunExplanation,
  DesktopAutoRunEvent,
  DesktopAutoRunState,
  DesktopBlockDetail,
  DesktopBridgeApi,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import { vi } from "vitest";
import { createDesktopBridgeMock } from "../desktopBridgeMock";
import { createTranslator } from "../../renderer/i18n";

type UseAutoRunControl = typeof import("../../renderer/hooks/useAutoRunControl").useAutoRunControl;
type AutoRunControlArgs = Parameters<UseAutoRunControl>[0];

export const project: DesktopProjectSummary = {
  projectId: "P-001",
  name: "Demo project",
  rootPath: "/tmp/demo",
  workspaceRoot: "/tmp/demo",
  activeCanvasId: null,
  taskCanvases: []
};

export const selectedBlock: DesktopBlockDetail = {
  ref: "T-ALPHA#B-001",
  taskId: "T-ALPHA",
  blockId: "B-001",
  type: "implementation",
  title: "Implement alpha",
  status: "ready",
  executor: null,
  effectiveExecutor: "codex",
  promptMarkdown: "# Implement alpha",
  promptMissing: false,
  promptSurfaceMarkdown: "# Effective implement alpha",
  promptSources: [],
  dependencies: [],
  latestRunId: null,
  latestReviewAttemptId: null,
  activeFeedbackId: null,
  exceptionReason: null,
  reviewGate: null
};

export function explanationFor(
  state: Omit<DesktopAutoRunState, "explanation">
): AutoRunExplanation {
  return {
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
  };
}

export function autoRunState(patch: Partial<DesktopAutoRunState> = {}): DesktopAutoRunState {
  const state = {
    runId: "DESKTOP-RUN-0001",
    projectRoot: project.rootPath,
    canvasId: "canvas-main",
    scope: { kind: "project" },
    phase: "running",
    stepCount: 0,
    stepLimit: 20,
    currentRef: null,
    currentExecutor: null,
    elapsedMs: 0,
    latestOutputSummary: null,
    latestRecordId: null,
    latestRecordPath: null,
    statePath: "/tmp/project/.planweave/results/auto-runs/DESKTOP-RUN-0001/state.json",
    eventLogPath: "/tmp/project/.planweave/results/auto-runs/DESKTOP-RUN-0001/events.ndjson",
    options: { tmuxEnabled: true },
    error: null,
    startedAt: "2026-05-23T00:00:00.000Z",
    updatedAt: "2026-05-23T00:00:00.000Z",
    ...patch
  };
  return { ...state, explanation: patch.explanation ?? explanationFor(state) };
}

export function autoRunEvent(
  state: DesktopAutoRunState,
  patch: Partial<DesktopAutoRunEvent> = {}
): DesktopAutoRunEvent {
  return {
    projectRoot: state.projectRoot,
    canvasId: state.canvasId,
    runId: state.runId,
    phase: state.phase,
    state,
    currentRef: state.currentRef,
    latestRecordId: state.latestRecordId,
    latestRecordPath: state.latestRecordPath,
    eventType: "step_started",
    triggeredAt: state.updatedAt,
    ...patch
  };
}

export function cleanupAutoRunControlTestEnvironment() {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}

export function stubAutoRunControlBridge(bridge: DesktopBridgeApi): DesktopBridgeApi {
  vi.stubGlobal("planweave", bridge);
  return bridge;
}

export function createAndStubAutoRunControlBridge(
  overrides: Partial<DesktopBridgeApi> = {}
): DesktopBridgeApi {
  return stubAutoRunControlBridge(createDesktopBridgeMock(overrides));
}

export function createAutoRunChangedBridge(overrides: Partial<DesktopBridgeApi> = {}) {
  let onAutoRunChangedCallback: ((event: DesktopAutoRunEvent) => void) | null = null;
  const bridge = createDesktopBridgeMock({
    ...overrides,
    onAutoRunChanged: vi.fn((callback: (event: DesktopAutoRunEvent) => void) => {
      onAutoRunChangedCallback = callback;
      return () => undefined;
    })
  });
  return {
    bridge,
    emitAutoRunEvent: (event: DesktopAutoRunEvent) => onAutoRunChangedCallback?.(event)
  };
}

export async function loadAutoRunControl() {
  vi.resetModules();
  return import("../../renderer/hooks/useAutoRunControl");
}

export function defaultAutoRunControlArgs(
  patch: Partial<AutoRunControlArgs> = {}
): AutoRunControlArgs {
  return {
    autoRunState: null,
    handleOpenRunRecord: vi.fn(),
    selectedCanvasId: "canvas-main",
    selectedBlock: null,
    selectedProject: null,
    selectedTaskPanelId: null,
    setAutoRunState: vi.fn(),
    setError: vi.fn(),
    t: createTranslator("zh-CN"),
    tmuxMonitoringEnabled: false,
    ...patch
  };
}

export async function renderAutoRunControlHook(args: Partial<AutoRunControlArgs> = {}) {
  const { useAutoRunControl } = await loadAutoRunControl();
  return renderHook(() => useAutoRunControl(defaultAutoRunControlArgs(args)));
}

export async function renderStatefulAutoRunControlHook(
  initialState: DesktopAutoRunState | null,
  args: Partial<AutoRunControlArgs> = {}
) {
  const { useAutoRunControl } = await loadAutoRunControl();
  return renderHook(() => {
    const [autoRunStateValue, setAutoRunState] = useState<DesktopAutoRunState | null>(initialState);
    return useAutoRunControl(
      defaultAutoRunControlArgs({ ...args, autoRunState: autoRunStateValue, setAutoRunState })
    );
  });
}

export { createDesktopBridgeMock, createTranslator };
