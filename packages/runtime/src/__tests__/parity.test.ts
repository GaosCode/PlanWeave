import { describe, expect, it } from "vitest";
import {
  claimNext,
  markBlockBlocked,
  markBlockDiverged,
  resolveBlockDivergence,
  submitBlockResult,
  submitFeedback,
  submitReviewResult,
  unblockBlock
} from "../taskManager/index.js";
import { readState } from "../state.js";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { ensureStateForManifest } from "../state.js";
import type { PlanPackageManifest, RuntimeState } from "../types.js";
import {
  transitionClaimSequential,
  transitionClaimParallel,
  transitionSubmitBlockResult as domainSubmitBlockResult,
  transitionReviewPassed,
  transitionReviewNeedsChangesNewFeedback,
  transitionReviewMaxCycles,
  transitionSubmitFeedback as domainSubmitFeedback,
  transitionBlockBlocked,
  transitionBlockDiverged,
  transitionUnblock,
  transitionResolveDivergence
} from "../taskManager/domainTransitions.js";
import { basicManifest, createTestWorkspace, writeReport, writeReviewResult } from "./promptTestHelpers.js";

function equivalentStates(left: RuntimeState, right: RuntimeState, description: string): void {
  const leftRefs = [...left.currentRefs].sort();
  const rightRefs = [...right.currentRefs].sort();
  expect(leftRefs, `${description}: currentRefs mismatch`).toEqual(rightRefs);
  expect(left.currentFeedbackId, `${description}: currentFeedbackId mismatch`).toBe(right.currentFeedbackId);
  expect(left.currentReviewBlockRef, `${description}: currentReviewBlockRef mismatch`).toBe(right.currentReviewBlockRef);
  for (const ref of Object.keys({ ...left.blocks, ...right.blocks })) {
    const leftBlock = left.blocks[ref];
    const rightBlock = right.blocks[ref];
    expect(leftBlock?.status ?? null, `${description}: block ${ref} status`).toBe(rightBlock?.status ?? null);
    expect(leftBlock?.lastRunId ?? null, `${description}: block ${ref} lastRunId`).toBe(rightBlock?.lastRunId ?? null);
    expect(leftBlock?.blockedReason ?? null, `${description}: block ${ref} blockedReason`).toBe(rightBlock?.blockedReason ?? null);
    expect(leftBlock?.divergenceReason ?? null, `${description}: block ${ref} divergenceReason`).toBe(rightBlock?.divergenceReason ?? null);
    expect(leftBlock?.completionReason ?? null, `${description}: block ${ref} completionReason`).toBe(rightBlock?.completionReason ?? null);
    expect(leftBlock?.activeFeedbackId ?? null, `${description}: block ${ref} activeFeedbackId`).toBe(rightBlock?.activeFeedbackId ?? null);
    expect(leftBlock?.pendingFeedbackId ?? null, `${description}: block ${ref} pendingFeedbackId`).toBe(rightBlock?.pendingFeedbackId ?? null);
  }
  for (const feedbackId of Object.keys({ ...left.feedback, ...right.feedback })) {
    const leftFb = left.feedback[feedbackId];
    const rightFb = right.feedback[feedbackId];
    expect(leftFb?.status ?? null, `${description}: feedback ${feedbackId} status`).toBe(rightFb?.status ?? null);
    expect(leftFb?.sourceReviewBlockRef ?? null, `${description}: feedback ${feedbackId} sourceReviewBlockRef`).toBe(rightFb?.sourceReviewBlockRef ?? null);
  }
}

function initialDomainState(manifest: ReturnType<typeof basicManifest>): RuntimeState {
  return ensureStateForManifest(manifest, {
    currentRefs: [],
    currentFeedbackId: null,
    currentReviewBlockRef: null,
    tasks: {},
    blocks: {},
    feedback: {}
  });
}

async function readFileState(stateFile: string, manifest: PlanPackageManifest): Promise<RuntimeState> {
  const raw = await readState(stateFile);
  return ensureStateForManifest(manifest, raw);
}

describe("runtime parity", () => {
  describe("claim", () => {
    it("file-backed vs domain transition produce the same state after sequential claim", async () => {
      const manifest = basicManifest();
      const { root, init } = await createTestWorkspace(manifest);

      const claimResult = await claimNext({ projectRoot: root });
      expect(claimResult.kind).toBe("block");

      const fileState = await readFileState(init.workspace.stateFile, manifest);
      const domainState = transitionClaimSequential(
        initialDomainState(manifest),
        manifest,
        compileTaskGraph(manifest),
        "T-001#B-001"
      );
      equivalentStates(fileState, domainState, "sequential claim");
    });

    it("file-backed vs domain transition produce the same state after parallel claim", async () => {
      const manifest = basicManifest({ parallel: true, maxConcurrent: 2, includeSecondTask: true });
      const { root, init } = await createTestWorkspace(manifest);

      const claimResult = await claimNext({ projectRoot: root, parallel: true });
      expect(claimResult.kind).toBe("batch");
      if (claimResult.kind !== "batch") throw new Error("expected batch");

      const fileState = await readFileState(init.workspace.stateFile, manifest);
      const domainState = transitionClaimParallel(
        initialDomainState(manifest),
        manifest,
        compileTaskGraph(manifest),
        claimResult.refs
      );
      equivalentStates(fileState, domainState, "parallel claim");
    });
  });

  describe("submit", () => {
    it("file-backed and domain transition produce equivalent state after submit", async () => {
      const manifest = basicManifest();
      const { root, init } = await createTestWorkspace(manifest);

      const claimResult = await claimNext({ projectRoot: root });
      expect(claimResult.kind).toBe("block");
      const submitResult = await submitBlockResult({
        projectRoot: root,
        ref: "T-001#B-001",
        reportPath: await writeReport(root, "report.md")
      });
      expect(submitResult.status).toBe("completed");

      const fileState = await readFileState(init.workspace.stateFile, manifest);
      const graph = compileTaskGraph(manifest);
      const claimedDomain = transitionClaimSequential(
        initialDomainState(manifest),
        manifest,
        graph,
        "T-001#B-001"
      );
      const domainState = domainSubmitBlockResult(
        claimedDomain,
        manifest,
        "T-001#B-001",
        submitResult.runId
      );
      equivalentStates(fileState, domainState, "submit");
    });
  });

  describe("review feedback", () => {
    it("file-backed and domain transition produce equivalent state after review needs_changes + feedback", async () => {
      const manifest = basicManifest();
      const { root, init } = await createTestWorkspace(manifest);

      await claimNext({ projectRoot: root });
      await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "b.md") });
      await claimNext({ projectRoot: root });
      const reviewResult = await submitReviewResult({
        projectRoot: root,
        ref: "T-001#R-001",
        resultPath: await writeReviewResult(root, "needs_changes", "Please update tests.")
      });
      expect(reviewResult.verdict).toBe("needs_changes");
      expect(reviewResult.feedbackCreated).toBe(true);
      expect(reviewResult.feedbackId).toBeTruthy();

      const fileState = await readFileState(init.workspace.stateFile, manifest);
      const graph = compileTaskGraph(manifest);
      const claimed = transitionClaimSequential(initialDomainState(manifest), manifest, graph, "T-001#B-001");
      const submitted = domainSubmitBlockResult(claimed, manifest, "T-001#B-001", "RUN-001");
      const reviewed = transitionReviewNeedsChangesNewFeedback(
        submitted, manifest, "T-001#R-001", "REV-001",
        reviewResult.feedbackId!, "Please update tests."
      );
      equivalentStates(fileState, reviewed, "review feedback");
    });

    it("file-backed and domain transition produce equivalent state after feedback submission", async () => {
      const manifest = basicManifest();
      const { root, init } = await createTestWorkspace(manifest);

      await claimNext({ projectRoot: root });
      await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "b.md") });
      await claimNext({ projectRoot: root });
      const reviewResult = await submitReviewResult({
        projectRoot: root,
        ref: "T-001#R-001",
        resultPath: await writeReviewResult(root, "needs_changes", "Please update tests.")
      });
      const feedbackResult = await submitFeedback({ projectRoot: root, reportPath: await writeReport(root, "feedback.md", "Fixed.") });
      expect(feedbackResult.status).toBe("accepted");

      const fileState = await readFileState(init.workspace.stateFile, manifest);
      const graph = compileTaskGraph(manifest);
      const claimed = transitionClaimSequential(initialDomainState(manifest), manifest, graph, "T-001#B-001");
      const submitted = domainSubmitBlockResult(claimed, manifest, "T-001#B-001", "RUN-001");
      const reviewed = transitionReviewNeedsChangesNewFeedback(
        submitted, manifest, "T-001#R-001", "REV-001",
        reviewResult.feedbackId!, "Please update tests."
      );
      const feedbacked = domainSubmitFeedback(
        reviewed, manifest, reviewResult.feedbackId!, feedbackResult.submissionId, "T-001#R-001"
      );
      equivalentStates(fileState, feedbacked, "feedback submitted");
    });

    it("file-backed and domain transition produce equivalent state after review passed", async () => {
      const manifest = basicManifest();
      const { root, init } = await createTestWorkspace(manifest);

      await claimNext({ projectRoot: root });
      await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "b.md") });
      await claimNext({ projectRoot: root });
      const reviewResult = await submitReviewResult({
        projectRoot: root,
        ref: "T-001#R-001",
        resultPath: await writeReviewResult(root, "passed", "Looks good.")
      });
      expect(reviewResult.verdict).toBe("passed");

      const fileState = await readFileState(init.workspace.stateFile, manifest);
      const graph = compileTaskGraph(manifest);
      const claimed = transitionClaimSequential(initialDomainState(manifest), manifest, graph, "T-001#B-001");
      const submitted = domainSubmitBlockResult(claimed, manifest, "T-001#B-001", "RUN-001");
      const reviewed = transitionReviewPassed(
        submitted, manifest, "T-001#R-001", reviewResult.reviewAttemptId, ""
      );
      equivalentStates(fileState, reviewed, "review passed");
    });

    it("file-backed and domain transition produce equivalent state after max cycles", async () => {
      const manifest = basicManifest({ reviewMaxFeedbackCycles: 0 });
      const { root, init } = await createTestWorkspace(manifest);

      await claimNext({ projectRoot: root });
      await submitBlockResult({ projectRoot: root, ref: "T-001#B-001", reportPath: await writeReport(root, "b.md") });
      await claimNext({ projectRoot: root });
      const reviewResult = await submitReviewResult({
        projectRoot: root,
        ref: "T-001#R-001",
        resultPath: await writeReviewResult(root, "needs_changes", "Still failing.")
      });
      expect(reviewResult.completionReason).toBe("max_cycles_reached");

      const fileState = await readFileState(init.workspace.stateFile, manifest);
      const graph = compileTaskGraph(manifest);
      const claimed = transitionClaimSequential(initialDomainState(manifest), manifest, graph, "T-001#B-001");
      const submitted = domainSubmitBlockResult(claimed, manifest, "T-001#B-001", "RUN-001");
      const reviewed = transitionReviewMaxCycles(submitted, manifest, "T-001#R-001", reviewResult.reviewAttemptId);
      equivalentStates(fileState, reviewed, "max cycles");
    });
  });

  describe("block / diverge / retry", () => {
    it("file-backed and domain transition produce equivalent state after mark-block-blocked", async () => {
      const manifest = basicManifest();
      const { root, init } = await createTestWorkspace(manifest);
      await claimNext({ projectRoot: root });

      await markBlockBlocked({ projectRoot: root, ref: "T-001#B-001", reason: "waiting for input" });
      const fileState = await readFileState(init.workspace.stateFile, manifest);
      const graph = compileTaskGraph(manifest);
      const claimed = transitionClaimSequential(initialDomainState(manifest), manifest, graph, "T-001#B-001");
      const blocked = transitionBlockBlocked(claimed, manifest, graph, "T-001#B-001", "waiting for input");
      equivalentStates(fileState, blocked, "blocked");
    });

    it("file-backed and domain transition produce equivalent state after unblock", async () => {
      const manifest = basicManifest();
      const { root, init } = await createTestWorkspace(manifest);

      await markBlockBlocked({ projectRoot: root, ref: "T-001#B-001", reason: "waiting" });
      await unblockBlock({ projectRoot: root, ref: "T-001#B-001", reason: "input arrived" });

      const fileState = await readFileState(init.workspace.stateFile, manifest);
      const graph = compileTaskGraph(manifest);
      const blocked = transitionBlockBlocked(initialDomainState(manifest), manifest, graph, "T-001#B-001", "waiting");
      const unblocked = transitionUnblock(blocked, manifest, graph, "T-001#B-001");
      equivalentStates(fileState, unblocked, "unblocked");
    });

    it("file-backed and domain transition produce equivalent state after mark-block-diverged", async () => {
      const manifest = basicManifest();
      const { root, init } = await createTestWorkspace(manifest);

      await markBlockDiverged({ projectRoot: root, ref: "T-001#B-001", reason: "manifest changed" });
      const fileState = await readFileState(init.workspace.stateFile, manifest);
      const graph = compileTaskGraph(manifest);
      const diverged = transitionBlockDiverged(initialDomainState(manifest), manifest, graph, "T-001#B-001", "manifest changed");
      equivalentStates(fileState, diverged, "diverged");
    });

    it("file-backed and domain transition produce equivalent state after resolve-divergence", async () => {
      const manifest = basicManifest();
      const { root, init } = await createTestWorkspace(manifest);

      await markBlockDiverged({ projectRoot: root, ref: "T-001#B-001", reason: "manifest changed" });
      await resolveBlockDivergence({ projectRoot: root, ref: "T-001#B-001", reason: "rebased" });

      const fileState = await readFileState(init.workspace.stateFile, manifest);
      const graph = compileTaskGraph(manifest);
      const diverged = transitionBlockDiverged(initialDomainState(manifest), manifest, graph, "T-001#B-001", "manifest changed");
      const resolved = transitionResolveDivergence(diverged, manifest, graph, "T-001#B-001");
      equivalentStates(fileState, resolved, "resolve divergence");
    });
  });
});
