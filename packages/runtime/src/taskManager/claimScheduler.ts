import { writeState } from "../state.js";
import type { ClaimResult, ClaimScope, ExecutionGraphSession, PackageWorkspaceRef } from "../types.js";
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
  scope?: ClaimScope;
  session?: ExecutionGraphSession;
}): Promise<ClaimResult> {
  const context = await loadRuntime(options);
  let { state } = context;
  const { graph, manifest, workspace } = context;
  const scope = normalizeClaimScope(options.scope);
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
    const currentFeedback = state.feedback[state.currentFeedbackId];
    if (currentFeedback?.status === "resolved") {
      if (!blockInScope(inProgressReview, graph, scope)) {
        return { kind: "blocked", ref: inProgressReview, reason: "A review block is in progress outside the selected Auto Run scope." };
      }
      state.currentRefs = [inProgressReview];
      state.currentFeedbackId = null;
      state.currentReviewBlockRef = inProgressReview;
      await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
      return claimResultForBlock(inProgressReview, graph, "feedback_resolved");
    }
  }
  if (inProgressReview) {
    if (!blockInScope(inProgressReview, graph, scope)) {
      return { kind: "blocked", ref: inProgressReview, reason: "A review block is in progress outside the selected Auto Run scope." };
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
    if (!blockInScope(current, graph, scope)) {
      return { kind: "blocked", ref: current, reason: "A block is in progress outside the selected Auto Run scope." };
    }
    return claimResultForBlock(current, graph, "current");
  }

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
    for (const ref of selected) {
      state.blocks[ref] = { ...state.blocks[ref], status: "in_progress" };
    }
    state.currentRefs = selected;
    await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
    return selected.length > 0 ? { kind: "batch", refs: selected } : { kind: "none", reason: "no_parallel_blocks" };
  }

  for (const ref of graph.blockRefsInManifestOrder) {
    if (!blockInScope(ref, graph, scope)) {
      continue;
    }
    const taskId = graph.blockTaskByRef.get(ref);
    const block = graph.blocksByRef.get(ref);
    if (!taskId || !block || block.type === "review") {
      continue;
    }
    if (taskDependenciesSatisfied(graph, state, taskId) && blockDependenciesCompleted(graph, state, ref) && state.blocks[ref]?.status === "ready") {
      markClaimed(state, ref, graph);
      await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
      return claimResultForBlock(ref, graph, "claimed");
    }
  }

  for (const ref of graph.blockRefsInManifestOrder) {
    if (!blockInScope(ref, graph, scope)) {
      continue;
    }
    const taskId = graph.blockTaskByRef.get(ref);
    const block = graph.blocksByRef.get(ref);
    if (!taskId || block?.type !== "review") {
      continue;
    }
    if (taskDependenciesSatisfied(graph, state, taskId) && state.blocks[ref]?.status === "ready" && canClaimReviewBlock(graph, state, ref)) {
      markClaimed(state, ref, graph);
      await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
      return claimResultForBlock(ref, graph, "claimed");
    }
  }

  const blockedRef = graph.blockRefsInManifestOrder.find((ref) => blockInScope(ref, graph, scope) && state.blocks[ref]?.status === "blocked");
  if (blockedRef) {
    return {
      kind: "blocked",
      ref: blockedRef,
      reason: state.blocks[blockedRef]?.blockedReason ?? `Block '${blockedRef}' is blocked.`
    };
  }

  await writeState(workspace.stateFile, refreshDerivedState(manifest, state));
  return { kind: "none", reason: "no_claimable_blocks" };
}
