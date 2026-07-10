import { z } from "zod";
import { EXCLUSIVE_LOCK, locksConflict } from "../../graph/parallelLocks.js";
import type { CompiledExecutionGraph, RuntimeState } from "../../types.js";
import type { ClaimHint } from "../../types/taskManager.js";
import type {
  DesktopBlockPreview,
  DesktopBlockWaitingOn,
  DesktopGraphViewModel,
  DesktopLockGroup,
  DesktopTaskNodeViewModel
} from "../types/graphTypes.js";

export const desktopBlockWaitingOnSchema = z.object({
  lock: z.string().min(1),
  holderRef: z.string().min(1)
});

export const desktopLockGroupSchema = z.object({
  name: z.string().min(1),
  memberTaskIds: z.array(z.string().min(1)),
  memberBlockRefs: z.array(z.string().min(1)),
  holderRef: z.string().min(1).nullable()
});

export type DesktopBlockWaitingOnDto = z.infer<typeof desktopBlockWaitingOnSchema>;
export type DesktopLockGroupDto = z.infer<typeof desktopLockGroupSchema>;

function inProgressImplementationRefs(
  graph: CompiledExecutionGraph,
  state: RuntimeState
): string[] {
  return state.currentRefs.filter((ref) => {
    if (state.blocks[ref]?.status !== "in_progress") {
      return false;
    }
    return graph.blocksByRef.get(ref)?.type === "implementation";
  });
}

/**
 * Resolve the lock + holder that keep a ready implementation block from dispatching.
 * Mirrors lock-holder selection used by claim hints, but returns structured DTO fields.
 */
export function resolveBlockWaitingOn(
  graph: CompiledExecutionGraph,
  state: RuntimeState,
  ref: string,
  options: { ready: boolean; dispatchable: boolean }
): DesktopBlockWaitingOn | null {
  if (!options.ready || options.dispatchable) {
    return null;
  }
  const block = graph.blocksByRef.get(ref);
  if (block?.type !== "implementation" || state.blocks[ref]?.status !== "ready") {
    return null;
  }
  const candidateLocks = graph.locksByBlockRef.get(ref) ?? [];
  for (const currentRef of inProgressImplementationRefs(graph, state)) {
    const holderLocks = graph.locksByBlockRef.get(currentRef) ?? [];
    if (!locksConflict(candidateLocks, holderLocks)) {
      continue;
    }
    const shared =
      candidateLocks.find((lock) => holderLocks.includes(lock)) ??
      candidateLocks.find((lock) => lock === EXCLUSIVE_LOCK) ??
      holderLocks.find((lock) => lock === EXCLUSIVE_LOCK) ??
      holderLocks[0] ??
      candidateLocks[0];
    if (!shared) {
      continue;
    }
    return { lock: shared, holderRef: currentRef };
  }
  return null;
}

export function resolveLockHolderRef(
  graph: CompiledExecutionGraph,
  state: RuntimeState,
  lockName: string
): string | null {
  for (const currentRef of inProgressImplementationRefs(graph, state)) {
    const holderLocks = graph.locksByBlockRef.get(currentRef) ?? [];
    if (holderLocks.includes(lockName)) {
      return currentRef;
    }
    // exclusive conflicts with every lock; treat exclusive holders as holders of that name only
    // when the group itself is exclusive (otherwise membership is via shared named locks).
    if (lockName === EXCLUSIVE_LOCK && holderLocks.includes(EXCLUSIVE_LOCK)) {
      return currentRef;
    }
  }
  return null;
}

export function buildLockGroups(
  graph: CompiledExecutionGraph,
  state: RuntimeState
): DesktopLockGroup[] {
  const memberBlockRefsByLock = new Map<string, Set<string>>();
  for (const [ref, locks] of graph.locksByBlockRef.entries()) {
    const taskId = graph.blockTaskByRef.get(ref);
    if (!taskId || locks.length === 0) {
      continue;
    }
    for (const lock of locks) {
      const memberBlockRefs = memberBlockRefsByLock.get(lock) ?? new Set<string>();
      memberBlockRefs.add(ref);
      memberBlockRefsByLock.set(lock, memberBlockRefs);
    }
  }
  const names = [...memberBlockRefsByLock.keys()].sort((left, right) => left.localeCompare(right));
  return names.map((name) => {
    const memberBlockRefs = [...(memberBlockRefsByLock.get(name) ?? [])].sort((left, right) =>
      left.localeCompare(right)
    );
    const memberTaskIds = new Set<string>();
    for (const ref of memberBlockRefs) {
      const taskId = graph.blockTaskByRef.get(ref);
      if (taskId) {
        memberTaskIds.add(taskId);
      }
    }
    return {
      name,
      memberTaskIds: [...memberTaskIds].sort((left, right) => left.localeCompare(right)),
      memberBlockRefs,
      holderRef: resolveLockHolderRef(graph, state, name)
    };
  });
}

function enrichBlockPreview(
  block: DesktopBlockPreview,
  graph: CompiledExecutionGraph,
  state: RuntimeState,
  claimHintByRef: Map<string, ClaimHint>
): DesktopBlockPreview {
  const hint = claimHintByRef.get(block.ref);
  const dispatchable = hint?.dispatchable ?? false;
  // Use runtime block status (not claimHint.ready): claim readiness also folds sequential
  // current-block locks that are unrelated to mutex waiting UX.
  const ready = block.status === "ready";
  return {
    ...block,
    dispatchable,
    waitingOn: resolveBlockWaitingOn(graph, state, block.ref, { ready, dispatchable })
  };
}

function taskLocks(graph: CompiledExecutionGraph, task: DesktopTaskNodeViewModel): string[] {
  const locks = new Set<string>();
  for (const block of task.blocks) {
    for (const lock of graph.locksByBlockRef.get(block.ref) ?? []) {
      locks.add(lock);
    }
  }
  return [...locks].sort((left, right) => left.localeCompare(right));
}

/**
 * Attach locks, per-block dispatchability/waitingOn, and canvas lock groups.
 * Derives from claim hints + graph indexes (single authority; renderer must not recompute).
 */
export function enrichGraphViewModelLocks(
  graphView: Omit<DesktopGraphViewModel, "lockGroups"> & { lockGroups?: DesktopLockGroup[] },
  options: {
    graph: CompiledExecutionGraph;
    state: RuntimeState;
    claimHints: ClaimHint[];
  }
): DesktopGraphViewModel {
  const claimHintByRef = new Map(options.claimHints.map((hint) => [hint.ref, hint]));
  const tasks = graphView.tasks.map((task) => {
    const blocks = task.blocks.map((block) =>
      enrichBlockPreview(block, options.graph, options.state, claimHintByRef)
    );
    const visibleCount = task.blockPreview.length;
    return {
      ...task,
      locks: taskLocks(options.graph, { ...task, blocks }),
      blocks,
      blockPreview: blocks.slice(0, visibleCount)
    };
  });
  const lockGroups = buildLockGroups(options.graph, options.state);
  return {
    ...graphView,
    tasks,
    lockGroups
  };
}
