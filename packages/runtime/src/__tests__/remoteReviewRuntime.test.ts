import { appendFile, mkdir, readFile, readdir, symlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTaskWorkspaceRunDetail } from "../desktop/index.js";
import { readState } from "../state.js";
import {
  claimNext,
  getExecutionStatus,
  submitFeedback,
  unblockBlock
} from "../taskManager/index.js";
import { writeReport } from "./promptTestHelpers.js";
import { previewClaimNext } from "../desktop/claimPreviewApi.js";
import { snapshotDirectory } from "./support/snapshotDirectory.js";
import { recordBlockRunInIndex } from "../autoRun/blockRunIndex.js";
import { writeJsonFile } from "../json.js";
import { reportInput, claimIdentity, activateReadyBlock } from "./remoteBlockTestHelpers.js";

describe("remote review runtime lifecycle", () => {
  it.each([
    ["a persisted REV leaf", "reviews/R-001/attempts/REV-001/review-result.json", false],
    ["a dangling REV leaf", "reviews/R-001/attempts/REV-001/metadata.json", true],
    ["an ACP run metadata leaf", "blocks/R-001/runs/RUN-001/metadata.json", false],
    [
      "the ACP run index pointer",
      "blocks/R-001/runs/.planweave-task-workspace-run-index/current.json",
      false
    ],
    ["the ACP run index generation", "", false]
  ])("rejects %s without changing Results or state", async (_kind, relative, dangling) => {
    const { init, port, identity } = await activateReadyBlock();
    await port.complete({
      ref: "T-001#B-001",
      ...identity,
      ...reportInput(Buffer.from("# Implementation complete\n"))
    });
    const ref = "T-001#R-001";
    const candidate = await port.inspect({ ref });
    const reviewIdentity = {
      ...identity,
      operationId: "operation-review-boundary",
      dispatchId: "dispatch-review-boundary",
      executionAttemptId: "attempt-review-boundary",
      sourceRevision: candidate.sourceRevision,
      graphFingerprint: candidate.graphFingerprint
    };
    await port.claim({ ref, ...claimIdentity(reviewIdentity) });
    await port.activate({ ref, ...reviewIdentity });

    const { resultsDir, stateFile } = init.workspace;
    const outside = `${resultsDir}-outside`;
    const reviewRunRoot = join(resultsDir, "T-001", "blocks", "R-001", "runs");
    const indexRoot = join(reviewRunRoot, ".planweave-task-workspace-run-index");
    let escapedPath = join(resultsDir, "T-001", ...relative.split("/"));
    if (!relative) {
      await writeJsonFile(join(reviewRunRoot, "RUN-001", "metadata.json"), {
        ref,
        startedAt: "2026-01-01T00:00:00.000Z",
        executionAttemptId: "previous-attempt"
      });
      await recordBlockRunInIndex(reviewRunRoot, "RUN-001");
      const { currentGeneration } = JSON.parse(
        await readFile(join(indexRoot, "current.json"), "utf8")
      ) as { currentGeneration: string };
      escapedPath = join(indexRoot, "generations", currentGeneration, "manifest.json");
      await unlink(escapedPath);
    }
    await mkdir(outside);
    const sentinel = await writeReport(outside, "sentinel", "outside Results\n");
    await mkdir(dirname(escapedPath), { recursive: true });
    await symlink(dangling ? join(outside, "missing") : sentinel, escapedPath, "file");
    const beforeState = await readFile(stateFile);
    const beforeResults = await snapshotDirectory(resultsDir);
    const beforeOutside = await snapshotDirectory(outside);

    await expect(
      port.complete({
        ref,
        ...reviewIdentity,
        ...reportInput(
          Buffer.from(
            JSON.stringify({
              reviewBlockRef: ref,
              taskId: "T-001",
              verdict: "passed",
              content: "Reviewed the implementation."
            })
          )
        )
      })
    ).rejects.toMatchObject({
      code: "results_path_outside",
      message: expect.stringContaining(escapedPath)
    });
    expect(await readFile(stateFile)).toEqual(beforeState);
    expect(await snapshotDirectory(outside)).toEqual(beforeOutside);
    expect(await snapshotDirectory(resultsDir)).toEqual(beforeResults);
  });

  it("dispatches and completes a ready review block through the remote port", async () => {
    const { init, port, identity } = await activateReadyBlock();
    const implBytes = Buffer.from("# Implementation complete\n");
    await port.complete({
      ref: "T-001#B-001",
      ...identity,
      ...reportInput(implBytes)
    });

    const reviewCandidate = await port.inspect({ ref: "T-001#R-001" });
    expect(reviewCandidate.blockType).toBe("review");
    const reviewIdentity = {
      operationId: "operation-review-001",
      controlPlane: "collaboration" as const,
      sourceRevision: reviewCandidate.sourceRevision,
      graphFingerprint: reviewCandidate.graphFingerprint,
      dispatchId: "dispatch-review-001",
      executionAttemptId: "attempt-review-001"
    };
    await port.claim({
      ref: "T-001#R-001",
      operationId: reviewIdentity.operationId,
      controlPlane: reviewIdentity.controlPlane,
      sourceRevision: reviewIdentity.sourceRevision,
      graphFingerprint: reviewIdentity.graphFingerprint
    });
    await port.activate({ ref: "T-001#R-001", ...reviewIdentity });

    const reviewJson = JSON.stringify({
      reviewBlockRef: "T-001#R-001",
      taskId: "T-001",
      verdict: "passed",
      content: "Remote review accepted the implementation evidence."
    });
    const completed = await port.complete({
      ref: "T-001#R-001",
      ...reviewIdentity,
      ...reportInput(Buffer.from(reviewJson, "utf8"))
    });
    expect(completed).toMatchObject({ ref: "T-001#R-001", status: "completed" });
    await expect(
      port.complete({
        ref: "T-001#R-001",
        ...reviewIdentity,
        ...reportInput(Buffer.from(reviewJson, "utf8"))
      })
    ).resolves.toEqual(completed);
    const reviewState = (await readState(init.workspace.stateFile)).blocks["T-001#R-001"];
    expect(reviewState).toMatchObject({
      status: "completed",
      completionReason: "passed",
      lastRunId: completed.runId,
      remoteOperationReceipt: {
        outcome: "completed",
        operationId: reviewIdentity.operationId,
        runId: completed.runId,
        blockType: "review"
      }
    });
    expect(reviewState).not.toHaveProperty("remoteOwnership");

    const reviewRunRoot = join(init.workspace.resultsDir, "T-001", "blocks", "R-001", "runs");
    const reviewRunIds = (await readdir(reviewRunRoot))
      .filter((name) => /^RUN-\d+$/.test(name))
      .sort();
    expect(reviewRunIds).toHaveLength(1);
    const reviewRunId = reviewRunIds.at(-1)!;
    expect(
      JSON.parse(await readFile(join(reviewRunRoot, reviewRunId, "metadata.json"), "utf8"))
    ).toMatchObject({
      runnerKind: "acp",
      agentId: "codex",
      executor: "codex-acp",
      executionAttemptId: reviewIdentity.executionAttemptId,
      reviewAttemptId: completed.runId
    });
    const detail = await getTaskWorkspaceRunDetail({
      projectRoot: init.workspace.rootPath,
      canvasId: "default",
      taskId: "T-001",
      recordId: `T-001#R-001::${reviewRunId}`
    });
    expect(detail.record.runnerReadModel?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: expect.objectContaining({
            kind: "terminal",
            outcome: expect.objectContaining({ state: "succeeded", artifactValidated: true })
          })
        })
      ])
    );
  });

  it("reclaims an in_progress review after remote needs_changes and local feedback resolve", async () => {
    const { root, init, port, identity } = await activateReadyBlock();
    await port.complete({
      ref: "T-001#B-001",
      ...identity,
      ...reportInput(Buffer.from("# Implementation complete\n"))
    });

    const firstReviewCandidate = await port.inspect({ ref: "T-001#R-001" });
    const firstReviewIdentity = {
      operationId: "operation-review-needs-changes",
      controlPlane: "collaboration" as const,
      sourceRevision: firstReviewCandidate.sourceRevision,
      graphFingerprint: firstReviewCandidate.graphFingerprint,
      dispatchId: "dispatch-review-needs-changes",
      executionAttemptId: "attempt-review-needs-changes"
    };
    await port.claim({
      ref: "T-001#R-001",
      ...claimIdentity(firstReviewIdentity)
    });
    await port.activate({ ref: "T-001#R-001", ...firstReviewIdentity });
    await port.complete({
      ref: "T-001#R-001",
      ...firstReviewIdentity,
      ...reportInput(
        Buffer.from(
          JSON.stringify({
            reviewBlockRef: "T-001#R-001",
            taskId: "T-001",
            verdict: "needs_changes",
            content: "Please update tests."
          }),
          "utf8"
        )
      )
    });

    const afterNeedsChanges = await readState(init.workspace.stateFile);
    expect(afterNeedsChanges.blocks["T-001#R-001"]).toMatchObject({
      status: "in_progress"
    });
    expect(afterNeedsChanges.blocks["T-001#R-001"]).not.toHaveProperty("remoteOwnership");

    await claimNext({ projectRoot: root });
    await submitFeedback({
      projectRoot: root,
      reportPath: await writeReport(root, "feedback-remote-rereview.md", "Tests updated.\n")
    });

    const preview = await previewClaimNext(root, null, { kind: "project" });
    expect(preview).toMatchObject({
      kind: "block",
      ref: "T-001#R-001",
      blockType: "review",
      reason: "feedback_resolved"
    });

    const resumeCandidate = await port.inspect({ ref: "T-001#R-001" });
    const resumeIdentity = {
      operationId: "operation-review-resume",
      controlPlane: "collaboration" as const,
      sourceRevision: resumeCandidate.sourceRevision,
      graphFingerprint: resumeCandidate.graphFingerprint,
      dispatchId: "dispatch-review-resume",
      executionAttemptId: "attempt-review-resume"
    };
    await port.claim({
      ref: "T-001#R-001",
      ...claimIdentity(resumeIdentity)
    });
    const afterResumeClaim = await readState(init.workspace.stateFile);
    expect(afterResumeClaim.blocks["T-001#R-001"]).toMatchObject({
      status: "in_progress",
      pendingFeedbackId: null,
      remoteOwnership: {
        phase: "preparing",
        operationId: resumeIdentity.operationId
      }
    });
    expect(afterResumeClaim.currentReviewBlockRef).toBe("T-001#R-001");
    expect(afterResumeClaim.currentRefs).toContain("T-001#R-001");

    await port.activate({ ref: "T-001#R-001", ...resumeIdentity });
    const completed = await port.complete({
      ref: "T-001#R-001",
      ...resumeIdentity,
      ...reportInput(
        Buffer.from(
          JSON.stringify({
            reviewBlockRef: "T-001#R-001",
            taskId: "T-001",
            verdict: "passed",
            content: "Remote re-review accepted the fix."
          }),
          "utf8"
        )
      )
    });
    expect(completed).toMatchObject({ ref: "T-001#R-001", status: "completed" });
    const finalState = await readState(init.workspace.stateFile);
    expect(finalState.blocks["T-001#R-001"]).toMatchObject({
      status: "completed",
      completionReason: "passed"
    });
    expect(finalState.blocks["T-001#R-001"]).not.toHaveProperty("remoteOwnership");
    expect(finalState.tasks["T-001"]?.status).toBe("implemented");
  });

  it("keeps remote-owned in_progress review out of local claimNext currentReview", async () => {
    const { root, init, port, identity } = await activateReadyBlock();
    await port.complete({
      ref: "T-001#B-001",
      ...identity,
      ...reportInput(Buffer.from("# Implementation complete\n"))
    });

    const reviewCandidate = await port.inspect({ ref: "T-001#R-001" });
    const reviewIdentity = {
      operationId: "operation-review-owned",
      controlPlane: "collaboration" as const,
      sourceRevision: reviewCandidate.sourceRevision,
      graphFingerprint: reviewCandidate.graphFingerprint,
      dispatchId: "dispatch-review-owned",
      executionAttemptId: "attempt-review-owned"
    };
    await port.claim({
      ref: "T-001#R-001",
      ...claimIdentity(reviewIdentity)
    });
    await port.activate({ ref: "T-001#R-001", ...reviewIdentity });

    const owned = await readState(init.workspace.stateFile);
    expect(owned.blocks["T-001#R-001"]).toMatchObject({
      status: "in_progress",
      remoteOwnership: reviewIdentity
    });
    expect(owned.currentReviewBlockRef).toBe("T-001#R-001");

    await expect(claimNext({ projectRoot: root, dryRun: true })).resolves.toEqual({
      kind: "none",
      reason: "no_claimable_blocks"
    });
    await expect(claimNext({ projectRoot: root })).resolves.toEqual({
      kind: "none",
      reason: "no_claimable_blocks"
    });
    expect((await getExecutionStatus({ projectRoot: root })).currentReviewBlockRef).toBe(
      "T-001#R-001"
    );
  });

  it("clears currentReviewBlockRef when a remote review fails and allows reclaim after unblock", async () => {
    const { init, port, identity } = await activateReadyBlock();
    await port.complete({
      ref: "T-001#B-001",
      ...identity,
      ...reportInput(Buffer.from("# Implementation complete\n"))
    });

    const reviewCandidate = await port.inspect({ ref: "T-001#R-001" });
    const reviewIdentity = {
      operationId: "operation-review-fail",
      controlPlane: "collaboration" as const,
      sourceRevision: reviewCandidate.sourceRevision,
      graphFingerprint: reviewCandidate.graphFingerprint,
      dispatchId: "dispatch-review-fail",
      executionAttemptId: "attempt-review-fail"
    };
    await port.claim({
      ref: "T-001#R-001",
      ...claimIdentity(reviewIdentity)
    });
    await port.activate({ ref: "T-001#R-001", ...reviewIdentity });
    expect((await readState(init.workspace.stateFile)).currentReviewBlockRef).toBe("T-001#R-001");

    const failure = {
      code: "executor_failed" as const,
      message: "Remote executor failed.",
      retryable: true
    };
    const failed = await port.fail({
      ref: "T-001#R-001",
      ...reviewIdentity,
      failure
    });
    expect(failed.retryDecision).toBe("manual_retry_required");

    const afterFail = await readState(init.workspace.stateFile);
    expect(afterFail.currentReviewBlockRef).toBeNull();
    expect(afterFail.currentRefs).not.toContain("T-001#R-001");
    expect(afterFail.blocks["T-001#R-001"]).toMatchObject({
      status: "blocked",
      blockedReason: "[executor_failed] Remote executor failed.",
      remoteOperationReceipt: { outcome: "failed", ...reviewIdentity, failure }
    });
    expect(afterFail.blocks["T-001#R-001"]).not.toHaveProperty("remoteOwnership");

    await unblockBlock({
      projectRoot: init.workspace,
      ref: "T-001#R-001",
      reason: "Operator approved a new review operation generation."
    });
    const afterUnblock = await readState(init.workspace.stateFile);
    expect(afterUnblock.blocks["T-001#R-001"]).toMatchObject({ status: "ready" });
    expect(afterUnblock.blocks["T-001#R-001"]).not.toHaveProperty("remoteOperationReceipt");

    const reclaimCandidate = await port.inspect({ ref: "T-001#R-001" });
    const reclaimIdentity = {
      operationId: "operation-review-reclaim",
      controlPlane: "collaboration" as const,
      sourceRevision: reclaimCandidate.sourceRevision,
      graphFingerprint: reclaimCandidate.graphFingerprint,
      dispatchId: "dispatch-review-reclaim",
      executionAttemptId: "attempt-review-reclaim"
    };
    await port.claim({
      ref: "T-001#R-001",
      ...claimIdentity(reclaimIdentity)
    });
    await port.activate({ ref: "T-001#R-001", ...reclaimIdentity });
    const afterReclaim = await readState(init.workspace.stateFile);
    expect(afterReclaim.blocks["T-001#R-001"]).toMatchObject({
      status: "in_progress",
      remoteOwnership: reclaimIdentity
    });
    expect(afterReclaim.currentReviewBlockRef).toBe("T-001#R-001");
  });

  it("clears currentRefs and currentReviewBlockRef when a remote review is interrupted", async () => {
    const { init, port, identity } = await activateReadyBlock();
    await port.complete({
      ref: "T-001#B-001",
      ...identity,
      ...reportInput(Buffer.from("# Implementation complete\n"))
    });

    const reviewCandidate = await port.inspect({ ref: "T-001#R-001" });
    const reviewIdentity = {
      operationId: "operation-review-interrupt",
      controlPlane: "collaboration" as const,
      sourceRevision: reviewCandidate.sourceRevision,
      graphFingerprint: reviewCandidate.graphFingerprint,
      dispatchId: "dispatch-review-interrupt",
      executionAttemptId: "attempt-review-interrupt"
    };
    await port.claim({
      ref: "T-001#R-001",
      ...claimIdentity(reviewIdentity)
    });
    await port.activate({ ref: "T-001#R-001", ...reviewIdentity });
    expect((await readState(init.workspace.stateFile)).currentReviewBlockRef).toBe("T-001#R-001");

    await port.markInterrupted({
      ref: "T-001#R-001",
      ...reviewIdentity,
      interruption: { reason: "transport_lost", resumable: true }
    });

    const afterInterrupt = await readState(init.workspace.stateFile);
    expect(afterInterrupt.currentReviewBlockRef).toBeNull();
    expect(afterInterrupt.currentRefs).not.toContain("T-001#R-001");
    expect(afterInterrupt.blocks["T-001#R-001"]).toMatchObject({
      status: "diverged",
      remoteInterruption: { reason: "transport_lost", resumable: true }
    });
  });

  it("clears current pointers when reconcile records remote source drift", async () => {
    const { init, port, identity } = await activateReadyBlock();
    await port.complete({
      ref: "T-001#B-001",
      ...identity,
      ...reportInput(Buffer.from("# Implementation complete\n"))
    });

    const reviewCandidate = await port.inspect({ ref: "T-001#R-001" });
    const reviewIdentity = {
      operationId: "operation-review-drift",
      controlPlane: "collaboration" as const,
      sourceRevision: reviewCandidate.sourceRevision,
      graphFingerprint: reviewCandidate.graphFingerprint,
      dispatchId: "dispatch-review-drift",
      executionAttemptId: "attempt-review-drift"
    };
    await port.claim({
      ref: "T-001#R-001",
      ...claimIdentity(reviewIdentity)
    });
    await port.activate({ ref: "T-001#R-001", ...reviewIdentity });
    expect((await readState(init.workspace.stateFile)).currentReviewBlockRef).toBe("T-001#R-001");

    await appendFile(
      join(init.workspace.packageDir, "nodes/T-001/blocks/R-001.prompt.md"),
      "\nchanged while remote review was active\n",
      "utf8"
    );

    const drifted = await port.reconcile({
      ref: "T-001#R-001",
      operationId: reviewIdentity.operationId
    });
    expect(drifted).toMatchObject({ status: "diverged" });

    const afterDrift = await readState(init.workspace.stateFile);
    expect(afterDrift.currentReviewBlockRef).toBeNull();
    expect(afterDrift.currentRefs).not.toContain("T-001#R-001");
  });
});
