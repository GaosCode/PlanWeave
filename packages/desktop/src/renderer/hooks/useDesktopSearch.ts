import { useCallback, useEffect, useState } from "react";
import type { DesktopProjectSummary, DesktopSearchResult } from "@planweave/runtime";
import { bridge } from "../bridge";
import { searchNavigationTarget } from "../components/SearchResultList";
import type { AppView } from "../types";

type UseDesktopSearchArgs = {
  handleBlockSelect: (ref: string) => Promise<void>;
  handleOpenRunRecord: (recordId: string | null | undefined) => Promise<void>;
  selectedProject: DesktopProjectSummary | null;
  setActiveView: (view: AppView) => void;
  setError: (message: string | null) => void;
  setSelectedContextNodeId: (nodeId: string | null) => void;
  setSelectedTaskPanelId: (taskId: string | null) => void;
};

export function useDesktopSearch({
  handleBlockSelect,
  handleOpenRunRecord,
  selectedProject,
  setActiveView,
  setError,
  setSelectedContextNodeId,
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
    (result: DesktopSearchResult) => {
      const target = searchNavigationTarget(result);
      if (target.kind === "task") {
        setSelectedTaskPanelId(target.ref);
        setSelectedContextNodeId(null);
        setActiveView("graph");
        return;
      }
      if (target.kind === "block") {
        void handleBlockSelect(target.ref);
        return;
      }
      if (target.kind === "context") {
        setSelectedTaskPanelId(null);
        setSelectedContextNodeId(target.ref);
        setActiveView("graph");
        return;
      }
      if (target.kind === "record") {
        void handleOpenRunRecord(target.recordId);
      }
    },
    [handleBlockSelect, handleOpenRunRecord, setActiveView, setSelectedContextNodeId, setSelectedTaskPanelId]
  );

  return { handleSearchResultOpen, searchQuery, searchResults, setSearchQuery };
}
