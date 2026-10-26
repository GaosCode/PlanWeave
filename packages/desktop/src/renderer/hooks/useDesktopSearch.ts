import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DesktopProjectSummary,
  DesktopSearchFilters,
  DesktopSearchProjection,
  DesktopSearchResult,
  DesktopSearchResultKind,
  ValidationIssue
} from "@planweave-ai/runtime";
import { bridge } from "../bridge";
import { useSearchInvalidation } from "./useSearchInvalidation";
import { searchNavigationTarget } from "../components/SearchResultList";
import {
  blockWorkspaceTarget,
  taskWorkspaceTarget,
  type TaskWorkspaceNavigationTarget
} from "../taskWorkspaceNavigation";

export type DesktopSearchCanvasScope = "all" | "current";

export const desktopSearchResultKinds: DesktopSearchResultKind[] = [
  "task",
  "block",
  "prompt",
  "run_record",
  "review_attempt",
  "feedback"
];

export type DesktopSearchStatus =
  | { phase: "idle" }
  | { phase: "debouncing" }
  | { phase: "summary_loading" }
  | { phase: "body_loading"; summaryResultCount: number; truncated: boolean }
  | { phase: "complete"; resultCount: number; expandedBodySearch: boolean; truncated: boolean }
  | { phase: "error"; message: string };

const bodySearchResultKinds = new Set<DesktopSearchResultKind>([
  "prompt",
  "run_record",
  "review_attempt"
]);

type UseDesktopSearchArgs = {
  enabled?: boolean;
  packageFingerprint?: string;
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
};

function normalizeSearchResultKinds(kinds: DesktopSearchResultKind[]): DesktopSearchResultKind[] {
  const selected = new Set(kinds);
  return desktopSearchResultKinds.filter((kind) => selected.has(kind));
}

function selectedKindsNeedBodySearch(kinds: DesktopSearchResultKind[]): boolean {
  return kinds.some((kind) => bodySearchResultKinds.has(kind));
}

export function useDesktopSearch({
  enabled = true,
  packageFingerprint,
  openRunWorkspace,
  openTaskWorkspace,
  selectedCanvasId,
  selectedProject,
  setError
}: UseDesktopSearchArgs) {
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<DesktopSearchResult[]>([]);
  const [searchResultsProjectRoot, setSearchResultsProjectRoot] = useState<string | null>(null);
  const [searchDiagnostics, setSearchDiagnostics] = useState<ValidationIssue[]>([]);
  const [searchStatus, setSearchStatus] = useState<DesktopSearchStatus>({ phase: "idle" });
  const [selectedSearchResultKinds, setSelectedSearchResultKinds] = useState<
    DesktopSearchResultKind[]
  >(() => [...desktopSearchResultKinds]);
  const [searchCanvasScope, setSearchCanvasScope] = useState<DesktopSearchCanvasScope>("all");
  const requestSequence = useRef(0);
  const setErrorRef = useRef(setError);
  useEffect(() => {
    setErrorRef.current = setError;
  }, [setError]);
  const clearSearchResults = useCallback(() => {
    setSearchResults((current) => (current.length ? [] : current));
    setSearchResultsProjectRoot(null);
  }, []);
  const clearSearchDiagnostics = useCallback(() => {
    setSearchDiagnostics((current) => (current.length ? [] : current));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearchQuery(searchQuery), 300);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const setSearchResultKindEnabled = useCallback(
    (kind: DesktopSearchResultKind, enabled: boolean) => {
      setSelectedSearchResultKinds((current) => {
        const next = new Set(current);
        if (enabled) {
          next.add(kind);
        } else if (next.size > 1) {
          next.delete(kind);
        }
        const normalized = normalizeSearchResultKinds([...next]);
        return normalized.length === current.length &&
          normalized.every((value, index) => value === current[index])
          ? current
          : normalized;
      });
    },
    []
  );

  const selectedSearchKindKey = selectedSearchResultKinds.join(",");
  const projectRoot = selectedProject?.rootPath ?? null;
  const normalizedDebouncedQuery = debouncedSearchQuery.trim();
  const normalizedSearchQuery = searchQuery.trim();
  const rawQueryIsEmpty = !normalizedSearchQuery;
  const canvasFilterId =
    searchCanvasScope === "current" && selectedCanvasId ? selectedCanvasId : undefined;
  const { active, revision } = useSearchInvalidation({
    enabled,
    projectRoot,
    canvasFilterId,
    packageFingerprint
  });
  const searchKey = useMemo(() => {
    if (!projectRoot || !normalizedDebouncedQuery) {
      return null;
    }
    return [
      projectRoot,
      normalizedDebouncedQuery.toLowerCase(),
      selectedSearchKindKey,
      canvasFilterId ?? "all",
      revision
    ].join("\u001f");
  }, [canvasFilterId, normalizedDebouncedQuery, projectRoot, revision, selectedSearchKindKey]);

  useEffect(() => {
    if (!bridge || !projectRoot || rawQueryIsEmpty) {
      clearSearchResults();
      clearSearchDiagnostics();
      setSearchStatus({ phase: "idle" });
      return;
    }
    if (normalizedSearchQuery !== normalizedDebouncedQuery) {
      clearSearchResults();
      clearSearchDiagnostics();
      setSearchStatus({ phase: "debouncing" });
    }
  }, [
    clearSearchDiagnostics,
    clearSearchResults,
    normalizedDebouncedQuery,
    normalizedSearchQuery,
    projectRoot,
    rawQueryIsEmpty
  ]);

  useEffect(() => {
    if (!bridge || !projectRoot || rawQueryIsEmpty) {
      clearSearchResults();
      clearSearchDiagnostics();
      setSearchStatus({ phase: "idle" });
      return;
    }
    if (
      !normalizedDebouncedQuery ||
      normalizedSearchQuery !== normalizedDebouncedQuery ||
      !searchKey
    ) {
      return;
    }
    if (!active) {
      return;
    }
    const desktopBridge = bridge;
    const requestId = ++requestSequence.current;
    let cancelled = false;
    const filters: DesktopSearchFilters = {
      kinds: selectedSearchResultKinds
    };
    if (canvasFilterId) {
      filters.canvasId = canvasFilterId;
    }
    const summaryFilters = { ...filters, includeBodies: false };
    const bodyFilters = selectedKindsNeedBodySearch(selectedSearchResultKinds)
      ? { ...filters, includeBodies: true }
      : null;
    const isLatestSearch = () => !cancelled && requestSequence.current === requestId;
    const applySummaryResults = (projection: DesktopSearchProjection) => {
      if (!isLatestSearch()) {
        return;
      }
      const { diagnostics, results, truncated } = projection;
      setSearchDiagnostics(diagnostics);
      setSearchResults(results);
      setSearchResultsProjectRoot(projectRoot);
      if (bodyFilters) {
        setSearchStatus({ phase: "body_loading", summaryResultCount: results.length, truncated });
        return;
      }
      setSearchStatus({
        phase: "complete",
        resultCount: results.length,
        expandedBodySearch: false,
        truncated
      });
    };
    const applyBodyResults = (projection: DesktopSearchProjection) => {
      if (!isLatestSearch()) {
        return;
      }
      const { diagnostics, results, truncated } = projection;
      setSearchDiagnostics(diagnostics);
      setSearchResults(results);
      setSearchResultsProjectRoot(projectRoot);
      setSearchStatus({
        phase: "complete",
        resultCount: results.length,
        expandedBodySearch: true,
        truncated
      });
    };
    const applyError = (caught: unknown) => {
      if (!isLatestSearch()) {
        return;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      setSearchStatus({ phase: "error", message });
      setErrorRef.current(message);
    };
    if (!cancelled && requestSequence.current === requestId) {
      clearSearchResults();
      clearSearchDiagnostics();
      setSearchStatus({ phase: "summary_loading" });
    }
    void (async () => {
      try {
        applySummaryResults(
          await desktopBridge.searchProjectWithDiagnostics(
            projectRoot,
            normalizedDebouncedQuery,
            summaryFilters
          )
        );
        if (bodyFilters && isLatestSearch()) {
          applyBodyResults(
            await desktopBridge.searchProjectWithDiagnostics(
              projectRoot,
              normalizedDebouncedQuery,
              bodyFilters
            )
          );
        }
      } catch (caught) {
        applyError(caught);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    active,
    canvasFilterId,
    clearSearchDiagnostics,
    clearSearchResults,
    normalizedDebouncedQuery,
    normalizedSearchQuery,
    projectRoot,
    rawQueryIsEmpty,
    searchKey,
    selectedSearchResultKinds
  ]);

  const handleSearchResultOpen = useCallback(
    async (result: DesktopSearchResult) => {
      try {
        if (!searchResultsProjectRoot) {
          throw new Error(
            "Cannot open search result because its project authority is unavailable."
          );
        }
        if (!result.canvasId) {
          throw new Error("Cannot open search result because its canvas authority is unavailable.");
        }
        const target = searchNavigationTarget(result);
        if (target.kind === "task") {
          openTaskWorkspace(
            taskWorkspaceTarget({
              projectRoot: searchResultsProjectRoot,
              canvasId: result.canvasId,
              taskId: target.ref
            })
          );
          return;
        }
        if (target.kind === "block") {
          const taskId = target.ref.slice(0, target.ref.indexOf("#"));
          openTaskWorkspace(
            blockWorkspaceTarget({
              projectRoot: searchResultsProjectRoot,
              canvasId: result.canvasId,
              taskId,
              blockRef: target.ref
            })
          );
          return;
        }
        if (target.kind === "record") {
          if (!result.targetRef) {
            throw new Error("Cannot open run record because its block authority is unavailable.");
          }
          await openRunWorkspace({
            projectRoot: searchResultsProjectRoot,
            canvasId: result.canvasId,
            recordId: target.recordId,
            expectedBlockRef: result.targetRef
          });
          return;
        }
        throw new Error("Cannot open search result because it has no navigation target.");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [openRunWorkspace, openTaskWorkspace, searchResultsProjectRoot, setError]
  );

  return {
    desktopSearchResultKinds,
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
  };
}
