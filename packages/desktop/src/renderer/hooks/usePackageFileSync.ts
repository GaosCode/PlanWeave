import { useCallback, useEffect } from "react";
import type { DesktopPackageFileChangeEvent, DesktopProjectSummary } from "@planweave/runtime";
import { bridge } from "../bridge";

type UsePackageFileSyncArgs = {
  loadProject: (project: DesktopProjectSummary) => Promise<void>;
  selectedProject: DesktopProjectSummary | null;
  setDirtyPromptRefs: (refs: string[]) => void;
  setError: (message: string | null) => void;
  setFileSyncDiagnostics: (diagnostics: string[]) => void;
  setLastFileChange: (event: DesktopPackageFileChangeEvent | null) => void;
};

export function usePackageFileSync({
  loadProject,
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
      const result = await bridge.refreshPackageFileChanges(selectedProject.rootPath);
      setDirtyPromptRefs(result.dirtyPromptRefs);
      setFileSyncDiagnostics(result.diagnostics.map((diagnostic) => diagnostic.message));
      if (!result.ok) {
        setError(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
        return;
      }
      await loadProject(selectedProject);
      setDirtyPromptRefs(result.dirtyPromptRefs);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [loadProject, selectedProject, setDirtyPromptRefs, setError, setFileSyncDiagnostics]);

  useEffect(() => {
    if (!bridge || !selectedProject) {
      return undefined;
    }
    return bridge.onPackageFileChanged((event) => {
      if (event.projectRoot !== selectedProject.rootPath) {
        return;
      }
      setLastFileChange(event);
      void refreshPackageFiles();
    });
  }, [refreshPackageFiles, selectedProject, setLastFileChange]);

  return { refreshPackageFiles };
}
