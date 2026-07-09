/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  DesktopProjectSummary,
  DesktopSearchResult,
  DesktopSearchResultKind
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSearchCanvasScope } from "../renderer/hooks/useDesktopSearch";
import { createTranslator } from "../renderer/i18n";
import { SearchView } from "../renderer/views/SearchView";

const searchResultKinds: DesktopSearchResultKind[] = [
  "task",
  "block",
  "prompt",
  "run_record",
  "review_attempt",
  "feedback"
];
const project: DesktopProjectSummary = {
  projectId: "P-001",
  name: "Demo",
  rootPath: "/tmp/demo",
  workspaceRoot: "/tmp/demo",
  activeCanvasId: "canvas-main",
  taskCanvases: []
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SearchView", () => {
  function stubResizeObserver() {
    class ResizeObserverMock {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  }

  it("explains that search depends on project data when no project is open", async () => {
    stubResizeObserver();
    const handleOpenProject = vi.fn().mockResolvedValue(undefined);

    render(
      <SearchView
        handleOpenProject={handleOpenProject}
        handleSearchResultOpen={vi.fn().mockResolvedValue(undefined)}
        searchCanvasScope="all"
        searchQuery=""
        searchResultKinds={searchResultKinds}
        searchResults={[]}
        searchStatus={{ phase: "idle" }}
        selectedCanvasId={null}
        selectedProject={null}
        selectedSearchResultKinds={searchResultKinds}
        setSearchCanvasScope={vi.fn()}
        setSearchQuery={vi.fn()}
        setSearchResultKindEnabled={vi.fn()}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByText("Open a project to search")).toBeInTheDocument();
    expect(screen.getByText(/Search can find tasks, blocks, prompts/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open Project" }));

    expect(handleOpenProject).toHaveBeenCalledTimes(1);
  });

  it("updates result kind and canvas scope controls through props", async () => {
    stubResizeObserver();
    function SearchHarness() {
      const [selectedKinds, setSelectedKinds] =
        useState<DesktopSearchResultKind[]>(searchResultKinds);
      const [scope, setScope] = useState<DesktopSearchCanvasScope>("all");
      return (
        <SearchView
          handleOpenProject={vi.fn().mockResolvedValue(undefined)}
          handleSearchResultOpen={vi.fn().mockResolvedValue(undefined)}
          searchCanvasScope={scope}
          searchQuery=""
          searchResultKinds={searchResultKinds}
          searchResults={[]}
          searchStatus={{ phase: "idle" }}
          selectedCanvasId="canvas-main"
          selectedProject={{
            projectId: "P-001",
            name: "Demo",
            rootPath: "/tmp/demo",
            workspaceRoot: "/tmp/demo",
            activeCanvasId: "canvas-main",
            taskCanvases: []
          }}
          selectedSearchResultKinds={selectedKinds}
          setSearchCanvasScope={setScope}
          setSearchQuery={vi.fn()}
          setSearchResultKindEnabled={(kind, enabled) => {
            setSelectedKinds((current) =>
              enabled ? [...current, kind] : current.filter((selected) => selected !== kind)
            );
          }}
          t={createTranslator("en")}
        />
      );
    }

    render(<SearchHarness />);

    expect(screen.getByTestId("search-kind-feedback")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByTestId("search-kind-feedback"));
    expect(screen.getByTestId("search-kind-feedback")).toHaveAttribute("aria-pressed", "false");

    expect(screen.getByTestId("search-scope-all")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByTestId("search-scope-current"));
    expect(screen.getByTestId("search-scope-current")).toHaveAttribute("aria-pressed", "true");
  });

  it("shows search stage feedback without deriving it from result length", () => {
    stubResizeObserver();
    render(
      <SearchView
        handleOpenProject={vi.fn().mockResolvedValue(undefined)}
        handleSearchResultOpen={vi.fn().mockResolvedValue(undefined)}
        searchCanvasScope="all"
        searchQuery="alpha"
        searchResultKinds={searchResultKinds}
        searchResults={[]}
        searchStatus={{ phase: "summary_loading" }}
        selectedCanvasId="canvas-main"
        selectedProject={project}
        selectedSearchResultKinds={searchResultKinds}
        setSearchCanvasScope={vi.fn()}
        setSearchQuery={vi.fn()}
        setSearchResultKindEnabled={vi.fn()}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByTestId("search-status")).toHaveTextContent(
      "Searching task and block summaries"
    );
    expect(screen.queryByText("No results found")).not.toBeInTheDocument();
  });

  it("keeps summary results visible while body search is pending", () => {
    stubResizeObserver();
    const results: DesktopSearchResult[] = [
      { kind: "task", ref: "T-ALPHA", title: "Alpha task", excerpt: "Alpha task" }
    ];

    render(
      <SearchView
        handleOpenProject={vi.fn().mockResolvedValue(undefined)}
        handleSearchResultOpen={vi.fn().mockResolvedValue(undefined)}
        searchCanvasScope="all"
        searchQuery="alpha"
        searchResultKinds={searchResultKinds}
        searchResults={results}
        searchStatus={{ phase: "body_loading", summaryResultCount: results.length }}
        selectedCanvasId="canvas-main"
        selectedProject={project}
        selectedSearchResultKinds={searchResultKinds}
        setSearchCanvasScope={vi.fn()}
        setSearchQuery={vi.fn()}
        setSearchResultKindEnabled={vi.fn()}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByTestId("search-status")).toHaveTextContent(
      "Expanding body search Summary results: 1"
    );
    expect(screen.getAllByText("Alpha task").length).toBeGreaterThan(0);
  });

  it("shows no results only after search completes with zero results", () => {
    stubResizeObserver();
    render(
      <SearchView
        handleOpenProject={vi.fn().mockResolvedValue(undefined)}
        handleSearchResultOpen={vi.fn().mockResolvedValue(undefined)}
        searchCanvasScope="all"
        searchQuery="missing"
        searchResultKinds={searchResultKinds}
        searchResults={[]}
        searchStatus={{ phase: "complete", resultCount: 0, expandedBodySearch: true }}
        selectedCanvasId="canvas-main"
        selectedProject={project}
        selectedSearchResultKinds={searchResultKinds}
        setSearchCanvasScope={vi.fn()}
        setSearchQuery={vi.fn()}
        setSearchResultKindEnabled={vi.fn()}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByText("No results found")).toBeInTheDocument();
  });

  it("shows result count after completed searches with matches", () => {
    stubResizeObserver();
    const results: DesktopSearchResult[] = [
      { kind: "task", ref: "T-ALPHA", title: "Alpha task", excerpt: "Alpha task" }
    ];

    render(
      <SearchView
        handleOpenProject={vi.fn().mockResolvedValue(undefined)}
        handleSearchResultOpen={vi.fn().mockResolvedValue(undefined)}
        searchCanvasScope="all"
        searchQuery="alpha"
        searchResultKinds={searchResultKinds}
        searchResults={results}
        searchStatus={{ phase: "complete", resultCount: results.length, expandedBodySearch: true }}
        selectedCanvasId="canvas-main"
        selectedProject={project}
        selectedSearchResultKinds={searchResultKinds}
        setSearchCanvasScope={vi.fn()}
        setSearchQuery={vi.fn()}
        setSearchResultKindEnabled={vi.fn()}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByTestId("search-status")).toHaveTextContent("Results: 1");
    expect(screen.queryByText("No results found")).not.toBeInTheDocument();
  });

  it("labels task and block match sources from the runtime match field", () => {
    stubResizeObserver();
    const results: DesktopSearchResult[] = [
      {
        kind: "task",
        ref: "T-001",
        title: "Runtime task",
        excerpt: "body match",
        canvasId: "canvas-main",
        canvasName: "Main",
        targetRef: "T-001",
        match: {
          field: "body",
          start: 0,
          length: 4,
          excerpt: "body match",
          excerptStart: 0
        }
      },
      {
        kind: "block",
        ref: "T-001#B-001",
        title: "Implementation block",
        excerpt: "title match",
        canvasId: "canvas-main",
        canvasName: "Main",
        targetRef: "T-001#B-001",
        match: {
          field: "title",
          start: 0,
          length: 5,
          excerpt: "title match",
          excerptStart: 0
        }
      }
    ];

    render(
      <SearchView
        handleOpenProject={vi.fn().mockResolvedValue(undefined)}
        handleSearchResultOpen={vi.fn().mockResolvedValue(undefined)}
        searchCanvasScope="all"
        searchQuery="match"
        searchResultKinds={searchResultKinds}
        searchResults={results}
        searchStatus={{ phase: "complete", resultCount: results.length, expandedBodySearch: true }}
        selectedCanvasId="canvas-main"
        selectedProject={{
          projectId: "P-001",
          name: "Demo",
          rootPath: "/tmp/demo",
          workspaceRoot: "/tmp/demo",
          activeCanvasId: "canvas-main",
          taskCanvases: []
        }}
        selectedSearchResultKinds={searchResultKinds}
        setSearchCanvasScope={vi.fn()}
        setSearchQuery={vi.fn()}
        setSearchResultKindEnabled={vi.fn()}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByText("Task body")).toBeInTheDocument();
    expect(screen.getByText("Block title")).toBeInTheDocument();
  });
});
