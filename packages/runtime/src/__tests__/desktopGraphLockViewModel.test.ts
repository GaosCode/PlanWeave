import { afterEach, describe, expect, it } from "vitest";
import { getGraphViewModel } from "../desktop/index.js";
import { markBlockBlocked } from "../taskManager/blockStatusMutations.js";
import { claimBlock } from "../taskManager/claimScheduler.js";
import { writeJsonFile } from "../json.js";
import type { PlanPackageManifest } from "../types.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

function sharedLockManifest(): PlanPackageManifest {
  return {
    version: "plan-package/v1",
    project: {
      title: "Shared Lock Canvas",
      description: "Two tasks share lock db."
    },
    execution: {
      parallel: {
        enabled: true,
        maxConcurrent: 2
      }
    },
    review: {
      maxFeedbackCycles: 1,
      completionPolicy: "strict"
    },
    nodes: [
      {
        id: "T-A",
        type: "task",
        title: "Holder task",
        prompt: "nodes/T-A/prompt.md",
        acceptance: ["done"],
        blocks: [
          {
            id: "B-001",
            type: "implementation",
            title: "Hold db",
            prompt: "nodes/T-A/blocks/B-001.prompt.md",
            depends_on: [],
            parallel: { locks: ["db"] }
          }
        ]
      },
      {
        id: "T-B",
        type: "task",
        title: "Waiter task",
        prompt: "nodes/T-B/prompt.md",
        acceptance: ["done"],
        blocks: [
          {
            id: "B-001",
            type: "implementation",
            title: "Wait for db",
            prompt: "nodes/T-B/blocks/B-001.prompt.md",
            depends_on: [],
            parallel: { locks: ["db"] }
          }
        ]
      }
    ],
    edges: []
  };
}

describe("desktop graph lock view model", () => {
  it("exposes locks, lock groups, dispatchable, and waitingOn for shared locks", async () => {
    const { root, init } = await createTestWorkspace(sharedLockManifest());
    await writeJsonFile(init.workspace.manifestFile, sharedLockManifest());

    const claim = await claimBlock({ projectRoot: root, ref: "T-A#B-001", dispatch: true });
    expect(claim.kind).toBe("block");

    const graph = await getGraphViewModel(root);
    const taskA = graph.tasks.find((task) => task.taskId === "T-A");
    const taskB = graph.tasks.find((task) => task.taskId === "T-B");
    expect(taskA?.locks).toEqual(["db"]);
    expect(taskB?.locks).toEqual(["db"]);

    const dbGroup = graph.lockGroups.find((group) => group.name === "db");
    expect(dbGroup).toEqual({
      name: "db",
      memberTaskIds: ["T-A", "T-B"],
      holderRef: "T-A#B-001"
    });

    const blockA = taskA?.blocks.find((block) => block.ref === "T-A#B-001");
    const blockB = taskB?.blocks.find((block) => block.ref === "T-B#B-001");
    expect(blockA?.status).toBe("in_progress");
    expect(blockA?.dispatchable).toBe(false);
    expect(blockA?.waitingOn).toBeNull();
    expect(blockB?.status).toBe("ready");
    expect(blockB?.dispatchable).toBe(false);
    expect(blockB?.waitingOn).toEqual({ lock: "db", holderRef: "T-A#B-001" });
  });

  it("clears holder and flips waiter dispatchable after mark blocked", async () => {
    const { root, init } = await createTestWorkspace(sharedLockManifest());
    await writeJsonFile(init.workspace.manifestFile, sharedLockManifest());

    await claimBlock({ projectRoot: root, ref: "T-A#B-001", dispatch: true });
    await markBlockBlocked({
      projectRoot: root,
      ref: "T-A#B-001",
      reason: "paused for transfer"
    });

    const graph = await getGraphViewModel(root);
    const dbGroup = graph.lockGroups.find((group) => group.name === "db");
    expect(dbGroup?.holderRef).toBeNull();

    const blockB = graph.tasks
      .find((task) => task.taskId === "T-B")
      ?.blocks.find((block) => block.ref === "T-B#B-001");
    expect(blockB?.dispatchable).toBe(true);
    expect(blockB?.waitingOn).toBeNull();
  });
});
