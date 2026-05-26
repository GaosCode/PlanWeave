import { describe, expect, it } from "vitest";
import { claimNext, getExecutionStatus, markBlockBlocked, markBlockDiverged, submitBlockResult } from "../taskManager/index.js";
import { basicManifest, createTestWorkspace, writeReport } from "./promptTestHelpers.js";

describe("getExecutionStatus", () => {
  it("summarizes task, block, feedback, and current claim state", async () => {
    const { root } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "b.md") });

    const status = await getExecutionStatus({ projectRoot: root });

    expect(status.taskTotal).toBe(1);
    expect(status.blockTotal).toBe(2);
    expect(status.counts.blocks.completed).toBe(1);
    expect(status.counts.blocks.ready).toBe(1);
    expect(status.counts.feedback.open).toBe(0);
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")?.lastRunId).toBe("RUN-001");
  });

  it("only lists blocks claimable after task upstream dependencies are satisfied", async () => {
    const { root } = await createTestWorkspace(basicManifest({ includeSecondTask: true, taskDependsOn: ["T-002"] }));

    const status = await getExecutionStatus({ projectRoot: root });
    const claim = await claimNext({ projectRoot: root });

    expect(status.nextClaimable).toEqual(["T-002#B-001"]);
    expect(status.counts.blocks.ready).toBe(1);
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")?.status).toBe("planned");
    expect(claim).toMatchObject({ kind: "block", ref: "T-002#B-001" });
    expect(status.claimHints.find((hint) => hint.ref === "T-001#B-001")).toMatchObject({
      ref: "T-001#B-001",
      blockedByTasks: ["T-002"],
      parallelSafe: true,
      sequentialOnly: false
    });
  });

  it("separates parallel and sequential claimable blocks with recommended commands", async () => {
    const { root } = await createTestWorkspace(basicManifest({ parallel: true }));
    await claimNext({ projectRoot: root, parallel: true });
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "b.md") });

    const status = await getExecutionStatus({ projectRoot: root });

    expect(status.nextClaimable).toEqual(["T-001#R-001"]);
    expect(status.nextParallelClaimable).toEqual([]);
    expect(status.nextSequentialClaimable).toEqual(["T-001#R-001"]);
    expect(status.claimHints.find((hint) => hint.ref === "T-001#R-001")).toMatchObject({
      ref: "T-001#R-001",
      ready: true,
      readyReason: "Review gate is ready after required implementation blocks completed.",
      parallelSafe: false,
      sequentialOnly: true,
      recommendedCommand: "planweave claim T-001#R-001",
      reviewGate: {
        isGate: true,
        required: true,
        requiredReason: "Required review gate for task completion.",
        executorRole: "reviewer",
        needsChangesReturnsTo: ["T-001#B-001"]
      }
    });
  });

  it("includes blocked and diverged reasons in claim hints", async () => {
    const { root } = await createTestWorkspace();
    await markBlockBlocked({ projectRoot: root, ref: "T-001#B-001", reason: "Waiting for external API access." });
    await markBlockDiverged({ projectRoot: root, ref: "T-001#R-001", reason: "Prompt no longer matches the manifest." });

    const status = await getExecutionStatus({ projectRoot: root });

    expect(status.claimHints.find((hint) => hint.ref === "T-001#B-001")).toMatchObject({
      status: "blocked",
      statusReason: "Waiting for external API access."
    });
    expect(status.claimHints.find((hint) => hint.ref === "T-001#R-001")).toMatchObject({
      status: "diverged",
      statusReason: "Prompt no longer matches the manifest."
    });
  });

  it("only reports review gate unlocks for downstream tasks with no other unfinished task dependencies", async () => {
    const manifest = basicManifest({ includeSecondTask: true });
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
          depends_on: [],
          parallel: { safe: true, locks: ["third"] }
        }
      ]
    });
    manifest.edges.push({ from: "T-002", to: "T-001", type: "depends_on" });
    manifest.edges.push({ from: "T-002", to: "T-003", type: "depends_on" });
    const { root } = await createTestWorkspace(manifest);

    const status = await getExecutionStatus({ projectRoot: root });

    expect(status.claimHints.find((hint) => hint.ref === "T-001#R-001")?.reviewGate).toMatchObject({
      downstreamTasks: ["T-002"],
      unlocksTasks: []
    });
  });

  it("explains optional review gates as not claimable", async () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    const reviewBlock = task?.type === "task" ? task.blocks.find((block) => block.id === "R-001") : null;
    if (reviewBlock?.type !== "review") {
      throw new Error("missing review block");
    }
    reviewBlock.review.required = false;
    const { root } = await createTestWorkspace(manifest);

    await claimNext({ projectRoot: root });
    await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "b.md") });
    const status = await getExecutionStatus({ projectRoot: root });

    expect(status.nextClaimable).toEqual([]);
    expect(status.claimHints.find((hint) => hint.ref === "T-001#R-001")).toMatchObject({
      status: "ready",
      statusReason: "Optional review gate is not required and is not claimable; task can complete without it.",
      ready: false,
      recommendedCommand: null,
      reviewGate: {
        required: false,
        requiredReason: "Optional review gate; not required for task completion."
      }
    });
  });

  it("keeps explicit blocked and diverged reasons for optional review gates", async () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    const reviewBlock = task?.type === "task" ? task.blocks.find((block) => block.id === "R-001") : null;
    if (reviewBlock?.type !== "review") {
      throw new Error("missing review block");
    }
    reviewBlock.review.required = false;
    const { root } = await createTestWorkspace(manifest);

    await markBlockBlocked({ projectRoot: root, ref: "T-001#R-001", reason: "Reviewer account is unavailable." });
    let status = await getExecutionStatus({ projectRoot: root });
    expect(status.claimHints.find((hint) => hint.ref === "T-001#R-001")).toMatchObject({
      status: "blocked",
      statusReason: "Reviewer account is unavailable."
    });

    await markBlockDiverged({ projectRoot: root, ref: "T-001#R-001", reason: "Review prompt drifted." });
    status = await getExecutionStatus({ projectRoot: root });
    expect(status.claimHints.find((hint) => hint.ref === "T-001#R-001")).toMatchObject({
      status: "diverged",
      statusReason: "Review prompt drifted."
    });
  });
});
