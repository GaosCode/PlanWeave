import type {
  BlockType,
  ClaimHint,
  ClaimResult,
  ClaimScope,
  CompiledExecutionGraph,
  FeedbackEnvelopeState,
  PlanPackageManifest,
  RuntimeState,
  ValidationIssue
} from "../types.js";
import type { ProjectGraphClaimGuard } from "./projectGraphClaimGuard.js";
import { buildClaimHints } from "./claimHints.js";
import {
  blockMatchesClaimFilter,
  blockReadyWithoutProjectBlockers,
  currentClaimLockReason,
  noProjectGraphBlockers,
  projectBlockerReason,
  reviewMaxCycleWarnings
} from "./claimReadinessRules.js";
import {
  blockDependenciesCompleted,
  blockInScope,
  claimResultForBlock,
  activeOpenFeedback,
  feedbackInScope,
  normalizeClaimScope,
  taskDependenciesSatisfied,
  validateClaimScope
} from "./selectors.js";

export type ClaimCandidate = {
  ref: string;
  result: Extract<ClaimResult, { kind: "block" }>;
};

export type ClaimReadiness = {
  scope: ClaimScope;
  invalidScope: ClaimResult | null;
  claimOrder: ClaimOrder;
  defaultClaimLockReason: string | null;
  claimHints: ClaimHint[];
  nextClaimable: string[];
  nextParallelClaimable: string[];
  nextSequentialClaimable: string[];
  nextParallelDispatchable: string[];
  scopedNextSequentialClaimable: string[];
  sequentialImplementationCandidates: ClaimCandidate[];
  sequentialReviewCandidates: ClaimCandidate[];
  parallelBatchRefs: string[];
  firstProjectBlockedResult: Extract<ClaimResult, { kind: "blocked" }> | null;
  firstBlockedResult: Extract<ClaimResult, { kind: "blocked" }> | null;
  warnings: ValidationIssue[];
};

export type ClaimOrder =
  | { kind: "blocked"; result: Extract<ClaimResult, { kind: "blocked" }> | Extract<ClaimResult, { kind: "none" }> }
  | {
      kind: "feedback";
      feedbackId: string;
      feedback: FeedbackEnvelopeState;
      taskId: string;
      result: Extract<ClaimResult, { kind: "feedback" }>;
    }
  | {
      kind: "currentReview";
      ref: string;
      reason: "current" | "feedback_resolved";
      clearCurrentFeedback: boolean;
      result: Extract<ClaimResult, { kind: "block" }>;
    }
  | { kind: "currentBlock"; ref: string; result: Extract<ClaimResult, { kind: "block" }> }
  | { kind: "ready" };

export type BuildClaimReadinessInput = {
  graph: CompiledExecutionGraph;
  manifest: PlanPackageManifest;
  state: RuntimeState;
  scope?: ClaimScope;
  blockType?: BlockType;
  projectGuard?: ProjectGraphClaimGuard;
};

function claimCandidate(ref: string, graph: CompiledExecutionGraph, reason: "claimed" | "current" | "feedback_resolved"): ClaimCandidate {
  const result = claimResultForBlock(ref, graph, reason);
  if (result.kind !== "block") {
    throw new Error(`Claim '${ref}' did not produce a block result.`);
  }
  return { ref, result };
}

function selectedParallelBatchRefs(
  graph: CompiledExecutionGraph,
  manifest: PlanPackageManifest,
  state: RuntimeState,
  scope: ClaimScope,
  blockType: BlockType | undefined,
  projectGuard: ProjectGraphClaimGuard
): string[] {
  const selected: string[] = [];
  for (const ref of graph.blockRefsInManifestOrder) {
    const taskId = graph.blockTaskByRef.get(ref);
    const block = graph.blocksByRef.get(ref);
    if (!blockMatchesClaimFilter(ref, graph, scope, blockType) || !taskId || !block || block.type === "review") {
      continue;
    }
    if (selected.length >= manifest.execution.parallel.maxConcurrent) {
      break;
    }
    if (!taskDependenciesSatisfied(graph, state, taskId) || projectBlockerReason(projectGuard, taskId) || !blockDependenciesCompleted(graph, state, ref)) {
      continue;
    }
    if (!graph.parallelSafeByBlockRef.get(ref) || state.blocks[ref]?.status !== "ready") {
      continue;
    }
    const locks = new Set(graph.locksByBlockRef.get(ref) ?? []);
    const conflicts = selected.some((selectedRef) => {
      const selectedTaskId = graph.blockTaskByRef.get(selectedRef);
      if (selectedTaskId && (graph.taskReachable(taskId, selectedTaskId) || graph.taskReachable(selectedTaskId, taskId))) {
        return true;
      }
      return (graph.locksByBlockRef.get(selectedRef) ?? []).some((lock) => locks.has(lock));
    });
    if (!conflicts) {
      selected.push(ref);
    }
  }
  return selected;
}

function firstProjectBlockedResult(
  graph: CompiledExecutionGraph,
  state: RuntimeState,
  scope: ClaimScope,
  blockType: BlockType | undefined,
  projectGuard: ProjectGraphClaimGuard
): Extract<ClaimResult, { kind: "blocked" }> | null {
  const ref = graph.blockRefsInManifestOrder.find((candidate) => {
    if (!blockMatchesClaimFilter(candidate, graph, scope, blockType) || !blockReadyWithoutProjectBlockers(graph, state, candidate)) {
      return false;
    }
    return Boolean(projectBlockerReason(projectGuard, graph.blockTaskByRef.get(candidate)));
  });
  return ref
    ? {
        kind: "blocked",
        ref,
        reason: projectBlockerReason(projectGuard, graph.blockTaskByRef.get(ref)) ?? "Project graph blockers are not complete."
      }
    : null;
}

function firstBlockedResult(
  graph: CompiledExecutionGraph,
  state: RuntimeState,
  scope: ClaimScope
): Extract<ClaimResult, { kind: "blocked" }> | null {
  const ref = graph.blockRefsInManifestOrder.find((candidate) => blockInScope(candidate, graph, scope) && state.blocks[candidate]?.status === "blocked");
  return ref ? { kind: "blocked", ref, reason: state.blocks[ref]?.blockedReason ?? `Block '${ref}' is blocked.` } : null;
}

function blockedByClaimType(ref: string, reason: string): ClaimOrder {
  return { kind: "blocked", result: { kind: "blocked", ref, reason } };
}

function buildClaimOrder(input: {
  graph: CompiledExecutionGraph;
  state: RuntimeState;
  scope: ClaimScope;
  blockType?: BlockType;
  projectGuard: ProjectGraphClaimGuard;
}): ClaimOrder {
  const openFeedback = activeOpenFeedback(input.state);
  if (openFeedback.length > 1) {
    return { kind: "blocked", result: { kind: "blocked", reason: "Multiple open feedback envelopes exist; resolve or dismiss one before continuing." } };
  }
  if (openFeedback.length === 1) {
    const [feedbackId, feedback] = openFeedback[0];
    if (!feedbackInScope(feedback, input.graph, input.scope)) {
      return { kind: "blocked", result: { kind: "none", reason: "no_claimable_blocks_in_scope" } };
    }
    const taskId = input.graph.blockTaskByRef.get(feedback.sourceReviewBlockRef);
    if (!taskId) {
      throw new Error(`Feedback '${feedbackId}' points to an unknown review block.`);
    }
    const projectBlocker = projectBlockerReason(input.projectGuard, taskId);
    if (projectBlocker) {
      return { kind: "blocked", result: { kind: "blocked", ref: feedback.sourceReviewBlockRef, reason: projectBlocker } };
    }
    return {
      kind: "feedback",
      feedbackId,
      feedback,
      taskId,
      result: { kind: "feedback", feedbackId, sourceReviewBlockRef: feedback.sourceReviewBlockRef, taskId, content: feedback.content }
    };
  }

  const inProgressReview = input.graph.blockRefsInManifestOrder.find((ref) => {
    const block = input.graph.blocksByRef.get(ref);
    return block?.type === "review" && input.state.blocks[ref]?.status === "in_progress";
  });
  if (inProgressReview && input.state.currentFeedbackId) {
    if (input.blockType && input.blockType !== "review") {
      return blockedByClaimType(inProgressReview, "A review block is in progress outside the selected claim type.");
    }
    const currentFeedback = input.state.feedback[input.state.currentFeedbackId];
    if (currentFeedback?.status === "resolved") {
      if (!blockInScope(inProgressReview, input.graph, input.scope)) {
        return { kind: "blocked", result: { kind: "blocked", ref: inProgressReview, reason: "A review block is in progress outside the selected Auto Run scope." } };
      }
      return {
        kind: "currentReview",
        ref: inProgressReview,
        reason: "feedback_resolved",
        clearCurrentFeedback: true,
        result: claimCandidate(inProgressReview, input.graph, "feedback_resolved").result
      };
    }
  }
  if (inProgressReview) {
    if (input.blockType && input.blockType !== "review") {
      return blockedByClaimType(inProgressReview, "A review block is in progress outside the selected claim type.");
    }
    if (!blockInScope(inProgressReview, input.graph, input.scope)) {
      return { kind: "blocked", result: { kind: "blocked", ref: inProgressReview, reason: "A review block is in progress outside the selected Auto Run scope." } };
    }
    const reason = input.state.blocks[inProgressReview]?.pendingFeedbackId ? "feedback_resolved" : "current";
    return {
      kind: "currentReview",
      ref: inProgressReview,
      reason,
      clearCurrentFeedback: false,
      result: claimCandidate(inProgressReview, input.graph, reason).result
    };
  }

  const current = input.graph.blockRefsInManifestOrder.find((ref) => {
    const block = input.graph.blocksByRef.get(ref);
    return input.state.blocks[ref]?.status === "in_progress" && block?.type !== "review";
  });
  if (current) {
    const currentBlock = input.graph.blocksByRef.get(current);
    if (input.blockType && currentBlock?.type !== input.blockType) {
      return blockedByClaimType(current, "A block is in progress outside the selected claim type.");
    }
    if (!blockInScope(current, input.graph, input.scope)) {
      return { kind: "blocked", result: { kind: "blocked", ref: current, reason: "A block is in progress outside the selected Auto Run scope." } };
    }
    return { kind: "currentBlock", ref: current, result: claimCandidate(current, input.graph, "current").result };
  }

  return { kind: "ready" };
}

export function buildClaimReadiness(input: BuildClaimReadinessInput): ClaimReadiness {
  const scope = normalizeClaimScope(input.scope);
  const projectGuard = input.projectGuard ?? noProjectGraphBlockers;
  const invalidScope = validateClaimScope(scope, input.graph);
  const defaultClaimLockReason = currentClaimLockReason(input.graph, input.state);
  const claimHints = buildClaimHints(input.graph, input.state, projectGuard, defaultClaimLockReason);
  const scopedReadyRefs = input.graph.blockRefsInManifestOrder.filter(
    (ref) =>
      blockMatchesClaimFilter(ref, input.graph, scope, input.blockType) &&
      blockReadyWithoutProjectBlockers(input.graph, input.state, ref) &&
      !projectBlockerReason(projectGuard, input.graph.blockTaskByRef.get(ref))
  );
  const sequentialImplementationCandidates = scopedReadyRefs
    .filter((ref) => input.graph.blocksByRef.get(ref)?.type !== "review")
    .map((ref) => claimCandidate(ref, input.graph, "claimed"));
  const sequentialReviewCandidates = scopedReadyRefs
    .filter((ref) => input.graph.blocksByRef.get(ref)?.type === "review")
    .map((ref) => claimCandidate(ref, input.graph, "claimed"));
  const nextClaimable = claimHints.filter((hint) => hint.ready).map((hint) => hint.ref);
  const nextParallelClaimable = claimHints.filter((hint) => hint.ready && hint.parallelSafe).map((hint) => hint.ref);
  const nextSequentialClaimable = claimHints.filter((hint) => hint.ready && !hint.parallelSafe).map((hint) => hint.ref);
  const nextParallelDispatchable = claimHints.filter((hint) => hint.dispatchable).map((hint) => hint.ref);
  const scopedNextSequentialClaimable = scopedReadyRefs.filter((ref) => {
    const block = input.graph.blocksByRef.get(ref);
    return block?.type === "review" || !input.graph.parallelSafeByBlockRef.get(ref);
  });

  return {
    scope,
    invalidScope,
    claimOrder: buildClaimOrder({ graph: input.graph, state: input.state, scope, blockType: input.blockType, projectGuard }),
    defaultClaimLockReason,
    claimHints,
    nextClaimable,
    nextParallelClaimable,
    nextSequentialClaimable,
    nextParallelDispatchable,
    scopedNextSequentialClaimable,
    sequentialImplementationCandidates,
    sequentialReviewCandidates,
    parallelBatchRefs: selectedParallelBatchRefs(input.graph, input.manifest, input.state, scope, input.blockType, projectGuard),
    firstProjectBlockedResult: firstProjectBlockedResult(input.graph, input.state, scope, input.blockType, projectGuard),
    firstBlockedResult: firstBlockedResult(input.graph, input.state, scope),
    warnings: reviewMaxCycleWarnings(input.graph, input.state)
  };
}
