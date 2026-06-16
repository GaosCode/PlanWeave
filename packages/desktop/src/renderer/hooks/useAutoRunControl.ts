import { useCallback, useEffect, useState } from "react";
import type * as React from "react";
import type { DesktopAutoRunScope, DesktopAutoRunState, DesktopBlockDetail, DesktopProjectSummary } from "@planweave-ai/runtime";
import { autoRunEventMatchesCanvas, shouldRefreshGraphForAutoRunEvent } from "../autoRunEvents";
import { bridge, desktopCanvasReference } from "../bridge";
import type { createTranslator } from "../i18n";
import type { AutoRunScopeMode, FloatingControlDrag, FloatingControlPosition } from "../types";
import { clamp } from "../viewHelpers";

type UseAutoRunControlArgs = {
  autoRunState: DesktopAutoRunState | null;
  onAutoRunStateRefresh?: (state: DesktopAutoRunState) => Promise<void>;
  selectedCanvasId: string | null;
  selectedBlock: DesktopBlockDetail | null;
  selectedProject: DesktopProjectSummary | null;
  selectedTaskPanelId: string | null;
  setError: (message: string | null) => void;
  setAutoRunState: (state: DesktopAutoRunState | null) => void;
  t: ReturnType<typeof createTranslator>;
  tmuxMonitoringEnabled: boolean;
};

function isActiveAutoRunState(state: DesktopAutoRunState | null): state is DesktopAutoRunState {
  return state?.phase === "running" || state?.phase === "pausing";
}

export function useAutoRunControl({
  autoRunState,
  onAutoRunStateRefresh,
  selectedCanvasId,
  selectedBlock,
  selectedProject,
  selectedTaskPanelId,
  setError,
  setAutoRunState,
  t,
  tmuxMonitoringEnabled
}: UseAutoRunControlArgs) {
  const [autoRunScopeMode, setAutoRunScopeMode] = useState<AutoRunScopeMode>("project");
  const [miniRunPanelOpen, setMiniRunPanelOpen] = useState(false);
  const [autoRunControlPosition, setAutoRunControlPosition] = useState<FloatingControlPosition | null>(null);
  const [autoRunControlDrag, setAutoRunControlDrag] = useState<FloatingControlDrag | null>(null);

  const applyAutoRunState = useCallback(async (nextState: DesktopAutoRunState, options: { refreshGraph?: boolean } = {}) => {
    setAutoRunState(nextState);
    if (options.refreshGraph) {
      await onAutoRunStateRefresh?.(nextState);
    }
  }, [onAutoRunStateRefresh, setAutoRunState]);
  const activeRunId = isActiveAutoRunState(autoRunState) ? autoRunState.runId : null;

  useEffect(() => {
    if (!bridge || !selectedProject) {
      return;
    }
    return bridge.onAutoRunChanged((event) => {
      if (!autoRunEventMatchesCanvas(event, selectedProject.rootPath, selectedCanvasId)) {
        return;
      }
      if (activeRunId && event.runId !== activeRunId) {
        return;
      }
      void applyAutoRunState(event.state, { refreshGraph: shouldRefreshGraphForAutoRunEvent(event) });
    });
  }, [activeRunId, applyAutoRunState, selectedCanvasId, selectedProject]);

  const selectedAutoRunScope = useCallback((): DesktopAutoRunScope | null => {
    if (autoRunScopeMode === "project") {
      return { kind: "project" };
    }
    if (autoRunScopeMode === "selectedTask" && selectedTaskPanelId) {
      return { kind: "task", taskId: selectedTaskPanelId };
    }
    if (!selectedBlock) {
      return null;
    }
    if (autoRunScopeMode === "selectedTask") {
      return { kind: "task", taskId: selectedBlock.taskId };
    }
    return { kind: "block", blockRef: selectedBlock.ref };
  }, [autoRunScopeMode, selectedBlock, selectedTaskPanelId]);

  const startAutoRunWithScope = useCallback(async (scope: DesktopAutoRunScope) => {
    if (!bridge || !selectedProject) {
      return;
    }
    try {
      setMiniRunPanelOpen(true);
      if (autoRunState && ["running", "pausing"].includes(autoRunState.phase)) {
        return;
      }
      if (autoRunState?.phase === "blocked" && autoRunState.currentRef) {
        await bridge.unblockBlock(desktopCanvasReference(selectedProject, selectedCanvasId), autoRunState.currentRef, "Retry requested from Auto Run.");
      }
      await applyAutoRunState(await bridge.startAutoRun(desktopCanvasReference(selectedProject, selectedCanvasId), scope, 20, { tmuxEnabled: tmuxMonitoringEnabled }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [applyAutoRunState, autoRunState, selectedCanvasId, selectedProject, setError, tmuxMonitoringEnabled]);

  const handleAutoRunClick = useCallback(async () => {
    if (!bridge || !selectedProject) {
      return;
    }
    try {
      setMiniRunPanelOpen(true);
      if (!autoRunState || ["completed", "blocked", "failed", "stopped", "manual"].includes(autoRunState.phase)) {
        const scope = selectedAutoRunScope();
        if (!scope) {
          setError(t("selectBlockFirst"));
          return;
        }
        await startAutoRunWithScope(scope);
        return;
      }
      if (autoRunState.phase === "running") {
        await applyAutoRunState(await bridge.pauseAutoRun(autoRunState.runId));
        return;
      }
      if (autoRunState.phase === "paused" || autoRunState.phase === "pausing") {
        await applyAutoRunState(await bridge.resumeAutoRun(autoRunState.runId));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [applyAutoRunState, autoRunState, selectedAutoRunScope, selectedProject, setError, startAutoRunWithScope, t]);

  const stopAutoRunClick = useCallback(async () => {
    if (!bridge || !autoRunState) {
      return;
    }
    try {
      await applyAutoRunState(await bridge.stopAutoRun(autoRunState.runId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [applyAutoRunState, autoRunState, setError]);

  const startAutoRunControlDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const control = event.currentTarget.closest("[data-auto-run-control]");
    const surface = event.currentTarget.closest("[data-graph-surface]");
    if (!(control instanceof HTMLElement) || !(surface instanceof HTMLElement)) {
      return;
    }
    const controlBounds = control.getBoundingClientRect();
    const surfaceBounds = surface.getBoundingClientRect();
    const inset = 12;
    event.currentTarget.setPointerCapture(event.pointerId);
    setAutoRunControlDrag({
      pointerId: event.pointerId,
      offsetX: event.clientX - controlBounds.left,
      offsetY: event.clientY - controlBounds.top,
      containerLeft: surfaceBounds.left,
      containerTop: surfaceBounds.top,
      minLeft: inset,
      minTop: inset,
      maxLeft: Math.max(inset, surfaceBounds.width - controlBounds.width - inset),
      maxTop: Math.max(inset, surfaceBounds.height - controlBounds.height - inset)
    });
  }, []);

  const moveAutoRunControl = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!autoRunControlDrag || event.pointerId !== autoRunControlDrag.pointerId) {
        return;
      }
      setAutoRunControlPosition({
        left: clamp(event.clientX - autoRunControlDrag.containerLeft - autoRunControlDrag.offsetX, autoRunControlDrag.minLeft, autoRunControlDrag.maxLeft),
        top: clamp(event.clientY - autoRunControlDrag.containerTop - autoRunControlDrag.offsetY, autoRunControlDrag.minTop, autoRunControlDrag.maxTop)
      });
    },
    [autoRunControlDrag]
  );

  const stopAutoRunControlDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setAutoRunControlDrag(null);
  }, []);

  const autoRunControlStyle = autoRunControlPosition ? { left: autoRunControlPosition.left, top: autoRunControlPosition.top } : { right: 20, bottom: 20 };

  return {
    autoRunControlStyle,
    autoRunScopeMode,
    autoRunState,
    handleAutoRunClick,
    miniRunPanelOpen,
    moveAutoRunControl,
    setAutoRunScopeMode,
    setAutoRunState,
    setMiniRunPanelOpen,
    startAutoRunWithScope,
    startAutoRunControlDrag,
    stopAutoRunClick,
    stopAutoRunControlDrag
  };
}
