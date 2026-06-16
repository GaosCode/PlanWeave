import { useCallback, useEffect } from "react";
import type { DesktopPackageFileChangeEvent, DesktopProjectSummary } from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";

type UsePackageFileSyncArgs = {
  reloadCurrentCanvas: () => Promise<void>;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setDirtyPromptRefs: (refs: string[]) => void;
  setError: (message: string | null) => void;
  setFileSyncDiagnostics: (diagnostics: string[]) => void;
  setLastFileChange: (event: DesktopPackageFileChangeEvent | null) => void;
};

export function usePackageFileSync({
  reloadCurrentCanvas,
  selectedCanvasId,
  selectedProject,
  setDirtyPromptRefs,
  setError,
  setFileSyncDiagnostics,
  setLastFileChange
}: UsePackageFileSyncArgs) {
  const refreshPackageFiles = useCallback(async () => {
    if (!bridge || !selectedProject) {
      return;
    }
    try {
      const result = await bridge.refreshPackageFileChanges(desktopCanvasReference(selectedProject, selectedCanvasId));
      setDirtyPromptRefs(result.dirtyPromptRefs);
      setFileSyncDiagnostics(result.diagnostics.map((diagnostic) => diagnostic.message));
      if (!result.ok) {
        setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
        return;
      }
      await reloadCurrentCanvas();
      setDirtyPromptRefs(result.dirtyPromptRefs);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [reloadCurrentCanvas, selectedCanvasId, selectedProject, setDirtyPromptRefs, setError, setFileSyncDiagnostics]);

  useEffect(() => {
    if (!bridge || !selectedProject) {
      return undefined;
    }
    return bridge.onPackageFileChanged((event) => {
      if (event.projectRoot !== selectedProject.rootPath || (event.canvasId ?? null) !== selectedCanvasId) {
        return;
      }
      setLastFileChange(event);
      void refreshPackageFiles();
    });
  }, [refreshPackageFiles, selectedCanvasId, selectedProject, setLastFileChange]);

  return { refreshPackageFiles };
}
