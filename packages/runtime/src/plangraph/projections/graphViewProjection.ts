import type { BlockStatus, TaskStatus } from "../../types.js";
import type { ExecutionStatus } from "../../taskManager/executionStatus.js";
import type { RuntimeContext } from "../../taskManager/runtimeContext.js";
import type {
  DesktopBlockPreview,
  DesktopGraphEdgeViewModel,
  DesktopTaskException,
  DesktopTaskNodeViewModel
} from "../../desktop/types.js";
import type { PlanGraph, PlanGraphBlockNode, PlanGraphTaskNode } from "../domain/types.js";

export type PlanGraphViewProjection = {
  graphVersion: string;
  tasks: DesktopTaskNodeViewModel[];
  edges: DesktopGraphEdgeViewModel[];
};

function blockStatus(
  status: ExecutionStatus,
  ref: string
): { status: BlockStatus; reason: string | null } {
  const block = status.blocks.find((item) => item.ref === ref);
  return {
    status: block?.status ?? "planned",
    reason: block?.reason ?? null
  };
}

function taskStatus(status: ExecutionStatus, taskId: string): TaskStatus {
  return status.tasks.find((item) => item.taskId === taskId)?.status ?? "planned";
}

function exceptionForBlock(
  ref: string,
  status: BlockStatus,
  reason: string | null
): DesktopTaskException | null {
  if (status === "blocked") {
    return { ref, source: "blocked", reason: reason ?? `${ref} is blocked.` };
  }
  if (status === "diverged") {
    return { ref, source: "diverged", reason: reason ?? `${ref} diverged from expected work.` };
  }
  if (status === "needs_changes") {
    return { ref, source: "needs_changes", reason: reason ?? `${ref} needs changes.` };
  }
  return null;
}

function effectiveExecutor(
  task: PlanGraphTaskNode,
  block: PlanGraphBlockNode,
  runtime: RuntimeContext
): string | null {
  return block.executor ?? task.executor ?? runtime.manifest.execution.defaultExecutor ?? null;
}

function executorLabel(task: PlanGraphTaskNode, graph: PlanGraph, runtime: RuntimeContext): string {
  const blockExecutors = new Set(
    task.blockRefs.map((ref) => {
      const block = graph.blocks.get(ref);
      return block
        ? effectiveExecutor(task, block, runtime)
        : (task.executor ?? runtime.manifest.execution.defaultExecutor ?? null);
    })
  );
  if (blockExecutors.size > 1) {
    return "Mixed";
  }
  return (
    [...blockExecutors][0] ??
    task.executor ??
    runtime.manifest.execution.defaultExecutor ??
    "manual"
  );
}

function sortedBlockRefsForTask(graph: PlanGraph, task: PlanGraphTaskNode): string[] {
  const refs = task.blockRefs;
  const order = new Map(refs.map((ref, index) => [ref, index]));
  const dependencies = new Map(
    refs.map((ref) => [ref, new Set(graph.blocks.get(ref)?.dependsOn ?? [])])
  );
  const dependents = new Map<string, string[]>();
  for (const ref of refs) {
    for (const dependency of graph.blocks.get(ref)?.dependsOn ?? []) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), ref]);
    }
  }
  const sorted: string[] = [];
  const ready = refs.filter((ref) => (dependencies.get(ref)?.size ?? 0) === 0);

  while (ready.length > 0) {
    ready.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
    const current = ready.shift();
    if (!current || sorted.includes(current)) {
      continue;
    }
    sorted.push(current);
    for (const dependent of dependents.get(current) ?? []) {
      const remaining = dependencies.get(dependent);
      if (!remaining) {
        continue;
      }
      remaining.delete(current);
      if (remaining.size === 0) {
        ready.push(dependent);
      }
    }
  }

  return sorted.length === refs.length ? sorted : refs;
}

function blockPreview(
  graph: PlanGraph,
  runtime: RuntimeContext,
  task: PlanGraphTaskNode,
  block: PlanGraphBlockNode,
  status: ExecutionStatus
): DesktopBlockPreview {
  const currentStatus = blockStatus(status, block.ref);
  return {
    ref: block.ref,
    blockId: block.blockId,
    type: block.type,
    title: block.title,
    status: currentStatus.status,
    executor: effectiveExecutor(task, block, runtime),
    promptMissing: block.promptRef.contentHash.length === 0,
    exceptionReason: currentStatus.reason
  };
}

export function buildPlanGraphViewProjection(options: {
  graph: PlanGraph;
  runtime: RuntimeContext;
  status: ExecutionStatus;
  taskPromptMarkdownById?: Map<string, string>;
}): PlanGraphViewProjection {
  const tasks: DesktopTaskNodeViewModel[] = [];
  for (const task of options.graph.tasks.values()) {
    const orderedRefs = sortedBlockRefsForTask(options.graph, task);
    const blocks = orderedRefs
      .map((ref) => options.graph.blocks.get(ref))
      .filter((block): block is PlanGraphBlockNode => block !== undefined)
      .map((block) => blockPreview(options.graph, options.runtime, task, block, options.status));
    const visibleBlocks = blocks.slice(0, 4);
    const exceptions = blocks
      .map((block) => exceptionForBlock(block.ref, block.status, block.exceptionReason))
      .filter((item): item is DesktopTaskException => item !== null);
    if ((options.runtime.state.tasks[task.taskId]?.openFeedbackCount ?? 0) > 0) {
      exceptions.push({
        ref: task.taskId,
        source: "feedback",
        reason: `${options.runtime.state.tasks[task.taskId].openFeedbackCount} unresolved feedback item(s).`
      });
    }
    tasks.push({
      taskId: task.taskId,
      title: task.title,
      status: taskStatus(options.status, task.taskId),
      executor: task.executor,
      executorLabel: executorLabel(task, options.graph, options.runtime),
      promptMarkdown: options.taskPromptMarkdownById?.get(task.taskId) ?? "",
      promptHash: task.promptRef.contentHash,
      promptMissing: task.promptRef.contentHash.length === 0,
      promptPreview: task.promptRef.preview,
      blocks,
      blockPreview: visibleBlocks,
      hiddenBlockRefs: orderedRefs.slice(visibleBlocks.length),
      overflowBlockCount: Math.max(0, orderedRefs.length - visibleBlocks.length),
      exceptions
    });
  }

  return {
    graphVersion: options.graph.graphVersion,
    tasks,
    edges: options.graph.edges
      .filter((edge) => edge.type === "taskDependsOn")
      .map((edge) => ({ from: edge.fromTaskId, to: edge.toTaskId, type: "depends_on" }))
  };
}
