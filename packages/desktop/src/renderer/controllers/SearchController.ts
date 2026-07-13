import type { DesktopProjectSummary } from "@planweave-ai/runtime";
import { useDesktopSearch } from "../hooks/useDesktopSearch";
import type { TaskWorkspaceNavigationTarget } from "../taskWorkspaceNavigation";
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
  openRunWorkspace,
  openTaskWorkspace,
  selectedCanvasId,
  selectedProject,
  setError
}: {
  openRunWorkspace: (locator: {
    projectRoot: string;
    canvasId: string;
    recordId: string;
    expectedBlockRef: string;
  }) => Promise<void>;
  openTaskWorkspace: (target: TaskWorkspaceNavigationTarget) => void;
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
    openRunWorkspace,
    openTaskWorkspace,
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
