import { parseBlockRef } from "../graph/compileTaskGraph.js";
import type {
  BlockState,
  BlockStatus,
  CompiledExecutionGraph,
  ExecutionGraphSession,
  PackageWorkspaceRef,
  RuntimeState,
  ValidationIssue
} from "../types.js";
import { loadRuntime } from "./runtimeContext.js";
import {
  blockDependenciesCompleted,
  canClaimReviewBlock,
  getBlock,
  isActiveFeedbackStatus,
  requiredImplementationRefs,
  taskDependenciesSatisfied
} from "./selectors.js";

function reviewGateUnlocksTasks(taskId: string, downstreamTasks: string[], state: RuntimeState, graph: CompiledExecutionGraph): string[] {
  return downstreamTasks.filter((downstreamTaskId) =>
    (graph.taskDependenciesByTask.get(downstreamTaskId) ?? []).every((dependency) => dependency === taskId || state.tasks[dependency]?.status === "implemented")
  );
}

function statusReasonForBlock(blockState: BlockState | undefined): string | null {
  if (blockState?.status === "blocked") {
    return blockState.blockedReason ?? null;
  }
  if (blockState?.status === "diverged") {
    return blockState.divergenceReason ?? null;
  }
  return blockState?.blockedReason ?? blockState?.divergenceReason ?? null;
}

export async function getExecutionStatus(options: { projectRoot: PackageWorkspaceRef; session?: ExecutionGraphSession }) {
  const context = await loadRuntime(options);
  const { workspace, graph, state } = context;
  const taskCounts = Object.fromEntries(["planned", "ready", "in_progress", "implemented"].map((status) => [status, 0])) as Record<
    "planned" | "ready" | "in_progress" | "implemented",
    number
  >;
  const blockCounts = Object.fromEntries(
    ["planned", "ready", "in_progress", "completed", "needs_changes", "blocked", "diverged"].map((status) => [status, 0])
  ) as Record<BlockStatus, number>;
  const feedbackCounts = Object.fromEntries(["open", "in_progress", "resolved", "dismissed"].map((status) => [status, 0])) as Record<
    "open" | "in_progress" | "resolved" | "dismissed",
    number
  >;
  for (const task of Object.values(state.tasks)) {
    taskCounts[task.status] += 1;
  }
  for (const block of Object.values(state.blocks)) {
    blockCounts[block.status] += 1;
  }
  for (const feedback of Object.values(state.feedback)) {
    feedbackCounts[feedback.status] += 1;
  }
  const currentFeedbackId =
    state.currentFeedbackId && isActiveFeedbackStatus(state.feedback[state.currentFeedbackId]?.status) ? state.currentFeedbackId : null;
  const claimHints = graph.blockRefsInManifestOrder.map((ref) => {
    const taskId = graph.blockTaskByRef.get(ref);
    const block = graph.blocksByRef.get(ref);
    const blockState = state.blocks[ref];
    const { blockId } = parseBlockRef(ref);
    const blockedByTasks = taskId
      ? (graph.taskDependenciesByTask.get(taskId) ?? []).filter((dependency) => state.tasks[dependency]?.status !== "implemented")
      : [];
    const directBlockBlockers = (graph.blockDependenciesByRef.get(ref) ?? []).filter((dependency) => state.blocks[dependency]?.status !== "completed");
    const reviewWorkBlockers =
      taskId && block?.type === "review"
        ? requiredImplementationRefs(graph, taskId).filter((dependency) => state.blocks[dependency]?.status !== "completed")
        : [];
    const blockedByBlocks = Array.from(new Set([...directBlockBlockers, ...reviewWorkBlockers]));
    const ready =
      !!taskId &&
      state.blocks[ref]?.status === "ready" &&
      taskDependenciesSatisfied(graph, state, taskId) &&
      (block?.type === "review" ? canClaimReviewBlock(graph, state, ref) : blockDependenciesCompleted(graph, state, ref));
    const parallelSafe = block?.type !== "review" && !!graph.parallelSafeByBlockRef.get(ref);
    const downstreamTasks = taskId && block?.type === "review" ? (graph.taskDependentsByTask.get(taskId) ?? []) : [];
    const reviewGate =
      taskId && block?.type === "review"
        ? {
            isGate: true as const,
            required: block.review.required,
            requiredReason: block.review.required
              ? "Required review gate for task completion."
              : "Optional review gate; not required for task completion.",
            executorRole: "reviewer" as const,
            downstreamTasks,
            unlocksTasks: reviewGateUnlocksTasks(taskId, downstreamTasks, state, graph),
            needsChangesReturnsTo: requiredImplementationRefs(graph, taskId)
          }
        : null;
    const readyReason = ready
      ? block?.type === "review"
        ? "Review gate is ready after required implementation/check blocks completed."
        : parallelSafe
          ? "Block is ready and parallel-safe."
          : "Block is ready for sequential claim."
      : null;
    const explicitStatusReason = statusReasonForBlock(blockState);
    const statusReason =
      explicitStatusReason ??
      (block?.type === "review" && !block.review.required
        ? "Optional review gate is not required and is not claimable; task can complete without it."
        : null);
    return {
      ref,
      taskId: taskId ?? "",
      blockId,
      blockType: block?.type ?? "implementation",
      status: blockState?.status ?? "planned",
      statusReason,
      ready,
      readyReason,
      blockedByBlocks,
      blockedByTasks,
      parallelSafe,
      sequentialOnly: block?.type === "review" || !parallelSafe,
      recommendedCommand: ready ? `planweave claim ${ref}` : null,
      reviewGate
    };
  });
  const nextClaimable = claimHints.filter((hint) => hint.ready).map((hint) => hint.ref);
  const nextParallelClaimable = claimHints.filter((hint) => hint.ready && hint.parallelSafe).map((hint) => hint.ref);
  const nextSequentialClaimable = claimHints.filter((hint) => hint.ready && !hint.parallelSafe).map((hint) => hint.ref);
  const warnings: ValidationIssue[] = graph.blockRefsInManifestOrder
    .filter((ref) => state.blocks[ref]?.completionReason === "max_cycles_reached")
    .map((ref) => ({
      code: "review_max_cycles_reached",
      message: `Review block '${ref}' reached max feedback cycles without passing.`,
      path: ref
    }));
  return {
    projectId: workspace.id,
    projectRoot: workspace.rootPath,
    taskTotal: graph.taskNodesInManifestOrder.length,
    blockTotal: graph.blockRefsInManifestOrder.length,
    tasks: graph.taskNodesInManifestOrder.map((taskId) => ({
      taskId,
      status: state.tasks[taskId]?.status ?? "planned",
      openFeedbackCount: state.tasks[taskId]?.openFeedbackCount ?? 0
    })),
    blocks: graph.blockRefsInManifestOrder.map((ref) => {
      const { taskId, blockId } = parseBlockRef(ref);
      const block = getBlock(graph, ref);
      const blockState = state.blocks[ref];
      return {
        ref,
        taskId,
        blockId,
        type: block.type,
        status: blockState?.status ?? "planned",
        reason: statusReasonForBlock(blockState),
        completionReason: blockState?.completionReason ?? null,
        lastRunId: blockState?.lastRunId ?? null,
        latestReviewAttemptId: blockState?.latestReviewAttemptId ?? null,
        activeFeedbackId: blockState?.activeFeedbackId ?? null
      };
    }),
    currentRefs: state.currentRefs,
    currentFeedbackId,
    currentReviewBlockRef: state.currentReviewBlockRef,
    openFeedback: Object.entries(state.feedback)
      .filter(([, feedback]) => feedback.status === "open" || feedback.status === "in_progress")
      .map(([feedbackId, feedback]) => ({
        feedbackId,
        sourceReviewBlockRef: feedback.sourceReviewBlockRef,
        status: feedback.status
      })),
    nextClaimable,
    nextParallelClaimable,
    nextSequentialClaimable,
    claimHints,
    warnings,
    counts: {
      tasks: taskCounts,
      blocks: blockCounts,
      feedback: feedbackCounts
    },
    orphanState: [],
    orphanResults: []
  };
}
