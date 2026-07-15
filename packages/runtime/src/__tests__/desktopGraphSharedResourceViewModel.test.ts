import { afterEach, describe, expect, it } from "vitest";
import { getGraphViewModel } from "../desktop/index.js";
import { desktopSharedResourceGroupSchema } from "../desktop/graph/sharedResourceViewModel.js";
import { claimBlock } from "../taskManager/claimScheduler.js";
import { writeJsonFile } from "../json.js";
import type { PlanPackageManifest } from "../types.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

function sharedResourceManifest(): PlanPackageManifest {
  return {
    version: "plan-package/v1",
    project: { title: "Shared Resource Canvas", description: "Two tasks share database." },
    execution: { parallel: { enabled: true, maxConcurrent: 2 } },
    review: { maxFeedbackCycles: 1, completionPolicy: "strict" },
    nodes: [
      {
        id: "T-A",
        type: "task",
        title: "First task",
        prompt: "nodes/T-A/prompt.md",
        acceptance: ["done"],
        blocks: [
          {
            id: "B-001",
            type: "implementation",
            title: "Update database",
            prompt: "nodes/T-A/blocks/B-001.prompt.md",
            depends_on: [],
            parallel: { sharedResources: ["database"] }
          }
        ]
      },
      {
        id: "T-B",
        type: "task",
        title: "Second task",
        prompt: "nodes/T-B/prompt.md",
        acceptance: ["done"],
        blocks: [
          {
            id: "B-001",
            type: "implementation",
            title: "Read database",
            prompt: "nodes/T-B/blocks/B-001.prompt.md",
            depends_on: [],
            parallel: { sharedResources: ["database"] }
          }
        ]
      }
    ],
    edges: []
  };
}

describe("desktop graph shared resource view model", () => {
  it("projects stable membership and all active overlaps without gating dispatch", async () => {
    const manifest = sharedResourceManifest();
    const { root, init } = await createTestWorkspace(manifest);
    await writeJsonFile(init.workspace.manifestFile, manifest);

    expect((await claimBlock({ projectRoot: root, ref: "T-A#B-001", dispatch: true })).kind).toBe(
      "block"
    );
    expect((await claimBlock({ projectRoot: root, ref: "T-B#B-001", dispatch: true })).kind).toBe(
      "block"
    );

    const graph = await getGraphViewModel(root);
    expect(graph.tasks.find((task) => task.taskId === "T-A")?.sharedResources).toEqual([
      "database"
    ]);
    expect(graph.tasks.find((task) => task.taskId === "T-B")?.sharedResources).toEqual([
      "database"
    ]);
    expect(graph.sharedResourceGroups).toEqual([
      {
        name: "database",
        memberTaskIds: ["T-A", "T-B"],
        memberBlockRefs: ["T-A#B-001", "T-B#B-001"],
        activeBlockRefs: ["T-A#B-001", "T-B#B-001"]
      }
    ]);
    expect(graph.tasks.flatMap((task) => task.blocks).every((block) => !block.dispatchable)).toBe(
      true
    );
  });

  it("requires stable member and active block data in the DTO", () => {
    expect(
      desktopSharedResourceGroupSchema.safeParse({
        name: "database",
        memberTaskIds: ["T-A"],
        memberBlockRefs: ["T-A#B-001"]
      }).success
    ).toBe(false);
    expect(
      desktopSharedResourceGroupSchema.safeParse({
        name: "database",
        memberTaskIds: ["T-A"],
        memberBlockRefs: ["T-A#B-001"],
        activeBlockRefs: []
      }).success
    ).toBe(true);
  });
});
