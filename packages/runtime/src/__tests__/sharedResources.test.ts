import { describe, expect, it } from "vitest";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import {
  createExecutionGraphSession,
  drainGraphReadQueue,
  enqueueGraphEditOperations
} from "../graph/session.js";
import { sharedResourcesForBlock } from "../graph/sharedResources.js";
import { editBlock } from "../package/manifestEdit.js";
import { getGraphViewModel } from "../desktop/index.js";
import { desktopSharedResourceGroupSchema } from "../desktop/graph/lockViewModel.js";
import { renderPrompt, claimNext } from "../taskManager/index.js";
import type { ManifestTaskNode } from "../types.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

function manifestWithSharedResources() {
  const manifest = basicManifest({ parallel: true, maxConcurrent: 2, includeSecondTask: true });
  for (const task of manifest.nodes) {
    const implementation = task.blocks.find((block) => block.type === "implementation");
    if (implementation?.type === "implementation") {
      implementation.parallel = {
        locks: [],
        sharedResources: ["packages/runtime", "packages/runtime"]
      };
    }
  }
  return manifest;
}

function withSharedResources(task: ManifestTaskNode, sharedResources: string[]): ManifestTaskNode {
  return {
    ...task,
    blocks: task.blocks.map((block) => {
      if (block.type === "review") {
        return block;
      }
      return {
        ...block,
        parallel: { ...block.parallel, sharedResources }
      };
    })
  };
}

describe("shared resource hints", () => {
  it("normalizes implementation hints and ignores review blocks", () => {
    const manifest = manifestWithSharedResources();
    const [task] = manifest.nodes;
    const implementation = task.blocks.find((block) => block.type === "implementation");
    const review = task.blocks.find((block) => block.type === "review");
    if (!(implementation && review)) {
      throw new Error("missing shared resource test blocks");
    }

    expect(sharedResourcesForBlock(implementation)).toEqual(["packages/runtime"]);
    expect(sharedResourcesForBlock(review)).toEqual([]);
  });

  it("compiles deduplicated hints without turning them into locks", () => {
    const graph = compileTaskGraph(manifestWithSharedResources());

    expect(graph.sharedResourcesByBlockRef.get("T-001#B-001")).toEqual(["packages/runtime"]);
    expect(graph.locksByBlockRef.get("T-001#B-001")).toEqual([]);
  });

  it("allows ready blocks with the same shared resource to be claimed together", async () => {
    const { root } = await createTestWorkspace(manifestWithSharedResources());

    await expect(claimNext({ projectRoot: root, parallel: true })).resolves.toMatchObject({
      kind: "batch",
      refs: ["T-001#B-001", "T-002#B-001"]
    });
  });

  it("projects soft groups and explains them in the agent prompt", async () => {
    const { root } = await createTestWorkspace(manifestWithSharedResources());

    const graph = await getGraphViewModel(root);
    expect(graph.tasks.find((task) => task.taskId === "T-001")?.sharedResources).toEqual([
      "packages/runtime"
    ]);
    expect(graph.sharedResourceGroups).toEqual([
      {
        name: "packages/runtime",
        memberTaskIds: ["T-001", "T-002"],
        memberBlockRefs: ["T-001#B-001", "T-002#B-001"],
        activeBlockRefs: []
      }
    ]);
    expect(() =>
      desktopSharedResourceGroupSchema.parse(graph.sharedResourceGroups?.[0])
    ).not.toThrow();

    const prompt = await renderPrompt({ projectRoot: root, ref: "T-001#B-001" });
    expect(prompt).toContain("## Shared Resource Hints");
    expect(prompt).toContain(
      "packages/runtime (coordination hint only; it does not reserve the resource or block parallel work)"
    );
    expect(prompt.match(/packages\/runtime \(coordination hint only/g)).toHaveLength(1);
  });

  it("maintains hints across incremental task add, update, and remove", async () => {
    const { root } = await createTestWorkspace(basicManifest());
    const session = await createExecutionGraphSession(root);
    const addedTask = manifestWithSharedResources().nodes.find((node) => node.id === "T-002");
    if (!addedTask) {
      throw new Error("missing T-002 test task");
    }

    enqueueGraphEditOperations(session, [{ type: "add_node", node: addedTask }]);
    expect((await drainGraphReadQueue(session)).diagnostics).toEqual([]);
    expect(session.graph.sharedResourcesByBlockRef.get("T-002#B-001")).toEqual([
      "packages/runtime"
    ]);

    const updatedTask = withSharedResources(addedTask, [
      "runtime/state",
      "runtime/state",
      "db/schema"
    ]);
    enqueueGraphEditOperations(session, [{ type: "update_node", node: updatedTask }]);
    expect((await drainGraphReadQueue(session)).diagnostics).toEqual([]);
    expect(session.graph.sharedResourcesByBlockRef.get("T-002#B-001")).toEqual([
      "runtime/state",
      "db/schema"
    ]);

    enqueueGraphEditOperations(session, [{ type: "remove_node", nodeId: "T-002" }]);
    expect((await drainGraphReadQueue(session)).diagnostics).toEqual([]);
    expect(session.graph.sharedResourcesByBlockRef.has("T-002#B-001")).toBe(false);
  });

  it("edits shared resources independently from legacy hard locks", async () => {
    const { root } = await createTestWorkspace(basicManifest());

    const result = await editBlock({
      projectRoot: root,
      ref: "T-001#B-001",
      sharedResources: ["db/schema", "db/schema", "runtime/state"]
    });

    expect(result.updatedFields).toEqual(["parallel.sharedResources"]);
    expect(result.graph?.sharedResourcesByBlockRef.get("T-001#B-001")).toEqual([
      "db/schema",
      "runtime/state"
    ]);
    expect(result.graph?.locksByBlockRef.get("T-001#B-001")).toEqual(["shared"]);
  });

  it("rejects shared resources on review blocks", async () => {
    const { root } = await createTestWorkspace(basicManifest());

    const result = await editBlock({
      projectRoot: root,
      ref: "T-001#R-001",
      sharedResources: ["db"]
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "command_validation_failed",
        message: "parallel fields can only be edited on implementation blocks."
      })
    );
  });
});
