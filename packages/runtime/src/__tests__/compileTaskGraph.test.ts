import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compilePackageGraph, compileTaskGraph } from "../graph/compileTaskGraph.js";
import type { PlanPackageManifest, RuntimeState } from "../types.js";
import { createPackageWorkspace } from "./promptTestHelpers.js";

function manifest(): PlanPackageManifest {
  return {
    version: "plan-package/v0",
    project: { title: "Project", description: "" },
    execution: { parallel: { enabled: true, maxConcurrent: 2 } },
    global_prompt: "global-prompt.md",
    nodes: [
      { id: "G-001", type: "goal", title: "Goal", summary: "Deliver the goal." },
      { id: "R-001", type: "requirement", title: "Requirement", summary: "Keep the requirement." },
      { id: "C-001", type: "constraint", title: "Constraint", summary: "Respect the constraint." },
      { id: "CMP-001", type: "component", title: "Runtime", summary: "Runtime package." },
      {
        id: "T-001",
        type: "task",
        title: "First",
        prompt: "nodes/T-001.prompt.md",
        acceptance: ["done"],
        parallel: { safe: true, locks: ["runtime"] }
      },
      {
        id: "T-002",
        type: "task",
        title: "Second",
        prompt: "nodes/T-002.prompt.md",
        acceptance: ["done"],
        parallel: { safe: true, locks: ["cli"] }
      },
      {
        id: "T-003",
        type: "task",
        title: "Third",
        prompt: "nodes/T-003.prompt.md",
        acceptance: ["done"],
        parallel: { safe: true, locks: [] }
      }
    ],
    edges: [
      { from: "T-002", to: "T-001", type: "depends_on" },
      { from: "T-003", to: "T-002", type: "depends_on" },
      { from: "T-001", to: "G-001", type: "implements" },
      { from: "T-001", to: "R-001", type: "implements" },
      { from: "T-001", to: "C-001", type: "constrained_by" },
      { from: "T-001", to: "CMP-001", type: "touches" },
      { from: "T-002", to: "CMP-001", type: "touches" },
      { from: "T-001", to: "R-001", type: "supersedes" },
      { from: "T-002", to: "T-001", type: "supersedes" }
    ]
  };
}

describe("compileTaskGraph", () => {
  it("builds deterministic task indexes and memoized dependency reachability", () => {
    const graph = compileTaskGraph(manifest());

    expect(graph.tasksInManifestOrder.map((task) => task.id)).toEqual(["T-001", "T-002", "T-003"]);
    expect(graph.dependenciesByTask.get("T-003")).toEqual(["T-002"]);
    expect(graph.dependentsByTask.get("T-001")).toEqual(["T-002"]);
    expect(graph.locksByTask.get("T-001")).toEqual(new Set(["runtime"]));
    expect(graph.reachable("T-003", "T-001")).toBe(true);
    expect(graph.reachable("T-001", "T-003")).toBe(false);
  });

  it("derives claim buckets and blocked reasons from runtime state without storing graph state", () => {
    const graph = compileTaskGraph(manifest());
    const state: RuntimeState = {
      currentTaskId: null,
      tasks: {
        "T-001": { status: "implemented", claimedBy: null, lastRunId: null, blockedBy: [] },
        "T-002": { status: "needs_changes", claimedBy: null, lastRunId: "RUN-001", blockedBy: [] },
        "T-003": { status: "planned", claimedBy: null, lastRunId: null, blockedBy: ["T-002"] }
      }
    };

    expect(graph.claimBuckets(state).needsChanges.map((task) => task.id)).toEqual(["T-002"]);
    expect(graph.claimBuckets(state).ready).toEqual([]);
    expect(graph.blockedReasonByTask(state).get("T-003")).toEqual(["T-002: needs_changes"]);
  });

  it("groups one-hop graph context by edge semantics", () => {
    const graph = compileTaskGraph(manifest());
    const context = graph.relatedContext("T-001");

    expect(context.goals.map((node) => node.id)).toEqual(["G-001"]);
    expect(context.requirements.map((node) => node.id)).toEqual(["R-001"]);
    expect(context.constraints.map((node) => node.id)).toEqual(["C-001"]);
    expect(context.components.map((node) => node.id)).toEqual(["CMP-001"]);
    expect(context.supersedes.map((node) => node.id)).toEqual(["R-001"]);
    expect(context.supersededBy.map((node) => node.id)).toEqual(["T-002"]);
  });

  it("reports edge endpoint type mismatches for every edge semantic", () => {
    const graph = compileTaskGraph({
      ...manifest(),
      edges: [
        { from: "G-001", to: "C-001", type: "implements" },
        { from: "T-001", to: "G-001", type: "constrained_by" },
        { from: "T-001", to: "R-001", type: "touches" },
        { from: "T-001", to: "G-001", type: "conflicts_with" },
        { from: "T-001", to: "G-001", type: "depends_on" }
      ]
    });

    expect(graph.diagnostics.errors.map((error) => error.code)).toEqual([
      "edge_endpoint_type_invalid",
      "edge_endpoint_type_invalid",
      "edge_endpoint_type_invalid",
      "edge_endpoint_type_invalid",
      "depends_on_non_task"
    ]);
  });

  it("allows documented conflicts_with and supersedes endpoint semantics", () => {
    const graph = compileTaskGraph({
      ...manifest(),
      edges: [
        { from: "G-001", to: "R-001", type: "supersedes" },
        { from: "G-001", to: "T-001", type: "conflicts_with" },
        { from: "CMP-001", to: "C-001", type: "conflicts_with" }
      ]
    });

    expect(graph.diagnostics.errors).toEqual([]);
    expect(graph.diagnostics.warnings.map((warning) => warning.code)).toEqual([
      "conflict_edge_warning",
      "conflict_edge_warning",
      "task_without_goal_or_requirement",
      "task_without_goal_or_requirement"
    ]);
  });

  it("reports duplicate edges as graph diagnostics", () => {
    const graph = compileTaskGraph({
      ...manifest(),
      edges: [
        { from: "T-001", to: "G-001", type: "implements" },
        { from: "T-001", to: "G-001", type: "implements" }
      ]
    });

    expect(graph.diagnostics.errors.map((error) => error.code)).toContain("edge_duplicate");
  });

  it("reports missing edge references and depends_on cycles as compiler diagnostics", () => {
    const graph = compileTaskGraph({
      ...manifest(),
      edges: [
        { from: "T-001", to: "missing", type: "depends_on" },
        { from: "T-001", to: "T-002", type: "depends_on" },
        { from: "T-002", to: "T-001", type: "depends_on" }
      ]
    });

    expect(graph.diagnostics.errors.map((error) => error.code)).toContain("edge_to_missing");
    expect(graph.diagnostics.errors.map((error) => error.code)).toContain("depends_on_cycle");
  });

  it("adds package-level Prompt Surface diagnostics when package files are available", async () => {
    const { root, init } = await createPackageWorkspace();
    await writeFile(join(init.workspace.packageDir, "nodes", "stale.prompt.md"), "stale\n", "utf8");
    const graph = await compilePackageGraph(manifest(), init.workspace.packageDir);

    expect(graph.diagnostics.errors.map((error) => error.code)).toEqual(["prompt_missing", "prompt_missing"]);
    expect(graph.diagnostics.warnings.map((warning) => warning.code)).toContain("stale_prompt_reference");
    delete process.env.PLANWEAVE_HOME;
  });

  it("reports conflict edges and missing task-body sections as graph diagnostics", async () => {
    const testManifest: PlanPackageManifest = {
      ...manifest(),
      nodes: manifest().nodes.slice(0, 6),
      edges: [
        { from: "T-001", to: "G-001", type: "implements" },
        { from: "T-001", to: "T-002", type: "conflicts_with" }
      ]
    };
    const { init } = await createPackageWorkspace(testManifest, "No user section\n");

    const graph = await compilePackageGraph(testManifest, init.workspace.packageDir);

    expect(graph.diagnostics.errors.map((error) => error.code)).toContain("task_body_missing");
    expect(graph.diagnostics.warnings.map((warning) => warning.code)).toContain("conflict_edge_warning");
    delete process.env.PLANWEAVE_HOME;
  });
});
