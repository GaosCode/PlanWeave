import { useCallback, useEffect, useState } from "react";
import type * as React from "react";
import type {
  DesktopAutoRunRetrospectiveSummary,
  DesktopAutoRunScope,
  DesktopAutoRunState,
  DesktopBlockDetail,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import { autoRunEventMatchesCanvas, shouldRefreshGraphForAutoRunEvent } from "../autoRunEvents";
import { bridge, desktopCanvasReference } from "../bridge";
import type { createTranslator } from "../i18n";
import {
  buildAutoRunNextActionDescriptor,
  type AutoRunNextActionDescriptor
} from "../run/autoRunNextActions";
import type { AutoRunScopeMode, FloatingControlDrag, FloatingControlPosition } from "../types";
import { clamp } from "../viewHelpers";

type UseAutoRunControlArgs = {
  autoRunState: DesktopAutoRunState | null;
  onAutoRunDerivedStateRefresh?: () => Promise<void>;
  selectedCanvasId: string | null;
  selectedBlock: DesktopBlockDetail | null;
  selectedProject: DesktopProjectSummary | null;
  selectedTaskPanelId: string | null;
  handleOpenRunRecord: (
    recordId: string | null | undefined,
    canvasId?: string | null
  ) => Promise<void>;
  setError: (message: string | null) => void;
  setAutoRunState: (state: DesktopAutoRunState | null) => void;
  t: ReturnType<typeof createTranslator>;
  tmuxMonitoringEnabled: boolean;
  initialPosition?: FloatingControlPosition | null;
  position?: FloatingControlPosition | null;
  onPositionCommit?: (position: FloatingControlPosition) => void;
};

type FloatingControlViewport = {
  maxLeft: number;
  maxTop: number;
};

const floatingControlInset = 12;

function isActiveAutoRunState(state: DesktopAutoRunState | null): boolean {
  return state?.phase === "running" || state?.phase === "pausing";
}

function isValidControlPosition(
  position: FloatingControlPosition | null | undefined
): position is FloatingControlPosition {
  return Boolean(
    position &&
      Number.isFinite(position.left) &&
      Number.isFinite(position.top) &&
      position.left >= 0 &&
      position.top >= 0
  );
}

function missingAutoRunStateError(caught: unknown, runId: string): boolean {
  const message = caught instanceof Error ? caught.message : String(caught);
  return message.includes(`Auto Run '${runId}'`) && message.includes("auto_run_state_missing");
}

function sameControlPosition(
  left: FloatingControlPosition | null,
  right: FloatingControlPosition | null
): boolean {
  return left?.left === right?.left && left?.top === right?.top;
}

function sameControlViewport(
  left: FloatingControlViewport | null,
  right: FloatingControlViewport | null
): boolean {
  return left?.maxLeft === right?.maxLeft && left?.maxTop === right?.maxTop;
}

function clampControlPosition(
  position: FloatingControlPosition,
  drag: FloatingControlDrag
): FloatingControlPosition {
  return {
    left: clamp(position.left, drag.minLeft, drag.maxLeft),
    top: clamp(position.top, drag.minTop, drag.maxTop)
  };
}

function clampMeasuredControlPosition(
  position: FloatingControlPosition,
  viewport: FloatingControlViewport
): FloatingControlPosition {
  return {
    left: clamp(position.left, floatingControlInset, viewport.maxLeft),
    top: clamp(position.top, floatingControlInset, viewport.maxTop)
  };
}

function measuredControlViewport(element: HTMLElement): FloatingControlViewport | null {
  const surface = element.closest("[data-graph-surface]");
  if (!(surface instanceof HTMLElement)) {
    return null;
  }
  const controlBounds = element.getBoundingClientRect();
  const surfaceBounds = surface.getBoundingClientRect();
  return {
    maxLeft: Math.max(
      floatingControlInset,
      surfaceBounds.width - controlBounds.width - floatingControlInset
    ),
    maxTop: Math.max(
      floatingControlInset,
      surfaceBounds.height - controlBounds.height - floatingControlInset
    )
  };
}

function positionFromPointer(
  event: React.PointerEvent<HTMLButtonElement>,
  drag: FloatingControlDrag
): FloatingControlPosition {
  return clampControlPosition(
    {
      left: event.clientX - drag.containerLeft - drag.offsetX,
      top: event.clientY - drag.containerTop - drag.offsetY
    },
    drag
  );
}

export function useAutoRunControl({
  autoRunState,
  onAutoRunDerivedStateRefresh,
  selectedCanvasId,
  selectedBlock,
  selectedProject,
  selectedTaskPanelId,
  handleOpenRunRecord,
  setError,
  setAutoRunState,
  t,
  tmuxMonitoringEnabled,
  initialPosition,
  position,
  onPositionCommit
}: UseAutoRunControlArgs) {
  const [autoRunScopeMode, setAutoRunScopeMode] = useState<AutoRunScopeMode>("project");
  const [miniRunPanelOpen, setMiniRunPanelOpen] = useState(false);
  const [autoRunControlPosition, setAutoRunControlPosition] =
    useState<FloatingControlPosition | null>(() => {
      const configuredPosition = position !== undefined ? position : initialPosition;
      return isValidControlPosition(configuredPosition) ? configuredPosition : null;
    });
  const [autoRunControlDrag, setAutoRunControlDrag] = useState<FloatingControlDrag | null>(null);
  const [autoRunControlElement, setAutoRunControlElement] = useState<HTMLDivElement | null>(null);
  const [autoRunControlViewport, setAutoRunControlViewport] =
    useState<FloatingControlViewport | null>(null);
  const [autoRunRetrospective, setAutoRunRetrospective] =
    useState<DesktopAutoRunRetrospectiveSummary | null>(null);

  const autoRunControlRef = useCallback((element: HTMLDivElement | null) => {
    setAutoRunControlElement((currentElement) =>
      currentElement === element ? currentElement : element
    );
  }, []);

  const applyAutoRunState = useCallback(
    async (nextState: DesktopAutoRunState, options: { refreshDerivedState?: boolean } = {}) => {
      setAutoRunState(nextState);
      if (options.refreshDerivedState) {
        await onAutoRunDerivedStateRefresh?.();
      }
    },
    [onAutoRunDerivedStateRefresh, setAutoRunState]
  );
  const autoRunRunId = autoRunState?.runId ?? null;
  const activeRunId = isActiveAutoRunState(autoRunState) ? autoRunRunId : null;

  useEffect(() => {
    if (position === undefined) {
      return;
    }
    const nextPosition = isValidControlPosition(position) ? position : null;
    setAutoRunControlPosition((currentPosition) =>
      sameControlPosition(currentPosition, nextPosition) ? currentPosition : nextPosition
    );
  }, [position]);

  useEffect(() => {
    if (!autoRunControlElement) {
      setAutoRunControlViewport((currentViewport) =>
        currentViewport === null ? currentViewport : null
      );
      return;
    }

    const updateViewport = () => {
      const nextViewport = measuredControlViewport(autoRunControlElement);
      setAutoRunControlViewport((currentViewport) =>
        sameControlViewport(currentViewport, nextViewport) ? currentViewport : nextViewport
      );
    };
    updateViewport();

    const surface = autoRunControlElement.closest("[data-graph-surface]");
    const resizeObserver =
      typeof ResizeObserver === "function" ? new ResizeObserver(updateViewport) : null;
    resizeObserver?.observe(autoRunControlElement);
    if (surface instanceof HTMLElement) {
      resizeObserver?.observe(surface);
    }
    window.addEventListener("resize", updateViewport);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateViewport);
    };
  }, [autoRunControlElement]);

  useEffect(() => {
    if (!bridge || !selectedProject || isActiveAutoRunState(autoRunState)) {
      setAutoRunRetrospective(null);
      return;
    }
    let cancelled = false;
    const ref = desktopCanvasReference(selectedProject, selectedCanvasId);
    const loadRetrospective = autoRunRunId
      ? bridge.getAutoRunRetrospective(ref, autoRunRunId)
      : bridge.getLatestAutoRunRetrospective(ref);
    void loadRetrospective
      .then((summary) => {
        if (!cancelled) {
          setAutoRunRetrospective(summary);
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          if (autoRunRunId && missingAutoRunStateError(caught, autoRunRunId)) {
            setAutoRunRetrospective(null);
            setAutoRunState(null);
            return;
          }
          setAutoRunRetrospective(null);
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    autoRunRunId,
    autoRunState?.phase,
    selectedCanvasId,
    selectedProject,
    setAutoRunState,
    setError
  ]);

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
      void applyAutoRunState(event.state, {
        refreshDerivedState: shouldRefreshGraphForAutoRunEvent(event)
      });
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

  const autoRunNextAction = buildAutoRunNextActionDescriptor({
    labels: {
      copyManualCommand: t("copyManualCommand"),
      inspectRecord: t("inspectRecord"),
      retryRef: t("retryRef"),
      reviewStatus: t("reviewStatus"),
      resume: t("resume"),
      start: t("start"),
      wait: t("wait")
    },
    noCommandReason: t("manualCommandUnavailable"),
    noRecordReason: t("recordUnavailable"),
    noRefReason: t("retryRefUnavailable"),
    noRunReason: t("runUnavailable"),
    noScopeReason: t("selectBlockFirst"),
    retrospective: autoRunRetrospective,
    selectedScopeReady: Boolean(selectedAutoRunScope()),
    state: autoRunState
  });

  const startAutoRunWithScope = useCallback(
    async (scope: DesktopAutoRunScope) => {
      if (!bridge || !selectedProject) {
        return;
      }
      try {
        setMiniRunPanelOpen(true);
        if (autoRunState && ["running", "pausing"].includes(autoRunState.phase)) {
          return;
        }
        if (autoRunState?.phase === "blocked" && autoRunState.currentRef) {
          await bridge.unblockBlock(
            desktopCanvasReference(selectedProject, selectedCanvasId),
            autoRunState.currentRef,
            "Retry requested from Auto Run."
          );
        }
        await applyAutoRunState(
          await bridge.startAutoRun(
            desktopCanvasReference(selectedProject, selectedCanvasId),
            scope,
            20,
            { tmuxEnabled: tmuxMonitoringEnabled }
          )
        );
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [
      applyAutoRunState,
      autoRunState,
      selectedCanvasId,
      selectedProject,
      setError,
      tmuxMonitoringEnabled
    ]
  );

  const handleAutoRunClick = useCallback(async () => {
    if (!bridge || !selectedProject) {
      return;
    }
    try {
      setMiniRunPanelOpen(true);
      if (
        !autoRunState ||
        ["completed", "blocked", "failed", "stopped"].includes(autoRunState.phase)
      ) {
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
  }, [
    applyAutoRunState,
    autoRunState,
    selectedAutoRunScope,
    selectedProject,
    setError,
    startAutoRunWithScope,
    t
  ]);

  const openRecordOrRevealPath = useCallback(
    async (action: AutoRunNextActionDescriptor) => {
      if (action.recordId) {
        await handleOpenRunRecord(action.recordId, autoRunState?.canvasId ?? selectedCanvasId);
        return;
      }
      if (bridge && action.targetPath) {
        await bridge.revealPathInFinder(action.targetPath);
      }
    },
    [autoRunState?.canvasId, handleOpenRunRecord, selectedCanvasId]
  );

  const handleAutoRunNextAction = useCallback(
    async (action: AutoRunNextActionDescriptor) => {
      if (!action.enabled) {
        return;
      }
      if (!bridge || !selectedProject) {
        setError(t("bridgeUnavailable"));
        return;
      }
      try {
        if (action.command === "start") {
          const scope = selectedAutoRunScope();
          if (!scope) {
            setError(t("selectBlockFirst"));
            return;
          }
          await startAutoRunWithScope(scope);
          return;
        }
        if (action.command === "wait") {
          return;
        }
        if (action.command === "resume") {
          if (!autoRunState) {
            setError(t("runUnavailable"));
            return;
          }
          await applyAutoRunState(await bridge.resumeAutoRun(autoRunState.runId));
          return;
        }
        if (action.command === "copy_manual_command") {
          if (!action.manualCommand) {
            setError(t("manualCommandUnavailable"));
            return;
          }
          if (!navigator.clipboard) {
            setError(`${t("manualCommandUnavailable")}: ${action.manualCommand}`);
            return;
          }
          await navigator.clipboard.writeText(action.manualCommand);
          return;
        }
        if (action.command === "inspect_record" || action.command === "review_status") {
          await openRecordOrRevealPath(action);
          return;
        }
        if (action.command === "retry_ref") {
          if (!action.ref) {
            setError(t("retryRefUnavailable"));
            return;
          }
          const ref = desktopCanvasReference(selectedProject, selectedCanvasId);
          await bridge.unblockBlock(ref, action.ref, "Retry requested from Auto Run.");
          await applyAutoRunState(
            await bridge.startAutoRun(ref, { kind: "block", blockRef: action.ref }, 20, {
              tmuxEnabled: tmuxMonitoringEnabled
            })
          );
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [
      applyAutoRunState,
      autoRunState,
      openRecordOrRevealPath,
      selectedAutoRunScope,
      selectedCanvasId,
      selectedProject,
      setError,
      startAutoRunWithScope,
      t,
      tmuxMonitoringEnabled
    ]
  );

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

  const resetRuntimeStateClick = useCallback(async () => {
    if (!bridge || !selectedProject) {
      return;
    }
    if (isActiveAutoRunState(autoRunState)) {
      setError(t("stopAutoRunBeforeReset"));
      return;
    }
    if (!window.confirm(t("resetRuntimeStateConfirm"))) {
      return;
    }
    try {
      setMiniRunPanelOpen(true);
      await bridge.resetRuntimeState(desktopCanvasReference(selectedProject, selectedCanvasId), {
        force: true,
        reason: "Desktop reset requested."
      });
      setAutoRunState(null);
      setAutoRunRetrospective(null);
      await onAutoRunDerivedStateRefresh?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [
    autoRunState,
    onAutoRunDerivedStateRefresh,
    selectedCanvasId,
    selectedProject,
    setAutoRunState,
    setError,
    t
  ]);

  const startAutoRunControlDrag = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const control = event.currentTarget.closest("[data-auto-run-control]");
      const surface = event.currentTarget.closest("[data-graph-surface]");
      if (!(control instanceof HTMLElement) || !(surface instanceof HTMLElement)) {
        return;
      }
      const controlBounds = control.getBoundingClientRect();
      const surfaceBounds = surface.getBoundingClientRect();
      const inset = floatingControlInset;
      const drag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - controlBounds.left,
        offsetY: event.clientY - controlBounds.top,
        containerLeft: surfaceBounds.left,
        containerTop: surfaceBounds.top,
        minLeft: inset,
        minTop: inset,
        maxLeft: Math.max(inset, surfaceBounds.width - controlBounds.width - inset),
        maxTop: Math.max(inset, surfaceBounds.height - controlBounds.height - inset)
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setAutoRunControlDrag(drag);
      if (autoRunControlPosition) {
        setAutoRunControlPosition(clampControlPosition(autoRunControlPosition, drag));
      }
    },
    [autoRunControlPosition]
  );

  const commitAutoRunControlPosition = useCallback(
    (nextPosition: FloatingControlPosition) => {
      setAutoRunControlPosition(nextPosition);
      onPositionCommit?.(nextPosition);
    },
    [onPositionCommit]
  );

  const commitCurrentAutoRunControlPosition = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!autoRunControlDrag || event.pointerId !== autoRunControlDrag.pointerId) {
        return;
      }
      commitAutoRunControlPosition(positionFromPointer(event, autoRunControlDrag));
    },
    [autoRunControlDrag, commitAutoRunControlPosition]
  );

  const moveAutoRunControl = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!autoRunControlDrag || event.pointerId !== autoRunControlDrag.pointerId) {
        return;
      }
      setAutoRunControlPosition(positionFromPointer(event, autoRunControlDrag));
    },
    [autoRunControlDrag]
  );

  const stopAutoRunControlDrag = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      commitCurrentAutoRunControlPosition(event);
      setAutoRunControlDrag(null);
    },
    [commitCurrentAutoRunControlPosition]
  );

  const measuredAutoRunControlPosition =
    autoRunControlPosition && autoRunControlViewport
      ? clampMeasuredControlPosition(autoRunControlPosition, autoRunControlViewport)
      : null;
  const autoRunControlStyle: React.CSSProperties = measuredAutoRunControlPosition
    ? {
        left: `${measuredAutoRunControlPosition.left}px`,
        top: `${measuredAutoRunControlPosition.top}px`
      }
    : autoRunControlPosition
      ? {
          left: `clamp(${floatingControlInset}px, ${autoRunControlPosition.left}px, calc(100% - ${floatingControlInset}px))`,
          top: `clamp(${floatingControlInset}px, ${autoRunControlPosition.top}px, calc(100% - ${floatingControlInset}px))`
        }
      : { right: 20, bottom: 20 };

  return {
    autoRunControlRef,
    autoRunControlStyle,
    autoRunNextAction,
    autoRunRetrospective,
    autoRunScopeMode,
    autoRunState,
    handleAutoRunClick,
    handleAutoRunNextAction,
    miniRunPanelOpen,
    moveAutoRunControl,
    setAutoRunScopeMode,
    setAutoRunState,
    setMiniRunPanelOpen,
    resetRuntimeStateClick,
    startAutoRunWithScope,
    startAutoRunControlDrag,
    stopAutoRunClick,
    stopAutoRunControlDrag
  };
}
