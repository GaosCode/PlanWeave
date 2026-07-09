import { describe, expect, it } from "vitest";
import { claimNext } from "../taskManager/claimScheduler.js";
import { buildClaimReadiness } from "../taskManager/claimReadiness.js";
import { loadRuntime } from "../taskManager/runtimeContext.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

describe("claim readiness", () => {
  it("derives claim hints and next claimable refs without mutating runtime state", async () => {
    const { root } = await createTestWorkspace();
    const context = await loadRuntime({ projectRoot: root });

    const readiness = buildClaimReadiness(context);

    expect(readiness.nextClaimable).toEqual(["T-001#B-001"]);
    expect(readiness.nextParallelClaimable).toEqual(["T-001#B-001"]);
    expect(readiness.nextSequentialClaimable).toEqual([]);
    expect(readiness.claimHints.find((hint) => hint.ref === "T-001#B-001")).toMatchObject({
      ready: true,
      readyReason: "Block is ready and parallel-eligible (locks-only mutex).",
      recommendedCommand: "planweave claim T-001#B-001"
    });
    expect(context.state.currentRefs).toEqual([]);
  });

  it("names lock and holder when a ready block is blocked by a held lock", async () => {
    const manifest = basicManifest({ parallel: true, maxConcurrent: 2, includeSecondTask: true });
    for (const taskId of ["T-001", "T-002"] as const) {
      const task = manifest.nodes.find((node) => node.type === "task" && node.id === taskId);
      if (task?.type !== "task") {
        throw new Error("missing task");
      }
      const block = task.blocks.find((item) => item.id === "B-001");
      if (block?.type !== "implementation") {
        throw new Error("missing block");
      }
      block.parallel = { locks: ["runtime-desktop"] };
    }
    const { root } = await createTestWorkspace(manifest);
    await claimNext({ projectRoot: root, parallel: true });
    const context = await loadRuntime({ projectRoot: root });
    const readiness = buildClaimReadiness(context);
    const peer = readiness.claimHints.find((hint) => hint.ref === "T-002#B-001");
    expect(peer).toMatchObject({
      ready: false,
      dispatchable: false,
      statusReason: "blocked by lock 'runtime-desktop' held by T-001#B-001 (in_progress)"
    });
  });

  it("accepts a project graph claim guard adapter for blocker explanations", async () => {
    const { root } = await createTestWorkspace();
    const context = await loadRuntime({ projectRoot: root });

    const readiness = buildClaimReadiness({
      ...context,
      projectGuard: {
        blockersForTask: (taskId) => (taskId === "T-001" ? ["canvas:upstream"] : []),
        blockerReasonForTask: (taskId) =>
          taskId === "T-001" ? "Project graph blockers are not complete: canvas:upstream." : null
      }
    });

    expect(readiness.nextClaimable).toEqual([]);
    expect(readiness.firstProjectBlockedResult).toEqual({
      kind: "blocked",
      ref: "T-001#B-001",
      reason: "Project graph blockers are not complete: canvas:upstream."
    });
    expect(readiness.claimHints.find((hint) => hint.ref === "T-001#B-001")).toMatchObject({
      ready: false,
      blockedByProject: ["canvas:upstream"],
      statusReason: "Project graph blockers are not complete: canvas:upstream."
    });
  });

  it("previews deterministic parallel batches through the same interface", async () => {
    const { root } = await createTestWorkspace(
      basicManifest({ includeSecondTask: true, parallel: true, maxConcurrent: 2 })
    );
    const context = await loadRuntime({ projectRoot: root });

    const readiness = buildClaimReadiness(context);

    expect(readiness.parallelBatchRefs).toEqual(["T-001#B-001", "T-002#B-001"]);
  });

  it("derives current in-progress claim order through the readiness interface", async () => {
    const { root } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    const context = await loadRuntime({ projectRoot: root });

    const readiness = buildClaimReadiness(context);

    expect(readiness.claimOrder).toMatchObject({
      kind: "currentBlock",
      ref: "T-001#B-001",
      result: {
        kind: "block",
        ref: "T-001#B-001",
        reason: "current"
      }
    });
  });
});
