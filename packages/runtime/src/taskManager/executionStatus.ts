import { parseBlockRef } from "../graph/compileTaskGraph.js";
import type { BlockStatus, ExecutionGraphSession, PackageWorkspaceRef, ValidationIssue } from "../types.js";
import { loadRuntime } from "./runtimeContext.js";
import { blockDependenciesCompleted, getBlock, taskDependenciesSatisfied } from "./selectors.js";

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
  const nextClaimable = graph.blockRefsInManifestOrder.filter((ref) => {
    const taskId = graph.blockTaskByRef.get(ref);
    return (
      !!taskId &&
      state.blocks[ref]?.status === "ready" &&
      taskDependenciesSatisfied(graph, state, taskId) &&
      blockDependenciesCompleted(graph, state, ref)
    );
  });
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
        reason: blockState?.blockedReason ?? blockState?.divergenceReason ?? null,
        completionReason: blockState?.completionReason ?? null,
        lastRunId: blockState?.lastRunId ?? null,
        latestReviewAttemptId: blockState?.latestReviewAttemptId ?? null,
        activeFeedbackId: blockState?.activeFeedbackId ?? null
      };
    }),
    currentRefs: state.currentRefs,
    currentFeedbackId: state.currentFeedbackId,
    currentReviewBlockRef: state.currentReviewBlockRef,
    openFeedback: Object.entries(state.feedback)
      .filter(([, feedback]) => feedback.status === "open" || feedback.status === "in_progress")
      .map(([feedbackId, feedback]) => ({
        feedbackId,
        sourceReviewBlockRef: feedback.sourceReviewBlockRef,
        status: feedback.status
      })),
    nextClaimable,
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
