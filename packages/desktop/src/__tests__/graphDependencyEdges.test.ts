import { describe, expect, it } from "vitest";
import type { DesktopGraphViewModel } from "@planweave/runtime";
import {
  dependencyConnectionToManifestEndpoints,
  dependencyDisplayEdgeToManifestEndpoints,
  displayEdgeManifestData,
  executionFlowEndpoints
} from "../renderer/graph/dependencyEdges";
import { graphEdges } from "../renderer/graph/flowModel";

describe("desktop graph dependency edge direction", () => {
  it("renders depends_on arrows as execution flow from prerequisite to dependent", () => {
    const edge = { from: "T-001", to: "T-002", type: "depends_on" as const };

    expect(executionFlowEndpoints(edge)).toEqual({ source: "T-002", target: "T-001" });
  });

  it("keeps user-created execution arrows stored as manifest dependencies", () => {
    expect(dependencyConnectionToManifestEndpoints({ source: "T-002", target: "T-001", sourceHandle: null, targetHandle: null })).toEqual({
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
      executorOptions: [],
      tasks: [
        task("T-001", "Dependent task", "planned"),
        task("T-002", "Prerequisite task", "ready")
      ],
      edges: [{ from: "T-001", to: "T-002", type: "depends_on" }],
      diagnostics: [],
      dirtyPromptRefs: []
    };

    expect(graphEdges(graph)).toEqual([
      expect.objectContaining({
        id: "T-001-depends_on-T-002",
        source: "T-002",
        target: "T-001",
        data: {
          manifestEdgeType: "depends_on",
          manifestFrom: "T-001",
          manifestTo: "T-002"
        }
      })
    ]);
  });
});

function task(taskId: string, title: string, status: "planned" | "ready"): DesktopGraphViewModel["tasks"][number] {
  return {
    taskId,
    title,
    status,
    executor: null,
    executorLabel: "inherit",
    promptMarkdown: "",
    promptPreview: "",
    blocks: [],
    blockPreview: [],
    hiddenBlockRefs: [],
    overflowBlockCount: 0,
    exceptions: []
  };
}
