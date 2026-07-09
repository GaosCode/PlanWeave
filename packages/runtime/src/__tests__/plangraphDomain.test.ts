import { describe, expect, it } from "vitest";
import {
  loadPlanGraphPackage,
  selectBlock,
  selectClaimableTasks,
  selectDownstreamTasks,
  selectTaskBlocks,
  selectUpstreamTasks
} from "../plangraph/index.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

describe("PlanGraph domain selectors", () => {
  it("builds a domain graph from the package and selects task/block dependencies", async () => {
    const { root } = await createTestWorkspace(
      basicManifest({ includeSecondTask: true, taskDependsOn: ["T-002"] })
    );

    const { graph } = await loadPlanGraphPackage(root);

    expect(graph.tasks.size).toBe(2);
    expect(selectUpstreamTasks(graph, "T-001").map((task) => task.taskId)).toEqual(["T-002"]);
    expect(selectDownstreamTasks(graph, "T-002").map((task) => task.taskId)).toEqual(["T-001"]);
    expect(selectTaskBlocks(graph, "T-001").map((block) => block.ref)).toEqual([
      "T-001#B-001",
      "T-001#R-001"
    ]);
    expect(selectBlock(graph, "T-001#R-001")?.dependsOn).toEqual(["T-001#B-001"]);
    expect(selectClaimableTasks(graph).map((task) => task.taskId)).toEqual(["T-002"]);
  });

  it("surfaces existing graph invariant diagnostics", async () => {
    const manifest = basicManifest();
    manifest.nodes.push(structuredClone(manifest.nodes[0]));
    const { root } = await createTestWorkspace(manifest);

    const { graph } = await loadPlanGraphPackage(root);

    expect(graph.diagnostics.map((item) => item.code)).toContain("node_id_duplicate");
  });
});
