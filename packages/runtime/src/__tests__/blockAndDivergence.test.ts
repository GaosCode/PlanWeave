import { describe, expect, it } from "vitest";
import {
  claimNext,
  getExecutionStatus,
  markBlockBlocked,
  markBlockDiverged,
  resolveBlockDivergence,
  submitBlockResult,
  submitReviewResult,
  unblockBlock
} from "../taskManager/index.js";
import {
  basicManifest,
  createTestWorkspace,
  writeReport,
  writeReviewResult
} from "./promptTestHelpers.js";

describe("block recovery commands", () => {
  it("blocks and unblocks block refs with explicit reasons", async () => {
    const { root } = await createTestWorkspace();
    await claimNext({ projectRoot: root });

    expect(
      await markBlockBlocked({ projectRoot: root, ref: "T-001#B-001", reason: "waiting for input" })
    ).toEqual({
      ref: "T-001#B-001",
      status: "blocked",
      reason: "waiting for input"
    });
    expect(
      await unblockBlock({ projectRoot: root, ref: "T-001#B-001", reason: "input arrived" })
    ).toMatchObject({
      ref: "T-001#B-001",
      status: "ready",
      reason: "input arrived"
    });
  });

  it("requires an unblock reason", async () => {
    const { root } = await createTestWorkspace();
    await markBlockBlocked({ projectRoot: root, ref: "T-001#B-001", reason: "waiting" });

    await expect(
      unblockBlock({ projectRoot: root, ref: "T-001#B-001", reason: " " })
    ).rejects.toThrow("unblock requires a non-empty reason");
  });

  it("records and resolves divergence on block refs", async () => {
    const { root } = await createTestWorkspace();

    expect(
      await markBlockDiverged({ projectRoot: root, ref: "T-001#B-001", reason: "manifest changed" })
    ).toEqual({
      ref: "T-001#B-001",
      status: "diverged",
      reason: "manifest changed"
    });
    expect(
      await resolveBlockDivergence({ projectRoot: root, ref: "T-001#B-001", reason: "rebased" })
    ).toMatchObject({
      ref: "T-001#B-001",
      status: "ready",
      reason: "rebased"
    });
  });

  it("clears max-cycle completion state when resolving a diverged review block", async () => {
    const { root } = await createTestWorkspace(basicManifest({ reviewMaxFeedbackCycles: 0 }));
    await claimNext({ projectRoot: root });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "b.md")
    });
    await claimNext({ projectRoot: root });
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Still failing.")
    });

    await markBlockDiverged({
      projectRoot: root,
      ref: "T-001#R-001",
      reason: "review cycle config changed"
    });
    await resolveBlockDivergence({
      projectRoot: root,
      ref: "T-001#R-001",
      reason: "max cycles increased"
    });
    const status = await getExecutionStatus({ projectRoot: root });

    expect(status.blocks.find((block) => block.ref === "T-001#R-001")).toMatchObject({
      status: "ready",
      completionReason: null
    });
    expect(status.warnings.map((warning) => warning.code)).not.toContain(
      "review_max_cycles_reached"
    );
  });
});
