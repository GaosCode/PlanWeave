import { useCallback, useEffect } from "react";
import type {
  DesktopPackageFileChangeEvent,
  DesktopPackageFileRefreshOptions,
  DesktopPackageFileSyncResult,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";

function hasProjectPromptChangeDiagnostic(result: DesktopPackageFileSyncResult): boolean {
  return result.diagnostics.some((diagnostic) => diagnostic.code === "package_change_non_package_prompt");
}

function shouldReloadCanvasAfterRefresh(result: DesktopPackageFileSyncResult): boolean {
  return result.fullRefresh || hasProjectPromptChangeDiagnostic(result);
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function syncErrorMessage(result: DesktopPackageFileSyncResult): string {
  return result.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
}

function watcherRefreshElapsedMs(triggeredAt: string | undefined): number | undefined {
  if (!triggeredAt) {
    return undefined;
  }
  const startedAt = Date.parse(triggeredAt);
  if (!Number.isFinite(startedAt)) {
    return undefined;
  }
  return Math.max(0, Date.now() - startedAt);
}

function syncResultWithWatcherMetadata(
  result: DesktopPackageFileSyncResult,
  event: DesktopPackageFileChangeEvent | undefined
): DesktopPackageFileSyncResult {
  if (!event) {
    return result;
  }
  const elapsedMs = watcherRefreshElapsedMs(event.triggeredAt);
  return {
    ...result,
    watcherBackendKind: event.backendKind,
    watcherChangedPathCount: event.changedPathCount ?? event.paths.length,
    ...(elapsedMs === undefined ? {} : { watcherRefreshElapsedMs: elapsedMs })
  };
}

type UsePackageFileSyncArgs = {
  reloadCurrentCanvas: () => Promise<void>;
  refreshProjectDerivedState: () => Promise<void>;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
  setFileSyncDiagnostics: (diagnostics: string[]) => void;
  setFileSyncResult?: (result: DesktopPackageFileSyncResult | null) => void;
  setLastFileChange: (event: DesktopPackageFileChangeEvent | null) => void;
};

export function usePackageFileSync({
  reloadCurrentCanvas,
  refreshProjectDerivedState,
  selectedCanvasId,
  selectedProject,
  setError,
  setFileSyncDiagnostics,
  setFileSyncResult,
  setLastFileChange
}: UsePackageFileSyncArgs) {
  const refreshPackageFiles = useCallback(async (options?: DesktopPackageFileRefreshOptions, event?: DesktopPackageFileChangeEvent) => {
    if (!bridge || !selectedProject) {
      return;
    }
    try {
      const ref = desktopCanvasReference(selectedProject, selectedCanvasId);
      const result = options ? await bridge.refreshPackageFileChanges(ref, options) : await bridge.refreshPackageFileChanges(ref);
      const uiResult = syncResultWithWatcherMetadata(result, event);
      setFileSyncDiagnostics(uiResult.diagnostics.map((diagnostic) => diagnostic.message));
      setFileSyncResult?.(uiResult);
      if (!uiResult.ok) {
        const message = syncErrorMessage(uiResult);
        setError(message);
        try {
          await refreshProjectDerivedState();
        } catch (caught) {
          setError([message, errorMessage(caught)].filter(Boolean).join("\n"));
        }
        return;
      }
      if (shouldReloadCanvasAfterRefresh(uiResult)) {
        await reloadCurrentCanvas();
      } else {
        await refreshProjectDerivedState();
      }
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [refreshProjectDerivedState, reloadCurrentCanvas, selectedCanvasId, selectedProject, setError, setFileSyncDiagnostics, setFileSyncResult]);

  useEffect(() => {
    if (!bridge || !selectedProject) {
      return undefined;
    }
    return bridge.onPackageFileChanged((event) => {
      if (event.projectRoot !== selectedProject.rootPath || (event.canvasId ?? null) !== selectedCanvasId) {
        return;
      }
      setLastFileChange(event);
      void refreshPackageFiles({ changedPaths: event.paths }, event);
    });
  }, [refreshPackageFiles, selectedCanvasId, selectedProject, setLastFileChange]);

  return { refreshPackageFiles };
}
