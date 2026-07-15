import type { BlockType, ProjectTaskRef, ReviewHookDefinition } from "@planweave-ai/runtime";
import {
  blockRefFromArgs,
  jsonToolResult,
  nonEmptyString,
  optionalNullableString,
  optionalStringArray,
  parseProjectCanvasArgs,
  readObjectArgs
} from "./toolHelpers.js";
import {
  parseCreateTaskToolArgs,
  parseUpdateBlockToolArgs,
  parseUpdateReviewPipelineToolArgs,
  parseUpdateTaskToolArgs
} from "./toolInputSchemas.js";
import type { RuntimeGateway } from "./toolTypes.js";

export {
  parseCreateTaskToolArgs,
  parseUpdateBlockToolArgs,
  parseUpdateReviewPipelineToolArgs,
  parseUpdateTaskToolArgs
};

export function parseCreateBlockInput(record: Record<string, unknown>) {
  return {
    taskId: nonEmptyString(record.taskId, "taskId"),
    type: parseBlockType(record.type),
    title: nonEmptyString(record.title, "title"),
    promptMarkdown: requiredMarkdown(record.promptMarkdown),
    executor: optionalNullableString(record.executor, "executor"),
    dependsOn: optionalStringArray(record.dependsOn, "dependsOn")
  };
}

export function parseTaskAcceptanceInput(record: Record<string, unknown>): string[] {
  const acceptance = requiredStringArray(record.acceptance, "acceptance");
  if (acceptance.length === 0) {
    throw new Error("acceptance must include at least one item.");
  }
  return acceptance;
}

export function parseBlockDependenciesInput(record: Record<string, unknown>): string[] {
  return requiredStringArray(record.dependsOn, "dependsOn");
}

export function parseBlockPlanningInput(record: Record<string, unknown>) {
  const input = {
    sharedResources:
      record.sharedResources === undefined
        ? undefined
        : requiredStringArray(record.sharedResources, "sharedResources"),
    reviewRequired: optionalBoolean(record.reviewRequired, "reviewRequired"),
    maxFeedbackCycles: optionalNonNegativeInteger(record.maxFeedbackCycles, "maxFeedbackCycles"),
    reviewHook: parseOptionalReviewHook(record.reviewHook, "reviewHook")
  };
  if (
    input.sharedResources === undefined &&
    input.reviewRequired === undefined &&
    input.maxFeedbackCycles === undefined &&
    input.reviewHook === undefined
  ) {
    throw new Error("At least one block planning field must be provided.");
  }
  return input;
}

export function parseCanvasExecutionPolicyInput(record: Record<string, unknown>) {
  const input = {
    defaultExecutor: optionalNullableString(record.defaultExecutor, "defaultExecutor"),
    parallelEnabled: optionalBoolean(record.parallelEnabled, "parallelEnabled"),
    maxConcurrent: optionalPositiveInteger(record.maxConcurrent, "maxConcurrent")
  };
  if (
    input.defaultExecutor === undefined &&
    input.parallelEnabled === undefined &&
    input.maxConcurrent === undefined
  ) {
    throw new Error("At least one execution policy field must be provided.");
  }
  return input;
}

export function parseProjectTaskRefs(record: Record<string, unknown>): {
  from: ProjectTaskRef;
  to: ProjectTaskRef;
} {
  return {
    from: {
      canvasId: nonEmptyString(record.fromCanvasId, "fromCanvasId"),
      taskId: nonEmptyString(record.fromTaskId, "fromTaskId")
    },
    to: {
      canvasId: nonEmptyString(record.toCanvasId, "toCanvasId"),
      taskId: nonEmptyString(record.toTaskId, "toTaskId")
    }
  };
}

export function requiredMarkdown(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("markdown or promptMarkdown must be a string.");
  }
  return value;
}

export async function readPrompt(args: unknown, gateway: RuntimeGateway) {
  const record = readObjectArgs(args);
  const { projectId, canvasId } = parseProjectCanvasArgs(record);
  const target = nonEmptyString(record.target, "target");
  if (target === "project") {
    return jsonToolResult({ target, markdown: await gateway.readProjectPrompt(projectId) });
  }
  if (target === "task") {
    const task = await gateway.getTaskDetail(
      projectId,
      nonEmptyString(record.taskId, "taskId"),
      canvasId
    );
    return jsonToolResult({
      target,
      taskId: task.taskId,
      markdown: task.promptMarkdown,
      promptMissing: task.promptMissing
    });
  }
  if (target === "block") {
    const block = await gateway.getBlockDetail(projectId, blockRefFromArgs(record), canvasId);
    return jsonToolResult({
      target,
      blockRef: block.ref,
      markdown: record.rendered === true ? block.promptSurfaceMarkdown : block.promptMarkdown,
      promptMissing: block.promptMissing,
      rendered: record.rendered === true
    });
  }
  throw new Error("target must be one of: project, task, block.");
}

function parseBlockType(value: unknown, field = "type"): BlockType {
  if (value !== "implementation" && value !== "review") {
    throw new Error(`${field} must be one of: implementation, review.`);
  }
  return value;
}

function requiredStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array.`);
  }
  return value.map((item, index) => nonEmptyString(item, `${field}[${index}]`));
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseReviewHook(value: unknown, field: string): ReviewHookDefinition {
  const record = recordValue(value, field);
  const args = record.args === undefined ? [] : requiredStringArray(record.args, `${field}.args`);
  const hook = {
    id: nonEmptyString(record.id, `${field}.id`),
    type: nonEmptyString(record.type, `${field}.type`),
    command: nonEmptyString(record.command, `${field}.command`),
    args,
    executionPolicy: nonEmptyString(record.executionPolicy, `${field}.executionPolicy`)
  };
  if (hook.type !== "executable") {
    throw new Error(`${field}.type must be executable.`);
  }
  if (hook.executionPolicy !== "trusted-local") {
    throw new Error(`${field}.executionPolicy must be trusted-local.`);
  }
  return { ...hook, type: "executable", executionPolicy: "trusted-local" };
}

function parseOptionalReviewHook(
  value: unknown,
  field: string
): ReviewHookDefinition | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return parseReviewHook(value, field);
}
