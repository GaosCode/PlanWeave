import type { BlockState, BlockStatus, CompiledExecutionGraph, FeedbackEnvelopeState, FeedbackStatus, PlanPackageManifest, RuntimeState } from "../types.js";
import { refreshDerivedState } from "./runtimeContext.js";
import { blockDependenciesCompleted, getBlock } from "./selectors.js";

type ClonedState = RuntimeState;

function cloneState(state: RuntimeState): ClonedState {
  return structuredClone(state);
}

function setBlock(state: ClonedState, ref: string, patch: Partial<BlockState>): void {
  state.blocks[ref] = { ...state.blocks[ref], ...patch };
}

function setFeedback(state: ClonedState, feedbackId: string, patch: Partial<FeedbackEnvelopeState>): void {
  state.feedback[feedbackId] = { ...state.feedback[feedbackId], ...patch };
}

function withoutRef(currentRefs: string[], ref: string): string[] {
  return currentRefs.filter((r) => r !== ref);
}

function withRef(currentRefs: string[], ref: string): string[] {
  return currentRefs.includes(ref) ? currentRefs : [...currentRefs, ref];
}

export function transitionClaimSequential(
  state: RuntimeState,
  manifest: PlanPackageManifest,
  graph: CompiledExecutionGraph,
  ref: string
): RuntimeState {
  const next = cloneState(state);
  setBlock(next, ref, { status: "in_progress" });
  next.currentRefs = [ref];
  const block = graph.blocksByRef.get(ref);
  if (block?.type === "review") {
    next.currentReviewBlockRef = ref;
  }
  return refreshDerivedState(manifest, next);
}

export function transitionClaimParallel(
  state: RuntimeState,
  manifest: PlanPackageManifest,
  graph: CompiledExecutionGraph,
  refs: string[]
): RuntimeState {
  const next = cloneState(state);
  for (const ref of refs) {
    setBlock(next, ref, { status: "in_progress" });
  }
  next.currentRefs = refs;
  return refreshDerivedState(manifest, next);
}

export function transitionClaimFeedback(
  state: RuntimeState,
  manifest: PlanPackageManifest,
  feedbackId: string,
  sourceReviewBlockRef: string
): RuntimeState {
  const next = cloneState(state);
  setFeedback(next, feedbackId, { status: "in_progress" });
  next.currentFeedbackId = feedbackId;
  next.currentReviewBlockRef = sourceReviewBlockRef;
  next.currentRefs = withoutRef(next.currentRefs, sourceReviewBlockRef);
  return refreshDerivedState(manifest, next);
}

export function transitionClaimCurrentReview(
  state: RuntimeState,
  manifest: PlanPackageManifest,
  ref: string,
  options: { clearCurrentFeedback?: boolean } = {}
): RuntimeState {
  const next = cloneState(state);
  setBlock(next, ref, { pendingFeedbackId: null });
  next.currentRefs = withRef(next.currentRefs, ref);
  if (options.clearCurrentFeedback) {
    next.currentFeedbackId = null;
  }
  next.currentReviewBlockRef = ref;
  return refreshDerivedState(manifest, next);
}

export function transitionSubmitBlockResult(
  state: RuntimeState,
  manifest: PlanPackageManifest,
  ref: string,
  runId: string
): RuntimeState {
  const next = cloneState(state);
  setBlock(next, ref, { status: "completed", lastRunId: runId });
  next.currentRefs = withoutRef(next.currentRefs, ref);
  return refreshDerivedState(manifest, next);
}

export function transitionReviewPassed(
  state: RuntimeState,
  manifest: PlanPackageManifest,
  ref: string,
  attemptId: string,
  workRevision: string
): RuntimeState {
  const next = cloneState(state);
  setBlock(next, ref, {
    status: "completed",
    latestReviewAttemptId: attemptId,
    activeFeedbackId: null,
    pendingFeedbackId: null,
    completionReason: "passed",
    passedWorkRevision: workRevision
  });
  next.currentReviewBlockRef = next.currentReviewBlockRef === ref ? null : next.currentReviewBlockRef;
  next.currentRefs = withoutRef(next.currentRefs, ref);
  return refreshDerivedState(manifest, next);
}

export function transitionReviewNeedsChangesWithFeedback(
  state: RuntimeState,
  manifest: PlanPackageManifest,
  reviewBlockRef: string,
  attemptId: string,
  feedbackId: string,
  feedbackStatus: FeedbackStatus,
  feedbackContent: string
): RuntimeState {
  const next = cloneState(state);
  const isActive = feedbackStatus === "open" || feedbackStatus === "in_progress";
  const isResolved = feedbackStatus === "resolved";
  setBlock(next, reviewBlockRef, {
    status: "in_progress",
    latestReviewAttemptId: attemptId,
    activeFeedbackId: isActive ? feedbackId : null,
    pendingFeedbackId: isResolved ? feedbackId : null,
    completionReason: null
  });
  next.feedback[feedbackId] = {
    status: feedbackStatus,
    sourceReviewBlockRef: reviewBlockRef,
    latestSubmissionId: null,
    content: feedbackContent
  };
  next.currentReviewBlockRef = reviewBlockRef;
  if (isActive) {
    next.currentFeedbackId = feedbackId;
    next.currentRefs = withoutRef(next.currentRefs, reviewBlockRef);
  } else {
    next.currentRefs = withRef(next.currentRefs, reviewBlockRef);
  }
  return refreshDerivedState(manifest, next);
}

export function transitionReviewNeedsChangesNewFeedback(
  state: RuntimeState,
  manifest: PlanPackageManifest,
  reviewBlockRef: string,
  attemptId: string,
  feedbackId: string,
  feedbackContent: string
): RuntimeState {
  const next = cloneState(state);
  setBlock(next, reviewBlockRef, {
    status: "in_progress",
    latestReviewAttemptId: attemptId,
    activeFeedbackId: feedbackId,
    pendingFeedbackId: null
  });
  next.feedback[feedbackId] = {
    status: "open",
    sourceReviewBlockRef: reviewBlockRef,
    latestSubmissionId: null,
    content: feedbackContent
  };
  next.currentFeedbackId = feedbackId;
  next.currentReviewBlockRef = reviewBlockRef;
  next.currentRefs = withoutRef(next.currentRefs, reviewBlockRef);
  return refreshDerivedState(manifest, next);
}

export function transitionReviewMaxCycles(
  state: RuntimeState,
  manifest: PlanPackageManifest,
  ref: string,
  attemptId: string
): RuntimeState {
  const next = cloneState(state);
  setBlock(next, ref, {
    status: "completed",
    latestReviewAttemptId: attemptId,
    activeFeedbackId: null,
    pendingFeedbackId: null,
    blockedReason: null,
    completionReason: "max_cycles_reached"
  });
  next.currentReviewBlockRef = next.currentReviewBlockRef === ref ? null : next.currentReviewBlockRef;
  next.currentRefs = withoutRef(next.currentRefs, ref);
  return refreshDerivedState(manifest, next);
}

export function transitionReviewHookFailure(
  state: RuntimeState,
  manifest: PlanPackageManifest,
  ref: string,
  attemptId: string,
  blockedReason: string
): RuntimeState {
  const next = cloneState(state);
  setBlock(next, ref, {
    status: "blocked",
    latestReviewAttemptId: attemptId,
    activeFeedbackId: null,
    pendingFeedbackId: null,
    blockedReason
  });
  next.currentRefs = withoutRef(next.currentRefs, ref);
  return refreshDerivedState(manifest, next);
}

export function transitionSubmitFeedback(
  state: RuntimeState,
  manifest: PlanPackageManifest,
  feedbackId: string,
  submissionId: string,
  sourceReviewBlockRef: string
): RuntimeState {
  const next = cloneState(state);
  const feedback = next.feedback[feedbackId];
  if (!feedback) {
    throw new Error(`Feedback '${feedbackId}' does not exist.`);
  }
  next.feedback[feedbackId] = {
    ...feedback,
    status: "resolved" as FeedbackStatus,
    latestSubmissionId: submissionId
  };
  setBlock(next, sourceReviewBlockRef, {
    status: "in_progress",
    activeFeedbackId: null,
    pendingFeedbackId: feedbackId
  });
  next.currentFeedbackId = null;
  next.currentReviewBlockRef = sourceReviewBlockRef;
  next.currentRefs = withRef(next.currentRefs, sourceReviewBlockRef);
  return refreshDerivedState(manifest, next);
}

function resolveBlockStatus(graph: CompiledExecutionGraph, state: RuntimeState, ref: string): BlockStatus {
  return blockDependenciesCompleted(graph, state, ref) ? "ready" : "planned";
}

export function transitionBlockBlocked(
  state: RuntimeState,
  manifest: PlanPackageManifest,
  graph: CompiledExecutionGraph,
  ref: string,
  reason: string
): RuntimeState {
  const next = cloneState(state);
  setBlock(next, ref, { status: "blocked", blockedReason: reason });
  next.currentRefs = withoutRef(next.currentRefs, ref);
  return refreshDerivedState(manifest, next);
}

export function transitionBlockDiverged(
  state: RuntimeState,
  manifest: PlanPackageManifest,
  graph: CompiledExecutionGraph,
  ref: string,
  reason: string
): RuntimeState {
  const next = cloneState(state);
  const block = graph.blocksByRef.get(ref);
  const patch: Partial<BlockState> = {
    status: "diverged",
    divergenceReason: reason
  };
  if (block?.type === "review") {
    patch.activeFeedbackId = null;
    patch.pendingFeedbackId = null;
    patch.completionReason = null;
    patch.passedWorkRevision = null;
  }
  setBlock(next, ref, patch);
  next.currentRefs = withoutRef(next.currentRefs, ref);
  return refreshDerivedState(manifest, next);
}

export function transitionUnblock(
  state: RuntimeState,
  manifest: PlanPackageManifest,
  graph: CompiledExecutionGraph,
  ref: string
): RuntimeState {
  const next = cloneState(state);
  const newStatus = resolveBlockStatus(graph, next, ref);
  setBlock(next, ref, { status: newStatus, blockedReason: null });
  return refreshDerivedState(manifest, next);
}

export function transitionResolveDivergence(
  state: RuntimeState,
  manifest: PlanPackageManifest,
  graph: CompiledExecutionGraph,
  ref: string
): RuntimeState {
  const next = cloneState(state);
  const block = graph.blocksByRef.get(ref);
  const newStatus = resolveBlockStatus(graph, next, ref);
  const patch: Partial<BlockState> = {
    status: newStatus,
    divergenceReason: null
  };
  if (block?.type === "review") {
    patch.activeFeedbackId = null;
    patch.pendingFeedbackId = null;
    patch.completionReason = null;
    patch.passedWorkRevision = null;
  }
  setBlock(next, ref, patch);
  return refreshDerivedState(manifest, next);
}
