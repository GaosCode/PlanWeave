import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GraphEditResult } from "@planweave-ai/runtime";
import { jsonToolResult, summarizeGraphEdit } from "./toolHelpers.js";
import {
  parseBlockDependencyUpdates,
  parseBulkCreateBlocks,
  parseBulkCreateTasks,
  parseBulkParallelPolicyInput,
  parseBulkRemoveGraphItems,
  parseBulkReviewPipelineUpdates,
  parseBulkUpdateBlocks,
  parseBulkUpdateTasks,
  parseTaskDependencyEdges,
  parseTaskDependencyUpdates
} from "./toolStructuredEditSchemas.js";
import type { RuntimeGateway } from "./toolTypes.js";

export {
  parseBlockDependencyUpdates,
  parseBulkCreateBlocks,
  parseBulkCreateTasks,
  parseBulkParallelPolicyInput,
  parseBulkRemoveGraphItems,
  parseBulkReviewPipelineUpdates,
  parseBulkUpdateBlocks,
  parseBulkUpdateTasks,
  parseTaskDependencyEdges,
  parseTaskDependencyUpdates
};

export function affectedBlockRefsForTasks(result: GraphEditResult, taskIds: string[]): string[] {
  if (!result.ok || !result.graph) {
    return [];
  }
  const { graph } = result;
  return taskIds.flatMap((taskId) => graph.blocksByTask?.get(taskId) ?? []);
}

export function createdBlockRefsForInputs(
  result: GraphEditResult,
  inputs: Parameters<RuntimeGateway["bulkCreateBlocks"]>[2]
): string[] {
  if (!result.ok || !result.graph) {
    return [];
  }
  const { graph } = result;
  const countByTask = new Map<string, number>();
  for (const input of inputs) {
    countByTask.set(input.taskId, (countByTask.get(input.taskId) ?? 0) + 1);
  }
  return [...countByTask.entries()].flatMap(([taskId, count]) => {
    const refs = graph.blocksByTask?.get(taskId) ?? [];
    return refs.slice(Math.max(0, refs.length - count));
  });
}

export function reviewBlockRefsForPipelineUpdates(
  result: GraphEditResult,
  updates: Array<{ taskId: string; input: Parameters<RuntimeGateway["updateReviewPipeline"]>[3] }>
): string[] {
  if (!result.ok || !result.graph) {
    return [];
  }
  const refs: string[] = [];
  for (const update of updates) {
    const reviewRefs = result.graph.reviewBlocksByTask?.get(update.taskId) ?? [];
    const existingRefByBlockId = new Map(reviewRefs.map((ref) => [blockIdFromRef(ref), ref]));
    const used = new Set<string>();
    for (let index = 0; index < update.input.steps.length; index += 1) {
      const step = update.input.steps[index];
      const requested = step.blockId ? existingRefByBlockId.get(step.blockId) : undefined;
      const ref = requested ?? reviewRefs[index];
      if (isBlockRef(ref) && !used.has(ref)) {
        refs.push(ref);
        used.add(ref);
      }
    }
  }
  return refs;
}

export function bulkGraphEditResult(
  result: GraphEditResult,
  options: { affectedBlocks?: string[] } = {}
): CallToolResult {
  const edit = summarizeGraphEdit(result);
  const affectedBlocks = options.affectedBlocks ?? [];
  return jsonToolResult({
    bulkEdit: {
      ok: edit.ok,
      counts: {
        affectedTaskCount: edit.affectedTasks.length,
        affectedBlockCount: affectedBlocks.length,
        diagnosticCount: edit.diagnostics.length
      },
      affectedTasks: edit.affectedTasks,
      affectedBlocks,
      diagnostics: edit.diagnostics
    }
  });
}

function blockIdFromRef(ref: string): string {
  const separator = ref.indexOf("#");
  return separator >= 0 ? ref.slice(separator + 1) : "";
}

function isBlockRef(value: string | undefined): value is string {
  return typeof value === "string" && value.includes("#") && blockIdFromRef(value).trim() !== "";
}
