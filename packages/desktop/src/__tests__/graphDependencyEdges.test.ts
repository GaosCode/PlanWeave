import { describe, expect, it } from "vitest";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import {
  dependencyConnectionToManifestEndpoints,
  dependencyDisplayEdgeToManifestEndpoints,
  displayEdgeManifestData,
  executionFlowEndpoints
} from "../renderer/graph/dependencyEdges";
import { styleDependencyEdgesForInteraction } from "../renderer/graph/dependencyEdgeVisual";
import { graphEdges, taskDependencyEdgeType } from "../renderer/graph/flowModel";

describe("desktop graph dependency edge direction", () => {
  it("renders depends_on arrows as execution flow from prerequisite to dependent", () => {
    const edge = { from: "T-001", to: "T-002", type: "depends_on" as const };

    expect(executionFlowEndpoints(edge)).toEqual({ source: "T-002", target: "T-001" });
  });

  it("keeps user-created execution arrows stored as manifest dependencies", () => {
    expect(
      dependencyConnectionToManifestEndpoints({
        source: "T-002",
        target: "T-001",
        sourceHandle: null,
        targetHandle: null
      })
    ).toEqual({
      from: "T-001",
      to: "T-002"
    });
  });

  it("removes manifest dependencies from displayed execution arrows", () => {
    expect(
      dependencyDisplayEdgeToManifestEndpoints({
        id: "edge-1",
        source: "T-002",
        target: "T-001",
        data: displayEdgeManifestData({ from: "T-001", to: "T-002", type: "depends_on" })
      })
    ).toEqual({
      from: "T-001",
      to: "T-002"
    });
  });

  it("does not treat self-loop display edges as removable dependency edges", () => {
    expect(
      dependencyDisplayEdgeToManifestEndpoints({
        id: "edge-1",
        source: "T-001",
        target: "T-001"
      })
    ).toBeNull();
  });

  it("maps graph view model dependency edges to ReactFlow execution arrows", () => {
    const graph: DesktopGraphViewModel = {
      projectId: "P-001",
      projectTitle: "Execution flow",
      graphVersion: "pgv-test",
      packageFingerprint: "pkg-test",
      executorOptions: [],
      tasks: [
        task("T-001", "Dependent task", "planned"),
        task("T-002", "Prerequisite task", "ready")
      ],
      edges: [{ from: "T-001", to: "T-002", type: "depends_on" }],
      sharedResourceGroups: [],
      diagnostics: [],
      dirtyPromptRefs: []
    };

    expect(graphEdges(graph)).toEqual([
      expect.objectContaining({
        id: "T-001-depends_on-T-002",
        source: "T-002",
        target: "T-001",
        type: taskDependencyEdgeType,
        data: expect.objectContaining({
          manifestEdgeType: "depends_on",
          manifestFrom: "T-001",
          manifestTo: "T-002",
          sourceTaskId: "T-002",
          targetTaskId: "T-001",
          sourceColor: expect.any(String)
        }),
        style: expect.objectContaining({
          opacity: expect.any(Number),
          stroke: expect.any(String)
        })
      })
    ]);
  });

  it("does not add visual path offsets to multiple outgoing dependency arrows from the same task", () => {
    const graph: DesktopGraphViewModel = {
      projectId: "P-001",
      projectTitle: "Execution flow",
      graphVersion: "pgv-test",
      packageFingerprint: "pkg-test",
      executorOptions: [],
      tasks: [
        task("T-001", "Prerequisite task", "ready"),
        task("T-002", "Dependent task A", "planned"),
        task("T-003", "Dependent task B", "planned"),
        task("T-004", "Dependent task C", "planned")
      ],
      edges: [
        { from: "T-002", to: "T-001", type: "depends_on" },
        { from: "T-003", to: "T-001", type: "depends_on" },
        { from: "T-004", to: "T-001", type: "depends_on" }
      ],
      sharedResourceGroups: [],
      diagnostics: [],
      dirtyPromptRefs: []
    };

    expect(
      graphEdges(graph).map((edge) => [
        edge.id,
        edge.data?.sourceLaneOffset,
        edge.data?.targetLaneOffset
      ])
    ).toEqual([
      ["T-002-depends_on-T-001", undefined, undefined],
      ["T-003-depends_on-T-001", undefined, undefined],
      ["T-004-depends_on-T-001", undefined, undefined]
    ]);
  });

  it("does not add visual path offsets to multiple incoming dependency arrows on the same task", () => {
    const graph: DesktopGraphViewModel = {
      projectId: "P-001",
      projectTitle: "Execution flow",
      graphVersion: "pgv-test",
      packageFingerprint: "pkg-test",
      executorOptions: [],
      tasks: [
        task("T-001", "Dependent task", "planned"),
        task("T-002", "Prerequisite task A", "ready"),
        task("T-003", "Prerequisite task B", "ready"),
        task("T-004", "Prerequisite task C", "ready")
      ],
      edges: [
        { from: "T-001", to: "T-002", type: "depends_on" },
        { from: "T-001", to: "T-003", type: "depends_on" },
        { from: "T-001", to: "T-004", type: "depends_on" }
      ],
      sharedResourceGroups: [],
      diagnostics: [],
      dirtyPromptRefs: []
    };

    expect(
      graphEdges(graph).map((edge) => [
        edge.id,
        edge.data?.sourceLaneOffset,
        edge.data?.targetLaneOffset
      ])
    ).toEqual([
      ["T-001-depends_on-T-002", undefined, undefined],
      ["T-001-depends_on-T-003", undefined, undefined],
      ["T-001-depends_on-T-004", undefined, undefined]
    ]);
  });

  it("highlights hovered node edges and dims unrelated edges", () => {
    const graph: DesktopGraphViewModel = {
      projectId: "P-001",
      projectTitle: "Execution flow",
      graphVersion: "pgv-test",
      packageFingerprint: "pkg-test",
      executorOptions: [],
      tasks: [
        task("T-001", "Dependent task", "planned"),
        task("T-002", "Prerequisite task", "ready"),
        task("T-003", "Other task", "planned")
      ],
      edges: [
        { from: "T-001", to: "T-002", type: "depends_on" },
        { from: "T-003", to: "T-001", type: "depends_on" }
      ],
      sharedResourceGroups: [],
      diagnostics: [],
      dirtyPromptRefs: []
    };

    const styled = styleDependencyEdgesForInteraction(graphEdges(graph), {
      hoveredNodeId: "T-002"
    });
    const related = styled.find((edge) => edge.source === "T-002" || edge.target === "T-002");
    const unrelated = styled.find((edge) => edge.source !== "T-002" && edge.target !== "T-002");

    expect(related?.style?.opacity).toBeGreaterThan(unrelated?.style?.opacity as number);
    expect(related?.style?.strokeWidth).toBeGreaterThan(unrelated?.style?.strokeWidth as number);
  });

  it("keeps dependency edge data stable when an edge is hovered", () => {
    const graph: DesktopGraphViewModel = {
      projectId: "P-001",
      projectTitle: "Execution flow",
      graphVersion: "pgv-test",
      packageFingerprint: "pkg-test",
      executorOptions: [],
      tasks: [
        task("T-001", "Prerequisite task", "ready"),
        task("T-002", "Dependent task A", "planned"),
        task("T-003", "Dependent task B", "planned"),
        task("T-004", "Dependent task C", "planned")
      ],
      edges: [
        { from: "T-002", to: "T-001", type: "depends_on" },
        { from: "T-003", to: "T-001", type: "depends_on" },
        { from: "T-004", to: "T-001", type: "depends_on" }
      ],
      sharedResourceGroups: [],
      diagnostics: [],
      dirtyPromptRefs: []
    };

    const edges = graphEdges(graph);
    const idleEdges = styleDependencyEdgesForInteraction(edges, {});
    const hoveredEdges = styleDependencyEdgesForInteraction(edges, {
      hoveredEdgeId: "T-002-depends_on-T-001"
    });

    expect(hoveredEdges.map((edge) => edge.data)).toEqual(idleEdges.map((edge) => edge.data));
    expect(hoveredEdges[0]?.style?.strokeWidth).toBeGreaterThan(
      idleEdges[0]?.style?.strokeWidth as number
    );
  });

  it("highlights a selected dependency edge without requiring hover", () => {
    const graph: DesktopGraphViewModel = {
      projectId: "P-001",
      projectTitle: "Execution flow",
      graphVersion: "pgv-test",
      packageFingerprint: "pkg-test",
      executorOptions: [],
      tasks: [
        task("T-001", "Prerequisite task", "ready"),
        task("T-002", "Dependent task A", "planned"),
        task("T-003", "Dependent task B", "planned")
      ],
      edges: [
        { from: "T-002", to: "T-001", type: "depends_on" },
        { from: "T-003", to: "T-001", type: "depends_on" }
      ],
      sharedResourceGroups: [],
      diagnostics: [],
      dirtyPromptRefs: []
    };

    const edges = graphEdges(graph).map((edge) => ({
      ...edge,
      selected: edge.id === "T-002-depends_on-T-001"
    }));
    const styled = styleDependencyEdgesForInteraction(edges, {});

    expect(styled.map((edge) => [edge.id, edge.style?.opacity])).toEqual([
      ["T-002-depends_on-T-001", expect.any(Number)],
      ["T-003-depends_on-T-001", expect.any(Number)]
    ]);
    expect(styled[0]?.style?.opacity).toBeGreaterThan(styled[1]?.style?.opacity as number);
    expect(styled.map((edge) => edge.data)).toEqual(edges.map((edge) => edge.data));
  });

  it("keeps hover and selection scoped to the selected dependency edge", () => {
    const graph: DesktopGraphViewModel = {
      projectId: "P-001",
      projectTitle: "Execution flow",
      graphVersion: "pgv-test",
      packageFingerprint: "pkg-test",
      executorOptions: [],
      tasks: [
        task("T-001", "Prerequisite task", "ready"),
        task("T-002", "Dependent task A", "planned"),
        task("T-003", "Dependent task B", "planned")
      ],
      edges: [
        { from: "T-002", to: "T-001", type: "depends_on" },
        { from: "T-003", to: "T-001", type: "depends_on" }
      ],
      sharedResourceGroups: [],
      diagnostics: [],
      dirtyPromptRefs: []
    };
    const selectedEdgeId = "T-002-depends_on-T-001";
    const hoveredOtherEdgeId = "T-003-depends_on-T-001";
    const edges = graphEdges(graph).map((edge) => ({
      ...edge,
      selected: edge.id === selectedEdgeId
    }));

    const styled = styleDependencyEdgesForInteraction(edges, { hoveredEdgeId: hoveredOtherEdgeId });
    const selectedEdge = styled.find((edge) => edge.id === selectedEdgeId);
    const hoveredOtherEdge = styled.find((edge) => edge.id === hoveredOtherEdgeId);

    expect(selectedEdge?.style?.opacity).toBeGreaterThan(
      hoveredOtherEdge?.style?.opacity as number
    );
    expect(selectedEdge?.style?.strokeWidth).toBeGreaterThan(
      hoveredOtherEdge?.style?.strokeWidth as number
    );
    expect(selectedEdge?.selectable).toBeUndefined();
    expect(selectedEdge?.reconnectable).toBeUndefined();
    expect(selectedEdge?.interactionWidth).toBeUndefined();
    expect(hoveredOtherEdge?.selectable).toBe(false);
    expect(hoveredOtherEdge?.reconnectable).toBe(false);
    expect(hoveredOtherEdge?.interactionWidth).toBe(1);
  });
});

function task(
  taskId: string,
  title: string,
  status: "planned" | "ready"
): DesktopGraphViewModel["tasks"][number] {
  return {
    taskId,
    title,
    status,
    executor: null,
    executorLabel: "inherit",
    promptMarkdown: "",
    promptPreview: "",
    sharedResources: [],
    blocks: [],
    blockPreview: [],
    hiddenBlockRefs: [],
    overflowBlockCount: 0,
    exceptions: []
  };
}
