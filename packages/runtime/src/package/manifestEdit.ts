import { commitPlanPackageGraphMutation } from "../graph/editGraph.js";
import { buildPlanPackageBlockFieldEditMutation, buildPlanPackageTaskFieldEditMutation } from "../graph/fieldEditMutation.js";
import type { EditBlockInput, EditBlockResult, EditTaskInput, EditTaskResult } from "../types.js";
import { loadPackage } from "./loadPackage.js";

export async function editTask(options: EditTaskInput): Promise<EditTaskResult> {
  const { manifest } = await loadPackage(options.projectRoot);
  const mutation = buildPlanPackageTaskFieldEditMutation(manifest, {
    taskId: options.taskId,
    title: options.title,
    promptMarkdown: options.promptMarkdown,
    executor: options.executor
  });
  const result = await commitPlanPackageGraphMutation({
    projectRoot: options.projectRoot,
    mutation
  });
  return { ...result, taskId: mutation.taskId, updatedFields: mutation.updatedFields };
}

export async function editBlock(options: EditBlockInput): Promise<EditBlockResult> {
  const { manifest } = await loadPackage(options.projectRoot);
  const mutation = buildPlanPackageBlockFieldEditMutation(manifest, {
    blockRef: options.ref,
    title: options.title,
    promptMarkdown: options.promptMarkdown,
    executor: options.executor,
    parallelSafe: options.parallelSafe,
    parallelLocks: options.parallelLocks,
    reviewRequired: options.reviewRequired,
    maxFeedbackCycles: options.maxFeedbackCycles,
    reviewHook: options.reviewHook
  });
  const result = await commitPlanPackageGraphMutation({
    projectRoot: options.projectRoot,
    mutation
  });
  return {
    ...result,
    ref: mutation.blockRef,
    taskId: mutation.taskId,
    blockId: mutation.blockId,
    blockType: mutation.blockType,
    updatedFields: mutation.updatedFields
  };
}
