import { describe, expect, it } from "vitest";
import type { DesktopCanvasGraphViewModel } from "@planweave-ai/runtime";
import { canvasMapEdges } from "../renderer/graph/canvasFlowModel";
import {
  dependencyEdgeDefaultOpacity,
  dependencyEdgeSourceColors,
  styleDependencyEdgesForInteraction
} from "../renderer/graph/dependencyEdgeVisual";

describe("canvas map visuals", () => {
  it("renders one canvas edge for cross-task dependencies between the same canvases", () => {
    const graph: DesktopCanvasGraphViewModel = {
      projectId: "P-001",
      projectTitle: "Canvas map",
      canvases: [canvas("downstream"), canvas("upstream")],
      edges: [],
      crossTaskEdges: [
        {
          from: { canvasId: "downstream", taskId: "T-001" },
          to: { canvasId: "upstream", taskId: "T-001" },
          type: "depends_on"
        },
        {
          from: { canvasId: "downstream", taskId: "T-002" },
          to: { canvasId: "upstream", taskId: "T-002" },
          type: "depends_on"
        }
      ],
      diagnostics: [],
      health: {
        severity: "warning",
        canvases: [],
        edges: [],
        blockedBlocks: [],
        diagnostics: []
      }
    };

    const [edge] = canvasMapEdges(graph);

    expect(edge).toEqual(
      expect.objectContaining({
        source: "upstream",
        target: "downstream",
        animated: false,
        selectable: false
      })
    );
    expect(edge?.style).not.toHaveProperty("strokeDasharray");
  });

  it("prefers one explicit canvas edge over cross-task dependencies for the same pair", () => {
    const graph: DesktopCanvasGraphViewModel = {
      projectId: "P-001",
      projectTitle: "Canvas map",
      canvases: [canvas("downstream"), canvas("upstream")],
      edges: [{ from: "downstream", to: "upstream", type: "depends_on" }],
      crossTaskEdges: [
        {
          from: { canvasId: "downstream", taskId: "T-001" },
          to: { canvasId: "upstream", taskId: "T-001" },
          type: "depends_on"
        }
      ],
      diagnostics: [],
      health: {
        severity: "ok",
        canvases: [],
        edges: [],
        blockedBlocks: [],
        diagnostics: []
      }
    };

    const [edge] = canvasMapEdges(graph);

    expect(edge).toEqual(
      expect.objectContaining({
        id: "downstream-depends_on-upstream",
        source: "upstream",
        target: "downstream",
        selectable: true
      })
    );
    expect(edge?.style).not.toHaveProperty("strokeDasharray");
  });

  it("renders canvas dependencies with the shared dependency edge palette and no warning animation", () => {
    const graph: DesktopCanvasGraphViewModel = {
      projectId: "P-001",
      projectTitle: "Canvas map",
      canvases: [canvas("downstream"), canvas("upstream")],
      edges: [{ from: "downstream", to: "upstream", type: "depends_on" }],
      crossTaskEdges: [],
      diagnostics: [],
      health: {
        severity: "warning",
        canvases: [
          { canvasId: "downstream", severity: "warning", blockerCount: 1, diagnosticCount: 0 },
          { canvasId: "upstream", severity: "ok", blockerCount: 0, diagnosticCount: 0 }
        ],
        edges: [
          {
            from: "downstream",
            to: "upstream",
            type: "depends_on",
            severity: "warning",
            blockerCount: 1,
            diagnosticCount: 0
          }
        ],
        blockedBlocks: [],
        diagnostics: []
      }
    };

    const expectedColor = dependencyEdgeSourceColors(
      ["downstream", "upstream"],
      [{ source: "upstream", target: "downstream" }]
    ).get("upstream");

    expect(canvasMapEdges(graph)).toEqual([
      expect.objectContaining({
        id: "downstream-depends_on-upstream",
        source: "upstream",
        target: "downstream",
        animated: false,
        markerEnd: expect.objectContaining({ color: expectedColor }),
        style: expect.objectContaining({
          stroke: expectedColor,
          strokeWidth: 2.2,
          opacity: dependencyEdgeDefaultOpacity
        })
      })
    ]);
  });

  it("highlights canvas dependency edges connected to the hovered canvas", () => {
    const graph: DesktopCanvasGraphViewModel = {
      projectId: "P-001",
      projectTitle: "Canvas map",
      canvases: [
        canvas("downstream"),
        canvas("upstream"),
        canvas("unrelated-source"),
        canvas("unrelated-target")
      ],
      edges: [
        { from: "downstream", to: "upstream", type: "depends_on" },
        { from: "unrelated-target", to: "unrelated-source", type: "depends_on" }
      ],
      crossTaskEdges: [],
      diagnostics: [],
      health: {
        severity: "ok",
        canvases: [
          { canvasId: "downstream", severity: "ok", blockerCount: 0, diagnosticCount: 0 },
          { canvasId: "upstream", severity: "ok", blockerCount: 0, diagnosticCount: 0 },
          { canvasId: "unrelated-source", severity: "ok", blockerCount: 0, diagnosticCount: 0 },
          { canvasId: "unrelated-target", severity: "ok", blockerCount: 0, diagnosticCount: 0 }
        ],
        edges: [
          {
            from: "downstream",
            to: "upstream",
            type: "depends_on",
            severity: "ok",
            blockerCount: 0,
            diagnosticCount: 0
          },
          {
            from: "unrelated-target",
            to: "unrelated-source",
            type: "depends_on",
            severity: "ok",
            blockerCount: 0,
            diagnosticCount: 0
          }
        ],
        blockedBlocks: [],
        diagnostics: []
      }
    };

    const styled = styleDependencyEdgesForInteraction(canvasMapEdges(graph), {
      hoveredNodeId: "upstream"
    });
    const related = styled.find((edge) => edge.source === "upstream" || edge.target === "upstream");
    const unrelated = styled.find(
      (edge) => edge.source !== "upstream" && edge.target !== "upstream"
    );

    expect(related?.style?.opacity).toBeGreaterThan(unrelated?.style?.opacity as number);
    expect(related?.style?.strokeWidth).toBeGreaterThan(unrelated?.style?.strokeWidth as number);
  });
});

function canvas(canvasId: string): DesktopCanvasGraphViewModel["canvases"][number] {
  return {
    canvasId,
    title: canvasId,
    status: "ready",
    packageDir: `canvases/${canvasId}/package`,
    executionPolicy: null,
    diagnostics: []
  };
}
