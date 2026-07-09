/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  DesktopProjectSummary,
  DesktopSearchProjection,
  DesktopSearchResult,
  ValidationIssue
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";

const project: DesktopProjectSummary = {
  projectId: "P-001",
  name: "Demo project",
  rootPath: "/tmp/demo",
  workspaceRoot: "/tmp/demo",
  activeCanvasId: "canvas-main",
  taskCanvases: [
    {
      canvasId: "canvas-main",
      name: "Main canvas",
      taskCount: 2,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z"
    }
  ]
};

function searchArgs(overrides: Partial<ReturnType<typeof searchArgsBase>> = {}) {
  return {
    ...searchArgsBase(),
    ...overrides
  };
}

function searchArgsBase() {
  return {
    handleBlockSelect: vi.fn().mockResolvedValue(undefined),
    handleOpenRunRecord: vi.fn().mockResolvedValue(undefined),
    openTaskInspector: vi.fn().mockResolvedValue(undefined),
    loadProject: vi.fn().mockResolvedValue(undefined),
    selectedCanvasId: "canvas-main",
    selectedProject: project,
    setError: vi.fn()
  };
}

function searchProjection(
  results: DesktopSearchResult[],
  diagnostics: ValidationIssue[] = []
): DesktopSearchProjection {
  return { diagnostics, results };
}

async function waitForSearchDebounce(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 350));
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("desktop search hook", () => {
  it("debounces bridge calls and deduplicates unchanged filter keys", async () => {
    const searchResults: DesktopSearchResult[] = [
      { kind: "task", ref: "T-ALPHA", title: "Alpha task", excerpt: "Alpha task" }
    ];
    const bridge = createDesktopBridgeMock({
      searchProjectWithDiagnostics: vi.fn().mockResolvedValue(searchProjection(searchResults))
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopSearch } = await import("../renderer/hooks/useDesktopSearch");

    const { result } = renderHook(() => useDesktopSearch(searchArgs()));

    act(() => {
      result.current.setSearchQuery("Alpha");
    });

    expect(bridge.searchProjectWithDiagnostics).not.toHaveBeenCalled();
    expect(result.current.searchStatus).toEqual({ phase: "debouncing" });

    await waitForSearchDebounce();

    expect(bridge.searchProjectWithDiagnostics).toHaveBeenCalledTimes(2);
    expect(bridge.searchProjectWithDiagnostics).toHaveBeenNthCalledWith(
      1,
      project.rootPath,
      "Alpha",
      {
        kinds: ["task", "block", "prompt", "run_record", "review_attempt", "feedback"],
        includeBodies: false
      }
    );
    expect(bridge.searchProjectWithDiagnostics).toHaveBeenNthCalledWith(
      2,
      project.rootPath,
      "Alpha",
      {
        kinds: ["task", "block", "prompt", "run_record", "review_attempt", "feedback"],
        includeBodies: true
      }
    );
    expect(result.current.searchResults).toEqual(searchResults);
    expect(result.current.searchStatus).toEqual({
      phase: "complete",
      resultCount: searchResults.length,
      expandedBodySearch: true
    });

    act(() => {
      result.current.setSearchResultKindEnabled("task", true);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(bridge.searchProjectWithDiagnostics).toHaveBeenCalledTimes(2);
  });

  it("passes result kind and current canvas filters through bridge search", async () => {
    const bridge = createDesktopBridgeMock({
      searchProjectWithDiagnostics: vi.fn().mockResolvedValue(searchProjection([]))
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopSearch } = await import("../renderer/hooks/useDesktopSearch");

    const { result } = renderHook(() => useDesktopSearch(searchArgs()));

    act(() => {
      result.current.setSearchQuery("Alpha");
    });
    await waitForSearchDebounce();

    act(() => {
      result.current.setSearchResultKindEnabled("feedback", false);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(bridge.searchProjectWithDiagnostics).toHaveBeenLastCalledWith(
      project.rootPath,
      "Alpha",
      {
        kinds: ["task", "block", "prompt", "run_record", "review_attempt"],
        includeBodies: true
      }
    );

    act(() => {
      result.current.setSearchCanvasScope("current");
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(bridge.searchProjectWithDiagnostics).toHaveBeenLastCalledWith(
      project.rootPath,
      "Alpha",
      {
        kinds: ["task", "block", "prompt", "run_record", "review_attempt"],
        canvasId: "canvas-main",
        includeBodies: true
      }
    );
  });

  it("returns summary search before hydrating body results in the background", async () => {
    let resolveBodySearch: (projection: DesktopSearchProjection) => void = () => undefined;
    const summaryResults: DesktopSearchResult[] = [
      { kind: "task", ref: "T-ALPHA", title: "Alpha task", excerpt: "Alpha task" }
    ];
    const bodyResults: DesktopSearchResult[] = [
      {
        kind: "prompt",
        ref: "T-ALPHA",
        targetRef: "T-ALPHA",
        title: "Alpha task",
        excerpt: "Alpha prompt body"
      }
    ];
    const bodyDiagnostics: ValidationIssue[] = [
      {
        code: "desktop_search_index_slow_part",
        message: "Desktop projection body search index construction took 12 ms.",
        path: project.rootPath
      }
    ];
    const bridge = createDesktopBridgeMock({
      searchProjectWithDiagnostics: vi
        .fn()
        .mockResolvedValueOnce(searchProjection(summaryResults))
        .mockReturnValueOnce(
          new Promise<DesktopSearchProjection>((resolve) => {
            resolveBodySearch = resolve;
          })
        )
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopSearch } = await import("../renderer/hooks/useDesktopSearch");

    const { result } = renderHook(() => useDesktopSearch(searchArgs()));

    act(() => {
      result.current.setSearchQuery("Alpha");
    });
    await waitForSearchDebounce();

    expect(bridge.searchProjectWithDiagnostics).toHaveBeenNthCalledWith(
      1,
      project.rootPath,
      "Alpha",
      {
        kinds: ["task", "block", "prompt", "run_record", "review_attempt", "feedback"],
        includeBodies: false
      }
    );
    expect(result.current.searchResults).toEqual(summaryResults);
    expect(result.current.searchStatus).toEqual({
      phase: "body_loading",
      summaryResultCount: summaryResults.length
    });
    expect(result.current.searchDiagnostics).toEqual([]);
    expect(bridge.searchProjectWithDiagnostics).toHaveBeenNthCalledWith(
      2,
      project.rootPath,
      "Alpha",
      {
        kinds: ["task", "block", "prompt", "run_record", "review_attempt", "feedback"],
        includeBodies: true
      }
    );

    await act(async () => {
      resolveBodySearch(searchProjection(bodyResults, bodyDiagnostics));
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.searchResults).toEqual(bodyResults));
    expect(result.current.searchDiagnostics).toEqual(bodyDiagnostics);
    expect(result.current.searchStatus).toEqual({
      phase: "complete",
      resultCount: bodyResults.length,
      expandedBodySearch: true
    });
  });

  it("reports summary loading while the first search phase is pending", async () => {
    let resolveSummarySearch: (projection: DesktopSearchProjection) => void = () => undefined;
    const bridge = createDesktopBridgeMock({
      searchProjectWithDiagnostics: vi.fn().mockReturnValue(
        new Promise<DesktopSearchProjection>((resolve) => {
          resolveSummarySearch = resolve;
        })
      )
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopSearch } = await import("../renderer/hooks/useDesktopSearch");

    const { result } = renderHook(() => useDesktopSearch(searchArgs()));

    act(() => {
      result.current.setSearchQuery("Alpha");
    });
    await waitForSearchDebounce();

    expect(result.current.searchStatus).toEqual({ phase: "summary_loading" });

    await act(async () => {
      resolveSummarySearch(searchProjection([]));
      await Promise.resolve();
    });
  });

  it("clears empty queries and prevents stale results from replacing them", async () => {
    let resolveSearch: (projection: DesktopSearchProjection) => void = () => undefined;
    const pendingSearch = new Promise<DesktopSearchProjection>((resolve) => {
      resolveSearch = resolve;
    });
    const bridge = createDesktopBridgeMock({
      searchProjectWithDiagnostics: vi.fn().mockReturnValue(pendingSearch)
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopSearch } = await import("../renderer/hooks/useDesktopSearch");

    const { result } = renderHook(() => useDesktopSearch(searchArgs()));

    act(() => {
      result.current.setSearchQuery("Alpha");
    });
    await waitForSearchDebounce();
    expect(bridge.searchProjectWithDiagnostics).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.setSearchQuery("");
    });
    expect(result.current.searchResults).toEqual([]);
    expect(result.current.searchStatus).toEqual({ phase: "idle" });

    await act(async () => {
      resolveSearch(
        searchProjection([
          { kind: "task", ref: "T-ALPHA", title: "Alpha task", excerpt: "Alpha task" }
        ])
      );
      await Promise.resolve();
    });

    expect(result.current.searchResults).toEqual([]);
    expect(result.current.searchStatus).toEqual({ phase: "idle" });
  });

  it("prevents stale searches from replacing a newer query state or results", async () => {
    let resolveAlphaSearch: (projection: DesktopSearchProjection) => void = () => undefined;
    let resolveBetaSearch: (projection: DesktopSearchProjection) => void = () => undefined;
    const alphaResults: DesktopSearchResult[] = [
      { kind: "task", ref: "T-ALPHA", title: "Alpha task", excerpt: "Alpha task" }
    ];
    const betaResults: DesktopSearchResult[] = [
      { kind: "task", ref: "T-BETA", title: "Beta task", excerpt: "Beta task" }
    ];
    const bridge = createDesktopBridgeMock({
      searchProjectWithDiagnostics: vi
        .fn()
        .mockReturnValueOnce(
          new Promise<DesktopSearchProjection>((resolve) => {
            resolveAlphaSearch = resolve;
          })
        )
        .mockResolvedValueOnce(searchProjection([]))
        .mockReturnValueOnce(
          new Promise<DesktopSearchProjection>((resolve) => {
            resolveBetaSearch = resolve;
          })
        )
        .mockResolvedValueOnce(searchProjection(betaResults))
    });
    vi.stubGlobal("planweave", bridge);
    vi.resetModules();
    const { useDesktopSearch } = await import("../renderer/hooks/useDesktopSearch");

    const { result } = renderHook(() => useDesktopSearch(searchArgs()));

    act(() => {
      result.current.setSearchQuery("Alpha");
    });
    await waitForSearchDebounce();
    expect(result.current.searchStatus).toEqual({ phase: "summary_loading" });

    act(() => {
      result.current.setSearchQuery("Beta");
    });
    expect(result.current.searchStatus).toEqual({ phase: "debouncing" });

    await act(async () => {
      resolveAlphaSearch(searchProjection(alphaResults));
      await Promise.resolve();
    });

    expect(result.current.searchResults).toEqual([]);
    expect(result.current.searchStatus).toEqual({ phase: "debouncing" });

    await waitForSearchDebounce();
    await act(async () => {
      resolveBetaSearch(searchProjection(betaResults));
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.searchResults).toEqual(betaResults));
    expect(result.current.searchStatus).toEqual({
      phase: "complete",
      resultCount: betaResults.length,
      expandedBodySearch: true
    });
  });

  it("opens task, block, and record targets from search results", async () => {
    const args = searchArgs();
    vi.resetModules();
    const { useDesktopSearch } = await import("../renderer/hooks/useDesktopSearch");

    const { result } = renderHook(() => useDesktopSearch(args));

    await act(async () => {
      await result.current.handleSearchResultOpen({
        kind: "prompt",
        ref: "T-001",
        targetRef: "T-001",
        title: "Task prompt",
        excerpt: "task"
      });
      await result.current.handleSearchResultOpen({
        kind: "review_attempt",
        ref: "T-001/reviews/R-001/attempts/REV-001/review-result.json",
        targetRef: "T-001#R-001",
        title: "Review",
        excerpt: "review"
      });
      await result.current.handleSearchResultOpen({
        kind: "feedback",
        ref: "FE-001",
        targetRef: "T-001#R-001",
        title: "Feedback",
        excerpt: "feedback"
      });
      await result.current.handleSearchResultOpen({
        kind: "run_record",
        ref: "T-001/blocks/B-001/runs/RUN-001/report.md",
        recordId: "T-001#B-001::RUN-001",
        title: "Run",
        excerpt: "run"
      });
    });

    expect(args.openTaskInspector).toHaveBeenCalledWith("T-001", "canvas-main");
    expect(args.handleBlockSelect).toHaveBeenCalledWith("T-001#R-001", "canvas-main");
    expect(args.handleBlockSelect).toHaveBeenCalledTimes(2);
    expect(args.handleOpenRunRecord).toHaveBeenCalledWith("T-001#B-001::RUN-001", "canvas-main");
  });

  it("loads the result canvas before opening its target", async () => {
    const args = searchArgs();
    vi.resetModules();
    const { useDesktopSearch } = await import("../renderer/hooks/useDesktopSearch");

    const { result } = renderHook(() => useDesktopSearch(args));

    await act(async () => {
      await result.current.handleSearchResultOpen({
        kind: "prompt",
        canvasId: "canvas-other",
        ref: "T-REMOTE",
        targetRef: "T-REMOTE",
        title: "Remote task prompt",
        excerpt: "remote"
      });
    });

    expect(args.loadProject).toHaveBeenCalledWith(project, "canvas-other");
    expect(args.openTaskInspector).toHaveBeenCalledWith("T-REMOTE", "canvas-other");
    expect(args.loadProject.mock.invocationCallOrder[0]).toBeLessThan(
      args.openTaskInspector.mock.invocationCallOrder[0]
    );
  });
});
