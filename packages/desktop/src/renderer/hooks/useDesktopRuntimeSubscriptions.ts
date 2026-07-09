import { useCallback, useEffect, useRef } from "react";
import type {
  DesktopGraphViewModel,
  DesktopProjectSummary,
  DesktopRuntimeStateChangeEvent
} from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";

const externalRuntimeRefreshIntervalMs = 30_000;

type UseDesktopRuntimeSubscriptionsArgs = {
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
  return event.projectRoot === project.rootPath && event.canvasId === canvasId;
}

export function useDesktopRuntimeSubscriptions({
  graph,
  refreshGraph,
  refreshRuntimeState,
  selectedCanvasId,
  selectedProject,
  setError
}: UseDesktopRuntimeSubscriptionsArgs) {
  const externalRefreshInFlightRef = useRef(false);

  const runExternalRuntimeRefresh = useCallback(() => {
    if (!documentIsVisible() || externalRefreshInFlightRef.current) {
      return;
    }
    externalRefreshInFlightRef.current = true;
    void refreshRuntimeState()
      .catch((caught: unknown) => setError(errorMessage(caught)))
      .finally(() => {
        externalRefreshInFlightRef.current = false;
      });
  }, [refreshRuntimeState, setError]);

  useEffect(() => {
    const projectRoot = selectedProject?.rootPath;
    const canvasId = selectedCanvasId;
    return () => {
      if (bridge && projectRoot) {
        void bridge.unwatchPackageFiles({ projectRoot, canvasId });
        void bridge.unwatchRuntimeState({ projectRoot, canvasId });
      }
    };
  }, [selectedCanvasId, selectedProject?.rootPath]);

  useEffect(() => {
    if (!bridge || !selectedProject) {
      return undefined;
    }
    const timer = window.setInterval(runExternalRuntimeRefresh, externalRuntimeRefreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [runExternalRuntimeRefresh, selectedProject]);

  useEffect(() => {
    if (!bridge || !selectedProject || !graph) {
      return undefined;
    }
    const runtimeBridge = bridge;
    const ref = desktopCanvasReference(selectedProject, selectedCanvasId);
    void runtimeBridge
      .watchRuntimeState(ref)
      .catch((caught: unknown) => setError(errorMessage(caught)));
    return () => {
      void runtimeBridge.unwatchRuntimeState(ref);
    };
  }, [Boolean(graph), selectedCanvasId, selectedProject?.rootPath, setError]);

  useEffect(() => {
    if (!bridge || !selectedProject) {
      return undefined;
    }
    return bridge.onRuntimeStateChanged((event) => {
      if (!runtimeStateEventMatchesCanvas(event, selectedProject, selectedCanvasId)) {
        return;
      }
      void refreshGraph().catch((caught: unknown) => setError(errorMessage(caught)));
    });
  }, [refreshGraph, selectedCanvasId, selectedProject, setError]);

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
