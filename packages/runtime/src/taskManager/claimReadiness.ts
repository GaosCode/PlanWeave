import { requireMapValue } from "../graph/requireMapValue.js";
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
  currentClaimBlockedReason,
  noProjectGraphBlockers,
  projectBlockerReason,
  reviewMaxCycleWarnings
} from "./claimReadinessRules.js";
import {
  blockInScope,
  canDispatchImplementationBlock,
  claimResultForBlock,
  activeOpenFeedback,
  effectiveFeedbackExecutor,
  feedbackInScope,
  getBlock,
  inProgressImplementationRefs,
  normalizeClaimScope,
  requireBlockState,
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
  defaultClaimBlockedReason: string | null;
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
  | {
      kind: "blocked";
      result: Extract<ClaimResult, { kind: "blocked" }> | Extract<ClaimResult, { kind: "none" }>;
    }
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

function claimCandidate(
  ref: string,
  graph: CompiledExecutionGraph,
  reason: "claimed" | "current" | "feedback_resolved",
  defaultExecutor?: string
): ClaimCandidate {
  const result = claimResultForBlock(ref, graph, reason, defaultExecutor);
  if (result.kind !== "block") {
    throw new Error(`Claim '${ref}' did not produce a block result.`);
  }
  return { ref, result };
}

/**
 * Select newly claimable implementation blocks up to remaining capacity.
 * Candidates must not conflict with in_progress current refs or with each other.
 * Order is manifest order (deterministic).
 */
function selectedParallelBatchRefs(
  graph: CompiledExecutionGraph,
  manifest: PlanPackageManifest,
  state: RuntimeState,
  scope: ClaimScope,
  blockType: BlockType | undefined,
  projectGuard: ProjectGraphClaimGuard
): string[] {
  const retained = inProgressImplementationRefs(graph, state);
  const selected: string[] = [];
  for (const ref of graph.blockRefsInManifestOrder) {
    const taskId = requireMapValue(graph.blockTaskByRef, ref, "blockTaskByRef");
    const block = getBlock(graph, ref);
    if (
      !blockMatchesClaimFilter(ref, graph, scope, blockType) ||
      block.type === "review"
    ) {
      continue;
    }
    if (retained.includes(ref) || requireBlockState(state, ref).status !== "ready") {
      continue;
    }
    if (
      projectBlockerReason(projectGuard, taskId) ||
      !canDispatchImplementationBlock(graph, state, ref, {
        maxConcurrent: manifest.execution.parallel.maxConcurrent,
        selectedRefs: selected
      })
    ) {
      continue;
    }
    selected.push(ref);
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
    if (
      !blockMatchesClaimFilter(candidate, graph, scope, blockType) ||
      !blockReadyWithoutProjectBlockers(graph, state, candidate)
    ) {
      return false;
    }
    const taskId = requireMapValue(graph.blockTaskByRef, candidate, "blockTaskByRef");
    return Boolean(projectBlockerReason(projectGuard, taskId));
  });
  if (!ref) {
    return null;
  }
  const taskId = requireMapValue(graph.blockTaskByRef, ref, "blockTaskByRef");
  return {
    kind: "blocked",
    ref,
    reason:
      projectBlockerReason(projectGuard, taskId) ?? "Project graph blockers are not complete."
  };
}

function firstBlockedResult(
  graph: CompiledExecutionGraph,
  state: RuntimeState,
  scope: ClaimScope
): Extract<ClaimResult, { kind: "blocked" }> | null {
  const ref = graph.blockRefsInManifestOrder.find(
    (candidate) =>
      blockInScope(candidate, graph, scope) &&
      requireBlockState(state, candidate).status === "blocked"
  );
  if (!ref) {
    return null;
  }
  const blockState = requireBlockState(state, ref);
  return {
    kind: "blocked",
    ref,
    reason: blockState.blockedReason ?? `Block '${ref}' is blocked.`
  };
}

function blockedByClaimType(ref: string, reason: string): ClaimOrder {
  return { kind: "blocked", result: { kind: "blocked", ref, reason } };
}

function buildClaimOrder(input: {
  graph: CompiledExecutionGraph;
  manifest: PlanPackageManifest;
  state: RuntimeState;
  scope: ClaimScope;
  blockType?: BlockType;
  projectGuard: ProjectGraphClaimGuard;
}): ClaimOrder {
  const openFeedback = activeOpenFeedback(input.state);
  if (openFeedback.length > 1) {
    return {
      kind: "blocked",
      result: {
        kind: "blocked",
        reason: "Multiple open feedback envelopes exist; resolve or dismiss one before continuing."
      }
    };
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
      return {
        kind: "blocked",
        result: { kind: "blocked", ref: feedback.sourceReviewBlockRef, reason: projectBlocker }
      };
    }
    return {
      kind: "feedback",
      feedbackId,
      feedback,
      taskId,
      result: {
        kind: "feedback",
        feedbackId,
        sourceReviewBlockRef: feedback.sourceReviewBlockRef,
        taskId,
        content: feedback.content,
        effectiveExecutor: effectiveFeedbackExecutor(
          input.graph,
          feedback.sourceReviewBlockRef,
          input.manifest.execution.defaultExecutor
        )
      }
    };
  }

  const inProgressReview = input.graph.blockRefsInManifestOrder.find((ref) => {
    const block = getBlock(input.graph, ref);
    return block.type === "review" && requireBlockState(input.state, ref).status === "in_progress";
  });
  if (inProgressReview && input.state.currentFeedbackId) {
    if (input.blockType && input.blockType !== "review") {
      return blockedByClaimType(
        inProgressReview,
        "A review block is in progress outside the selected claim type."
      );
    }
    // Feedback map lookup by id is dynamic / may be stale (public probe).
    const currentFeedback = input.state.feedback[input.state.currentFeedbackId];
    if (currentFeedback?.status === "resolved") {
      if (!blockInScope(inProgressReview, input.graph, input.scope)) {
        return {
          kind: "blocked",
          result: {
            kind: "blocked",
            ref: inProgressReview,
            reason: "A review block is in progress outside the selected Auto Run scope."
          }
        };
      }
      return {
        kind: "currentReview",
        ref: inProgressReview,
        reason: "feedback_resolved",
        clearCurrentFeedback: true,
        result: claimCandidate(
          inProgressReview,
          input.graph,
          "feedback_resolved",
          input.manifest.execution.defaultExecutor
        ).result
      };
    }
  }
  if (inProgressReview) {
    if (input.blockType && input.blockType !== "review") {
      return blockedByClaimType(
        inProgressReview,
        "A review block is in progress outside the selected claim type."
      );
    }
    if (!blockInScope(inProgressReview, input.graph, input.scope)) {
      return {
        kind: "blocked",
        result: {
          kind: "blocked",
          ref: inProgressReview,
          reason: "A review block is in progress outside the selected Auto Run scope."
        }
      };
    }
    const reason = requireBlockState(input.state, inProgressReview).pendingFeedbackId
      ? "feedback_resolved"
      : "current";
    return {
      kind: "currentReview",
      ref: inProgressReview,
      reason,
      clearCurrentFeedback: false,
      result: claimCandidate(
        inProgressReview,
        input.graph,
        reason,
        input.manifest.execution.defaultExecutor
      ).result
    };
  }

  const current = input.graph.blockRefsInManifestOrder.find((ref) => {
    const block = getBlock(input.graph, ref);
    return requireBlockState(input.state, ref).status === "in_progress" && block.type !== "review";
  });
  if (current) {
    const currentBlock = getBlock(input.graph, current);
    if (input.blockType && currentBlock.type !== input.blockType) {
      return blockedByClaimType(current, "A block is in progress outside the selected claim type.");
    }
    if (!blockInScope(current, input.graph, input.scope)) {
      return {
        kind: "blocked",
        result: {
          kind: "blocked",
          ref: current,
          reason: "A block is in progress outside the selected Auto Run scope."
        }
      };
    }
    return {
      kind: "currentBlock",
      ref: current,
      result: claimCandidate(
        current,
        input.graph,
        "current",
        input.manifest.execution.defaultExecutor
      ).result
    };
  }

  return { kind: "ready" };
}

export function buildClaimReadiness(input: BuildClaimReadinessInput): ClaimReadiness {
  const scope = normalizeClaimScope(input.scope);
  const projectGuard = input.projectGuard ?? noProjectGraphBlockers;
  const invalidScope = validateClaimScope(scope, input.graph);
  const defaultClaimBlockedReason = currentClaimBlockedReason(input.graph, input.state);
  const claimHints = buildClaimHints(
    input.graph,
    input.state,
    projectGuard,
    defaultClaimBlockedReason,
    input.manifest.execution.parallel.maxConcurrent,
    input.manifest.execution.defaultExecutor
  );
  const scopedReadyRefs = input.graph.blockRefsInManifestOrder.filter((ref) => {
    const taskId = requireMapValue(input.graph.blockTaskByRef, ref, "blockTaskByRef");
    return (
      blockMatchesClaimFilter(ref, input.graph, scope, input.blockType) &&
      blockReadyWithoutProjectBlockers(input.graph, input.state, ref) &&
      !projectBlockerReason(projectGuard, taskId)
    );
  });
  const sequentialImplementationCandidates = scopedReadyRefs
    .filter((ref) => getBlock(input.graph, ref).type !== "review")
    .map((ref) =>
      claimCandidate(ref, input.graph, "claimed", input.manifest.execution.defaultExecutor)
    );
  const sequentialReviewCandidates = scopedReadyRefs
    .filter((ref) => getBlock(input.graph, ref).type === "review")
    .map((ref) =>
      claimCandidate(ref, input.graph, "claimed", input.manifest.execution.defaultExecutor)
    );
  const nextClaimable = claimHints.filter((hint) => hint.ready).map((hint) => hint.ref);
  // Ready implementation blocks are eligible for parallel selection; dependencies and
  // project scope remain the ordering authority.
  const nextParallelClaimable = claimHints
    .filter((hint) => hint.ready && hint.blockType === "implementation")
    .map((hint) => hint.ref);
  // Review blocks remain sequential-only.
  const nextSequentialClaimable = claimHints
    .filter((hint) => hint.ready && hint.blockType === "review")
    .map((hint) => hint.ref);
  const nextParallelDispatchable = claimHints
    .filter((hint) => hint.dispatchable)
    .map((hint) => hint.ref);
  const scopedNextSequentialClaimable = scopedReadyRefs.filter(
    (ref) => getBlock(input.graph, ref).type === "review"
  );

  return {
    scope,
    invalidScope,
    claimOrder: buildClaimOrder({
      graph: input.graph,
      manifest: input.manifest,
      state: input.state,
      scope,
      blockType: input.blockType,
      projectGuard
    }),
    defaultClaimBlockedReason,
    claimHints,
    nextClaimable,
    nextParallelClaimable,
    nextSequentialClaimable,
    nextParallelDispatchable,
    scopedNextSequentialClaimable,
    sequentialImplementationCandidates,
    sequentialReviewCandidates,
    parallelBatchRefs: selectedParallelBatchRefs(
      input.graph,
      input.manifest,
      input.state,
      scope,
      input.blockType,
      projectGuard
    ),
    firstProjectBlockedResult: firstProjectBlockedResult(
      input.graph,
      input.state,
      scope,
      input.blockType,
      projectGuard
    ),
    firstBlockedResult: firstBlockedResult(input.graph, input.state, scope),
    warnings: reviewMaxCycleWarnings(input.graph, input.state)
  };
}
