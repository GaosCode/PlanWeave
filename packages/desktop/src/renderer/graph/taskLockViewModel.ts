import type { DesktopGraphViewModel, DesktopTaskNodeViewModel } from "@planweave-ai/runtime";
import type { TaskDispatchState, TaskLockState } from "../types";

function taskIdFromRef(ref: string): string {
  return ref.includes("#") ? ref.slice(0, ref.indexOf("#")) : ref;
}

/**
 * Derive per-lock chip state from DTO lockGroups only (no conflict recomputation).
 */
export function buildTaskLockStates(
  task: DesktopTaskNodeViewModel,
  lockGroups: DesktopGraphViewModel["lockGroups"]
): Record<string, TaskLockState> {
  const groupsByName = new Map(lockGroups.map((group) => [group.name, group]));
  const states: Record<string, TaskLockState> = {};
  for (const name of task.locks) {
    const group = groupsByName.get(name);
    const holderRef = group?.holderRef ?? null;
    if (!holderRef) {
      states[name] = { kind: "free" };
      continue;
    }
    if (taskIdFromRef(holderRef) === task.taskId) {
      states[name] = { kind: "heldByThis" };
      continue;
    }
    states[name] = {
      kind: "heldElsewhere",
      holderRef,
      holderTaskId: taskIdFromRef(holderRef)
    };
  }
  return states;
}

/**
 * Derive dispatch presentation from block DTO fields only.
 * Priority: waiting (ready but lock-held) > dispatchable > none.
 */
export function buildTaskDispatchState(task: DesktopTaskNodeViewModel): TaskDispatchState {
  const implementationBlocks = task.blocks.filter((block) => block.type === "implementation");
  const waitingBlock = implementationBlocks.find((block) => block.waitingOn != null);
  if (waitingBlock?.waitingOn) {
    return {
      kind: "waiting",
      lock: waitingBlock.waitingOn.lock,
      holderRef: waitingBlock.waitingOn.holderRef,
      holderTaskId: taskIdFromRef(waitingBlock.waitingOn.holderRef)
    };
  }
  if (implementationBlocks.some((block) => block.dispatchable)) {
    return { kind: "dispatchable" };
  }
  return { kind: "none" };
}
