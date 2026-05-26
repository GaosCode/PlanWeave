import { describe, expect, it } from "vitest";
import { compileTaskGraph, parseBlockRef } from "../graph/compileTaskGraph.js";
import { basicManifest } from "./promptTestHelpers.js";

describe("compileTaskGraph", () => {
  it("indexes block refs, block dependencies, and review blocks", () => {
    const graph = compileTaskGraph(basicManifest());

    expect(graph.blockRefsInManifestOrder).toEqual(["T-001#B-001", "T-001#R-001"]);
    expect(graph.blockDependenciesByRef.get("T-001#R-001")).toEqual(["T-001#B-001"]);
    expect(graph.reviewBlocksByTask.get("T-001")).toEqual(["T-001#R-001"]);
    expect(graph.diagnostics.errors).toEqual([]);
  });

  it("accepts tasks without review blocks", () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("missing task");
    }
    task.blocks = task.blocks.filter((block) => block.type !== "review");

    const graph = compileTaskGraph(manifest);

    expect(graph.blockRefsInManifestOrder).toEqual(["T-001#B-001"]);
    expect(graph.reviewBlocksByTask.get("T-001")).toEqual([]);
    expect(graph.diagnostics.errors).toEqual([]);
  });

  it("keeps block dependencies scoped to the same task", () => {
    const manifest = basicManifest({ includeSecondTask: true });
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("missing task");
    }
    task.blocks[0].depends_on = ["T-002#B-001"];

    const graph = compileTaskGraph(manifest);

    expect(graph.diagnostics.errors.map((error) => error.code)).toContain("block_dependency_missing");
  });

  it("detects task and block dependency cycles", () => {
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

  it("parses block refs explicitly", () => {
    expect(parseBlockRef("T-001#B-001")).toEqual({ taskId: "T-001", blockId: "B-001" });
    expect(() => parseBlockRef("T-001")).toThrow("Invalid block ref");
  });
});
