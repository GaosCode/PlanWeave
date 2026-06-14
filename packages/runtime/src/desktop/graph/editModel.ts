import { compileTaskGraph } from "../../graph/compileTaskGraph.js";
import { addEdge, commitPlanPackageGraphMutation, removeEdge } from "../../graph/editGraph.js";
import {
  buildPlanPackageBlockFieldEditMutation,
  buildPlanPackageTaskFieldEditMutation,
  type PlanPackageBlockFieldEditInput,
  type PlanPackageTaskFieldEditInput
} from "../../graph/fieldEditMutation.js";
import { buildPlanPackageGraphMutation } from "../../graph/mutation.js";
import { loadPackage } from "../../package/loadPackage.js";
import type { BlockType, GraphEditResult, ManifestBlock, ManifestTaskNode, PackageWorkspaceRef, PlanPackageManifest } from "../../types.js";
import type { DesktopAddBlockInput, DesktopAddTaskInput, DesktopGraphEditValidationInput } from "../types.js";
import { getTask } from "./graphHelpers.js";

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

function slugPart(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 18);
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

function graphEditResult(manifest: PlanPackageManifest, affectedTasks: string[] = []): GraphEditResult {
  const graph = compileTaskGraph(manifest);
  return {
    ok: graph.diagnostics.errors.length === 0,
    affectedTasks: [...new Set(affectedTasks)],
    diagnostics: graph.diagnostics.errors,
    graph
  };
}

async function commitTaskEdit(projectRoot: PackageWorkspaceRef, input: PlanPackageTaskFieldEditInput): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  return commitPlanPackageGraphMutation({
    projectRoot,
    mutation: buildPlanPackageTaskFieldEditMutation(manifest, input)
  });
}

async function commitBlockEdit(projectRoot: PackageWorkspaceRef, input: PlanPackageBlockFieldEditInput): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  return commitPlanPackageGraphMutation({
    projectRoot,
    mutation: buildPlanPackageBlockFieldEditMutation(manifest, input)
  });
}

export async function addTaskNode(projectRoot: PackageWorkspaceRef, input: DesktopAddTaskInput): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
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
  const node: ManifestTaskNode = {
    id: taskId,
    type: "task",
    title,
    prompt: `nodes/${taskId}/prompt.md`,
    executor: normalizeOptionalText(input.executor ?? null),
    acceptance: input.acceptance?.length ? input.acceptance : ["Task is implemented."],
    blocks
  };
  return commitPlanPackageGraphMutation({
    projectRoot,
    mutation: buildPlanPackageGraphMutation(manifest, {
      kind: "addTaskNode",
      node,
      taskPromptMarkdown: input.promptMarkdown,
      blockPromptMarkdown: blocks.map((block) => ({ blockId: block.id, markdown: promptFileMarkdown(`# ${block.title}\n\n${input.promptMarkdown}`) }))
    })
  });
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
  return commitPlanPackageGraphMutation({
    projectRoot,
    mutation: buildPlanPackageGraphMutation(manifest, {
      kind: "addBlock",
      taskId: task.id,
      block,
      promptMarkdown: promptFileMarkdown(input.promptMarkdown)
    })
  });
}

export async function removeTaskNode(projectRoot: PackageWorkspaceRef, taskId: string): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  getTask(compileTaskGraph(manifest), taskId);
  return commitPlanPackageGraphMutation({
    projectRoot,
    mutation: buildPlanPackageGraphMutation(manifest, { kind: "removeNode", nodeId: taskId, removeTaskDirectory: true })
  });
}

export async function removeBlock(projectRoot: PackageWorkspaceRef, ref: string): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  return commitPlanPackageGraphMutation({
    projectRoot,
    mutation: buildPlanPackageGraphMutation(manifest, { kind: "removeBlock", blockRef: ref })
  });
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

export async function updateTaskTitle(projectRoot: PackageWorkspaceRef, taskId: string, title: string): Promise<GraphEditResult> {
  return commitTaskEdit(projectRoot, { taskId, title: requireNonEmptyTitle(title) });
}

export async function updateTaskPrompt(projectRoot: PackageWorkspaceRef, taskId: string, markdown: string): Promise<GraphEditResult> {
  return commitTaskEdit(projectRoot, { taskId, promptMarkdown: markdown });
}

export async function updateBlockTitle(projectRoot: PackageWorkspaceRef, ref: string, title: string): Promise<GraphEditResult> {
  return commitBlockEdit(projectRoot, { blockRef: ref, title: requireNonEmptyTitle(title) });
}

export async function updateBlockPrompt(projectRoot: PackageWorkspaceRef, ref: string, markdown: string): Promise<GraphEditResult> {
  return commitBlockEdit(projectRoot, { blockRef: ref, promptMarkdown: markdown });
}

export async function updateTaskExecutor(projectRoot: PackageWorkspaceRef, taskId: string, executorName: string | null): Promise<GraphEditResult> {
  return commitTaskEdit(projectRoot, { taskId, executor: executorName });
}

export async function updateBlockExecutor(projectRoot: PackageWorkspaceRef, ref: string, executorName: string | null): Promise<GraphEditResult> {
  return commitBlockEdit(projectRoot, { blockRef: ref, executor: executorName });
}

export function addDependencyEdge(projectRoot: PackageWorkspaceRef, fromTaskId: string, toTaskId: string): Promise<GraphEditResult> {
  return addEdge({ projectRoot, edge: { from: fromTaskId, to: toTaskId, type: "depends_on" } });
}

export function removeDependencyEdge(projectRoot: PackageWorkspaceRef, fromTaskId: string, toTaskId: string): Promise<GraphEditResult> {
  return removeEdge({ projectRoot, edge: { from: fromTaskId, to: toTaskId, type: "depends_on" } });
}
