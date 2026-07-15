import { describe, expect, it } from "vitest";
import {
  claimNext,
  getExecutionStatus,
  markBlockBlocked,
  submitBlockResult
} from "../taskManager/index.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";
import type { PlanPackageManifest } from "../types.js";

async function writeReport(root: string, name: string): Promise<string> {
  const reportPath = join(root, name);
  await writeFile(reportPath, `${name} done\n`, "utf8");
  return reportPath;
}

function withImplementationParallel(
  manifest: PlanPackageManifest,
  taskId: string,
  blockId: string,
  sharedResources: string[] | null
): PlanPackageManifest {
  const nodes = manifest.nodes.map((node) => {
    if (node.type !== "task" || node.id !== taskId) {
      return node;
    }
    return {
      ...node,
      blocks: node.blocks.map((block) => {
        if (block.id !== blockId || block.type !== "implementation") {
          return block;
        }
        if (sharedResources === null) {
          const { parallel: _drop, ...rest } = block as typeof block & {
            parallel?: unknown;
          };
          return rest;
        }
        return {
          ...block,
          parallel: { sharedResources }
        };
      })
    };
  });
  return { ...manifest, nodes };
}

describe("parallel claim", () => {
  it("returns a batch only when package parallel execution is enabled", async () => {
    const disabled = await createTestWorkspace(
      basicManifest({ parallel: false, includeSecondTask: true })
    );

    expect(await claimNext({ projectRoot: disabled.root, parallel: true })).toMatchObject({
      kind: "blocked"
    });

    const enabled = await createTestWorkspace(
      basicManifest({ parallel: true, maxConcurrent: 2, includeSecondTask: true })
    );

    expect(await claimNext({ projectRoot: enabled.root, parallel: true })).toEqual({
      kind: "batch",
      refs: ["T-001#B-001", "T-002#B-001"],
      effectiveExecutors: {
        "T-001#B-001": "default",
        "T-002#B-001": "default"
      }
    });
  });

  it("claims an isolated block with no parallel entry at t=0", async () => {
    const manifest = withImplementationParallel(
      basicManifest({ parallel: true, maxConcurrent: 2 }),
      "T-001",
      "B-001",
      null
    );
    // Remove the optional parallel key entirely from source JSON semantics.
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("missing task");
    }
    const block = task.blocks.find((item) => item.id === "B-001");
    if (block?.type !== "implementation") {
      throw new Error("missing block");
    }
    delete block.parallel;

    const { root } = await createTestWorkspace(manifest);
    const first = await claimNext({ projectRoot: root, parallel: true });
    expect(first).toMatchObject({
      kind: "batch",
      refs: ["T-001#B-001"]
    });
  });

  it("backfills capacity while retaining live in_progress refs", async () => {
    const manifest = basicManifest({ parallel: true, maxConcurrent: 3, includeSecondTask: true });
    manifest.nodes.push({
      id: "T-003",
      type: "task",
      title: "Third task",
      prompt: "nodes/T-003/prompt.md",
      acceptance: ["Third complete."],
      blocks: [
        {
          id: "B-001",
          type: "implementation",
          title: "Implement third",
          prompt: "nodes/T-003/blocks/B-001.prompt.md",
          depends_on: []
        },
        {
          id: "R-001",
          type: "review",
          title: "Review third",
          prompt: "nodes/T-003/blocks/R-001.prompt.md",
          depends_on: ["B-001"],
          review: { required: true, maxFeedbackCycles: 1, hook: null }
        }
      ]
    });

    const { root } = await createTestWorkspace(manifest);

    // Claim only two slots first by temporarily limiting concurrency via a second claim path:
    // first claim with maxConcurrent effectively filled by taking 2, then backfill the third.
    // We claim with maxConcurrent 3 but only two are returned if we first claim with max 2...
    // Use claim-next after a batch of 2: create workspace with maxConcurrent 2, claim, then
    // raise capacity by writing maxConcurrent 3 is out of scope. Instead claim all 3, submit one,
    // and verify the remaining two stay live without re-claiming them as "new".
    const first = await claimNext({ projectRoot: root, parallel: true });
    expect(first).toMatchObject({
      kind: "batch",
      refs: ["T-001#B-001", "T-002#B-001", "T-003#B-001"]
    });

    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "t1.md")
    });

    // Capacity freed by one completion; nothing new is ready (reviews wait), retained live refs.
    const second = await claimNext({ projectRoot: root, parallel: true });
    expect(second).toMatchObject({
      kind: "batch",
      reason: "at_capacity"
    });
    if (second.kind !== "batch") {
      throw new Error("expected batch");
    }
    expect(second.refs.sort()).toEqual(["T-002#B-001", "T-003#B-001"]);

    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.currentRefs.sort()).toEqual(["T-002#B-001", "T-003#B-001"]);
    expect(status.blocks.find((block) => block.ref === "T-002#B-001")?.status).toBe("in_progress");
    expect(status.blocks.find((block) => block.ref === "T-003#B-001")?.status).toBe("in_progress");
  });

  it("backfills a new dispatchable block into free capacity", async () => {
    const manifest = basicManifest({ parallel: true, maxConcurrent: 2, includeSecondTask: true });
    manifest.nodes.push({
      id: "T-003",
      type: "task",
      title: "Third task",
      prompt: "nodes/T-003/prompt.md",
      acceptance: ["Third complete."],
      blocks: [
        {
          id: "B-001",
          type: "implementation",
          title: "Implement third",
          prompt: "nodes/T-003/blocks/B-001.prompt.md",
          depends_on: []
        },
        {
          id: "R-001",
          type: "review",
          title: "Review third",
          prompt: "nodes/T-003/blocks/R-001.prompt.md",
          depends_on: ["B-001"],
          review: { required: true, maxFeedbackCycles: 1, hook: null }
        }
      ]
    });
    const { root } = await createTestWorkspace(manifest);

    const first = await claimNext({ projectRoot: root, parallel: true });
    expect(first).toMatchObject({
      kind: "batch",
      refs: ["T-001#B-001", "T-002#B-001"]
    });

    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "t1.md")
    });

    const second = await claimNext({ projectRoot: root, parallel: true });
    // Newly claimed only T-003; T-002 stays in_progress and is retained in currentRefs.
    expect(second).toMatchObject({
      kind: "batch",
      refs: ["T-003#B-001"]
    });
    expect(second).not.toHaveProperty("reason", "at_capacity");

    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.currentRefs.sort()).toEqual(["T-002#B-001", "T-003#B-001"]);
    expect(status.blocks.find((block) => block.ref === "T-002#B-001")?.status).toBe("in_progress");
    expect(status.blocks.find((block) => block.ref === "T-003#B-001")?.status).toBe("in_progress");
  });

  it("returns at_capacity when maxConcurrent is filled", async () => {
    const { root } = await createTestWorkspace(
      basicManifest({ parallel: true, maxConcurrent: 1, includeSecondTask: true })
    );

    const first = await claimNext({ projectRoot: root, parallel: true });
    expect(first).toMatchObject({
      kind: "batch",
      refs: ["T-001#B-001"]
    });

    const second = await claimNext({ projectRoot: root, parallel: true });
    expect(second).toEqual({
      kind: "batch",
      refs: ["T-001#B-001"],
      effectiveExecutors: { "T-001#B-001": "default" },
      reason: "at_capacity"
    });
  });

  it("co-claims independent blocks that share a coordination resource", async () => {
    let manifest = basicManifest({ parallel: true, maxConcurrent: 2, includeSecondTask: true });
    manifest = withImplementationParallel(manifest, "T-001", "B-001", ["database"]);
    manifest = withImplementationParallel(manifest, "T-002", "B-001", ["database"]);

    const { root } = await createTestWorkspace(manifest);
    const first = await claimNext({ projectRoot: root, parallel: true });
    expect(first).toMatchObject({
      kind: "batch",
      refs: ["T-001#B-001", "T-002#B-001"]
    });
  });

  it("frees capacity after marking an in-progress block blocked", async () => {
    const manifest = basicManifest({ parallel: true, maxConcurrent: 1, includeSecondTask: true });

    const { root } = await createTestWorkspace(manifest);
    const first = await claimNext({ projectRoot: root, parallel: true });
    expect(first).toMatchObject({
      kind: "batch",
      refs: ["T-001#B-001"]
    });

    await markBlockBlocked({
      projectRoot: root,
      ref: "T-001#B-001",
      reason: "capacity release test"
    });

    const after = await claimNext({ projectRoot: root, parallel: true });
    expect(after).toMatchObject({
      kind: "batch",
      refs: ["T-002#B-001"]
    });
  });

  it("selects the same parallel batch twice for the same state (determinism)", async () => {
    const { root } = await createTestWorkspace(
      basicManifest({ parallel: true, maxConcurrent: 2, includeSecondTask: true })
    );
    const a = await claimNext({ projectRoot: root, parallel: true, dryRun: true });
    const b = await claimNext({ projectRoot: root, parallel: true, dryRun: true });
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      kind: "batch",
      refs: ["T-001#B-001", "T-002#B-001"]
    });
  });
});
