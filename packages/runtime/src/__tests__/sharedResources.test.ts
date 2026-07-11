import { describe, expect, it } from "vitest";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { editBlock } from "../package/manifestEdit.js";
import { getGraphViewModel } from "../desktop/index.js";
import { desktopSharedResourceGroupSchema } from "../desktop/graph/lockViewModel.js";
import { renderPrompt, claimNext } from "../taskManager/index.js";
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

describe("shared resource hints", () => {
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
    expect(prompt).toContain("coordination hint only");
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
