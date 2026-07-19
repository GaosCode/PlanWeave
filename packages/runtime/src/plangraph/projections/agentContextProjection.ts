import type { ExecutionStatus } from "../../taskManager/executionStatus.js";
import type { PlanGraph, PlanGraphBlockNode, PlanGraphTaskNode } from "../domain/types.js";
import {
  selectDownstreamTasks,
  selectTask,
  selectTaskBlocks,
  selectUpstreamTasks
} from "../domain/selectors.js";

function lineList(lines: string[]): string {
  return lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : "- None.";
}

function statusByBlockRef(status?: ExecutionStatus): Map<string, string> | undefined {
  if (status === undefined) {
    return undefined;
  }
  return new Map(status.blocks.map((block) => [block.ref, block.status]));
}

function blockStatusLabel(
  block: PlanGraphBlockNode,
  statuses: Map<string, string> | undefined
): string {
  if (statuses === undefined) {
    // Claim markdown may be rendered without an attached execution status projection.
    return "planned";
  }
  const status = statuses.get(block.ref);
  if (status === undefined) {
    throw new Error(
      `Internal runtime invariant violated: missing block status for '${block.ref}' in execution status.`
    );
  }
  return status;
}

function blockLine(block: PlanGraphBlockNode, statuses: Map<string, string> | undefined): string {
  const dependencyText =
    block.dependsOn.length > 0 ? `; depends on ${block.dependsOn.join(", ")}` : "";
  return `${block.ref} [${block.type}] ${block.title} (${blockStatusLabel(block, statuses)}${dependencyText})`;
}

function taskLine(task: PlanGraphTaskNode): string {
  return `${task.taskId}: ${task.title}`;
}

export function buildAgentClaimMarkdown(options: {
  graph: PlanGraph;
  ref: string;
  status?: ExecutionStatus;
}): string {
  const block = options.graph.blocks.get(options.ref);
  if (!block) {
    throw new Error(`PlanGraph block '${options.ref}' does not exist.`);
  }
  const task = selectTask(options.graph, block.taskId);
  if (!task) {
    throw new Error(`PlanGraph task '${block.taskId}' does not exist.`);
  }
  const statuses = statusByBlockRef(options.status);
  const upstreamTasks = selectUpstreamTasks(options.graph, task.taskId).map(taskLine);
  const downstreamTasks = selectDownstreamTasks(options.graph, task.taskId).map(taskLine);
  const taskBlocks = selectTaskBlocks(options.graph, task.taskId).map((item) =>
    blockLine(item, statuses)
  );
  const directDependencies = block.dependsOn.map((ref) => {
    const dependency = options.graph.blocks.get(ref);
    return dependency ? blockLine(dependency, statuses) : `${ref} (missing)`;
  });

  return [
    `PlanGraph version: ${options.graph.graphVersion}`,
    `Current claim: ${block.ref} (${block.type})`,
    `Task: ${task.taskId}: ${task.title}`,
    "",
    "### Upstream Tasks",
    lineList(upstreamTasks),
    "",
    "### Downstream Tasks",
    lineList(downstreamTasks),
    "",
    "### Task Blocks",
    lineList(taskBlocks),
    "",
    "### Direct Block Dependencies",
    lineList(directDependencies)
  ].join("\n");
}
