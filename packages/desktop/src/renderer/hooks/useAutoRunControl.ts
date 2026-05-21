import { useCallback, useEffect, useState } from "react";
import type * as React from "react";
import type { DesktopAutoRunScope, DesktopAutoRunState, DesktopBlockDetail, DesktopProjectSummary } from "@planweave/runtime";
import { bridge } from "../bridge";
import type { createTranslator } from "../i18n";
import type { AutoRunScopeMode, FloatingControlDrag, FloatingControlPosition } from "../types";
import { clamp } from "../viewHelpers";

type UseAutoRunControlArgs = {
  selectedBlock: DesktopBlockDetail | null;
  selectedProject: DesktopProjectSummary | null;
  selectedTaskPanelId: string | null;
  setError: (message: string | null) => void;
  t: ReturnType<typeof createTranslator>;
};

export function useAutoRunControl({ selectedBlock, selectedProject, selectedTaskPanelId, setError, t }: UseAutoRunControlArgs) {
  const [autoRunState, setAutoRunState] = useState<DesktopAutoRunState | null>(null);
  const [autoRunScopeMode, setAutoRunScopeMode] = useState<AutoRunScopeMode>("project");
  const [miniRunPanelOpen, setMiniRunPanelOpen] = useState(false);
  const [autoRunControlPosition, setAutoRunControlPosition] = useState<FloatingControlPosition | null>(null);
  const [autoRunControlDrag, setAutoRunControlDrag] = useState<FloatingControlDrag | null>(null);

  const refreshAutoRunState = useCallback(async (runId: string) => {
    if (!bridge) {
      return;
    }
    setAutoRunState(await bridge.getAutoRunState(runId));
  }, []);

  useEffect(() => {
    if (!autoRunState || autoRunState.phase !== "running") {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshAutoRunState(autoRunState.runId);
    }, 600);
    return () => window.clearInterval(timer);
  }, [autoRunState, refreshAutoRunState]);

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
        setAutoRunState(await bridge.startAutoRun(selectedProject.rootPath, scope, 20));
        return;
      }
      if (autoRunState.phase === "running") {
        setAutoRunState(await bridge.pauseAutoRun(autoRunState.runId));
        return;
      }
      if (autoRunState.phase === "paused") {
        setAutoRunState(await bridge.resumeAutoRun(autoRunState.runId));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [autoRunState, selectedAutoRunScope, selectedProject, setError, t]);

  const stopAutoRunClick = useCallback(async () => {
    if (!bridge || !autoRunState) {
      return;
    }
    try {
      setAutoRunState(await bridge.stopAutoRun(autoRunState.runId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [autoRunState, setError]);

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
    startAutoRunControlDrag,
    stopAutoRunClick,
    stopAutoRunControlDrag
  };
}
