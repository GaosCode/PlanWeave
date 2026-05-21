/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  PaletteSettingsPanel,
  SearchResultList,
  TodoGroupCard,
  searchNavigationTarget
} from "../renderer/App";
import type { DesktopSearchResult, DesktopTodoItem } from "@planweave/runtime";

describe("desktop renderer component interactions", () => {
  it("renders Todo blockers, parallel safety, and locks and jumps to the selected block", async () => {
    const item: DesktopTodoItem = {
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      title: "Implement dependency-aware Todo",
      status: "ready",
      dependencyBlockers: ["T-002"],
      parallelSafe: false,
      locks: ["package/manifest.json"]
    };
    const onSelect = vi.fn();

    render(
      <TodoGroupCard
        items={[item]}
        labels={{
          dependencyBlockers: "Dependency blockers",
          locks: "Locks",
          noBlockers: "No blockers",
          noLocks: "No locks",
          parallelBlocked: "Not safe",
          parallelSafe: "Safe",
          parallelSafety: "Parallel safety"
        }}
        onSelect={onSelect}
        status="ready"
      />
    );

    expect(screen.getByText("Dependency blockers")).toBeInTheDocument();
    expect(screen.getByText("T-002")).toBeInTheDocument();
    expect(screen.getByText("Parallel safety")).toBeInTheDocument();
    expect(screen.getAllByText("Not safe")).toHaveLength(2);
    expect(screen.getByText("package/manifest.json")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Implement dependency-aware Todo/ }));
    expect(onSelect).toHaveBeenCalledWith("T-001#B-001");
  });

  it("routes every searchable result kind to a canvas node or record target", async () => {
    const results: DesktopSearchResult[] = [
      { kind: "prompt", ref: "T-001", targetRef: "T-001", title: "Task prompt", excerpt: "task prompt" },
      { kind: "prompt", ref: "T-001#B-001", targetRef: "T-001#B-001", title: "Block prompt", excerpt: "block prompt" },
      { kind: "context", ref: "CMP-CLI", targetRef: "CMP-CLI", title: "CLI", excerpt: "context" },
      { kind: "review_attempt", ref: "T-001/reviews/R-001/attempts/REV-001/review-result.json", targetRef: "T-001#R-001", title: "Review", excerpt: "review" },
      { kind: "feedback", ref: "FE-001", targetRef: "T-001#R-001", title: "Feedback", excerpt: "feedback" },
      { kind: "run_record", ref: "T-001/blocks/B-001/runs/RUN-001/report.md", recordId: "T-001#B-001::RUN-001", title: "Run", excerpt: "run" }
    ];
    const onOpenResult = vi.fn();

    expect(results.map(searchNavigationTarget)).toEqual([
      { kind: "task", ref: "T-001" },
      { kind: "block", ref: "T-001#B-001" },
      { kind: "context", ref: "CMP-CLI" },
      { kind: "block", ref: "T-001#R-001" },
      { kind: "block", ref: "T-001#R-001" },
      { kind: "record", recordId: "T-001#B-001::RUN-001" }
    ]);

    render(<SearchResultList results={results} targetMissingLabel="No jump target" onOpenResult={onOpenResult} />);
    await userEvent.click(screen.getByRole("button", { name: /Feedback/ }));

    expect(onOpenResult).toHaveBeenCalledWith(expect.objectContaining({ kind: "feedback", targetRef: "T-001#R-001" }));
  });

  it("renders Component Palette settings as a settings-page section", () => {
    render(
      <PaletteSettingsPanel
        labels={{
          blockSetImplementation: "Implementation",
          blockSetImplementationCheck: "Implementation + Check",
          blockSetImplementationCheckReview: "Implementation + Check + Review",
          checkBlock: "Check Block",
          componentVisibility: "Component visibility",
          contextNode: "Context Node",
          defaultBlockSet: "Default block set",
          disabled: "Disabled",
          dragHint: "Drag hint",
          enabled: "Enabled",
          implementationBlock: "Implementation Block",
          paletteSettings: "Component Palette settings",
          reviewBlock: "Review Block",
          taskNode: "Task Node"
        }}
        settings={{
          runtimePath: "/tmp/project",
          defaultExecutor: "",
          appearance: "system",
          language: "en",
          notifications: {
            autoRunFailure: true,
            graphExceptions: true,
            dirtyPrompts: true,
            fileSyncConflict: true
          },
          palette: {
            visible: {
              task: true,
              implementation: true,
              check: true,
              review: true,
              context: true
            },
            defaultBlockSet: ["implementation", "check", "review"],
            dragHint: true
          }
        }}
        updateSettings={vi.fn()}
      />
    );

    expect(screen.getByText("Component Palette settings")).toBeInTheDocument();
    expect(screen.getByText("Default block set")).toBeInTheDocument();
    expect(screen.getByText("Component visibility")).toBeInTheDocument();
  });
});
