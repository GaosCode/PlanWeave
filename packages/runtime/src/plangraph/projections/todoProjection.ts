import type { ExecutionStatus } from "../../taskManager/executionStatus.js";
import type { RuntimeContext } from "../../taskManager/runtimeContext.js";
import type {
  DesktopProjectExecutionPhase,
  DesktopProjectExecutionPlan,
  DesktopTodoGroups,
  DesktopTodoItem
} from "../../desktop/types.js";
import type { ValidationIssue } from "../../types.js";
import type { ProjectCanvasAggregationContext } from "../../desktop/graph/projectCanvasAggregation.js";
import { getBlock } from "../../desktop/graph/graphHelpers.js";
import type { PlanGraph } from "../domain/types.js";

export type CanvasTodoRuntimeContext = RuntimeContext & {
  status: ExecutionStatus;
};

export type CanvasExecutionSnapshot = {
  groups: DesktopTodoGroups;
  projectBlockedReadyCount: number;
  taskCount: number;
  runtime: RuntimeContext | null;
  status: ExecutionStatus | null;
  error: unknown | null;
  graphVersion: string | null;
};

export type ProjectTodoContext = {
  aggregation: ProjectCanvasAggregationContext;
  snapshotsByCanvas: Map<string, CanvasExecutionSnapshot>;
  diagnostics: ValidationIssue[];
};

export type TodoProjectionInput = {
  graphVersion: string;
  runtime: RuntimeContext;
  status: ExecutionStatus;
  planGraph?: PlanGraph;
  canvasMeta?: { canvasId: string; canvasName: string };
};

export type TodoProjection = {
  graphVersion: string;
  groups: DesktopTodoGroups;
  projectBlockedReadyCount: number;
};

export function emptyTodoGroups(): DesktopTodoGroups {
  return {
    planned: [],
    ready: [],
    in_progress: [],
    completed: [],
    needs_changes: [],
    blocked: [],
    diverged: [],
    implemented: []
  };
}

function blockTitle(input: TodoProjectionInput, ref: string): string {
  return input.planGraph?.blocks.get(ref)?.title ?? getBlock(input.runtime.graph, ref).title;
}

export function buildTodoProjection(input: TodoProjectionInput): TodoProjection {
  const { runtime, status } = input;
  const taskStatusById = new Map(status.tasks.map((task) => [task.taskId, task.status]));
  const claimHintByRef = new Map(status.claimHints.map((hint) => [hint.ref, hint]));
  const groups = emptyTodoGroups();
  let projectBlockedReadyCount = 0;

  for (const blockStatus of status.blocks) {
    const claimHint = claimHintByRef.get(blockStatus.ref);
    const dependencyBlockers = claimHint
      ? [...claimHint.blockedByTasks, ...claimHint.blockedByBlocks, ...claimHint.blockedByProject]
      : [];
    if (blockStatus.status === "ready" && (claimHint?.blockedByProject.length ?? 0) > 0) {
      projectBlockedReadyCount += 1;
    }
    const displayStatus =
      blockStatus.status === "ready" && dependencyBlockers.length > 0
        ? "planned"
        : blockStatus.status;
    const groupName: keyof DesktopTodoGroups =
      taskStatusById.get(blockStatus.taskId) === "implemented" ? "implemented" : displayStatus;
    const item: DesktopTodoItem = {
      canvasId: input.canvasMeta?.canvasId,
      canvasName: input.canvasMeta?.canvasName,
      ref: blockStatus.ref,
      taskId: blockStatus.taskId,
      blockId: blockStatus.blockId,
      title: blockTitle(input, blockStatus.ref),
      status: displayStatus,
      dependencyBlockers,
      dispatchable: claimHint?.dispatchable ?? false,
      sharedResources: runtime.graph.sharedResourcesByBlockRef.get(blockStatus.ref) ?? [],
      reviewGate: claimHint?.reviewGate ?? null
    };
    groups[groupName].push(item);
  }

  return {
    graphVersion: input.graphVersion,
    groups,
    projectBlockedReadyCount
  };
}

export function buildTodoGroupsFromContext(context: ProjectTodoContext): DesktopTodoGroups {
  const { aggregation, snapshotsByCanvas } = context;
  const groups = emptyTodoGroups();
  for (const canvasId of aggregation.orderedCanvasIds) {
    const snapshot = snapshotsByCanvas.get(canvasId);
    if (!snapshot) {
      continue;
    }
    for (const [groupName, items] of Object.entries(snapshot.groups) as Array<
      [keyof DesktopTodoGroups, DesktopTodoItem[]]
    >) {
      groups[groupName].push(...items);
    }
  }
  return groups;
}

function executionPhaseFromGroups(
  phaseIndex: number,
  canvasId: string,
  canvasName: string,
  taskCount: number,
  groups: DesktopTodoGroups,
  projectBlockedReadyCount = 0
): DesktopProjectExecutionPhase {
  const readyQueue = groups.ready;
  return {
    phaseIndex,
    canvasId,
    canvasName,
    taskCount,
    readyQueue,
    parallelReadyQueue: readyQueue.filter((item) => item.reviewGate === null),
    sequentialReadyQueue: readyQueue.filter((item) => item.reviewGate !== null),
    blockedCount:
      groups.blocked.length +
      groups.diverged.length +
      groups.needs_changes.length +
      projectBlockedReadyCount,
    inProgressCount: groups.in_progress.length,
    completedCount: groups.completed.length + groups.implemented.length
  };
}

export function buildProjectExecutionPlanProjection(
  context: ProjectTodoContext
): DesktopProjectExecutionPlan {
  const { aggregation, snapshotsByCanvas } = context;
  const phases = aggregation.orderedCanvasIds.flatMap((canvasId, index) => {
    const canvas = aggregation.canvasesById.get(canvasId);
    const snapshot = snapshotsByCanvas.get(canvasId);
    if (!canvas || !snapshot) {
      return [];
    }
    return [
      executionPhaseFromGroups(
        index + 1,
        canvasId,
        canvas.canvasName,
        snapshot.taskCount,
        snapshot.groups,
        snapshot.projectBlockedReadyCount
      )
    ];
  });
  return {
    phases,
    readyQueue: phases.flatMap((phase) => phase.readyQueue),
    notes: aggregation.notes
  };
}
