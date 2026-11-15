import { describe, expect, it, vi } from "vitest";
import * as graphCompiler from "../graph/compileTaskGraph.js";
import { inspectGraph } from "../graph/inspectGraph.js";
import { writeJsonFile } from "../json.js";
import type { ManifestTaskNode, PlanPackageManifest, RuntimeState } from "../types.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

function completedState(): RuntimeState {
  return {
    currentRefs: [],
    currentFeedbackId: null,
    currentReviewBlockRef: null,
    tasks: {},
    blocks: {
      "T-001#B-001": { status: "completed", lastRunId: "RUN-001" },
      "T-001#R-001": {
        status: "completed",
        latestReviewAttemptId: "REV-001",
        completionReason: "passed"
      }
    },
    feedback: {}
  };
}

function threeTaskManifest(): PlanPackageManifest {
  const manifest = basicManifest({ includeSecondTask: true });
  manifest.nodes.push({
    id: "T-003",
    type: "task",
    title: "Third task",
    prompt: "nodes/T-003/prompt.md",
    acceptance: ["Third implementation is complete."],
    blocks: [
      {
        id: "B-001",
        type: "implementation",
        title: "Implement third task",
        prompt: "nodes/T-003/blocks/B-001.prompt.md",
        depends_on: [],
        parallel: { sharedResources: ["third"] }
      },
      {
        id: "R-001",
        type: "review",
        title: "Review third task",
        prompt: "nodes/T-003/blocks/R-001.prompt.md",
        depends_on: ["B-001"],
        review: {
          required: true,
          maxFeedbackCycles: 1,
          hook: null
        }
      }
    ]
  });
  return manifest;
}

function taskWithImplementationBlocks(id: string, title: string, blockCount = 1): ManifestTaskNode {
  return {
    id,
    type: "task",
    title,
    prompt: `nodes/${id}/prompt.md`,
    acceptance: [`${title} is complete.`],
    blocks: Array.from({ length: blockCount }, (_, index) => {
      const blockId = `B-${String(index + 1).padStart(3, "0")}`;
      return {
        id: blockId,
        type: "implementation" as const,
        title: `Implement ${title} ${index + 1}`,
        prompt: `nodes/${id}/blocks/${blockId}.prompt.md`,
        depends_on: [],
        parallel: { sharedResources: [`${id}-${blockId}`] }
      };
    })
  };
}

function wideSliceManifest(dependencyCount: number, centerBlockCount: number): PlanPackageManifest {
  const dependencyTasks = Array.from({ length: dependencyCount }, (_, index) => {
    const taskNumber = index + 2;
    const id = `T-${String(taskNumber).padStart(3, "0")}`;
    return taskWithImplementationBlocks(id, `Dependency ${taskNumber}`);
  });
  const center = taskWithImplementationBlocks("T-001", "Wide center", centerBlockCount);
  return {
    ...basicManifest(),
    nodes: [center, ...dependencyTasks],
    edges: dependencyTasks.map((task) => ({
      from: center.id,
      to: task.id,
      type: "depends_on" as const
    }))
  };
}

describe("inspectGraph", () => {
  it("returns a bounded summary with counts and no prompt bodies", async () => {
    const { root } = await createTestWorkspace(threeTaskManifest());

    const result = await inspectGraph({ projectRoot: root, view: "summary", limit: 2 });

    expect(result.view).toBe("summary");
    expect(result.counts).toMatchObject({
      taskCount: 3,
      blockCount: 6,
      taskDependencyCount: 0,
      reviewBlockCount: 3,
      readyBlockCount: 3,
      diagnosticCount: 0
    });
    expect(result.tasksPreview.map((task) => task.taskId)).toEqual(["T-001", "T-002"]);
    expect(result.page).toMatchObject({ limit: 2, cursor: null, nextCursor: "next:2", total: 3 });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("# T-001 task prompt");
    expect(serialized).not.toContain("promptSurfaceMarkdown");
  });

  it("paginates tasks with stable cursors", async () => {
    const { root } = await createTestWorkspace(threeTaskManifest());

    const first = await inspectGraph({ projectRoot: root, view: "tasks", limit: 1 });
    const second = await inspectGraph({
      projectRoot: root,
      view: "tasks",
      limit: 1,
      cursor: first.page.nextCursor ?? undefined
    });

    expect(first.tasks.map((task) => task.taskId)).toEqual(["T-001"]);
    expect(first.page.nextCursor).toBe("next:1");
    expect(second.tasks.map((task) => task.taskId)).toEqual(["T-002"]);
    expect(second.page.nextCursor).toBe("next:2");
  });

  it("uses read state normalized for the manifest instead of returning empty state", async () => {
    const { root, init } = await createTestWorkspace();
    await writeJsonFile(init.workspace.stateFile, completedState());

    const result = await inspectGraph({ projectRoot: root, view: "tasks" });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      taskId: "T-001",
      status: "implemented",
      blockCount: 2,
      reviewBlockCount: 1
    });
  });

  it("marks every task whose shared prompt path is missing and reports it once", async () => {
    const manifest = basicManifest({ includeSecondTask: true });
    const { root, init } = await createTestWorkspace(manifest);
    manifest.nodes[0].prompt = "./nodes/absent.md";
    manifest.nodes[1].prompt = "nodes/absent.md";
    await writeJsonFile(init.workspace.manifestFile, manifest);

    const result = await inspectGraph({ projectRoot: root, view: "summary" });

    expect(result.tasksPreview).toEqual([
      expect.objectContaining({ taskId: "T-001", promptMissing: true }),
      expect.objectContaining({ taskId: "T-002", promptMissing: true })
    ]);
    expect(result.counts.diagnosticCount).toBe(3);
  });

  it("returns a task slice with adjacent nodes, edges, and block refs", async () => {
    const manifest = basicManifest({ includeSecondTask: true, taskDependsOn: ["T-002"] });
    const { root } = await createTestWorkspace(manifest);

    const result = await inspectGraph({ projectRoot: root, view: "slice", taskId: "T-001" });

    expect(result.center.taskId).toBe("T-001");
    expect(result.dependencies.items.map((task) => task.taskId)).toEqual(["T-002"]);
    expect(result.dependents.items).toEqual([]);
    expect(result.edges.items).toEqual([{ from: "T-001", to: "T-002", type: "depends_on" }]);
    expect(result.blocks.items).toEqual([
      expect.objectContaining({
        ref: "T-001#B-001",
        blockId: "B-001",
        type: "implementation",
        status: "planned",
        dependsOn: []
      }),
      expect.objectContaining({
        ref: "T-001#R-001",
        blockId: "R-001",
        type: "review",
        status: "planned",
        dependsOn: ["T-001#B-001"]
      })
    ]);
  });

  it.each([
    { limit: 1, sectionLimit: 1, neighborCount: 1, edgeTotal: 3 },
    { limit: 3, sectionLimit: 3, neighborCount: 3, edgeTotal: 8 },
    { limit: undefined, sectionLimit: 50, neighborCount: 3, edgeTotal: 8 }
  ])("retains bidirectional neighbor and visible edge order at limit $limit", async (testCase) => {
    const manifest = wideSliceManifest(6, 1);
    const visibleEdges = [
      { from: "T-007", to: "T-005", type: "depends_on" },
      { from: "T-007", to: "T-001", type: "depends_on" },
      { from: "T-001", to: "T-005", type: "depends_on" },
      { from: "T-006", to: "T-001", type: "depends_on" },
      { from: "T-001", to: "T-003", type: "depends_on" },
      { from: "T-004", to: "T-001", type: "depends_on" },
      { from: "T-001", to: "T-002", type: "depends_on" },
      { from: "T-004", to: "T-002", type: "depends_on" }
    ] satisfies PlanPackageManifest["edges"];
    manifest.edges = [{ from: "T-001", to: "T-MISSING", type: "depends_on" }, ...visibleEdges];
    const { root } = await createTestWorkspace(manifest);
    const { limit, sectionLimit, neighborCount, edgeTotal } = testCase;

    const result = await inspectGraph({ projectRoot: root, view: "slice", taskId: "T-001", limit });

    expect(result).toMatchObject({
      center: {
        dependsOn: ["T-005", "T-003", "T-002"],
        dependents: ["T-007", "T-006", "T-004"]
      },
      dependencies: {
        limit: sectionLimit,
        total: 3,
        truncated: neighborCount < 3,
        items: ["T-005", "T-003", "T-002"].slice(0, neighborCount).map((taskId) => ({ taskId }))
      },
      dependents: {
        limit: sectionLimit,
        total: 3,
        truncated: neighborCount < 3,
        items: ["T-007", "T-006", "T-004"].slice(0, neighborCount).map((taskId) => ({ taskId }))
      },
      edges: {
        limit: sectionLimit,
        total: edgeTotal,
        truncated: edgeTotal > sectionLimit,
        items: visibleEdges.slice(0, Math.min(edgeTotal, sectionLimit))
      }
    });
  });

  it("reports empty neighbor and edge sections for an isolated task", async () => {
    const { root } = await createTestWorkspace();

    const result = await inspectGraph({
      projectRoot: root,
      view: "slice",
      taskId: "T-001",
      limit: 1
    });

    const emptySection = { limit: 1, total: 0, truncated: false, items: [] };
    expect(result).toMatchObject({
      dependencies: emptySection,
      dependents: emptySection,
      edges: emptySection
    });
    await expect(
      inspectGraph({ projectRoot: root, view: "slice", taskId: "T-UNKNOWN" })
    ).rejects.toThrow("Task 'T-UNKNOWN' does not exist in the graph.");
  });

  it("limits slice task lookups to the neighborhood", async () => {
    const neighborsPerDirection = 32;
    const neighborCount = neighborsPerDirection * 2;
    const limit = 1;
    const taskReadBudget = 2 * (neighborCount + 1 + 2 * limit);
    const manifest = wideSliceManifest(neighborsPerDirection * 5, 1);
    manifest.edges = [
      ...manifest.edges.slice(0, neighborsPerDirection),
      ...manifest.edges.slice(neighborsPerDirection, neighborCount).map(({ from, to, type }) => ({
        from: to,
        to: from,
        type
      }))
    ];
    const { root } = await createTestWorkspace(manifest);
    const compilePackageGraph = graphCompiler.compilePackageGraph;
    const readWholeIndex = new Set<PropertyKey>([
      Symbol.iterator,
      "entries",
      "keys",
      "values",
      "forEach"
    ]);
    let taskReads = 0;
    const compile = vi
      .spyOn(graphCompiler, "compilePackageGraph")
      .mockImplementation(async (...args) => {
        const graph = await compilePackageGraph(...args);
        const taskNodesInManifestOrder = new Proxy(graph.taskNodesInManifestOrder, {
          get(target, key, receiver) {
            if (typeof key === "string" && /^\d+$/.test(key)) {
              taskReads += 1;
            }
            return Reflect.get(target, key, receiver);
          }
        });
        const tasksById = new Proxy(graph.tasksById, {
          get(target, key) {
            if (key === "get" || key === "has") {
              return (taskId: string) => {
                taskReads += 1;
                return target[key](taskId);
              };
            }
            if (readWholeIndex.has(key)) {
              taskReads += target.size;
            }
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
        return { ...graph, taskNodesInManifestOrder, tasksById };
      });
    try {
      const result = await inspectGraph({
        projectRoot: root,
        view: "slice",
        taskId: "T-001",
        limit
      });
      const bounded = { limit, total: neighborsPerDirection, truncated: true };
      expect(result).toMatchObject({ dependencies: bounded, dependents: bounded });
      expect(taskReads).toBeGreaterThan(0);
      expect(taskReads).toBeLessThanOrEqual(taskReadBudget);
    } finally {
      compile.mockRestore();
    }
  });

  it("bounds slice adjacent tasks, edges, and blocks without cursor pagination", async () => {
    const { root } = await createTestWorkspace(wideSliceManifest(6, 5));

    const first = await inspectGraph({
      projectRoot: root,
      view: "slice",
      taskId: "T-001",
      limit: 3
    });

    expect(first.dependencies.items.map((task) => task.taskId)).toEqual([
      "T-002",
      "T-003",
      "T-004"
    ]);
    expect(first.dependencies).toMatchObject({ limit: 3, total: 6, truncated: true });
    expect(first.edges.items).toHaveLength(3);
    expect(first.edges).toMatchObject({ limit: 3, total: 3, truncated: false });
    expect(first.blocks.items.map((block) => block.blockId)).toEqual(["B-001", "B-002", "B-003"]);
    expect(first.blocks).toMatchObject({ limit: 3, total: 5, truncated: true });
    expect(JSON.stringify(first)).not.toContain("nextCursor");
  });

  it("rejects cursor pagination for slice views", async () => {
    const { root } = await createTestWorkspace(wideSliceManifest(6, 5));

    await expect(
      inspectGraph({
        projectRoot: root,
        view: "slice",
        taskId: "T-001",
        limit: 3,
        cursor: "next:3"
      })
    ).rejects.toThrow("Graph inspection slice view does not support cursor pagination.");
  });
});
