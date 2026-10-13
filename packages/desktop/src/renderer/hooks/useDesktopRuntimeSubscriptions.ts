import { useCallback, useEffect, useLayoutEffect, useRef, type MutableRefObject } from "react";
import type {
  DesktopGraphViewModel,
  DesktopProjectSummary,
  DesktopRuntimeStateChangeEvent
} from "@planweave-ai/runtime";
import { bridge } from "../bridge";
import { isDesktopHomeTransitionPending } from "../desktopHomeTransition";
import { beginDesktopWatchRegistration } from "../desktopWatchRegistration";
import type { CurrentDesktopCanvasRef, DesktopSelectionReceipt } from "./useDesktopProjectSnapshot";

const externalRuntimeRefreshIntervalMs = 30_000;

type UseDesktopRuntimeSubscriptionsArgs = {
  currentCanvasRef: MutableRefObject<CurrentDesktopCanvasRef>;
  planweaveHome: string;
  captureProjectSelection: () => DesktopSelectionReceipt;
  graph: DesktopGraphViewModel | null;
  refreshGraph: () => Promise<void>;
  refreshRuntimeState: () => Promise<void>;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
};

function documentIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function runtimeStateEventMatchesCanvas(
  event: DesktopRuntimeStateChangeEvent,
  project: DesktopProjectSummary,
  canvasId: string | null
): boolean {
  return (
    event.projectRoot === project.rootPath &&
    event.workspaceRoot === project.workspaceRoot &&
    event.canvasId === canvasId
  );
}

export function useDesktopRuntimeSubscriptions({
  currentCanvasRef,
  planweaveHome,
  captureProjectSelection,
  graph,
  refreshGraph,
  refreshRuntimeState,
  selectedCanvasId,
  selectedProject,
  setError
}: UseDesktopRuntimeSubscriptionsArgs) {
  const externalRefreshInFlightRef = useRef<DesktopSelectionReceipt | null>(null);
  const selectedProjectRoot = selectedProject?.rootPath;
  const selectedWorkspaceRoot = selectedProject?.workspaceRoot;
  const graphAvailable = graph !== null;

  const runExternalRuntimeRefresh = useCallback(() => {
    if (
      isDesktopHomeTransitionPending() ||
      !documentIsVisible() ||
      externalRefreshInFlightRef.current?.isCurrent()
    ) {
      return;
    }
    const request = captureProjectSelection();
    externalRefreshInFlightRef.current = request;
    void refreshRuntimeState()
      .catch((caught: unknown) => {
        if (request.isCurrent()) setError(errorMessage(caught));
      })
      .finally(() => {
        if (externalRefreshInFlightRef.current === request)
          externalRefreshInFlightRef.current = null;
      });
  }, [captureProjectSelection, refreshRuntimeState, setError]);

  useEffect(() => {
    if (!bridge || !selectedProject) {
      return undefined;
    }
    const timer = window.setInterval(runExternalRuntimeRefresh, externalRuntimeRefreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [runExternalRuntimeRefresh, selectedProject]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Home changes retire and rebind watchers even when the project path stays the same.
  useLayoutEffect(() => {
    if (!bridge || !selectedProjectRoot || !selectedWorkspaceRoot || !graphAvailable) {
      return undefined;
    }
    if (
      currentCanvasRef.current.projectRoot !== selectedProjectRoot ||
      currentCanvasRef.current.canvasId !== selectedCanvasId
    )
      return undefined;
    const runtimeBridge = bridge;
    const registration = beginDesktopWatchRegistration(
      {
        rootPath: selectedProjectRoot,
        workspaceRoot: selectedWorkspaceRoot
      },
      selectedCanvasId
    );
    const request = captureProjectSelection();
    let active = true;
    void runtimeBridge.watchRuntimeState(registration.reference).catch((caught: unknown) => {
      registration.retire();
      if (active && request.isCurrent()) setError(errorMessage(caught));
    });
    return () => {
      active = false;
      registration.retire();
      void runtimeBridge.unwatchRuntimeState(registration.reference).catch((caught: unknown) => {
        if (request.isCurrent()) setError(errorMessage(caught));
      });
    };
  }, [
    captureProjectSelection,
    currentCanvasRef,
    graphAvailable,
    planweaveHome,
    selectedCanvasId,
    selectedProjectRoot,
    selectedWorkspaceRoot,
    setError
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Home changes retire subscriptions even when the selected project stays the same.
  useEffect(() => {
    if (!bridge || !selectedProject) {
      return undefined;
    }
    let active = true;
    const unsubscribe = bridge.onRuntimeStateChanged((event) => {
      if (!active) return;
      if (!runtimeStateEventMatchesCanvas(event, selectedProject, selectedCanvasId)) {
        return;
      }
      const request = captureProjectSelection();
      void refreshGraph().catch((caught: unknown) => {
        if (active && request.isCurrent()) setError(errorMessage(caught));
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [
    captureProjectSelection,
    planweaveHome,
    refreshGraph,
    selectedCanvasId,
    selectedProject,
    setError
  ]);

  useEffect(() => {
    if (typeof document === "undefined" || !selectedProject) {
      return undefined;
    }
    const handleVisibilityChange = () => {
      if (documentIsVisible()) {
        runExternalRuntimeRefresh();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [runExternalRuntimeRefresh, selectedProject]);
}
