import { resolve } from "node:path";
import { compileTaskGraph, parseBlockRef } from "../../graph/compileTaskGraph.js";
import { commitPlanPackageGraphMutation } from "../../graph/editGraph.js";
import { buildPlanPackageBlockFieldEditMutation, buildPlanPackageTaskFieldEditMutation } from "../../graph/fieldEditMutation.js";
import { buildPlanPackageGraphMutation, buildPlanPackageManifestChangeMutation, type PlanPackageGraphMutationSideEffect } from "../../graph/mutation.js";
import { writeJsonFile } from "../../json.js";
import { loadPackage } from "../../package/loadPackage.js";
import { loadProjectGraphForWorkspace, projectCanvasWorkspace } from "../../projectGraph/index.js";
import { manifestSchema } from "../../schema/manifest.js";
import {
  executePlanGraphCommand,
  redoPlanGraphCommand,
  undoPlanGraphCommand,
  type PlanGraphCommand,
  type BlockComponentSnapshot,
  type PlanGraphCommandResult,
  type TaskComponentSnapshot
} from "../../plangraph/index.js";
import type {
  BlockType,
  GraphEditResult,
  ManifestEdge,
  ManifestBlock,
  ManifestTaskNode,
  PackageWorkspaceRef,
  PlanPackageManifest,
  ReviewHookDefinition,
  ValidationIssue
} from "../../types.js";
import type { DesktopAddBlockInput, DesktopAddTaskInput, DesktopGraphEditValidationInput, DesktopLayout, DesktopPromptSaveOptions } from "../types.js";
import { getDesktopLayout, saveDesktopLayoutDirect } from "../layoutApi.js";
import { getTask } from "./graphHelpers.js";
import { invalidateDesktopProjectProjection } from "./projectProjectionModel.js";

type UpdateTaskFieldsCommand = Extract<PlanGraphCommand, { type: "updateTaskFields" }>;
type UpdateBlockFieldsCommand = Extract<PlanGraphCommand, { type: "updateBlockFields" }>;

export type DesktopTaskFieldEditInput = Omit<UpdateTaskFieldsCommand["fields"], "basePromptHash">;
export type DesktopBlockFieldEditInput = Omit<UpdateBlockFieldsCommand["fields"], "basePromptHash">;

export type DesktopBulkCreateTaskInput = DesktopAddTaskInput;
export type DesktopBulkCreateBlockInput = DesktopAddBlockInput;
export type DesktopBulkUpdateTaskInput = {
  taskId: string;
  fields: DesktopTaskFieldEditInput;
};
export type DesktopBulkUpdateBlockInput = {
  blockRef: string;
  fields: DesktopBlockFieldEditInput;
};
export type DesktopBulkRemoveGraphItemsInput = {
  taskIds?: string[];
  blockRefs?: string[];
  taskDependencyEdges?: Array<{ dependentTaskId: string; dependsOnTaskId: string }>;
  blockDependencyEdges?: Array<{ blockRef: string; dependsOnBlockId: string }>;
};

function normalizeOptionalText(value: string | null): string | undefined {
  return value?.trim() || undefined;
}

function requireNonEmptyTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new Error("Title must not be empty.");
  }
  return trimmed;
}

function promptFileMarkdown(markdown: string): string {
  return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
}

function hasFieldEditValue(fields: DesktopTaskFieldEditInput | DesktopBlockFieldEditInput): boolean {
  return Object.values(fields).some((value) => value !== undefined);
}

function slugPart(value: string): string {
  const slug = value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-");
  let start = 0;
  let end = slug.length;
  while (start < end && slug[start] === "-") {
    start += 1;
  }
  while (end > start && slug[end - 1] === "-") {
    end -= 1;
  }
  return slug.slice(start, end).slice(0, 18);
}

function nextTaskId(manifest: PlanPackageManifest, title: string): string {
  const existing = new Set(manifest.nodes.map((node) => node.id));
  const base = slugPart(title);
  if (base && !existing.has(`T-${base}`)) {
    return `T-${base}`;
  }
  let index = manifest.nodes.filter((node) => node.type === "task").length + 1;
  while (existing.has(`T-${String(index).padStart(3, "0")}`)) {
    index += 1;
  }
  return `T-${String(index).padStart(3, "0")}`;
}

function nextBlockId(task: ManifestTaskNode, type: BlockType): string {
  const prefix = type === "review" ? "R" : "B";
  const existing = new Set(task.blocks.map((block) => block.id));
  let index = task.blocks.filter((block) => block.id.startsWith(`${prefix}-`)).length + 1;
  while (existing.has(`${prefix}-${String(index).padStart(3, "0")}`)) {
    index += 1;
  }
  return `${prefix}-${String(index).padStart(3, "0")}`;
}

function createBlock(options: {
  taskId: string;
  blockId: string;
  type: BlockType;
  title: string;
  dependsOn: string[];
  executor?: string;
  maxFeedbackCycles: number;
}): ManifestBlock {
  const common = {
    id: options.blockId,
    type: options.type,
    title: requireNonEmptyTitle(options.title),
    prompt: `nodes/${options.taskId}/blocks/${options.blockId}.prompt.md`,
    depends_on: options.dependsOn,
    executor: options.executor
  };
  if (options.type === "review") {
    return {
      ...common,
      type: "review",
      review: { required: true, maxFeedbackCycles: options.maxFeedbackCycles, hook: null }
    };
  }
  return { ...common, type: options.type, parallel: { safe: false, locks: [] } };
}

function buildTaskNodeForCreate(manifest: PlanPackageManifest, input: DesktopAddTaskInput): {
  node: ManifestTaskNode;
  taskPromptMarkdown: string;
  blockPromptMarkdown: Array<{ blockId: string; markdown: string }>;
} {
  const title = requireNonEmptyTitle(input.title);
  const taskId = nextTaskId(manifest, title);
  const blockTypes = input.blockTypes?.length ? input.blockTypes : (["implementation"] satisfies BlockType[]);
  const blocks: ManifestBlock[] = [];
  for (const type of blockTypes) {
    const blockId = nextBlockId({ id: taskId, type: "task", title, prompt: "", acceptance: [], blocks }, type);
    blocks.push(
      createBlock({
        taskId,
        blockId,
        type,
        title: type === "review" ? "Review work" : "Implement work",
        dependsOn: blocks.length > 0 ? [blocks[blocks.length - 1].id] : [],
        maxFeedbackCycles: manifest.review.maxFeedbackCycles
      })
    );
  }
  return {
    node: {
      id: taskId,
      type: "task",
      title,
      prompt: `nodes/${taskId}/prompt.md`,
      executor: normalizeOptionalText(input.executor ?? null),
      acceptance: input.acceptance?.length ? input.acceptance : ["Task is implemented."],
      blocks
    },
    taskPromptMarkdown: input.promptMarkdown,
    blockPromptMarkdown: blocks.map((block) => ({ blockId: block.id, markdown: promptFileMarkdown(`# ${block.title}\n\n${input.promptMarkdown}`) }))
  };
}

function graphEditResult(manifest: PlanPackageManifest, affectedTasks: string[] = []): GraphEditResult {
  const graph = compileTaskGraph(manifest);
  return {
    ok: graph.diagnostics.errors.length === 0,
    affectedTasks: [...new Set(affectedTasks)],
    diagnostics: graph.diagnostics.errors,
    graph
  };
}

function graphEditDiagnostics(manifest: PlanPackageManifest, diagnostics: ValidationIssue[]): GraphEditResult {
  return {
    ok: false,
    affectedTasks: [],
    diagnostics,
    graph: compileTaskGraph(manifest)
  };
}

function manifestValidationResult(manifest: PlanPackageManifest, affectedTasks: string[]): GraphEditResult {
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return {
      ok: false,
      affectedTasks: [],
      diagnostics: parsed.error.issues.map((issue) => ({
        code: "manifest_schema",
        message: issue.message,
        path: issue.path.join(".")
      })),
      graph: compileTaskGraph(manifest)
    };
  }
  return graphEditResult(parsed.data as PlanPackageManifest, affectedTasks);
}

async function commandResult(projectRoot: PackageWorkspaceRef, result: PlanGraphCommandResult): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  return {
    ok: result.ok && graph.diagnostics.errors.length === 0,
    affectedTasks: result.ok ? result.affected.tasks : [],
    diagnostics: result.ok ? graph.diagnostics.errors : result.diagnostics,
    graph
  };
}

async function executeDesktopPlanGraphCommand(
  projectRoot: PackageWorkspaceRef,
  command: Parameters<typeof executePlanGraphCommand>[0]["command"],
  options: { layoutSnapshot?: DesktopLayout | null } = {}
): Promise<GraphEditResult> {
  const result = await executePlanGraphCommand({ projectRoot, command });
  const resultWorkspace = result.ok ? result.workspaceRef : projectRoot;
  await applyLayoutNodeSideEffects(resultWorkspace, result);
  if (result.ok && options.layoutSnapshot) {
    await saveDesktopLayoutDirect(resultWorkspace, options.layoutSnapshot);
  }
  invalidateDesktopProjectProjection(resultWorkspace);
  return commandResult(resultWorkspace, result);
}

async function crossTaskEdgeDeleteDiagnostic(projectRoot: PackageWorkspaceRef, taskId: string): Promise<GraphEditResult | null> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const projectGraph = await loadProjectGraphForWorkspace(workspace);
  if (projectGraph.source !== "project_graph") {
    return null;
  }
  const canvas = projectGraph.manifest.canvases.find((candidate) => resolve(projectCanvasWorkspace(projectGraph.workspace, candidate).packageDir) === resolve(workspace.packageDir));
  if (!canvas) {
    return null;
  }
  const edge = projectGraph.manifest.crossTaskEdges.find(
    (candidate) =>
      (candidate.from.canvasId === canvas.id && candidate.from.taskId === taskId) ||
      (candidate.to.canvasId === canvas.id && candidate.to.taskId === taskId)
  );
  if (!edge) {
    return null;
  }
  return {
    ok: false,
    affectedTasks: [],
    diagnostics: [
      {
        code: "project_cross_task_edge_blocks_task_delete",
        message: `Task '${canvas.id}::${taskId}' is referenced by a project cross-task dependency; remove that dependency before deleting the task.`,
        path: "crossTaskEdges"
      }
    ],
    graph: compileTaskGraph(manifest)
  };
}

export async function addTaskNode(projectRoot: PackageWorkspaceRef, input: DesktopAddTaskInput): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  const { node, taskPromptMarkdown, blockPromptMarkdown } = buildTaskNodeForCreate(manifest, input);
  const snapshot: TaskComponentSnapshot = {
    task: node,
    taskPromptMarkdown,
    blockPromptMarkdown,
    insertIndex: null,
    affectedTaskEdges: [],
    layoutNode: input.layoutPosition ? { nodeId: node.id, x: input.layoutPosition.x, y: input.layoutPosition.y } : null
  };
  return executeDesktopPlanGraphCommand(projectRoot, { type: "addTask", snapshot });
}

export async function addBlock(projectRoot: PackageWorkspaceRef, input: DesktopAddBlockInput): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  const task = getTask(graph, input.taskId);
  const blockId = nextBlockId(task, input.type);
  const block = createBlock({
    taskId: task.id,
    blockId,
    type: input.type,
    title: input.title,
    dependsOn: input.dependsOn ?? (task.blocks.length > 0 ? [task.blocks[task.blocks.length - 1].id] : []),
    executor: normalizeOptionalText(input.executor ?? null),
    maxFeedbackCycles: manifest.review.maxFeedbackCycles
  });
  const snapshot: BlockComponentSnapshot = {
    taskId: task.id,
    block,
    promptMarkdown: promptFileMarkdown(input.promptMarkdown),
    insertIndex: null,
    affectedDependsOn: []
  };
  return executeDesktopPlanGraphCommand(projectRoot, { type: "addBlock", snapshot });
}

export async function removeTaskNode(projectRoot: PackageWorkspaceRef, taskId: string): Promise<GraphEditResult> {
  const blocked = await crossTaskEdgeDeleteDiagnostic(projectRoot, taskId);
  if (blocked) {
    return blocked;
  }
  const layout = await getDesktopLayout(projectRoot);
  return executeDesktopPlanGraphCommand(projectRoot, {
    type: "removeTask",
    taskId,
    layoutNode: layout.nodes.find((node) => node.nodeId === taskId) ?? null
  });
}

export async function removeBlock(projectRoot: PackageWorkspaceRef, ref: string): Promise<GraphEditResult> {
  return executeDesktopPlanGraphCommand(projectRoot, { type: "removeBlock", blockRef: ref });
}

export async function validateGraphEdit(projectRoot: PackageWorkspaceRef, input: DesktopGraphEditValidationInput): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  if (input.kind === "addDependencyEdge") {
    const mutation = buildPlanPackageGraphMutation(manifest, {
      kind: "addEdge",
      edge: { from: input.fromTaskId, to: input.toTaskId, type: "depends_on" }
    });
    return graphEditResult(mutation.nextManifest, mutation.affectedTasks);
  }
  if (input.kind === "removeDependencyEdge") {
    const mutation = buildPlanPackageGraphMutation(manifest, {
      kind: "removeEdge",
      edge: { from: input.fromTaskId, to: input.toTaskId, type: "depends_on" }
    });
    return graphEditResult(mutation.nextManifest, mutation.affectedTasks);
  }
  if (input.kind === "removeTaskNode") {
    const mutation = buildPlanPackageGraphMutation(manifest, { kind: "removeNode", nodeId: input.taskId });
    return graphEditResult(mutation.nextManifest, mutation.affectedTasks);
  }
  const mutation = buildPlanPackageGraphMutation(manifest, { kind: "removeBlock", blockRef: input.blockRef });
  return graphEditResult(mutation.nextManifest, mutation.affectedTasks);
}

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

type CanvasExecutionPolicyInput = {
  defaultExecutor?: string | null;
  parallelEnabled?: boolean;
  maxConcurrent?: number;
};

function updateCanvasExecutionPolicyManifest(
  manifest: PlanPackageManifest,
  input: {
    defaultExecutor?: string | null;
    parallelEnabled?: boolean;
    maxConcurrent?: number;
  }
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
    affectedTasks.push(...mutation.affectedTasks);
    sideEffects.push(...mutation.sideEffects);
  }
  const result = await commitPlanPackageGraphMutation({
    projectRoot,
    mutation: buildPlanPackageManifestChangeMutation(manifest, nextManifest, { affectedTasks, sideEffects })
  });
  invalidateDesktopProjectProjection(projectRoot);
  return result;
}

export async function bulkCreateTasks(
  projectRoot: PackageWorkspaceRef,
  tasks: DesktopBulkCreateTaskInput[]
): Promise<GraphEditResult> {
  if (tasks.length === 0) {
    throw new Error("bulk_create_tasks requires at least one task.");
  }
  const { manifest } = await loadPackage(projectRoot);
  let nextManifest = manifest;
  const affectedTasks: string[] = [];
  const sideEffects: PlanPackageGraphMutationSideEffect[] = [];
  for (const input of tasks) {
    const { node, taskPromptMarkdown, blockPromptMarkdown } = buildTaskNodeForCreate(nextManifest, input);
    const mutation = buildPlanPackageGraphMutation(nextManifest, {
      kind: "addTaskNode",
      node,
      taskPromptMarkdown,
      blockPromptMarkdown
    });
    nextManifest = mutation.nextManifest;
    affectedTasks.push(...mutation.affectedTasks, node.id);
    sideEffects.push(...mutation.sideEffects);
  }
  const result = await commitPlanPackageGraphMutation({
    projectRoot,
    mutation: buildPlanPackageManifestChangeMutation(manifest, nextManifest, { affectedTasks, sideEffects })
  });
  invalidateDesktopProjectProjection(projectRoot);
  return result;
}

export async function bulkCreateBlocks(
  projectRoot: PackageWorkspaceRef,
  blocks: DesktopBulkCreateBlockInput[]
): Promise<GraphEditResult> {
  if (blocks.length === 0) {
    throw new Error("bulk_create_blocks requires at least one block.");
  }
  const { manifest } = await loadPackage(projectRoot);
  let nextManifest = manifest;
  const affectedTasks: string[] = [];
  const sideEffects: PlanPackageGraphMutationSideEffect[] = [];
  for (const input of blocks) {
    const graph = compileTaskGraph(nextManifest);
    const task = getTask(graph, input.taskId);
    const blockId = nextBlockId(task, input.type);
    const block = createBlock({
      taskId: task.id,
      blockId,
      type: input.type,
      title: input.title,
      dependsOn: input.dependsOn ?? (task.blocks.length > 0 ? [task.blocks[task.blocks.length - 1].id] : []),
      executor: normalizeOptionalText(input.executor ?? null),
      maxFeedbackCycles: nextManifest.review.maxFeedbackCycles
    });
    const mutation = buildPlanPackageGraphMutation(nextManifest, {
      kind: "addBlock",
      taskId: task.id,
      block,
      promptMarkdown: promptFileMarkdown(input.promptMarkdown)
    });
    nextManifest = mutation.nextManifest;
    affectedTasks.push(...mutation.affectedTasks, task.id);
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

function taskDependencyEdge(input: { dependentTaskId: string; dependsOnTaskId: string }): ManifestEdge {
  return { from: input.dependentTaskId, to: input.dependsOnTaskId, type: "depends_on" };
}

function removeBlockDependency(manifest: PlanPackageManifest, input: { blockRef: string; dependsOnBlockId: string }): PlanPackageManifest {
  const { taskId, blockId } = parseBlockRef(input.blockRef);
  const task = manifest.nodes.find((node) => node.type === "task" && node.id === taskId);
  if (!task || task.type !== "task") {
    throw new Error(`Task '${taskId}' does not exist.`);
  }
  const block = task.blocks.find((candidate) => candidate.id === blockId);
  if (!block) {
    throw new Error(`Block '${input.blockRef}' does not exist.`);
  }
  return {
    ...manifest,
    nodes: manifest.nodes.map((node) =>
      node.type === "task" && node.id === taskId
        ? {
            ...task,
            blocks: task.blocks.map((candidate) =>
              candidate.id === blockId
                ? { ...candidate, depends_on: candidate.depends_on.filter((dependency) => dependency !== input.dependsOnBlockId) }
                : candidate
            )
          }
        : node
    )
  };
}

export async function bulkRemoveGraphItems(
  projectRoot: PackageWorkspaceRef,
  input: DesktopBulkRemoveGraphItemsInput
): Promise<GraphEditResult> {
  const taskIds = input.taskIds ?? [];
  const blockRefs = input.blockRefs ?? [];
  const taskDependencyEdges = input.taskDependencyEdges ?? [];
  const blockDependencyEdges = input.blockDependencyEdges ?? [];
  if (taskIds.length === 0 && blockRefs.length === 0 && taskDependencyEdges.length === 0 && blockDependencyEdges.length === 0) {
    throw new Error("bulk_remove_graph_items requires at least one item to remove.");
  }
  const { manifest } = await loadPackage(projectRoot);
  const blockedDiagnostics: ValidationIssue[] = [];
  for (const taskId of taskIds) {
    const blocked = await crossTaskEdgeDeleteDiagnostic(projectRoot, taskId);
    if (blocked) {
      blockedDiagnostics.push(...blocked.diagnostics);
    }
  }
  if (blockedDiagnostics.length > 0) {
    return graphEditDiagnostics(manifest, blockedDiagnostics);
  }

  let nextManifest = manifest;
  const affectedTasks: string[] = [];
  const sideEffects: PlanPackageGraphMutationSideEffect[] = [];
  for (const edge of taskDependencyEdges) {
    const mutation = buildPlanPackageGraphMutation(nextManifest, { kind: "removeEdge", edge: taskDependencyEdge(edge) });
    nextManifest = mutation.nextManifest;
    affectedTasks.push(...mutation.affectedTasks, edge.dependentTaskId, edge.dependsOnTaskId);
  }
  for (const edge of blockDependencyEdges) {
    const next = removeBlockDependency(nextManifest, edge);
    nextManifest = next;
    affectedTasks.push(parseBlockRef(edge.blockRef).taskId);
  }
  for (const blockRef of blockRefs) {
    const mutation = buildPlanPackageGraphMutation(nextManifest, { kind: "removeBlock", blockRef });
    nextManifest = mutation.nextManifest;
    affectedTasks.push(...mutation.affectedTasks, parseBlockRef(blockRef).taskId);
    sideEffects.push(...mutation.sideEffects);
  }
  for (const taskId of taskIds) {
    const mutation = buildPlanPackageGraphMutation(nextManifest, { kind: "removeNode", nodeId: taskId, removeTaskDirectory: true });
    nextManifest = mutation.nextManifest;
    affectedTasks.push(...mutation.affectedTasks, taskId);
    sideEffects.push(...mutation.sideEffects);
  }
  const result = await commitPlanPackageGraphMutation({
    projectRoot,
    mutation: buildPlanPackageManifestChangeMutation(manifest, nextManifest, { affectedTasks, sideEffects })
  });
  invalidateDesktopProjectProjection(projectRoot);
  return result;
}

export async function addDependencyEdge(
  projectRoot: PackageWorkspaceRef,
  fromTaskId: string,
  toTaskId: string,
  baseGraphVersion?: string,
  layoutSnapshot?: DesktopLayout
): Promise<GraphEditResult> {
  return executeDesktopPlanGraphCommand(projectRoot, { type: "addTaskDependency", fromTaskId, toTaskId, baseGraphVersion }, { layoutSnapshot });
}

export async function removeDependencyEdge(
  projectRoot: PackageWorkspaceRef,
  fromTaskId: string,
  toTaskId: string,
  baseGraphVersion?: string,
  layoutSnapshot?: DesktopLayout
): Promise<GraphEditResult> {
  return executeDesktopPlanGraphCommand(projectRoot, { type: "removeTaskDependency", fromTaskId, toTaskId, baseGraphVersion }, { layoutSnapshot });
}

export async function reconnectDependencyEdge(
  projectRoot: PackageWorkspaceRef,
  fromTaskId: string,
  oldToTaskId: string,
  newFromTaskId: string,
  newToTaskId: string,
  baseGraphVersion?: string,
  layoutSnapshot?: DesktopLayout
): Promise<GraphEditResult> {
  return executeDesktopPlanGraphCommand(projectRoot, {
    type: "reconnectTaskDependency",
    fromTaskId,
    oldToTaskId,
    newFromTaskId,
    newToTaskId,
    baseGraphVersion
  }, { layoutSnapshot });
}

export async function undoDesktopPlanGraphCommand(projectRoot: PackageWorkspaceRef): Promise<GraphEditResult> {
  const result = await undoPlanGraphCommand({ projectRoot });
  const resultWorkspace = result.ok ? result.workspaceRef : projectRoot;
  await applyLayoutNodeSideEffects(resultWorkspace, result);
  invalidateDesktopProjectProjection(resultWorkspace);
  return commandResult(resultWorkspace, result);
}

export async function redoDesktopPlanGraphCommand(projectRoot: PackageWorkspaceRef): Promise<GraphEditResult> {
  const result = await redoPlanGraphCommand({ projectRoot });
  const resultWorkspace = result.ok ? result.workspaceRef : projectRoot;
  await applyLayoutNodeSideEffects(resultWorkspace, result);
  invalidateDesktopProjectProjection(resultWorkspace);
  return commandResult(resultWorkspace, result);
}

async function applyLayoutNodeSideEffects(projectRoot: PackageWorkspaceRef, result: PlanGraphCommandResult): Promise<void> {
  if (!result.ok) {
    return;
  }
  const command = result.command;
  if (command.type === "removeTask") {
    const layout = await getDesktopLayout(projectRoot);
    await saveDesktopLayoutDirect(projectRoot, {
      ...layout,
      nodes: layout.nodes.filter((node) => node.nodeId !== command.taskId)
    });
    return;
  }
  if (command.type !== "restoreTask" && command.type !== "addTask") {
    return;
  }
  if (!command.snapshot.layoutNode) {
    return;
  }
  const layout = await getDesktopLayout(projectRoot);
  const layoutNode = command.snapshot.layoutNode;
  await saveDesktopLayoutDirect(projectRoot, {
    ...layout,
    nodes: [...layout.nodes.filter((node) => node.nodeId !== layoutNode.nodeId), layoutNode]
  });
}
