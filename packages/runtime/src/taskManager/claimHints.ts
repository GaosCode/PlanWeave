import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { requireMapValue } from "../graph/requireMapValue.js";
import type {
  BlockState,
  ClaimHint,
  CompiledExecutionGraph,
  ManifestBlock,
  RuntimeState
} from "../types.js";
import type { ProjectGraphClaimGuard } from "./projectGraphClaimGuard.js";
import {
  blockReadyWithoutProjectBlockers,
  projectBlockerReason,
  projectBlockers
} from "./claimReadinessRules.js";
import {
  canDispatchImplementationBlock,
  effectiveBlockExecutor,
  requiredImplementationRefs
} from "./selectors.js";

function statusReasonForBlock(blockState: BlockState | undefined): string | null {
  if (blockState?.status === "blocked") {
    return blockState.blockedReason ?? null;
  }
  if (blockState?.status === "diverged") {
    return blockState.divergenceReason ?? null;
  }
  return blockState?.blockedReason ?? blockState?.divergenceReason ?? null;
}

function reviewGateUnlocksTasks(
  taskId: string,
  downstreamTasks: string[],
  state: RuntimeState,
  graph: CompiledExecutionGraph
): string[] {
  return downstreamTasks.filter((downstreamTaskId) =>
    requireMapValue(graph.taskDependenciesByTask, downstreamTaskId, "taskDependenciesByTask").every(
      (dependency) => dependency === taskId || state.tasks[dependency]?.status === "implemented"
    )
  );
}

function dependencyBlockers(
  graph: CompiledExecutionGraph,
  state: RuntimeState,
  ref: string,
  block: ManifestBlock,
  taskId: string
) {
  const blockedByTasks = requireMapValue(
    graph.taskDependenciesByTask,
    taskId,
    "taskDependenciesByTask"
  ).filter((dependency) => state.tasks[dependency]?.status !== "implemented");
  const directBlockBlockers = requireMapValue(
    graph.blockDependenciesByRef,
    ref,
    "blockDependenciesByRef"
  ).filter((dependency) => state.blocks[dependency]?.status !== "completed");
  const reviewWorkBlockers =
    block.type === "review"
      ? requiredImplementationRefs(graph, taskId).filter(
          (dependency) => state.blocks[dependency]?.status !== "completed"
        )
      : [];
  return {
    blockedByTasks,
    blockedByBlocks: Array.from(new Set([...directBlockBlockers, ...reviewWorkBlockers]))
  };
}

export function buildClaimHints(
  graph: CompiledExecutionGraph,
  state: RuntimeState,
  projectGuard: ProjectGraphClaimGuard,
  defaultClaimBlockedReason: string | null,
  maxConcurrent: number,
  defaultExecutor?: string
): ClaimHint[] {
  return graph.blockRefsInManifestOrder.map((ref) => {
    const taskId = requireMapValue(graph.blockTaskByRef, ref, "blockTaskByRef");
    const block = requireMapValue(graph.blocksByRef, ref, "blocksByRef");
    const blockState = state.blocks[ref];
    const { blockId } = parseBlockRef(ref);
    const blockers = dependencyBlockers(graph, state, ref, block, taskId);
    const baseReady = blockReadyWithoutProjectBlockers(graph, state, ref);
    const projectBlocker = projectBlockerReason(projectGuard, taskId);
    const blockedByProject = projectBlockers(projectGuard, taskId);
    const ready = baseReady && defaultClaimBlockedReason === null && projectBlocker === null;
    const dispatchable =
      projectBlocker === null &&
      canDispatchImplementationBlock(graph, state, ref, { maxConcurrent });
    const downstreamTasks =
      block.type === "review"
        ? requireMapValue(graph.taskDependentsByTask, taskId, "taskDependentsByTask")
        : [];
    const reviewGate =
      block.type === "review"
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
      ? block.type === "review"
        ? "Review gate is ready after required implementation blocks completed."
        : "Block is ready for implementation."
      : null;
    const explicitStatusReason = statusReasonForBlock(blockState);
    const statusReason =
      explicitStatusReason ??
      (baseReady && projectBlocker ? projectBlocker : null) ??
      (baseReady && defaultClaimBlockedReason ? defaultClaimBlockedReason : null) ??
      (block.type === "review" && !block.review.required
        ? "Optional review gate is not required and is not claimable; task can complete without it."
        : null);
    return {
      ref,
      taskId,
      blockId,
      blockType: block.type,
      effectiveExecutor: effectiveBlockExecutor(graph, ref, defaultExecutor),
      status: blockState?.status ?? "planned",
      statusReason,
      ready,
      readyReason,
      blockedByBlocks: blockers.blockedByBlocks,
      blockedByTasks: blockers.blockedByTasks,
      blockedByProject,
      sequentialOnly: block.type === "review",
      recommendedCommand: ready ? `planweave claim ${ref}` : null,
      dispatchable,
      dispatchCommand: dispatchable ? `planweave claim ${ref} --dispatch` : null,
      reviewGate
    };
  });
}
