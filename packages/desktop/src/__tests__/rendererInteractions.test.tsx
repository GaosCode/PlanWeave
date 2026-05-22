/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSettingsPanel } from "../renderer/components/AgentSettingsPanel";
import { SettingsSwitchRow } from "../renderer/components/SettingsSwitchRow";
import { HistoryNavigationButtons } from "../renderer/components/HistoryNavigationButtons";
import { appViewHistoryChangedEvent } from "../renderer/hooks/useAppViewHistory";
import { SearchResultList, searchNavigationTarget } from "../renderer/components/SearchResultList";
import { TodoGroupCard } from "../renderer/components/TodoGroupCard";
import type { DesktopSearchResult, DesktopTodoItem } from "@planweave/runtime";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("desktop renderer component interactions", () => {
  it("disables history navigation buttons when no app history is available", () => {
    window.history.replaceState(null, "", "/");

    render(<HistoryNavigationButtons t={(key) => ({ redo: "Forward", undo: "Back" })[key] ?? key} />);

    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();
  });

  it("enables app history buttons after view navigation state changes", async () => {
    window.history.replaceState({ planweaveAppView: "graph", planweaveHistoryIndex: 0, planweaveHistoryMaxIndex: 0 }, "", "/");
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const forwardSpy = vi.spyOn(window.history, "forward").mockImplementation(() => undefined);

    render(<HistoryNavigationButtons t={(key) => ({ redo: "Forward", undo: "Back" })[key] ?? key} />);

    window.history.pushState({ planweaveAppView: "new-task", planweaveHistoryIndex: 1, planweaveHistoryMaxIndex: 1 }, "");
    window.dispatchEvent(new Event(appViewHistoryChangedEvent));
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(backSpy).toHaveBeenCalledTimes(1);

    window.history.replaceState({ planweaveAppView: "graph", planweaveHistoryIndex: 0, planweaveHistoryMaxIndex: 1 }, "", "/");
    window.dispatchEvent(new Event(appViewHistoryChangedEvent));
    await userEvent.click(screen.getByRole("button", { name: "Forward" }));
    expect(forwardSpy).toHaveBeenCalledTimes(1);

  });

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

  it("renders settings rows as switch controls", async () => {
    const onCheckedChange = vi.fn();

    render(
      <SettingsSwitchRow
        checked={false}
        title="Component visibility"
        description="Show this component in the palette."
        onCheckedChange={onCheckedChange}
      />
    );

    await userEvent.click(screen.getByRole("switch", { name: "Component visibility" }));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("disables agent switches when the CLI is not detected", () => {
    render(
      <AgentSettingsPanel
        agents={[
          {
            kind: "codex",
            name: "Codex",
            command: "codex",
            versionArgs: ["--version"],
            execArgs: ["exec", "-"],
            fullAccessArgs: ["exec", "--sandbox", "danger-full-access", "-"],
            installed: false,
            version: null,
            unavailableReason: "not found"
          }
        ]}
        labels={{
          agentDetected: "CLI detected",
          agentEnableDescription: "Run {command}",
          agentFullAccess: "Full access",
          agentFullAccessDescription: "Run {command}",
          agentMissing: "CLI not detected"
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
          },
          review: {
            autoAppendReviewBlock: true,
            feedbackLoop: true,
            pipelineEnabled: true,
            strictReview: true
          },
          agents: {
            codex: {
              enabled: false,
              fullAccess: false
            },
            "claude-code": {
              enabled: false,
              fullAccess: false
            },
            opencode: {
              enabled: false,
              fullAccess: false
            }
          }
        }}
        updateSettings={vi.fn()}
      />
    );

    expect(screen.getByRole("switch", { name: "Codex" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Full access" })).toBeDisabled();
  });
});
