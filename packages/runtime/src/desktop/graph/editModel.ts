import { parseBlockRef } from "../../graph/compileTaskGraph.js";
import { compileTaskGraph } from "../../graph/compileTaskGraph.js";
import { addEdge, addNode, commitPlanPackageGraphMutation, removeEdge, updateNode } from "../../graph/editGraph.js";
import { buildPlanPackageGraphMutation } from "../../graph/mutation.js";
import { loadPackage } from "../../package/loadPackage.js";
import type { BlockType, GraphEditResult, ManifestBlock, ManifestTaskNode, NodeType, PackageWorkspaceRef, PlanPackageManifest } from "../../types.js";
import type { DesktopAddBlockInput, DesktopAddContextNodeInput, DesktopAddTaskInput, DesktopGraphEditValidationInput } from "../types.js";
import { getBlock, getTask } from "./graphHelpers.js";

function normalizeOptionalText(value: string | null): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireNonEmptyTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
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

function contextPrefix(type: Exclude<NodeType, "task">): string {
  if (type === "requirement") {
    return "REQ";
  }
  if (type === "constraint") {
    return "CON";
  }
  if (type === "decision") {
    return "DEC";
  }
  if (type === "component") {
    return "CMP";
  }
  if (type === "risk") {
    return "RSK";
  }
  return "G";
}

function nextContextId(manifest: PlanPackageManifest, type: Exclude<NodeType, "task">, title: string): string {
  const existing = new Set(manifest.nodes.map((node) => node.id));
  const prefix = contextPrefix(type);
  const base = slugPart(title);
  if (base && !existing.has(`${prefix}-${base}`)) {
    return `${prefix}-${base}`;
  }
  let index = manifest.nodes.filter((node) => node.type === type).length + 1;
  while (existing.has(`${prefix}-${String(index).padStart(3, "0")}`)) {
    index += 1;
  }
  return `${prefix}-${String(index).padStart(3, "0")}`;
}

function blockPrefix(type: BlockType): string {
  if (type === "check") {
    return "C";
  }
  if (type === "review") {
    return "R";
  }
  return "B";
}

function nextBlockId(task: ManifestTaskNode, type: BlockType): string {
  const prefix = blockPrefix(type);
  const existing = new Set(task.blocks.map((block) => block.id));
  let index = task.blocks.filter((block) => block.id.startsWith(`${prefix}-`)).length + 1;
  while (existing.has(`${prefix}-${String(index).padStart(3, "0")}`)) {
    index += 1;
  }
  return `${prefix}-${String(index).padStart(3, "0")}`;
}

function defaultBlockTitle(type: BlockType): string {
  if (type === "check") {
    return "Check work";
  }
  if (type === "review") {
    return "Review work";
  }
  return "Implement work";
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
      review: {
        required: true,
        maxFeedbackCycles: options.maxFeedbackCycles,
        hook: null
      }
    };
  }
  return {
    ...common,
    type: options.type,
    parallel: {
      safe: false,
      locks: []
    }
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

export async function addTaskNode(projectRoot: PackageWorkspaceRef, input: DesktopAddTaskInput): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  const title = requireNonEmptyTitle(input.title);
  const taskId = nextTaskId(manifest, title);
  const blockTypes = input.blockTypes?.length ? input.blockTypes : (["implementation", "check", "review"] satisfies BlockType[]);
  const blocks: ManifestBlock[] = [];
  for (const type of blockTypes) {
    const blockId = nextBlockId({ id: taskId, type: "task", title, prompt: "", acceptance: [], blocks }, type);
    blocks.push(
      createBlock({
        taskId,
        blockId,
        type,
        title: defaultBlockTitle(type),
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
    acceptance: input.acceptance?.length ? input.acceptance : ["Task is implemented and reviewed."],
    blocks
  };
  return commitPlanPackageGraphMutation({
    projectRoot,
    mutation: buildPlanPackageGraphMutation(manifest, {
      kind: "addTaskNode",
      node,
      taskPromptMarkdown: input.promptMarkdown,
      blockPromptMarkdown: blocks.map((block) => ({
        blockId: block.id,
        markdown: promptFileMarkdown(`# ${block.title}\n\n${input.promptMarkdown}`)
      }))
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

export async function addContextNode(projectRoot: PackageWorkspaceRef, input: DesktopAddContextNodeInput): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  const title = requireNonEmptyTitle(input.title);
  return addNode({
    projectRoot,
    node: {
      id: nextContextId(manifest, input.type, title),
      type: input.type,
      title,
      summary: input.summary.trim() || `${title}.`
    }
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
  const { manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  const task = getTask(graph, taskId);
  return updateNode({ projectRoot, node: { ...task, title: requireNonEmptyTitle(title) } });
}

export async function updateTaskPrompt(projectRoot: PackageWorkspaceRef, taskId: string, markdown: string): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  return commitPlanPackageGraphMutation({
    projectRoot,
    mutation: buildPlanPackageGraphMutation(manifest, { kind: "writeTaskPrompt", taskId, markdown })
  });
}

export async function updateBlockTitle(projectRoot: PackageWorkspaceRef, ref: string, title: string): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  const { taskId, blockId } = parseBlockRef(ref);
  const task = getTask(graph, taskId);
  if (!task.blocks.some((block) => block.id === blockId)) {
    throw new Error(`Block '${ref}' does not exist.`);
  }
  return updateNode({
    projectRoot,
    node: {
      ...task,
      blocks: task.blocks.map((block) => (block.id === blockId ? { ...block, title: requireNonEmptyTitle(title) } : block))
    }
  });
}

export async function updateBlockPrompt(projectRoot: PackageWorkspaceRef, ref: string, markdown: string): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  return commitPlanPackageGraphMutation({
    projectRoot,
    mutation: buildPlanPackageGraphMutation(manifest, { kind: "writeBlockPrompt", blockRef: ref, markdown })
  });
}

export async function updateTaskExecutor(projectRoot: PackageWorkspaceRef, taskId: string, executorName: string | null): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  const task = getTask(graph, taskId);
  const executor = normalizeOptionalText(executorName);
  return updateNode({
    projectRoot,
    node: executor === undefined ? { ...task, executor: undefined } : { ...task, executor }
  });
}

export async function updateBlockExecutor(projectRoot: PackageWorkspaceRef, ref: string, executorName: string | null): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  const { taskId, blockId } = parseBlockRef(ref);
  const task = getTask(graph, taskId);
  if (!task.blocks.some((block) => block.id === blockId)) {
    throw new Error(`Block '${ref}' does not exist.`);
  }
  const executor = normalizeOptionalText(executorName);
  return updateNode({
    projectRoot,
    node: {
      ...task,
      blocks: task.blocks.map((block) => (block.id === blockId ? { ...block, executor } : block))
    }
  });
}

export function addDependencyEdge(projectRoot: PackageWorkspaceRef, fromTaskId: string, toTaskId: string): Promise<GraphEditResult> {
  return addEdge({ projectRoot, edge: { from: fromTaskId, to: toTaskId, type: "depends_on" } });
}

export function removeDependencyEdge(projectRoot: PackageWorkspaceRef, fromTaskId: string, toTaskId: string): Promise<GraphEditResult> {
  return removeEdge({ projectRoot, edge: { from: fromTaskId, to: toTaskId, type: "depends_on" } });
}
