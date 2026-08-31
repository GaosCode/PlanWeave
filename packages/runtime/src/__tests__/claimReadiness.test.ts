import { describe, expect, it } from "vitest";
import { remoteBlockDispatchReadiness } from "../index.js";
import { claimBlock, claimNext } from "../taskManager/claimScheduler.js";
import { submitBlockResult, submitFeedback, submitReviewResult } from "../taskManager/index.js";
import { buildClaimReadiness, reviewClaimForm } from "../taskManager/claimReadiness.js";
import { loadRuntime } from "../taskManager/runtimeContext.js";
import {
  basicManifest,
  createTestWorkspace,
  writeReport,
  writeReviewResult
} from "./promptTestHelpers.js";

describe("claim readiness", () => {
  it("publishes remote dispatch readiness for implementations and required reviews", async () => {
    const { root } = await createTestWorkspace();
    const initial = await loadRuntime({ projectRoot: root });

    expect(
      remoteBlockDispatchReadiness({
        graph: initial.graph,
        manifest: initial.manifest,
        state: initial.state,
        ref: "T-001#B-001"
      }).dispatchable
    ).toBe(true);
    expect(
      remoteBlockDispatchReadiness({
        graph: initial.graph,
        manifest: initial.manifest,
        state: initial.state,
        ref: "T-001#R-001"
      }).dispatchable
    ).toBe(false);

    await claimNext({ projectRoot: root });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "remote-readiness.md")
    });
    const afterImplementation = await loadRuntime({ projectRoot: root });

    expect(
      remoteBlockDispatchReadiness({
        graph: afterImplementation.graph,
        manifest: afterImplementation.manifest,
        state: afterImplementation.state,
        ref: "T-001#R-001"
      }).dispatchable
    ).toBe(true);
  });

  it("derives claim hints and next claimable refs without mutating runtime state", async () => {
    const { root } = await createTestWorkspace();
    const context = await loadRuntime({ projectRoot: root });

    const readiness = buildClaimReadiness(context);

    expect(readiness.nextClaimable).toEqual(["T-001#B-001"]);
    expect(readiness.nextParallelClaimable).toEqual(["T-001#B-001"]);
    expect(readiness.nextSequentialClaimable).toEqual([]);
    expect(readiness.claimHints.find((hint) => hint.ref === "T-001#B-001")).toMatchObject({
      ready: true,
      readyReason: "Block is ready for implementation.",
      recommendedCommand: "planweave claim T-001#B-001"
    });
    expect(context.state.currentRefs).toEqual([]);
  });

  it("keeps an independent shared-resource peer dispatchable", async () => {
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
      block.parallel = { sharedResources: ["runtime-desktop"] };
    }
    const { root } = await createTestWorkspace(manifest);
    await claimBlock({ projectRoot: root, ref: "T-001#B-001", dispatch: true });
    const context = await loadRuntime({ projectRoot: root });
    const readiness = buildClaimReadiness(context);
    const peer = readiness.claimHints.find((hint) => hint.ref === "T-002#B-001");
    expect(peer).toMatchObject({
      ready: false,
      dispatchable: true,
      statusReason: "Default claims are blocked by current block 'T-001#B-001'."
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

  it("counts an active remote review against global parallel capacity", async () => {
    const manifest = basicManifest({ includeSecondTask: true, parallel: true, maxConcurrent: 2 });
    manifest.nodes.push({
      id: "T-003",
      type: "task",
      title: "Third task",
      prompt: "nodes/T-003/prompt.md",
      acceptance: ["Third implementation is complete."],
      blocks: [
        {
          id: "B-001",
          type: "implementation",
          title: "Implement third task",
          prompt: "nodes/T-003/blocks/B-001.prompt.md",
          depends_on: []
        },
        {
          id: "R-001",
          type: "review",
          title: "Review third task",
          prompt: "nodes/T-003/blocks/R-001.prompt.md",
          depends_on: ["B-001"],
          review: { required: true, maxFeedbackCycles: 1, hook: null }
        }
      ]
    });
    const { root } = await createTestWorkspace(manifest);
    await claimNext({ projectRoot: root });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "t-001.md")
    });
    const context = await loadRuntime({ projectRoot: root });
    context.state.blocks["T-001#R-001"] = {
      ...context.state.blocks["T-001#R-001"],
      status: "in_progress",
      remoteOwnership: {
        phase: "active",
        operationId: "operation-review-001",
        sourceRevision: "revision-001",
        graphFingerprint: "fingerprint-001",
        dispatchId: "dispatch-001",
        executionAttemptId: "attempt-001"
      }
    };
    context.state.currentRefs = ["T-001#R-001"];
    context.state.currentReviewBlockRef = "T-001#R-001";

    const readiness = buildClaimReadiness(context);

    expect(readiness.parallelBatchRefs).toEqual(["T-002#B-001"]);
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

  it("classifies review claim form as initial, resume, or not_claimable", async () => {
    const { root } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "b.md")
    });

    const readyContext = await loadRuntime({ projectRoot: root });
    expect(reviewClaimForm(readyContext.graph, readyContext.state, "T-001#R-001")).toEqual({
      kind: "initial"
    });
    expect(reviewClaimForm(readyContext.graph, readyContext.state, "T-001#B-001")).toMatchObject({
      kind: "not_claimable"
    });

    await claimNext({ projectRoot: root });
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Please update tests.")
    });
    const openFeedbackContext = await loadRuntime({ projectRoot: root });
    expect(
      reviewClaimForm(openFeedbackContext.graph, openFeedbackContext.state, "T-001#R-001")
    ).toMatchObject({
      kind: "not_claimable",
      reason: expect.stringMatching(/open feedback/i)
    });

    await claimNext({ projectRoot: root });
    await submitFeedback({
      projectRoot: root,
      reportPath: await writeReport(root, "feedback.md", "Tests updated.\n")
    });
    const resumeContext = await loadRuntime({ projectRoot: root });
    expect(reviewClaimForm(resumeContext.graph, resumeContext.state, "T-001#R-001")).toEqual({
      kind: "resume"
    });

    resumeContext.state.blocks["T-001#R-001"] = {
      ...resumeContext.state.blocks["T-001#R-001"],
      remoteOwnership: {
        phase: "preparing",
        operationId: "operation-owned",
        sourceRevision: "pgv-pkg-revision-001",
        graphFingerprint: "pkg-fingerprint-001"
      }
    };
    expect(reviewClaimForm(resumeContext.graph, resumeContext.state, "T-001#R-001")).toMatchObject({
      kind: "not_claimable",
      reason: expect.stringMatching(/remote operation/i)
    });

    const ownedReadiness = buildClaimReadiness(resumeContext);
    expect(ownedReadiness.claimOrder.kind).toBe("ready");
    expect(ownedReadiness.defaultClaimBlockedReason).toBeNull();
  });
});
