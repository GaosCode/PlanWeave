import { writeState } from "../state.js";
import type { BlockType, ClaimResult, ClaimScope, ExecutionGraphSession, PackageWorkspaceRef } from "../types.js";
import { patchFeedbackArtifact } from "./feedbackArtifacts.js";
import { updateTaskIndex } from "./resultIndex.js";
import { loadRuntime, refreshDerivedState } from "./runtimeContext.js";
import {
  activeOpenFeedback,
  blockDependenciesCompleted,
  blockInScope,
  canClaimReviewBlock,
  claimResultForBlock,
  feedbackInScope,
  markClaimed,
  normalizeClaimScope,
  taskDependenciesSatisfied,
  validateClaimScope
} from "./selectors.js";

export async function claimNext(options: {
  projectRoot: PackageWorkspaceRef;
  parallel?: boolean;
  blockType?: BlockType;
  dryRun?: boolean;
  scope?: ClaimScope;
  session?: ExecutionGraphSession;
}): Promise<ClaimResult> {
  const context = await loadRuntime(options);
  let { state } = context;
  const { graph, manifest, workspace } = context;
  const scope = normalizeClaimScope(options.scope);
  const blockType = options.blockType;
  const dryRun = options.dryRun === true;
  const invalidScope = validateClaimScope(scope, graph);
  if (invalidScope) {
    return invalidScope;
  }
  const openFeedback = activeOpenFeedback(state);
  if (openFeedback.length > 1) {
    return { kind: "blocked", reason: "Multiple open feedback envelopes exist; resolve or dismiss one before continuing." };
  }
  if (openFeedback.length === 1) {
    const [feedbackId, feedback] = openFeedback[0];
    if (!feedbackInScope(feedback, graph, scope)) {
      return { kind: "none", reason: "no_claimable_blocks_in_scope" };
    }
    const taskId = graph.blockTaskByRef.get(feedback.sourceReviewBlockRef);
    if (!taskId) {
      throw new Error(`Feedback '${feedbackId}' points to an unknown review block.`);
    }
    if (dryRun) {
      return { kind: "feedback", content: feedback.content };
    }
    await patchFeedbackArtifact(workspace, taskId, feedbackId, { status: "in_progress" });
    await updateTaskIndex(workspace, taskId, (index) => ({
      ...index,
      feedbackStatusById: {
        ...(index.feedbackStatusById ?? {}),
        [feedbackId]: "in_progress"
      }
    }));
    feedback.status = "in_progress";
    state.currentFeedbackId = feedbackId;
    state.currentReviewBlockRef = feedback.sourceReviewBlockRef;
    state.currentRefs = [];
    state = refreshDerivedState(manifest, state);
    await writeState(workspace.stateFile, state);
    return { kind: "feedback", content: feedback.content };
  }

  const inProgressReview = graph.blockRefsInManifestOrder.find((ref) => {
    const block = graph.blocksByRef.get(ref);
    return block?.type === "review" && state.blocks[ref]?.status === "in_progress";
  });
  if (inProgressReview && state.currentFeedbackId) {
    if (blockType && blockType !== "review") {
      return { kind: "blocked", ref: inProgressReview, reason: "A review block is in progress outside the selected claim type." };
    }
    const currentFeedback = state.feedback[state.currentFeedbackId];
    if (currentFeedback?.status === "resolved") {
      if (!blockInScope(inProgressReview, graph, scope)) {
        return { kind: "blocked", ref: inProgressReview, reason: "A review block is in progress outside the selected Auto Run scope." };
      }
      if (dryRun) {
        return claimResultForBlock(inProgressReview, graph, "feedback_resolved");
      }
      state.currentRefs = [inProgressReview];
      state.currentFeedbackId = null;
      state.currentReviewBlockRef = inProgressReview;
      await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
      return claimResultForBlock(inProgressReview, graph, "feedback_resolved");
    }
  }
  if (inProgressReview) {
    if (blockType && blockType !== "review") {
      return { kind: "blocked", ref: inProgressReview, reason: "A review block is in progress outside the selected claim type." };
    }
    if (!blockInScope(inProgressReview, graph, scope)) {
      return { kind: "blocked", ref: inProgressReview, reason: "A review block is in progress outside the selected Auto Run scope." };
    }
    if (dryRun) {
      return claimResultForBlock(inProgressReview, graph, "current");
    }
    state.currentRefs = [inProgressReview];
    state.currentReviewBlockRef = inProgressReview;
    await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
    return claimResultForBlock(inProgressReview, graph, "current");
  }

  const current = graph.blockRefsInManifestOrder.find((ref) => {
    const block = graph.blocksByRef.get(ref);
    return state.blocks[ref]?.status === "in_progress" && block?.type !== "review";
  });
  if (current) {
    const currentBlock = graph.blocksByRef.get(current);
    if (blockType && currentBlock?.type !== blockType) {
      return { kind: "blocked", ref: current, reason: "A block is in progress outside the selected claim type." };
    }
    if (!blockInScope(current, graph, scope)) {
      return { kind: "blocked", ref: current, reason: "A block is in progress outside the selected Auto Run scope." };
    }
    return claimResultForBlock(current, graph, "current");
  }

  const claimSequentialReviewBlock = async (): Promise<ClaimResult | null> => {
    for (const ref of graph.blockRefsInManifestOrder) {
      if (!blockInScope(ref, graph, scope)) {
        continue;
      }
      const taskId = graph.blockTaskByRef.get(ref);
      const block = graph.blocksByRef.get(ref);
      if (blockType && blockType !== "review") {
        continue;
      }
      if (!taskId || block?.type !== "review") {
        continue;
      }
      if (taskDependenciesSatisfied(graph, state, taskId) && state.blocks[ref]?.status === "ready" && canClaimReviewBlock(graph, state, ref)) {
        if (dryRun) {
          return claimResultForBlock(ref, graph, "claimed");
        }
        markClaimed(state, ref, graph);
        state = refreshDerivedState(manifest, state);
        await writeState(workspace.stateFile, state);
        return claimResultForBlock(ref, graph, "claimed");
      }
    }
    return null;
  };

  const nextSequentialClaimableRefs = (): string[] =>
    graph.blockRefsInManifestOrder.filter((ref) => {
      if (!blockInScope(ref, graph, scope)) {
        return false;
      }
      const taskId = graph.blockTaskByRef.get(ref);
      const block = graph.blocksByRef.get(ref);
      if (blockType && block?.type !== blockType) {
        return false;
      }
      if (!taskId || !block || state.blocks[ref]?.status !== "ready" || !taskDependenciesSatisfied(graph, state, taskId)) {
        return false;
      }
      const ready =
        block.type === "review" ? canClaimReviewBlock(graph, state, ref) : blockDependenciesCompleted(graph, state, ref);
      return ready && (block.type === "review" || !graph.parallelSafeByBlockRef.get(ref));
    });

  if (options.parallel) {
    if (!manifest.execution.parallel.enabled) {
      return { kind: "blocked", reason: "Parallel execution is disabled by the Plan Package." };
    }
    const selected: string[] = [];
    for (const ref of graph.blockRefsInManifestOrder) {
      if (!blockInScope(ref, graph, scope)) {
        continue;
      }
      const taskId = graph.blockTaskByRef.get(ref);
      const block = graph.blocksByRef.get(ref);
      if (blockType && block?.type !== blockType) {
        continue;
      }
      if (!taskId || !block || block.type === "review") {
        continue;
      }
      if (selected.length >= manifest.execution.parallel.maxConcurrent) {
        break;
      }
      if (!taskDependenciesSatisfied(graph, state, taskId) || !blockDependenciesCompleted(graph, state, ref)) {
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
    if (selected.length === 0) {
      const reviewClaim = await claimSequentialReviewBlock();
      if (reviewClaim) {
        if (dryRun && reviewClaim.kind === "block" && reviewClaim.blockType === "review") {
          return {
            ...reviewClaim,
            requestedMode: "parallel",
            parallelFallbackReason: "review_requires_sequential_claim",
            nextParallelClaimable: []
          };
        }
        return reviewClaim;
      }
      state.currentRefs = [];
      if (!dryRun) {
        await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
      }
      return { kind: "none", reason: "no_parallel_blocks", nextSequentialClaimable: nextSequentialClaimableRefs() };
    }
    if (dryRun) {
      return { kind: "batch", refs: selected };
    }
    for (const ref of selected) {
      state.blocks[ref] = { ...state.blocks[ref], status: "in_progress" };
    }
    state.currentRefs = selected;
    await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
    return { kind: "batch", refs: selected };
  }

  for (const ref of graph.blockRefsInManifestOrder) {
    if (!blockInScope(ref, graph, scope)) {
      continue;
    }
    const taskId = graph.blockTaskByRef.get(ref);
    const block = graph.blocksByRef.get(ref);
    if (blockType && block?.type !== blockType) {
      continue;
    }
    if (!taskId || !block || block.type === "review") {
      continue;
    }
    if (taskDependenciesSatisfied(graph, state, taskId) && blockDependenciesCompleted(graph, state, ref) && state.blocks[ref]?.status === "ready") {
      if (dryRun) {
        return claimResultForBlock(ref, graph, "claimed");
      }
      markClaimed(state, ref, graph);
      await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
      return claimResultForBlock(ref, graph, "claimed");
    }
  }

  const reviewClaim = await claimSequentialReviewBlock();
  if (reviewClaim) {
    return reviewClaim;
  }

  const blockedRef = graph.blockRefsInManifestOrder.find((ref) => blockInScope(ref, graph, scope) && state.blocks[ref]?.status === "blocked");
  if (blockedRef) {
    return {
      kind: "blocked",
      ref: blockedRef,
      reason: state.blocks[blockedRef]?.blockedReason ?? `Block '${blockedRef}' is blocked.`
    };
  }

  if (!dryRun) {
    await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
  }
  return { kind: "none", reason: "no_claimable_blocks" };
}

export async function claimBlock(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  session?: ExecutionGraphSession;
}): Promise<ClaimResult> {
  return claimNext({ projectRoot: options.projectRoot, scope: { kind: "block", blockRef: options.ref }, session: options.session });
}

export async function claimTask(options: {
  projectRoot: PackageWorkspaceRef;
  taskId: string;
  session?: ExecutionGraphSession;
}): Promise<ClaimResult> {
  return claimNext({ projectRoot: options.projectRoot, scope: { kind: "task", taskId: options.taskId }, session: options.session });
}

export async function claimBlockType(options: {
  projectRoot: PackageWorkspaceRef;
  blockType: BlockType;
  session?: ExecutionGraphSession;
}): Promise<ClaimResult> {
  return claimNext({ projectRoot: options.projectRoot, blockType: options.blockType, session: options.session });
}
