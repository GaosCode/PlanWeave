import { describe, expect, it, vi } from "vitest";
import type { DesktopGraphViewModel, DesktopLayout } from "@planweave-ai/runtime";
import { defaultTaskNodePositions, graphNodes } from "../renderer/graph/flowModel";
import type { TaskNodeLabels } from "../renderer/types";

describe("desktop graph flow model", () => {
  it("lays out unsaved task nodes from prerequisites to dependents", () => {
    const graph = graphView(
      ["T-003", "T-001", "T-002"],
      [
        { from: "T-002", to: "T-001", type: "depends_on" },
        { from: "T-003", to: "T-002", type: "depends_on" }
      ]
    );

    const positions = defaultTaskNodePositions(graph);

    expect(positions.get("T-001")?.x).toBeLessThan(positions.get("T-002")?.x ?? 0);
    expect(positions.get("T-002")?.x).toBeLessThan(positions.get("T-003")?.x ?? 0);
  });

  it("keeps independent nodes in manifest order within the same default layer", () => {
    const positions = defaultTaskNodePositions(graphView(["T-003", "T-001", "T-002"], []));

    expect(positions.get("T-003")?.y).toBeLessThan(positions.get("T-001")?.y ?? 0);
    expect(positions.get("T-001")?.y).toBeLessThan(positions.get("T-002")?.y ?? 0);
    expect(
      (positions.get("T-001")?.y ?? 0) - (positions.get("T-003")?.y ?? 0)
    ).toBeGreaterThanOrEqual(360);
    expect(
      (positions.get("T-002")?.y ?? 0) - (positions.get("T-001")?.y ?? 0)
    ).toBeGreaterThanOrEqual(360);
  });

  it("prefers saved desktop layout positions over default dependency positions", () => {
    const graph = graphView(
      ["T-001", "T-002"],
      [{ from: "T-002", to: "T-001", type: "depends_on" }]
    );
    const layout: DesktopLayout = {
      version: "desktop-layout/v1",
      projectId: "P-001",
      updatedAt: new Date(0).toISOString(),
      nodes: [{ nodeId: "T-002", x: 999, y: 888 }]
    };

    const nodes = graphNodes(
      graph,
      layout,
      [],
      [],
      {},
      {},
      {},
      labels,
      null,
      [],
      [],
      [],
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn()
    );

    expect(nodes.find((node) => node.id === "T-002")?.position).toEqual({ x: 999, y: 888 });
    expect(nodes.find((node) => node.id === "T-001")?.position.x).toBeLessThan(999);
  });
});

const labels: TaskNodeLabels = {
  agent: "Agent",
  blockExecutionSummary: "Block execution summary",
  blockStack: "Block Stack",
  copyAgentPrompt: "Copy agent prompt",
  customExecutor: "Custom executor",
  deleteBlock: "Delete block",
  deleteBlockConfirm: "Delete block?",
  deleteTask: "Delete task",
  deleteTaskConfirm: "Delete task?",
  exception: "Exception",
  exceptionOverlay: "Exception overlay",
  feedbackMarker: "Feedback",
  latestReviewAttempt: "Latest review attempt",
  latestRun: "Latest run",
  more: "More",
  noBlockRecords: "No block records",
  openTaskInFileManager: "Open task in Finder",
  openRecord: "Open record",
  runBlock: "Run block",
  runTask: "Run task",
  savePrompt: "Save prompt",
  selectedBlock: "Selected block",
  selectedTask: "Selected task",
  sourcePrompt: "Source prompt",
  taskException: "Task exception",
  taskPrompt: "Task Prompt",
  title: "Title",
  unavailable: "Unavailable"
};

function graphView(
  taskIds: string[],
  edges: DesktopGraphViewModel["edges"]
): DesktopGraphViewModel {
  return {
    projectId: "P-001",
    projectTitle: "Project",
    graphVersion: "pgv-test",
    packageFingerprint: "pkg-test",
    executorOptions: [],
    tasks: taskIds.map((taskId) => task(taskId)),
    edges,
    diagnostics: [],
    dirtyPromptRefs: []
  };
}

function task(taskId: string): DesktopGraphViewModel["tasks"][number] {
  return {
    taskId,
    title: taskId,
    status: "planned",
    executor: null,
    executorLabel: "inherit",
    promptMarkdown: "",
    promptMissing: false,
    promptPreview: "",
    blocks: [],
    blockPreview: [],
    hiddenBlockRefs: [],
    overflowBlockCount: 0,
    exceptions: []
  };
}
