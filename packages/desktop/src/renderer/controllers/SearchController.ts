import type { DesktopProjectSummary } from "@planweave-ai/runtime";
import { useDesktopSearch } from "../hooks/useDesktopSearch";
import type { WorkspaceTabsSearchProps } from "../views/WorkspaceTabs";

export type SearchControllerInput = WorkspaceTabsSearchProps;

export type SearchController = WorkspaceTabsSearchProps & {
  diagnostics: ReturnType<typeof useDesktopSearch>["searchDiagnostics"];
};

export function createSearchController(props: SearchControllerInput): SearchController {
  const selectedKinds = new Set(props.selectedSearchResultKinds);
  return {
    ...props,
    diagnostics: [],
    selectedSearchResultKinds: props.searchResultKinds.filter((kind) => selectedKinds.has(kind))
  };
}

export function useSearchController({
  handleBlockSelect,
  handleOpenRunRecord,
  loadProject,
  openTaskInspector,
  selectedCanvasId,
  selectedProject,
  setError
}: {
  handleBlockSelect: (ref: string, canvasId?: string | null) => Promise<void>;
  handleOpenRunRecord: (
    recordId: string | null | undefined,
    canvasId?: string | null
  ) => Promise<void>;
  loadProject: (project: DesktopProjectSummary, canvasId?: string | null) => Promise<void>;
  openTaskInspector: (taskId: string, canvasId?: string | null) => Promise<void>;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
}): SearchController {
  const {
    desktopSearchResultKinds: searchResultKinds,
    handleSearchResultOpen,
    searchCanvasScope,
    searchDiagnostics,
    searchQuery,
    searchResults,
    searchStatus,
    selectedSearchResultKinds,
    setSearchCanvasScope,
    setSearchQuery,
    setSearchResultKindEnabled
  } = useDesktopSearch({
    handleBlockSelect,
    handleOpenRunRecord,
    loadProject,
    openTaskInspector,
    selectedCanvasId,
    selectedProject,
    setError
  });
  const search = createSearchController({
    handleSearchResultOpen,
    searchCanvasScope,
    searchQuery,
    searchResultKinds,
    searchResults,
    searchStatus,
    selectedSearchResultKinds,
    setSearchCanvasScope,
    setSearchQuery,
    setSearchResultKindEnabled
  });

  return {
    ...search,
    diagnostics: searchDiagnostics
  };
}
