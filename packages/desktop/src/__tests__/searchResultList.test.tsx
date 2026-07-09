/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  highlightedSearchExcerpt,
  SearchResultList,
  searchNavigationTarget
} from "../renderer/components/SearchResultList";
import type { DesktopSearchResult } from "@planweave-ai/runtime";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

const searchResultListLabels = {
  canvasLabel: "Canvas",
  kindLabels: {
    task: "Tasks",
    block: "Blocks",
    prompt: "Prompts",
    run_record: "Run records",
    review_attempt: "Review attempts",
    feedback: "Feedback"
  },
  matchSourceLabels: {
    blockBody: "Block body",
    blockTitle: "Block title",
    feedback: "Feedback",
    prompt: "Prompt",
    reviewAttempt: "Review attempt",
    runRecord: "Run record",
    taskBody: "Task body",
    taskTitle: "Task title"
  },
  refLabel: "Ref",
  targetLabel: "Target"
} satisfies Pick<
  ComponentProps<typeof SearchResultList>,
  "canvasLabel" | "kindLabels" | "matchSourceLabels" | "refLabel" | "targetLabel"
>;

describe("desktop renderer component interactions", () => {
  it("routes every searchable result kind to a canvas node or record target", async () => {
    const results: DesktopSearchResult[] = [
      {
        kind: "prompt",
        ref: "T-001",
        targetRef: "T-001",
        title: "Task prompt",
        excerpt: "task prompt"
      },
      {
        kind: "prompt",
        ref: "T-001#B-001",
        targetRef: "T-001#B-001",
        title: "Block prompt",
        excerpt: "block prompt"
      },
      {
        kind: "review_attempt",
        ref: "T-001/reviews/R-001/attempts/REV-001/review-result.json",
        targetRef: "T-001#R-001",
        title: "Review",
        excerpt: "review"
      },
      {
        kind: "feedback",
        ref: "FE-001",
        targetRef: "T-001#R-001",
        title: "Feedback",
        excerpt: "feedback"
      },
      {
        kind: "run_record",
        ref: "T-001/blocks/B-001/runs/RUN-001/report.md",
        recordId: "T-001#B-001::RUN-001",
        title: "Run",
        excerpt: "run"
      }
    ];
    const onOpenResult = vi.fn();

    expect(results.map(searchNavigationTarget)).toEqual([
      { kind: "task", ref: "T-001" },
      { kind: "block", ref: "T-001#B-001" },
      { kind: "block", ref: "T-001#R-001" },
      { kind: "block", ref: "T-001#R-001" },
      { kind: "record", recordId: "T-001#B-001::RUN-001" }
    ]);

    render(
      <SearchResultList
        {...searchResultListLabels}
        results={results}
        targetMissingLabel="No jump target"
        onOpenResult={onOpenResult}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: /Feedback/ }));

    expect(onOpenResult).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "feedback", targetRef: "T-001#R-001" })
    );
  });

  it("renders search results without navigation targets as non-interactive diagnostics", async () => {
    const result: DesktopSearchResult = {
      kind: "run_record",
      ref: "T-001/blocks/B-001/runs/RUN-001/report.md",
      title: "Run without record id",
      excerpt: "missing run record target"
    };
    const onOpenResult = vi.fn();

    expect(searchNavigationTarget(result)).toEqual({ kind: "none" });

    render(
      <SearchResultList
        {...searchResultListLabels}
        results={[result]}
        targetMissingLabel="No jump target"
        onOpenResult={onOpenResult}
      />
    );

    expect(screen.queryByRole("button", { name: /Run without record id/ })).not.toBeInTheDocument();
    expect(screen.getByText("No jump target")).toBeInTheDocument();

    await userEvent.click(screen.getByText("Run without record id"));

    expect(onOpenResult).not.toHaveBeenCalled();
  });

  it("renders search result context and highlights excerpts without HTML injection", () => {
    const result: DesktopSearchResult = {
      kind: "prompt",
      canvasId: "canvas-main",
      canvasName: "Main canvas",
      ref: "T-001#B-001",
      targetRef: "T-001#B-001",
      title: "Block prompt",
      excerpt: "ignore fallback excerpt",
      match: {
        field: "body",
        start: 17,
        length: 6,
        excerpt: "Implement search needle safely",
        excerptStart: 0
      }
    };

    expect(highlightedSearchExcerpt(result)).toEqual([
      { text: "Implement search ", highlighted: false },
      { text: "needle", highlighted: true },
      { text: " safely", highlighted: false }
    ]);

    render(
      <SearchResultList
        {...searchResultListLabels}
        results={[result]}
        targetMissingLabel="No jump target"
        onOpenResult={vi.fn()}
      />
    );

    expect(screen.getByText("Block prompt")).toBeInTheDocument();
    expect(screen.getByText(/Main canvas \(canvas-main\)/)).toBeInTheDocument();
    expect(screen.getAllByText("T-001#B-001")).toHaveLength(2);
    expect(screen.getByText("Prompt")).toBeInTheDocument();
    const highlight = screen.getByText("needle");
    expect(highlight.tagName).toBe("MARK");
  });
});
