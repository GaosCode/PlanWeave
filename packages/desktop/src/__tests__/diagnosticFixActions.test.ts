import { describe, expect, it, vi } from "vitest";
import {
  diagnosticFixActionFor,
  type DiagnosticFixContext
} from "../renderer/diagnosticFixActions";
import type { DesktopDiagnostic } from "../renderer/diagnostics";

function context(patch: Partial<DiagnosticFixContext> = {}): DiagnosticFixContext {
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

describe("diagnosticFixActionFor", () => {
  it("returns an apply action only for apply_canvas_lane_layout with explicit canvas context", async () => {
    const actionContext = context();
    const action = diagnosticFixActionFor(
      {
        code: "layout_single_column_risk",
        message:
          "Large canvases with very few task dependencies are likely to render as a hard-to-scan flat layout.",
        fixId: "apply_canvas_lane_layout"
      },
      actionContext
    );

    expect(action?.kind).toBe("apply");
    await action?.run();

    expect(actionContext.setError).toHaveBeenCalledWith(null);
    expect(actionContext.applyCanvasLaneLayout).toHaveBeenCalledWith({
      projectRoot: "/tmp/project",
      canvasId: "default"
    });
    expect(actionContext.refreshProjectDerivedState).toHaveBeenCalledTimes(1);
  });

  it("does not apply canvas lane layout without selected canvas context", () => {
    const action = diagnosticFixActionFor(
      {
        code: "layout_single_column_risk",
        message:
          "Large canvases with very few task dependencies are likely to render as a hard-to-scan flat layout.",
        fixId: "apply_canvas_lane_layout"
      },
      context({ canvasId: null })
    );

    expect(action).toBeNull();
  });

  it("returns copy actions for high-risk structural fixes", async () => {
    const actionContext = context();
    const diagnostic: DesktopDiagnostic = {
      code: "review_missing_implementation_dependency",
      message: "Review blocks should depend on the implementation blocks they review.",
      source: "graph_quality",
      suggestedTool: "set_block_dependencies",
      fixId: "connect_review_blocks_to_implementation",
      affectedIds: ["T-001#R-001"]
    };

    const action = diagnosticFixActionFor(diagnostic, actionContext);

    expect(action?.kind).toBe("copy");
    expect(action?.id).toBe("connect_review_blocks_to_implementation");
    expect(action?.command).toContain("PlanWeave MCP tool: set_block_dependencies");
    expect(action?.command).toContain("projectId: project-1");
    expect(action?.command).toContain("canvasId: default");
    expect(action?.command).toContain("affectedIds: T-001#R-001");

    await action?.run();

    expect(actionContext.copyText).toHaveBeenCalledWith(action?.command);
    expect(actionContext.applyCanvasLaneLayout).not.toHaveBeenCalled();
  });

  it("does not return copy actions without valid affected ids", () => {
    expect(
      diagnosticFixActionFor(
        {
          code: "task_missing_review_block",
          message: "Some tasks do not include a review block.",
          path: "T-001",
          fixId: "add_review_blocks"
        },
        context()
      )
    ).toBeNull();
    expect(
      diagnosticFixActionFor(
        {
          code: "task_missing_review_block",
          message: "Some tasks do not include a review block.",
          path: "T-001",
          fixId: "add_review_blocks",
          affectedIds: []
        },
        context()
      )
    ).toBeNull();
  });

  it("does not return actions for judgment-heavy or unknown fixes", () => {
    expect(
      diagnosticFixActionFor(
        {
          code: "acceptance_too_weak",
          message: "Acceptance is too weak.",
          fixId: "strengthen_acceptance_criteria"
        },
        context()
      )
    ).toBeNull();
    expect(
      diagnosticFixActionFor(
        { code: "unknown", message: "Unknown.", fixId: "unknown_fix" },
        context()
      )
    ).toBeNull();
  });
});
