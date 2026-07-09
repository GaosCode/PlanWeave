import { parseBlockRef } from "../graph/compileTaskGraph.js";
import type {
  BlockState,
  BlockStatus,
  ExecutionGraphSession,
  PackageWorkspaceRef
} from "../types.js";
import { buildClaimReadiness } from "./claimReadiness.js";
import {
  createProjectGraphClaimGuard,
  type ProjectGraphClaimGuard
} from "./projectGraphClaimGuard.js";
import { loadRuntimeReadonly, type RuntimeContext } from "./runtimeContext.js";
import { effectiveBlockExecutor, getBlock, isActiveFeedbackStatus } from "./selectors.js";

function statusReasonForBlock(blockState: BlockState | undefined): string | null {
  if (blockState?.status === "blocked") {
    return blockState.blockedReason ?? null;
  }
  if (blockState?.status === "diverged") {
    return blockState.divergenceReason ?? null;
  }
  return blockState?.blockedReason ?? blockState?.divergenceReason ?? null;
}

export async function buildExecutionStatus(
  context: RuntimeContext,
  options: { claimGuard?: ProjectGraphClaimGuard } = {}
) {
  const { workspace, manifest, graph, state } = context;
  const taskCounts = Object.fromEntries(
    ["planned", "ready", "in_progress", "implemented"].map((status) => [status, 0])
  ) as Record<"planned" | "ready" | "in_progress" | "implemented", number>;
  const blockCounts = Object.fromEntries(
    ["planned", "ready", "in_progress", "completed", "needs_changes", "blocked", "diverged"].map(
      (status) => [status, 0]
    )
  ) as Record<BlockStatus, number>;
  const feedbackCounts = Object.fromEntries(
    ["open", "in_progress", "resolved", "dismissed"].map((status) => [status, 0])
  ) as Record<"open" | "in_progress" | "resolved" | "dismissed", number>;
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
    state.currentFeedbackId &&
    isActiveFeedbackStatus(state.feedback[state.currentFeedbackId]?.status)
      ? state.currentFeedbackId
      : null;
  const readiness = buildClaimReadiness({
    graph,
    manifest,
    state,
    projectGuard: options.claimGuard ?? (await createProjectGraphClaimGuard(context))
  });
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
        effectiveExecutor: effectiveBlockExecutor(graph, ref, manifest.execution.defaultExecutor),
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
    nextClaimable: readiness.nextClaimable,
    nextParallelClaimable: readiness.nextParallelClaimable,
    nextSequentialClaimable: readiness.nextSequentialClaimable,
    nextParallelDispatchable: readiness.nextParallelDispatchable,
    claimHints: readiness.claimHints,
    warnings: readiness.warnings,
    counts: {
      tasks: taskCounts,
      blocks: blockCounts,
      feedback: feedbackCounts
    },
    orphanState: [],
    orphanResults: []
  };
}

export type ExecutionStatus = Awaited<ReturnType<typeof buildExecutionStatus>>;

export async function getExecutionStatus(options: {
  projectRoot: PackageWorkspaceRef;
  session?: ExecutionGraphSession;
}): Promise<ExecutionStatus> {
  return buildExecutionStatus(await loadRuntimeReadonly(options));
}
