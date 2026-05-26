import { useCallback, useEffect, useState } from "react";
import type { DesktopProjectSummary, DesktopSearchResult } from "@planweave/runtime";
import { bridge } from "../bridge";
import { searchNavigationTarget } from "../components/SearchResultList";
import type { AppView } from "../types";

type UseDesktopSearchArgs = {
  handleBlockSelect: (ref: string, canvasId?: string | null) => Promise<void>;
  handleOpenRunRecord: (recordId: string | null | undefined, canvasId?: string | null) => Promise<void>;
  loadProject: (project: DesktopProjectSummary, canvasId?: string | null) => Promise<void>;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setActiveView: (view: AppView) => void;
  setError: (message: string | null) => void;
  setSelectedTaskPanelId: (taskId: string | null) => void;
};

export function useDesktopSearch({
  handleBlockSelect,
  handleOpenRunRecord,
  loadProject,
  selectedCanvasId,
  selectedProject,
  setActiveView,
  setError,
  setSelectedTaskPanelId
}: UseDesktopSearchArgs) {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<DesktopSearchResult[]>([]);

  useEffect(() => {
    if (!bridge || !selectedProject || !searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    bridge
      .searchProject(selectedProject.rootPath, searchQuery)
      .then((results) => {
        if (!cancelled) {
          setSearchResults(results);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [searchQuery, selectedProject, setError]);

  const handleSearchResultOpen = useCallback(
    async (result: DesktopSearchResult) => {
      if (selectedProject && result.canvasId && result.canvasId !== selectedCanvasId) {
        await loadProject(selectedProject, result.canvasId);
      }
      const target = searchNavigationTarget(result);
      if (target.kind === "task") {
        setSelectedTaskPanelId(target.ref);
        setActiveView("graph");
        return;
      }
      if (target.kind === "block") {
        await handleBlockSelect(target.ref, result.canvasId ?? selectedCanvasId);
        return;
      }
      if (target.kind === "record") {
        await handleOpenRunRecord(target.recordId, result.canvasId ?? selectedCanvasId);
      }
    },
    [handleBlockSelect, handleOpenRunRecord, loadProject, selectedCanvasId, selectedProject, setActiveView, setSelectedTaskPanelId]
  );

  return { handleSearchResultOpen, searchQuery, searchResults, setSearchQuery };
}
