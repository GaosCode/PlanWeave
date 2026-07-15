import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GraphEditResult } from "@planweave-ai/runtime";
import {
  blockRefFromArgs,
  jsonToolResult,
  nonEmptyString,
  optionalNonEmptyString,
  optionalStringArray,
  readObjectArgs,
  summarizeGraphEdit
} from "./toolHelpers.js";
import {
  parseBlockPlanningInput,
  parseCanvasExecutionPolicyInput,
  parseCreateBlockInput,
  parseCreateTaskToolArgs,
  parseUpdateReviewPipelineToolArgs
} from "./toolParsers.js";
import type { RuntimeGateway } from "./toolTypes.js";

export function parseTaskDependencyEdges(
  value: unknown
): Array<{ dependentTaskId: string; dependsOnTaskId: string }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("edges must contain at least one dependency.");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`edges[${index}] must be an object.`);
    }
    const record = item as Record<string, unknown>;
    return {
      dependentTaskId: nonEmptyString(record.dependentTaskId, `edges[${index}].dependentTaskId`),
      dependsOnTaskId: nonEmptyString(record.dependsOnTaskId, `edges[${index}].dependsOnTaskId`)
    };
  });
}

export function parseTaskDependencyUpdates(
  value: unknown
): Array<{ taskId: string; dependsOn: string[] }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("updates must contain at least one task dependency update.");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`updates[${index}] must be an object.`);
    }
    const record = item as Record<string, unknown>;
    return {
      taskId: nonEmptyString(record.taskId, `updates[${index}].taskId`),
      dependsOn: requiredStringArrayValue(record.dependsOn, `updates[${index}].dependsOn`)
    };
  });
}

export function parseBulkCreateTasks(
  record: Record<string, unknown>,
  projectId: string,
  canvasId: string | undefined
): Parameters<RuntimeGateway["bulkCreateTasks"]>[2] {
  return requiredObjectArray(record.tasks, "tasks").map(
    (item) => parseCreateTaskToolArgs({ ...item, projectId, canvasId }).input
  );
}

export function parseBulkCreateBlocks(
  record: Record<string, unknown>
): Parameters<RuntimeGateway["bulkCreateBlocks"]>[2] {
  return requiredObjectArray(record.blocks, "blocks").map(parseCreateBlockInput);
}

export function parseBulkUpdateTasks(
  record: Record<string, unknown>
): Parameters<RuntimeGateway["bulkUpdateTasks"]>[2] {
  return requiredObjectArray(record.updates, "updates").map((item) => {
    const input = {
      title: optionalNonEmptyString(item.title, "title"),
      promptMarkdown: optionalMarkdownValue(item.promptMarkdown, "promptMarkdown"),
      executor:
        item.executor === undefined || item.executor === null
          ? item.executor
          : nonEmptyString(item.executor, "executor"),
      acceptance: optionalStringArray(item.acceptance, "acceptance")
    };
    if (Object.values(input).every((value) => value === undefined)) {
      throw new Error("At least one task field must be provided.");
    }
    return { taskId: nonEmptyString(item.taskId, "taskId"), input };
  });
}

export function parseBulkUpdateBlocks(
  record: Record<string, unknown>
): Parameters<RuntimeGateway["bulkUpdateBlocks"]>[2] {
  return requiredObjectArray(record.updates, "updates").map((item) => {
    const planning: Partial<ReturnType<typeof parseBlockPlanningInput>> = [
      "sharedResources",
      "reviewRequired",
      "maxFeedbackCycles",
      "reviewHook"
    ].some((field) => item[field] !== undefined)
      ? parseBlockPlanningInput(item)
      : {};
    const input = {
      title: optionalNonEmptyString(item.title, "title"),
      promptMarkdown: optionalMarkdownValue(item.promptMarkdown, "promptMarkdown"),
      executor:
        item.executor === undefined || item.executor === null
          ? item.executor
          : nonEmptyString(item.executor, "executor"),
      dependsOn: parseOptionalBlockDependencies(item.dependsOn, "dependsOn"),
      sharedResources: planning.sharedResources,
      reviewRequired: planning.reviewRequired,
      maxFeedbackCycles: planning.maxFeedbackCycles,
      reviewHook: planning.reviewHook
    };
    if (Object.values(input).every((value) => value === undefined)) {
      throw new Error("At least one block field must be provided.");
    }
    return { blockRef: blockRefFromArgs(item), input };
  });
}

export function parseBulkRemoveGraphItems(
  record: Record<string, unknown>
): Parameters<RuntimeGateway["bulkRemoveGraphItems"]>[2] {
  const input = {
    tasks: optionalStringArray(record.tasks, "tasks") ?? [],
    blocks: parseBulkRemoveBlocks(record.blocks),
    taskDependencyEdges: parseOptionalTaskDependencyEdges(record.taskDependencyEdges),
    blockDependencyRefs: parseBlockDependencyRefs(record.blockDependencyRefs)
  };
  if (
    input.tasks.length === 0 &&
    input.blocks.length === 0 &&
    input.taskDependencyEdges.length === 0 &&
    input.blockDependencyRefs.length === 0
  ) {
    throw new Error("bulk_remove_graph_items requires at least one item to remove.");
  }
  return input;
}

export function parseBlockDependencyUpdates(
  value: unknown
): Array<{ blockRef: string; dependsOn: string[] }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("updates must contain at least one block dependency update.");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`updates[${index}] must be an object.`);
    }
    const record = item as Record<string, unknown>;
    return {
      blockRef: blockRefFromArgs(record),
      dependsOn: requiredStringArrayValue(record.dependsOn, `updates[${index}].dependsOn`)
    };
  });
}

export function parseBulkReviewPipelineUpdates(
  record: Record<string, unknown>,
  projectId: string,
  canvasId: string | undefined
): Array<{ taskId: string; input: Parameters<RuntimeGateway["updateReviewPipeline"]>[3] }> {
  if (!Array.isArray(record.updates) || record.updates.length === 0) {
    throw new Error("updates must contain at least one review pipeline update.");
  }
  const seenTaskIds = new Set<string>();
  return record.updates.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`updates[${index}] must be an object.`);
    }
    const parsed = parseUpdateReviewPipelineToolArgs({
      projectId,
      canvasId,
      ...(item as Record<string, unknown>)
    });
    if (seenTaskIds.has(parsed.taskId)) {
      throw new Error(`updates must not contain duplicate taskId: ${parsed.taskId}`);
    }
    seenTaskIds.add(parsed.taskId);
    return { taskId: parsed.taskId, input: parsed.input };
  });
}

export function parseBulkParallelPolicyInput(record: Record<string, unknown>): {
  canvasPolicy: Parameters<RuntimeGateway["updateCanvasExecutionPolicy"]>[2] | undefined;
  blocks: Parameters<RuntimeGateway["bulkUpdateParallelPolicy"]>[2]["blocks"];
} {
  const canvasPolicy =
    record.canvasPolicy === undefined
      ? undefined
      : parseCanvasExecutionPolicyInput(readObjectArgs(record.canvasPolicy));
  const rawBlocks = record.blocks === undefined ? [] : record.blocks;
  if (!Array.isArray(rawBlocks)) {
    throw new Error("blocks must be an array when provided.");
  }
  const blocks = rawBlocks.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`blocks[${index}] must be an object.`);
    }
    const blockRecord = item as Record<string, unknown>;
    const blockPlanning = parseBlockPlanningInput(blockRecord);
    return {
      blockRef: blockRefFromArgs(blockRecord),
      input: {
        sharedResources: blockPlanning.sharedResources
      }
    };
  });
  if (!canvasPolicy && blocks.length === 0) {
    throw new Error(
      "bulk_update_parallel_policy requires canvasPolicy or at least one block update."
    );
  }
  return { canvasPolicy, blocks };
}

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

function requiredStringArrayValue(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return value.map((item, index) => nonEmptyString(item, `${field}[${index}]`));
}

function requiredObjectArray(value: unknown, field: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must contain at least one item.`);
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${field}[${index}] must be an object.`);
    }
    return item as Record<string, unknown>;
  });
}

function parseOptionalBlockDependencies(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requiredStringArrayValue(value, field);
}

function optionalMarkdownValue(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return value;
}

function parseBulkRemoveBlocks(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("blocks must be an array.");
  }
  return value.map((item, index) => {
    if (typeof item === "string") {
      return nonEmptyString(item, `blocks[${index}]`);
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`blocks[${index}] must be a block ref string or object.`);
    }
    return blockRefFromArgs(item as Record<string, unknown>);
  });
}

function parseOptionalTaskDependencyEdges(
  value: unknown
): Array<{ dependentTaskId: string; dependsOnTaskId: string }> {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value) && value.length === 0) {
    return [];
  }
  return parseTaskDependencyEdges(value);
}

function parseBlockDependencyRefs(
  value: unknown
): Array<{ blockRef: string; dependsOnBlockId: string }> {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value) && value.length === 0) {
    return [];
  }
  return requiredObjectArray(value, "blockDependencyRefs").map((item, index) => ({
    blockRef: blockRefFromArgs(item),
    dependsOnBlockId: nonEmptyString(
      item.dependsOnBlockId,
      `blockDependencyRefs[${index}].dependsOnBlockId`
    )
  }));
}
