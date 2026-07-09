import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { deriveParallelSafe } from "../graph/parallelLocks.js";
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
  lockHolderBlockerReason,
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
    (graph.taskDependenciesByTask.get(downstreamTaskId) ?? []).every(
      (dependency) => dependency === taskId || state.tasks[dependency]?.status === "implemented"
    )
  );
}

function dependencyBlockers(
  graph: CompiledExecutionGraph,
  state: RuntimeState,
  ref: string,
  block: ManifestBlock | undefined,
  taskId: string | undefined
) {
  const blockedByTasks = taskId
    ? (graph.taskDependenciesByTask.get(taskId) ?? []).filter(
        (dependency) => state.tasks[dependency]?.status !== "implemented"
      )
    : [];
  const directBlockBlockers = (graph.blockDependenciesByRef.get(ref) ?? []).filter(
    (dependency) => state.blocks[dependency]?.status !== "completed"
  );
  const reviewWorkBlockers =
    taskId && block?.type === "review"
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
  defaultClaimLockReason: string | null,
  defaultExecutor?: string
): ClaimHint[] {
  return graph.blockRefsInManifestOrder.map((ref) => {
    const taskId = graph.blockTaskByRef.get(ref);
    const block = graph.blocksByRef.get(ref);
    const blockState = state.blocks[ref];
    const { blockId } = parseBlockRef(ref);
    const blockers = dependencyBlockers(graph, state, ref, block, taskId);
    const baseReady = blockReadyWithoutProjectBlockers(graph, state, ref);
    const projectBlocker = projectBlockerReason(projectGuard, taskId);
    const blockedByProject = projectBlockers(projectGuard, taskId);
    const ready = baseReady && defaultClaimLockReason === null && projectBlocker === null;
    const locks = graph.locksByBlockRef.get(ref) ?? [];
    // Compat field: true when the block is not exclusive (can co-run with non-conflicting peers).
    const parallelSafe = block?.type === "implementation" && deriveParallelSafe(locks);
    const dispatchable =
      projectBlocker === null && canDispatchImplementationBlock(graph, state, ref);
    const lockBlocker =
      baseReady && projectBlocker === null && block?.type === "implementation" && !dispatchable
        ? lockHolderBlockerReason(graph, state, ref)
        : null;
    const downstreamTasks =
      taskId && block?.type === "review" ? (graph.taskDependentsByTask.get(taskId) ?? []) : [];
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
        ? "Review gate is ready after required implementation blocks completed."
        : parallelSafe
          ? "Block is ready and parallel-eligible (locks-only mutex)."
          : "Block is ready; reserved exclusive lock means it must run alone."
      : null;
    const explicitStatusReason = statusReasonForBlock(blockState);
    // Prefer lock-holder detail over the generic sequential current-block lock reason so
    // explain/status can name the lock and holder when parallel dispatch is blocked by mutex.
    const statusReason =
      explicitStatusReason ??
      (baseReady && projectBlocker ? projectBlocker : null) ??
      lockBlocker ??
      (baseReady && defaultClaimLockReason ? defaultClaimLockReason : null) ??
      (block?.type === "review" && !block.review.required
        ? "Optional review gate is not required and is not claimable; task can complete without it."
        : null);
    return {
      ref,
      taskId: taskId ?? "",
      blockId,
      blockType: block?.type ?? "implementation",
      effectiveExecutor: effectiveBlockExecutor(graph, ref, defaultExecutor),
      status: blockState?.status ?? "planned",
      statusReason,
      ready,
      readyReason,
      blockedByBlocks: blockers.blockedByBlocks,
      blockedByTasks: blockers.blockedByTasks,
      blockedByProject,
      parallelSafe,
      sequentialOnly: block?.type === "review",
      recommendedCommand: ready ? `planweave claim ${ref}` : null,
      dispatchable,
      dispatchCommand: dispatchable ? `planweave claim ${ref} --dispatch` : null,
      reviewGate
    };
  });
}
