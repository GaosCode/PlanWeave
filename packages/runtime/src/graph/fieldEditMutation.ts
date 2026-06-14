import { parseBlockRef } from "./compileTaskGraph.js";
import type { PlanPackageGraphMutation, PlanPackageGraphMutationSideEffect } from "./mutation.js";
import type {
  BlockType,
  ManifestBlock,
  ManifestImplementationBlock,
  ManifestReviewBlock,
  ManifestTaskNode,
  PlanPackageManifest,
  ReviewHookDefinition
} from "../types.js";

export type PlanPackageTaskFieldEditInput = {
  taskId: string;
  title?: string;
  promptMarkdown?: string;
  executor?: string | null;
};

export type PlanPackageTaskFieldEditMutation = PlanPackageGraphMutation & {
  taskId: string;
  updatedFields: string[];
};

export type PlanPackageBlockFieldEditInput = {
  blockRef: string;
  title?: string;
  promptMarkdown?: string;
  executor?: string | null;
  parallelSafe?: boolean;
  parallelLocks?: string[];
  reviewRequired?: boolean;
  maxFeedbackCycles?: number;
  reviewHook?: ReviewHookDefinition | null;
};

export type PlanPackageBlockFieldEditMutation = PlanPackageGraphMutation & {
  blockRef: string;
  taskId: string;
  blockId: string;
  blockType: BlockType;
  updatedFields: string[];
};

function nonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} must not be empty.`);
  }
  return trimmed;
}

function optionalText(value: string | null): string | undefined {
  if (value === null) {
    return undefined;
  }
  return nonEmpty(value, "executor");
}

function normalizeMaxFeedbackCycles(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("maxFeedbackCycles must be a non-negative integer.");
  }
  return value;
}

function requireTask(manifest: PlanPackageManifest, taskId: string): ManifestTaskNode {
  const task = manifest.nodes.find((node) => node.type === "task" && node.id === taskId);
  if (!task || task.type !== "task") {
    throw new Error(`Task '${taskId}' does not exist.`);
  }
  return task;
}

function replaceTask(manifest: PlanPackageManifest, task: ManifestTaskNode): PlanPackageManifest {
  return {
    ...manifest,
    nodes: manifest.nodes.map((node) => (node.type === "task" && node.id === task.id ? task : node))
  };
}

function editImplementationBlock(
  block: ManifestImplementationBlock,
  input: Pick<PlanPackageBlockFieldEditInput, "parallelSafe" | "parallelLocks">
): { block: ManifestImplementationBlock; fields: string[] } {
  const fields: string[] = [];
  let next = block;
  if (input.parallelSafe !== undefined) {
    next = { ...next, parallel: { ...next.parallel, safe: input.parallelSafe } };
    fields.push("parallel.safe");
  }
  if (input.parallelLocks !== undefined) {
    next = { ...next, parallel: { ...next.parallel, locks: input.parallelLocks.map((lock) => nonEmpty(lock, "parallel lock")) } };
    fields.push("parallel.locks");
  }
  return { block: next, fields };
}

function editReviewBlock(
  block: ManifestReviewBlock,
  input: Pick<PlanPackageBlockFieldEditInput, "reviewRequired" | "maxFeedbackCycles" | "reviewHook">
): { block: ManifestReviewBlock; fields: string[] } {
  const fields: string[] = [];
  let next = block;
  if (input.reviewRequired !== undefined) {
    next = { ...next, review: { ...next.review, required: input.reviewRequired } };
    fields.push("review.required");
  }
  if (input.maxFeedbackCycles !== undefined) {
    next = { ...next, review: { ...next.review, maxFeedbackCycles: normalizeMaxFeedbackCycles(input.maxFeedbackCycles) } };
    fields.push("review.maxFeedbackCycles");
  }
  if (input.reviewHook !== undefined) {
    next = { ...next, review: { ...next.review, hook: input.reviewHook } };
    fields.push("review.hook");
  }
  return { block: next, fields };
}

function ensureBlockFieldCompatibility(block: ManifestBlock, input: PlanPackageBlockFieldEditInput): void {
  if (block.type !== "implementation" && (input.parallelSafe !== undefined || input.parallelLocks !== undefined)) {
    throw new Error("parallel fields can only be edited on implementation blocks.");
  }
  if (
    block.type !== "review" &&
    (input.reviewRequired !== undefined || input.maxFeedbackCycles !== undefined || input.reviewHook !== undefined)
  ) {
    throw new Error("review fields can only be edited on review blocks.");
  }
}

function promptSideEffect(packagePath: string, markdown: string | undefined): PlanPackageGraphMutationSideEffect[] {
  return markdown === undefined ? [] : [{ kind: "writePrompt", packagePath, markdown }];
}

export function buildPlanPackageTaskFieldEditMutation(
  manifest: PlanPackageManifest,
  input: PlanPackageTaskFieldEditInput
): PlanPackageTaskFieldEditMutation {
  const task = requireTask(manifest, input.taskId);
  const updatedFields: string[] = [];
  let nextTask: ManifestTaskNode = task;
  if (input.title !== undefined) {
    nextTask = { ...nextTask, title: nonEmpty(input.title, "title") };
    updatedFields.push("title");
  }
  if (input.promptMarkdown !== undefined) {
    updatedFields.push("prompt");
  }
  if (input.executor !== undefined) {
    const executor = optionalText(input.executor);
    nextTask = {
      ...nextTask,
      ...(executor === undefined ? { executor: undefined } : { executor }),
      blocks: nextTask.blocks.map((block) => ({ ...block, executor: undefined }))
    };
    updatedFields.push("executor");
  }
  if (updatedFields.length === 0) {
    throw new Error("edit-task requires at least one field to update.");
  }
  return {
    taskId: input.taskId,
    updatedFields,
    affectedTasks: [input.taskId],
    nextManifest: replaceTask(manifest, nextTask),
    sideEffects: promptSideEffect(nextTask.prompt, input.promptMarkdown)
  };
}

export function buildPlanPackageBlockFieldEditMutation(
  manifest: PlanPackageManifest,
  input: PlanPackageBlockFieldEditInput
): PlanPackageBlockFieldEditMutation {
  const { taskId, blockId } = parseBlockRef(input.blockRef);
  const task = requireTask(manifest, taskId);
  const block = task.blocks.find((item) => item.id === blockId);
  if (!block) {
    throw new Error(`Block '${input.blockRef}' does not exist.`);
  }
  ensureBlockFieldCompatibility(block, input);

  const updatedFields: string[] = [];
  let nextBlock: ManifestBlock = block;
  if (input.title !== undefined) {
    nextBlock = { ...nextBlock, title: nonEmpty(input.title, "title") };
    updatedFields.push("title");
  }
  if (input.promptMarkdown !== undefined) {
    updatedFields.push("prompt");
  }
  if (input.executor !== undefined) {
    const executor = optionalText(input.executor);
    nextBlock = executor === undefined ? { ...nextBlock, executor: undefined } : { ...nextBlock, executor };
    updatedFields.push("executor");
  }
  if (nextBlock.type === "implementation") {
    const edited = editImplementationBlock(nextBlock, input);
    nextBlock = edited.block;
    updatedFields.push(...edited.fields);
  } else {
    const edited = editReviewBlock(nextBlock, input);
    nextBlock = edited.block;
    updatedFields.push(...edited.fields);
  }
  if (updatedFields.length === 0) {
    throw new Error("edit-block requires at least one field to update.");
  }

  const nextTask: ManifestTaskNode = {
    ...task,
    blocks: task.blocks.map((item) => (item.id === blockId ? nextBlock : item))
  };
  return {
    blockRef: input.blockRef,
    taskId,
    blockId,
    blockType: block.type,
    updatedFields,
    affectedTasks: [taskId],
    nextManifest: replaceTask(manifest, nextTask),
    sideEffects: promptSideEffect(nextBlock.prompt, input.promptMarkdown)
  };
}
