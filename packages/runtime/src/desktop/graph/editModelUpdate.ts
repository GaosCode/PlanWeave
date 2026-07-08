import { commitPlanPackageGraphMutation } from "../../graph/editGraph.js";
import { buildPlanPackageBlockFieldEditMutation, buildPlanPackageTaskFieldEditMutation } from "../../graph/fieldEditMutation.js";
import { buildPlanPackageManifestChangeMutation, type PlanPackageGraphMutationSideEffect } from "../../graph/mutation.js";
import { writeJsonFile } from "../../json.js";
import { loadPackage } from "../../package/loadPackage.js";
import type { GraphEditResult, PackageWorkspaceRef, PlanPackageManifest, ReviewHookDefinition } from "../../types.js";
import type { DesktopPromptSaveOptions } from "../types.js";
import { invalidateDesktopProjectProjection } from "./projectProjectionModel.js";
import { executeDesktopPlanGraphCommand } from "./editModelCommand.js";
import type {
  CanvasExecutionPolicyInput,
  DesktopBlockFieldEditInput,
  DesktopBulkUpdateBlockInput,
  DesktopBulkUpdateTaskInput,
  DesktopTaskFieldEditInput
} from "./editModelTypes.js";
import { hasFieldEditValue, manifestValidationResult, requireNonEmptyTitle } from "./editModelValidation.js";
import type { PlanGraphCommand } from "../../plangraph/index.js";

type UpdateTaskFieldsCommand = Extract<PlanGraphCommand, { type: "updateTaskFields" }>;
type UpdateBlockFieldsCommand = Extract<PlanGraphCommand, { type: "updateBlockFields" }>;

export async function updateTaskFields(
  projectRoot: PackageWorkspaceRef,
  taskId: string,
  fields: DesktopTaskFieldEditInput,
  options: DesktopPromptSaveOptions = {}
): Promise<GraphEditResult> {
  if (!hasFieldEditValue(fields)) {
    throw new Error("At least one task field must be provided.");
  }
  const commandFields: UpdateTaskFieldsCommand["fields"] = {
    ...fields,
    title: fields.title === undefined ? undefined : requireNonEmptyTitle(fields.title),
    basePromptHash: fields.promptMarkdown === undefined ? undefined : options.basePromptHash
  };
  return executeDesktopPlanGraphCommand(projectRoot, {
    type: "updateTaskFields",
    taskId,
    baseGraphVersion: options.baseGraphVersion,
    fields: commandFields
  });
}

export async function updateTaskTitle(projectRoot: PackageWorkspaceRef, taskId: string, title: string): Promise<GraphEditResult> {
  return updateTaskFields(projectRoot, taskId, { title });
}

export async function updateTaskPrompt(
  projectRoot: PackageWorkspaceRef,
  taskId: string,
  markdown: string,
  options: DesktopPromptSaveOptions = {}
): Promise<GraphEditResult> {
  return updateTaskFields(projectRoot, taskId, { promptMarkdown: markdown }, options);
}

export async function updateBlockFields(
  projectRoot: PackageWorkspaceRef,
  ref: string,
  fields: DesktopBlockFieldEditInput,
  options: DesktopPromptSaveOptions = {}
): Promise<GraphEditResult> {
  if (!hasFieldEditValue(fields)) {
    throw new Error("At least one block field must be provided.");
  }
  const commandFields: UpdateBlockFieldsCommand["fields"] = {
    ...fields,
    title: fields.title === undefined ? undefined : requireNonEmptyTitle(fields.title),
    basePromptHash: fields.promptMarkdown === undefined ? undefined : options.basePromptHash
  };
  return executeDesktopPlanGraphCommand(projectRoot, {
    type: "updateBlockFields",
    blockRef: ref,
    baseGraphVersion: options.baseGraphVersion,
    fields: commandFields
  });
}

export async function updateBlockTitle(projectRoot: PackageWorkspaceRef, ref: string, title: string): Promise<GraphEditResult> {
  return updateBlockFields(projectRoot, ref, { title });
}

export async function updateBlockPrompt(
  projectRoot: PackageWorkspaceRef,
  ref: string,
  markdown: string,
  options: DesktopPromptSaveOptions = {}
): Promise<GraphEditResult> {
  return updateBlockFields(projectRoot, ref, { promptMarkdown: markdown }, options);
}

export async function updateTaskExecutor(projectRoot: PackageWorkspaceRef, taskId: string, executorName: string | null): Promise<GraphEditResult> {
  return updateTaskFields(projectRoot, taskId, { executor: executorName });
}

export async function updateTaskAcceptance(projectRoot: PackageWorkspaceRef, taskId: string, acceptance: string[]): Promise<GraphEditResult> {
  return updateTaskFields(projectRoot, taskId, { acceptance });
}

export async function updateBlockExecutor(projectRoot: PackageWorkspaceRef, ref: string, executorName: string | null): Promise<GraphEditResult> {
  return updateBlockFields(projectRoot, ref, { executor: executorName });
}

export async function updateBlockDependencies(projectRoot: PackageWorkspaceRef, ref: string, dependsOn: string[]): Promise<GraphEditResult> {
  return updateBlockFields(projectRoot, ref, { dependsOn });
}

export async function updateBlockPlanning(
  projectRoot: PackageWorkspaceRef,
  ref: string,
  input: {
    parallelSafe?: boolean;
    parallelLocks?: string[];
    reviewRequired?: boolean;
    maxFeedbackCycles?: number;
    reviewHook?: ReviewHookDefinition | null;
  }
): Promise<GraphEditResult> {
  return updateBlockFields(projectRoot, ref, input);
}

function updateCanvasExecutionPolicyManifest(
  manifest: PlanPackageManifest,
  input: CanvasExecutionPolicyInput
): PlanPackageManifest {
  if (
    input.defaultExecutor === undefined &&
    input.parallelEnabled === undefined &&
    input.maxConcurrent === undefined
  ) {
    throw new Error("At least one execution policy field must be provided.");
  }
  if (input.maxConcurrent !== undefined && (!Number.isInteger(input.maxConcurrent) || input.maxConcurrent < 1)) {
    throw new Error("maxConcurrent must be a positive integer.");
  }

  const nextManifest: PlanPackageManifest = {
    ...manifest,
    execution: {
      ...manifest.execution,
      ...(input.defaultExecutor === undefined
        ? {}
        : input.defaultExecutor === null
          ? { defaultExecutor: undefined }
          : { defaultExecutor: input.defaultExecutor }),
      parallel: {
        ...manifest.execution.parallel,
        enabled: input.parallelEnabled ?? manifest.execution.parallel.enabled,
        maxConcurrent: input.maxConcurrent ?? manifest.execution.parallel.maxConcurrent
      }
    }
  };
  if (input.defaultExecutor === null) {
    delete nextManifest.execution.defaultExecutor;
  }
  return nextManifest;
}

export async function updateCanvasExecutionPolicy(
  projectRoot: PackageWorkspaceRef,
  input: CanvasExecutionPolicyInput
): Promise<GraphEditResult> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const nextManifest = updateCanvasExecutionPolicyManifest(manifest, input);
  const affectedTasks = nextManifest.nodes.map((node) => node.id);
  const result = manifestValidationResult(nextManifest, affectedTasks);
  if (!result.ok) {
    return result;
  }

  await writeJsonFile(workspace.manifestFile, nextManifest);
  invalidateDesktopProjectProjection(workspace);
  return result;
}

export async function bulkUpdateParallelPolicy(
  projectRoot: PackageWorkspaceRef,
  input: {
    canvasPolicy?: CanvasExecutionPolicyInput;
    blocks: Array<{
      blockRef: string;
      input: {
        parallelSafe?: boolean;
        parallelLocks?: string[];
      };
    }>;
  }
): Promise<GraphEditResult> {
  if (!input.canvasPolicy && input.blocks.length === 0) {
    throw new Error("bulk_update_parallel_policy requires canvasPolicy or at least one block update.");
  }
  const { manifest } = await loadPackage(projectRoot);
  let nextManifest = input.canvasPolicy ? updateCanvasExecutionPolicyManifest(manifest, input.canvasPolicy) : manifest;
  const affectedTasks = input.canvasPolicy ? nextManifest.nodes.map((node) => node.id) : [];
  const sideEffects: PlanPackageGraphMutationSideEffect[] = [];
  for (const update of input.blocks) {
    const mutation = buildPlanPackageBlockFieldEditMutation(nextManifest, {
      blockRef: update.blockRef,
      parallelSafe: update.input.parallelSafe,
      parallelLocks: update.input.parallelLocks
    });
    nextManifest = mutation.nextManifest;
    affectedTasks.push(...mutation.affectedTasks, mutation.taskId);
    sideEffects.push(...mutation.sideEffects);
  }
  const result = await commitPlanPackageGraphMutation({
    projectRoot,
    mutation: buildPlanPackageManifestChangeMutation(manifest, nextManifest, { affectedTasks, sideEffects })
  });
  invalidateDesktopProjectProjection(projectRoot);
  return result;
}

export async function bulkUpdateTasks(
  projectRoot: PackageWorkspaceRef,
  updates: DesktopBulkUpdateTaskInput[]
): Promise<GraphEditResult> {
  if (updates.length === 0) {
    throw new Error("bulk_update_tasks requires at least one task update.");
  }
  const { manifest } = await loadPackage(projectRoot);
  let nextManifest = manifest;
  const affectedTasks: string[] = [];
  const sideEffects: PlanPackageGraphMutationSideEffect[] = [];
  for (const update of updates) {
    if (!hasFieldEditValue(update.fields)) {
      throw new Error("At least one task field must be provided.");
    }
    const mutation = buildPlanPackageTaskFieldEditMutation(nextManifest, { taskId: update.taskId, ...update.fields });
    nextManifest = mutation.nextManifest;
    affectedTasks.push(...mutation.affectedTasks, update.taskId);
    sideEffects.push(...mutation.sideEffects);
  }
  const result = await commitPlanPackageGraphMutation({
    projectRoot,
    mutation: buildPlanPackageManifestChangeMutation(manifest, nextManifest, { affectedTasks, sideEffects })
  });
  invalidateDesktopProjectProjection(projectRoot);
  return result;
}

export async function bulkUpdateBlocks(
  projectRoot: PackageWorkspaceRef,
  updates: DesktopBulkUpdateBlockInput[]
): Promise<GraphEditResult> {
  if (updates.length === 0) {
    throw new Error("bulk_update_blocks requires at least one block update.");
  }
  const { manifest } = await loadPackage(projectRoot);
  let nextManifest = manifest;
  const affectedTasks: string[] = [];
  const sideEffects: PlanPackageGraphMutationSideEffect[] = [];
  for (const update of updates) {
    if (!hasFieldEditValue(update.fields)) {
      throw new Error("At least one block field must be provided.");
    }
    const mutation = buildPlanPackageBlockFieldEditMutation(nextManifest, { blockRef: update.blockRef, ...update.fields });
    nextManifest = mutation.nextManifest;
    affectedTasks.push(...mutation.affectedTasks, mutation.taskId);
    sideEffects.push(...mutation.sideEffects);
  }
  const result = await commitPlanPackageGraphMutation({
    projectRoot,
    mutation: buildPlanPackageManifestChangeMutation(manifest, nextManifest, { affectedTasks, sideEffects })
  });
  invalidateDesktopProjectProjection(projectRoot);
  return result;
}
