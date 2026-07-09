import { parseBlockRef } from "./compileTaskGraph.js";
import { withExclusiveLock } from "./parallelLocks.js";
import {
  buildPlanPackageManifestChangeMutation,
  writePromptSideEffects,
  type PlanPackageGraphMutation
} from "./mutation.js";
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
  acceptance?: string[];
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
  dependsOn?: string[];
  /** @deprecated Prefer exclusive; maps to reserved exclusive lock. */
  parallelSafe?: boolean;
  exclusive?: boolean;
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

function nonEmptyStringArray(value: string[], field: string): string[] {
  const normalized = value.map((item, index) => nonEmpty(item, `${field}[${index}]`));
  if (normalized.length === 0) {
    throw new Error(`${field} must include at least one item.`);
  }
  return normalized;
}

function stringArray(value: string[], field: string): string[] {
  return value.map((item, index) => nonEmpty(item, `${field}[${index}]`));
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
  input: Pick<PlanPackageBlockFieldEditInput, "parallelSafe" | "exclusive" | "parallelLocks">
): { block: ManifestImplementationBlock; fields: string[] } {
  const fields: string[] = [];
  let next = block;
  let locks = [...next.parallel.locks];
  let locksTouched = false;
  if (input.parallelLocks !== undefined) {
    locks = input.parallelLocks.map((lock) => nonEmpty(lock, "parallel lock"));
    locksTouched = true;
    fields.push("parallel.locks");
  }
  // exclusive takes precedence over deprecated parallelSafe when both are set.
  const exclusive =
    input.exclusive !== undefined
      ? input.exclusive
      : input.parallelSafe !== undefined
        ? !input.parallelSafe
        : undefined;
  if (exclusive !== undefined) {
    locks = withExclusiveLock(locks, exclusive);
    locksTouched = true;
    if (input.parallelSafe !== undefined && input.exclusive === undefined) {
      fields.push("parallel.safe");
    }
    fields.push("parallel.locks");
  }
  if (locksTouched) {
    const { safe: _deprecatedSafe, ...restParallel } = next.parallel;
    next = {
      ...next,
      parallel: {
        ...restParallel,
        locks
      }
    };
  }
  // Stable unique order: parallel.safe then parallel.locks.
  const ordered: string[] = [];
  if (fields.includes("parallel.safe")) {
    ordered.push("parallel.safe");
  }
  if (fields.includes("parallel.locks")) {
    ordered.push("parallel.locks");
  }
  const other = fields.filter((field) => field !== "parallel.safe" && field !== "parallel.locks");
  return { block: next, fields: [...other, ...ordered] };
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
    next = {
      ...next,
      review: {
        ...next.review,
        maxFeedbackCycles: normalizeMaxFeedbackCycles(input.maxFeedbackCycles)
      }
    };
    fields.push("review.maxFeedbackCycles");
  }
  if (input.reviewHook !== undefined) {
    next = { ...next, review: { ...next.review, hook: input.reviewHook } };
    fields.push("review.hook");
  }
  return { block: next, fields };
}

function ensureBlockFieldCompatibility(
  block: ManifestBlock,
  input: PlanPackageBlockFieldEditInput
): void {
  if (
    block.type !== "implementation" &&
    (input.parallelSafe !== undefined ||
      input.exclusive !== undefined ||
      input.parallelLocks !== undefined)
  ) {
    throw new Error("parallel fields can only be edited on implementation blocks.");
  }
  if (
    block.type !== "review" &&
    (input.reviewRequired !== undefined ||
      input.maxFeedbackCycles !== undefined ||
      input.reviewHook !== undefined)
  ) {
    throw new Error("review fields can only be edited on review blocks.");
  }
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
  if (input.acceptance !== undefined) {
    nextTask = { ...nextTask, acceptance: nonEmptyStringArray(input.acceptance, "acceptance") };
    updatedFields.push("acceptance");
  }
  if (updatedFields.length === 0) {
    throw new Error("edit-task requires at least one field to update.");
  }
  return {
    ...buildPlanPackageManifestChangeMutation(manifest, replaceTask(manifest, nextTask), {
      affectedTasks: input.promptMarkdown === undefined ? [] : [input.taskId],
      sideEffects: writePromptSideEffects(nextTask.prompt, input.promptMarkdown)
    }),
    taskId: input.taskId,
    updatedFields
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
    nextBlock =
      executor === undefined ? { ...nextBlock, executor: undefined } : { ...nextBlock, executor };
    updatedFields.push("executor");
  }
  if (input.dependsOn !== undefined) {
    nextBlock = { ...nextBlock, depends_on: stringArray(input.dependsOn, "dependsOn") };
    updatedFields.push("depends_on");
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
    ...buildPlanPackageManifestChangeMutation(manifest, replaceTask(manifest, nextTask), {
      affectedTasks: input.promptMarkdown === undefined ? [] : [taskId],
      sideEffects: writePromptSideEffects(nextBlock.prompt, input.promptMarkdown)
    }),
    blockRef: input.blockRef,
    taskId,
    blockId,
    blockType: block.type,
    updatedFields
  };
}
