/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticFixContext } from "../renderer/diagnosticFixActions";
import { createTranslator } from "../renderer/i18n";
import { DesktopDiagnosticsPopover } from "../renderer/run/DesktopDiagnosticsPopover";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const t = createTranslator("en");

function diagnosticFixContext(patch: Partial<DiagnosticFixContext> = {}): DiagnosticFixContext {
  return {
    projectId: "project-1",
    projectRoot: "/tmp/project",
    canvasId: "default",
    applyCanvasLaneLayout: vi.fn().mockResolvedValue(undefined),
    copyText: vi.fn().mockResolvedValue(undefined),
    refreshProjectDerivedState: vi.fn().mockResolvedValue(undefined),
    setError: vi.fn(),
    ...patch
  };
}

afterEach(() => {
  cleanupRendererTestEnvironment();
});

describe("DesktopDiagnosticsPopover", () => {
  it("opens with performance diagnostics expanded when diagnostics exist", async () => {
    render(
      <DesktopDiagnosticsPopover
        diagnostics={[
          {
            code: "desktop_projection_slow_part",
            message: "Desktop projection project aggregation took 12 ms.",
            path: "project"
          }
        ]}
        disabled={false}
        t={t}
      />
    );

    const triggerIcon = screen
      .getByRole("button", { name: "View desktop diagnostics" })
      .querySelector("svg");
    expect(triggerIcon).toHaveClass("lucide-gauge");
    expect(triggerIcon).not.toHaveClass("lucide-triangle-alert");

    await userEvent.click(screen.getByRole("button", { name: "View desktop diagnostics" }));

    expect(screen.getByTestId("desktop-diagnostics-popover")).toBeVisible();
    expect(screen.getByTestId("performance-diagnostics-section")).toHaveTextContent(
      "Performance diagnostics (1)"
    );
    expect(screen.getByTestId("desktop-performance-diagnostic")).toHaveTextContent(
      "desktop_projection_slow_part"
    );
    expect(screen.getByTestId("desktop-performance-diagnostic")).toHaveTextContent(
      "Desktop projection project aggregation took 12 ms."
    );
  });

  it("renders search diagnostics in the search section", async () => {
    render(
      <DesktopDiagnosticsPopover
        diagnostics={[
          {
            code: "desktop_projection_slow_part",
            message: "Desktop projection project aggregation took 12 ms.",
            path: "project"
          },
          {
            code: "desktop_result_metadata_read_failed",
            message: "Result metadata could not be read.",
            path: "results/run.json"
          }
        ]}
        disabled={false}
        t={t}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "View desktop diagnostics" }));
    await userEvent.click(
      within(screen.getByTestId("search-diagnostics-section")).getByRole("button", {
        name: "Search diagnostics (1)"
      })
    );

    expect(screen.getByTestId("search-diagnostics-section")).toHaveTextContent(
      "desktop_result_metadata_read_failed"
    );
    expect(screen.getByTestId("desktop-search-diagnostic")).toHaveTextContent(
      "Result metadata could not be read."
    );
    expect(screen.getByTestId("performance-diagnostics-section")).not.toHaveTextContent(
      "desktop_result_metadata_read_failed"
    );
  });

  it("renders runtime diagnostics in the runtime section", async () => {
    render(
      <DesktopDiagnosticsPopover
        diagnostics={[
          {
            code: "auto_run_state_invalid_json",
            message: "Auto Run state could not be parsed.",
            path: "state.json"
          }
        ]}
        disabled={false}
        t={t}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "View desktop diagnostics" }));

    expect(screen.getByTestId("runtime-diagnostics-section")).toHaveTextContent(
      "Runtime diagnostics (1)"
    );
    expect(screen.getByTestId("desktop-runtime-diagnostic")).toHaveTextContent(
      "auto_run_state_invalid_json"
    );
    expect(screen.getByTestId("desktop-runtime-diagnostic")).toHaveTextContent("state.json");
  });

  it("renders graph quality diagnostics with repair metadata", async () => {
    render(
      <DesktopDiagnosticsPopover
        diagnostics={[
          {
            code: "task_orphaned",
            message: "Some tasks are not connected.",
            path: "T-001",
            source: "graph_quality",
            severity: "warning",
            suggestedTool: "add_task_dependency",
            fixId: "connect_task_dependencies"
          }
        ]}
        disabled={false}
        t={t}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "View desktop diagnostics" }));

    expect(screen.getByTestId("graphQuality-diagnostics-section")).toHaveTextContent(
      "Graph quality diagnostics (1)"
    );
    expect(screen.getByTestId("desktop-graphQuality-diagnostic")).toHaveTextContent(
      "task_orphaned"
    );
    expect(screen.getByTestId("desktop-graphQuality-diagnostic")).toHaveTextContent("warning");
    expect(screen.getByTestId("desktop-graphQuality-diagnostic")).toHaveTextContent(
      "add_task_dependency"
    );
    expect(screen.getByTestId("desktop-graphQuality-diagnostic")).toHaveTextContent(
      "connect_task_dependencies"
    );
  });

  it("shows an empty state when there are no diagnostics", async () => {
    render(<DesktopDiagnosticsPopover diagnostics={[]} disabled={false} t={t} />);

    await userEvent.click(screen.getByRole("button", { name: "View desktop diagnostics" }));

    expect(screen.getByTestId("desktop-diagnostics-empty")).toHaveTextContent(
      "No desktop diagnostics to review"
    );
    expect(screen.queryByTestId("performance-diagnostics-section")).not.toBeInTheDocument();
  });

  it("disables the trigger while project actions are unavailable", () => {
    render(<DesktopDiagnosticsPopover diagnostics={[]} disabled={true} t={t} />);

    expect(screen.getByRole("button", { name: "View desktop diagnostics" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "View desktop diagnostics" }).querySelector("svg")
    ).toHaveClass("lucide-gauge");
  });

  it("applies the safe canvas lane layout fix and refreshes derived state", async () => {
    const actionContext = diagnosticFixContext();
    render(
      <DesktopDiagnosticsPopover
        actionContext={actionContext}
        diagnostics={[
          {
            code: "layout_single_column_risk",
            message:
              "Large canvases with very few task dependencies are likely to render as a hard-to-scan flat layout.",
            source: "graph_quality",
            fixId: "apply_canvas_lane_layout"
          }
        ]}
        disabled={false}
        t={t}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "View desktop diagnostics" }));
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(actionContext.applyCanvasLaneLayout).toHaveBeenCalledWith({
        projectRoot: "/tmp/project",
        canvasId: "default"
      })
    );
    expect(actionContext.refreshProjectDerivedState).toHaveBeenCalledTimes(1);
    expect(actionContext.copyText).not.toHaveBeenCalled();
  });

  it("copies commands for high-risk fixes instead of applying them", async () => {
    const actionContext = diagnosticFixContext();
    render(
      <DesktopDiagnosticsPopover
        actionContext={actionContext}
        diagnostics={[
          {
            code: "task_missing_review_block",
            message: "Some tasks do not include a review block.",
            source: "graph_quality",
            suggestedTool: "create_block",
            fixId: "add_review_blocks",
            affectedIds: ["T-001"]
          }
        ]}
        disabled={false}
        t={t}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "View desktop diagnostics" }));
    await userEvent.click(screen.getByRole("button", { name: "Copy command" }));

    await waitFor(() => expect(actionContext.copyText).toHaveBeenCalledTimes(1));
    expect(actionContext.copyText).toHaveBeenCalledWith(
      expect.stringContaining("PlanWeave MCP tool: create_block")
    );
    expect(actionContext.copyText).toHaveBeenCalledWith(
      expect.stringContaining("affectedIds: T-001")
    );
    expect(actionContext.applyCanvasLaneLayout).not.toHaveBeenCalled();
  });
});
