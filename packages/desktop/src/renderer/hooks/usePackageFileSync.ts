import { useCallback, useEffect } from "react";
import type {
  DesktopPackageFileChangeEvent,
  DesktopPackageFileRefreshOptions,
  DesktopPackageFileSyncResult,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";

function isProjectPromptChangePath(path: string): boolean {
  return path.split("\\").join("/").replace(/^\.\/+/, "").replace(/\/+$/, "") === "policy/project-prompt.md";
}

function shouldReloadCanvasAfterRefresh(options: DesktopPackageFileRefreshOptions | undefined, result: DesktopPackageFileSyncResult): boolean {
  return result.fullRefresh || (options?.changedPaths ?? []).some(isProjectPromptChangePath);
}

type UsePackageFileSyncArgs = {
  reloadCurrentCanvas: () => Promise<void>;
  refreshProjectDerivedState: () => Promise<void>;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setDirtyPromptRefs: (refs: string[]) => void;
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
  setDirtyPromptRefs,
  setError,
  setFileSyncDiagnostics,
  setFileSyncResult,
  setLastFileChange
}: UsePackageFileSyncArgs) {
  const refreshPackageFiles = useCallback(async (options?: DesktopPackageFileRefreshOptions) => {
    if (!bridge || !selectedProject) {
      return;
    }
    try {
      const ref = desktopCanvasReference(selectedProject, selectedCanvasId);
      const result = options ? await bridge.refreshPackageFileChanges(ref, options) : await bridge.refreshPackageFileChanges(ref);
      setDirtyPromptRefs(result.dirtyPromptRefs);
      setFileSyncDiagnostics(result.diagnostics.map((diagnostic) => diagnostic.message));
      setFileSyncResult?.(result);
      if (!result.ok) {
        setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
        return;
      }
      if (shouldReloadCanvasAfterRefresh(options, result)) {
        await reloadCurrentCanvas();
      } else {
        await refreshProjectDerivedState();
      }
      setDirtyPromptRefs(result.dirtyPromptRefs);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [refreshProjectDerivedState, reloadCurrentCanvas, selectedCanvasId, selectedProject, setDirtyPromptRefs, setError, setFileSyncDiagnostics, setFileSyncResult]);

  useEffect(() => {
    if (!bridge || !selectedProject) {
      return undefined;
    }
    return bridge.onPackageFileChanged((event) => {
      if (event.projectRoot !== selectedProject.rootPath || (event.canvasId ?? null) !== selectedCanvasId) {
        return;
      }
      setLastFileChange(event);
      void refreshPackageFiles({ changedPaths: event.paths });
    });
  }, [refreshPackageFiles, selectedCanvasId, selectedProject, setLastFileChange]);

  return { refreshPackageFiles };
}
