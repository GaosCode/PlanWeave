import { describe, expect, it } from "vitest";
import { sortBlockRefsForTask } from "../desktop/graph/graphHelpers.js";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { requireMapValue } from "../graph/requireMapValue.js";
import {
  addBlockIndexes,
  addEdgeIndexes,
  addTaskIndexes,
  removeEdgeIndexes,
  removeTaskIndexes
} from "../graph/session/graphIndexes.js";
import { createEmptyState, ensureStateForManifest } from "../state.js";
import {
  blockDependenciesCompleted,
  computeWorkRevision,
  requiredImplementationRefs,
  taskDependenciesSatisfied
} from "../taskManager/selectors.js";
import type { CompiledExecutionGraph, ManifestTaskNode } from "../types.js";
import { basicManifest } from "./promptTestHelpers.js";

function relevantIndexSnapshot(graph: CompiledExecutionGraph) {
  const listMap = (map: Map<string, string[]>) =>
    Object.fromEntries(
      [...map.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, [...value]])
    );
  const valueMap = (map: Map<string, string>) =>
    Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
  return {
    taskNodesInManifestOrder: [...graph.taskNodesInManifestOrder],
    blockRefsInManifestOrder: [...graph.blockRefsInManifestOrder],
    taskDependenciesByTask: listMap(graph.taskDependenciesByTask),
    taskDependentsByTask: listMap(graph.taskDependentsByTask),
    blocksByTask: listMap(graph.blocksByTask),
    blockDependenciesByRef: listMap(graph.blockDependenciesByRef),
    blockDependentsByRef: listMap(graph.blockDependentsByRef),
    reviewBlocksByTask: listMap(graph.reviewBlocksByTask),
    sharedResourcesByBlockRef: listMap(graph.sharedResourcesByBlockRef),
    blockTaskByRef: valueMap(graph.blockTaskByRef),
    blockIdsByRef: Object.fromEntries(
      [...graph.blocksByRef.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([ref, block]) => [ref, block.id])
    )
  };
}

describe("graph index internal invariants", () => {
  it("throws when addEdgeIndexes runs without taskDependenciesByTask for the from task (I6)", () => {
    const graph = compileTaskGraph(basicManifest({ includeSecondTask: true }));
    graph.taskDependenciesByTask.delete("T-001");

    expect(() => addEdgeIndexes(graph, { from: "T-001", to: "T-002", type: "depends_on" })).toThrow(
      "Internal graph invariant violated: missing key 'T-001' in taskDependenciesByTask."
    );
  });

  it("throws when addEdgeIndexes runs without taskDependentsByTask for the to task", () => {
    const graph = compileTaskGraph(basicManifest({ includeSecondTask: true }));
    graph.taskDependentsByTask.delete("T-002");

    expect(() => addEdgeIndexes(graph, { from: "T-001", to: "T-002", type: "depends_on" })).toThrow(
      "Internal graph invariant violated: missing key 'T-002' in taskDependentsByTask."
    );
  });

  it("throws when addBlockIndexes runs without blocksByTask for the task (I7)", () => {
    const graph = compileTaskGraph(basicManifest());
    graph.blocksByTask.delete("T-001");
    const block = {
      id: "B-extra",
      type: "implementation" as const,
      title: "Extra",
      prompt: "nodes/T-001/blocks/B-extra.prompt.md",
      depends_on: [] as string[]
    };

    expect(() => addBlockIndexes(graph, "T-001", block)).toThrow(
      "Internal graph invariant violated: missing key 'T-001' in blocksByTask."
    );
  });

  it("throws when removeTaskIndexes runs without blocksByTask for the task", () => {
    const graph = compileTaskGraph(basicManifest());
    graph.blocksByTask.delete("T-001");

    expect(() => removeTaskIndexes(graph, "T-001")).toThrow(
      "Internal graph invariant violated: missing key 'T-001' in blocksByTask."
    );
  });

  it("throws when removeEdgeIndexes runs without task dependency indexes", () => {
    const graph = compileTaskGraph(basicManifest({ includeSecondTask: true }));
    const edge = { from: "T-001", to: "T-002", type: "depends_on" as const };
    addEdgeIndexes(graph, edge);
    graph.taskDependenciesByTask.delete("T-001");

    expect(() => removeEdgeIndexes(graph, edge)).toThrow(
      "Internal graph invariant violated: missing key 'T-001' in taskDependenciesByTask."
    );
  });

  it("wires reverse block dependents when depends_on references a later block in the same task", () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("missing task");
    }
    task.blocks = [
      {
        id: "B-001",
        type: "implementation",
        title: "First (depends on later)",
        prompt: "nodes/T-001/blocks/B-001.prompt.md",
        depends_on: ["B-002"]
      },
      {
        id: "B-002",
        type: "implementation",
        title: "Second",
        prompt: "nodes/T-001/blocks/B-002.prompt.md",
        depends_on: []
      }
    ];

    const compiled = compileTaskGraph(manifest);
    expect(compiled.blockDependenciesByRef.get("T-001#B-001")).toEqual(["T-001#B-002"]);
    expect(compiled.blockDependentsByRef.get("T-001#B-002")).toEqual(["T-001#B-001"]);

    const incremental = compileTaskGraph({
      ...manifest,
      nodes: [],
      edges: []
    });
    addTaskIndexes(incremental, task);
    expect(incremental.blockDependenciesByRef.get("T-001#B-001")).toEqual(["T-001#B-002"]);
    expect(incremental.blockDependentsByRef.get("T-001#B-002")).toEqual(["T-001#B-001"]);
  });

  it("keeps legitimate empty dependency lists when keys are present", () => {
    const graph = compileTaskGraph(basicManifest());

    expect(graph.taskDependenciesByTask.get("T-001")).toEqual([]);
    expect(graph.reviewBlocksByTask.has("T-001")).toBe(true);
    expect(graph.blockDependenciesByRef.get("T-001#B-001")).toEqual([]);
  });

  it("throws from state reconcile when blocksByTask key is missing (I1)", () => {
    const manifest = basicManifest();
    const graph = compileTaskGraph(manifest);
    graph.blocksByTask.delete("T-001");

    // ensureStateForManifest recompiles; probe the reader helpers it uses after tamper.
    expect(() => requiredImplementationRefs(graph, "T-001")).toThrow(
      "Internal graph invariant violated: missing key 'T-001' in blocksByTask."
    );
    expect(() => sortBlockRefsForTask(graph, "T-001")).toThrow(
      "Internal graph invariant violated: missing key 'T-001' in blocksByTask."
    );
  });

  it("throws from block dependency readers when blockDependenciesByRef key is missing (I2)", () => {
    const graph = compileTaskGraph(basicManifest());
    const state = ensureStateForManifest(basicManifest(), createEmptyState());
    graph.blockDependenciesByRef.delete("T-001#B-001");

    expect(() => blockDependenciesCompleted(graph, state, "T-001#B-001")).toThrow(
      "Internal graph invariant violated: missing key 'T-001#B-001' in blockDependenciesByRef."
    );
  });

  it("throws from task dependency readers when taskDependenciesByTask key is missing (I3)", () => {
    const graph = compileTaskGraph(basicManifest());
    const state = ensureStateForManifest(basicManifest(), createEmptyState());
    graph.taskDependenciesByTask.delete("T-001");

    expect(() => taskDependenciesSatisfied(graph, state, "T-001")).toThrow(
      "Internal graph invariant violated: missing key 'T-001' in taskDependenciesByTask."
    );
  });

  it("throws from requiredImplementationRefs when blocksByRef entry is missing (I4)", () => {
    const graph = compileTaskGraph(basicManifest());
    graph.blocksByRef.delete("T-001#B-001");

    expect(() => requiredImplementationRefs(graph, "T-001")).toThrow(
      "Internal graph invariant violated: missing key 'T-001#B-001' in blocksByRef."
    );
  });

  it("throws from computeWorkRevision when blockTaskByRef is missing (I5)", () => {
    const graph = compileTaskGraph(basicManifest());
    const state = ensureStateForManifest(basicManifest(), createEmptyState());
    graph.blockTaskByRef.delete("T-001#R-001");

    expect(() => computeWorkRevision(graph, state, "T-001#R-001")).toThrow(
      "Internal graph invariant violated: missing key 'T-001#R-001' in blockTaskByRef."
    );
  });

  it("throws from sortBlockRefsForTask when blockDependenciesByRef key is missing (I8 family)", () => {
    const graph = compileTaskGraph(basicManifest());
    graph.blockDependenciesByRef.delete("T-001#B-001");

    expect(() => sortBlockRefsForTask(graph, "T-001")).toThrow(
      "Internal graph invariant violated: missing key 'T-001#B-001' in blockDependenciesByRef."
    );
  });

  it("throws when sharedResourcesByBlockRef key is missing for a known block (I8)", () => {
    const graph = compileTaskGraph(basicManifest());
    graph.sharedResourcesByBlockRef.delete("T-001#B-001");

    expect(() =>
      requireMapValue(graph.sharedResourcesByBlockRef, "T-001#B-001", "sharedResourcesByBlockRef")
    ).toThrow(
      "Internal graph invariant violated: missing key 'T-001#B-001' in sharedResourcesByBlockRef."
    );
  });

  it("full compile and equivalent incremental addTaskIndexes produce matching relevant indexes", () => {
    const manifest = basicManifest({ includeSecondTask: true });
    manifest.edges.push({ from: "T-002", to: "T-001", type: "depends_on" });
    const taskOne = manifest.nodes.find((node) => node.id === "T-001");
    const taskTwo = manifest.nodes.find((node) => node.id === "T-002");
    if (taskOne?.type !== "task" || taskTwo?.type !== "task") {
      throw new Error("missing tasks");
    }

    const compiled = compileTaskGraph(manifest);
    const incremental = compileTaskGraph({
      ...manifest,
      nodes: [],
      edges: []
    });
    for (const task of [taskOne, taskTwo] as ManifestTaskNode[]) {
      addTaskIndexes(incremental, task);
    }
    addEdgeIndexes(incremental, { from: "T-002", to: "T-001", type: "depends_on" });
    incremental.taskNodesInManifestOrder = ["T-001", "T-002"];
    incremental.blockRefsInManifestOrder = [
      "T-001#B-001",
      "T-001#R-001",
      "T-002#B-001",
      "T-002#R-001"
    ];

    expect(relevantIndexSnapshot(incremental)).toEqual(relevantIndexSnapshot(compiled));
  });
});

describe("graph index external diagnostics (preserve)", () => {
  it("reports missing edge endpoints as diagnostics without throwing", () => {
    const manifest = basicManifest();
    manifest.edges.push({ from: "T-missing", to: "T-001", type: "depends_on" });

    const graph = compileTaskGraph(manifest);

    expect(graph.diagnostics.errors.map((error) => error.code)).toContain("edge_from_missing");
    expect(graph.taskDependenciesByTask.has("T-missing")).toBe(false);
  });

  it("reports missing block depends_on targets as diagnostics without throwing", () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("missing task");
    }
    task.blocks[0].depends_on = ["NOPE"];

    const graph = compileTaskGraph(manifest);

    expect(graph.diagnostics.errors.map((error) => error.code)).toContain(
      "block_dependency_missing"
    );
    expect(graph.blockDependenciesByRef.get("T-001#B-001")).toEqual([]);
  });

  it("reports task and block cycles as diagnostics without throwing", () => {
    const manifest = basicManifest({ includeSecondTask: true });
    manifest.edges.push({ from: "T-001", to: "T-002", type: "depends_on" });
    manifest.edges.push({ from: "T-002", to: "T-001", type: "depends_on" });
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("missing task");
    }
    task.blocks[0].depends_on = ["R-001"];

    const graph = compileTaskGraph(manifest);

    expect(graph.diagnostics.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["depends_on_cycle", "block_depends_on_cycle"])
    );
  });
});
