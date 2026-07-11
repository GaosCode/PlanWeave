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

  it("threads shared-resource hints without creating lock wait state", () => {
    const graph = sharedLockGraph();
    const onLockHover = vi.fn();
    const noop = vi.fn();
    const nodes = graphNodes(
      graph,
      null,
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
      // 20 task/block callbacks (onTitleChange … onOpenRunRecord)
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      {
        activeLock: "db",
        releaseEpochByLock: {},
        onLockHover,
        onLockPin: vi.fn(),
        onLockOverflow: vi.fn(),
        onJumpToTask: vi.fn()
      }
    );

    const nodeA = nodes.find((node) => node.id === "T-A");
    const nodeB = nodes.find((node) => node.id === "T-B");
    expect(nodeA?.data.locks).toEqual(["db"]);
    expect(nodeB?.data.locks).toEqual(["db"]);
    expect(nodeA?.data.lockStates.db).toEqual({ kind: "free" });
    expect(nodeB?.data.lockStates.db).toEqual({ kind: "free" });
    expect(nodeB?.data.dispatchState).toEqual({ kind: "dispatchable" });
    expect(nodeA?.data.lockHighlighted).toBe(true);
    expect(nodeB?.data.lockHighlighted).toBe(true);
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
  unavailable: "Unavailable",
  exclusiveLock: "Exclusive",
  heldBy: "Held by",
  waitingForResource: "Waiting for resource",
  moreLocks: (count: number) => `+${count}`
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
    autoRunPreflightExecutorHint: null,
    tasks: taskIds.map((taskId) => task(taskId)),
    edges,
    lockGroups: [],
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
    locks: [],
    blocks: [],
    blockPreview: [],
    hiddenBlockRefs: [],
    overflowBlockCount: 0,
    exceptions: []
  };
}

function sharedLockGraph(): DesktopGraphViewModel {
  return {
    projectId: "P-001",
    projectTitle: "Project",
    graphVersion: "pgv-test",
    packageFingerprint: "pkg-test",
    executorOptions: [],
    autoRunPreflightExecutorHint: null,
    tasks: [
      {
        ...task("T-A"),
        status: "in_progress",
        locks: [],
        sharedResources: ["db"],
        blocks: [
          {
            ref: "T-A#B-001",
            blockId: "B-001",
            type: "implementation",
            title: "Hold",
            status: "in_progress",
            executor: null,
            promptMissing: false,
            exceptionReason: null,
            dispatchable: false,
            waitingOn: null
          }
        ],
        blockPreview: []
      },
      {
        ...task("T-B"),
        status: "ready",
        locks: [],
        sharedResources: ["db"],
        blocks: [
          {
            ref: "T-B#B-001",
            blockId: "B-001",
            type: "implementation",
            title: "Wait",
            status: "ready",
            executor: null,
            promptMissing: false,
            exceptionReason: null,
            dispatchable: true,
            waitingOn: null
          }
        ],
        blockPreview: []
      }
    ],
    edges: [],
    lockGroups: [
      {
        name: "db",
        memberTaskIds: ["T-A", "T-B"],
        memberBlockRefs: ["T-A#B-001", "T-B#B-001"],
        holderRef: "T-A#B-001"
      }
    ],
    sharedResourceGroups: [
      {
        name: "db",
        memberTaskIds: ["T-A", "T-B"],
        memberBlockRefs: ["T-A#B-001", "T-B#B-001"],
        activeBlockRefs: ["T-A#B-001"]
      }
    ],
    diagnostics: [],
    dirtyPromptRefs: []
  };
}
