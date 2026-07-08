import { compileTaskGraph } from "../../graph/compileTaskGraph.js";
import { commitPlanPackageGraphMutation } from "../../graph/editGraph.js";
import {
  buildPlanPackageGraphMutation,
  buildPlanPackageManifestChangeMutation,
  type PlanPackageGraphMutation,
  type PlanPackageGraphMutationSideEffect
} from "../../graph/mutation.js";
import { loadPackage } from "../../package/loadPackage.js";
import type {
  BlockType,
  GraphEditResult,
  ManifestBlock,
  ManifestTaskNode,
  PackageWorkspaceRef,
  PlanPackageManifest
} from "../../types.js";
import type { DesktopAddBlockInput, DesktopAddTaskInput } from "../types.js";
import { type BlockComponentSnapshot, type TaskComponentSnapshot } from "../../plangraph/index.js";
import { getTask } from "./graphHelpers.js";
import { invalidateDesktopProjectProjection } from "./projectProjectionModel.js";
import { defaultTaskBlockTypes } from "./taskDefaults.js";
import { executeDesktopPlanGraphCommand } from "./editModelCommand.js";
import type { DesktopBulkCreateBlockInput, DesktopBulkCreateTaskInput } from "./editModelTypes.js";
import { requireNonEmptyTitle } from "./editModelValidation.js";

function normalizeOptionalText(value: string | null): string | undefined {
  return value?.trim() || undefined;
}

function promptFileMarkdown(markdown: string): string {
  return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
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

function planNewBlockPlacement(task: ManifestTaskNode, block: ManifestBlock, explicitDependsOn: boolean): {
  task: ManifestTaskNode;
  insertIndex: number | null;
  affectedDependsOn: Array<{ blockRef: string; dependsOn: string[] }>;
} {
  if (explicitDependsOn || block.type !== "implementation") {
    return {
      task: { ...task, blocks: [...task.blocks, block] },
      insertIndex: null,
      affectedDependsOn: []
    };
  }
  let reviewIndex = -1;
  for (let index = task.blocks.length - 1; index >= 0; index -= 1) {
    if (task.blocks[index].type === "review") {
      reviewIndex = index;
      break;
    }
  }
  if (reviewIndex < 0) {
    return {
      task: { ...task, blocks: [...task.blocks, block] },
      insertIndex: null,
      affectedDependsOn: []
    };
  }
  const reviewBlock = task.blocks[reviewIndex];
  let dependsOn = [...reviewBlock.depends_on];
  if (dependsOn.length === 0) {
    for (let index = reviewIndex - 1; index >= 0; index -= 1) {
      if (task.blocks[index].type === "implementation") {
        dependsOn = [task.blocks[index].id];
        break;
      }
    }
  }
  const placedBlock = {
    ...block,
    depends_on: dependsOn
  };
  const nextBlocks = [
    ...task.blocks.slice(0, reviewIndex),
    placedBlock,
    ...task.blocks.slice(reviewIndex).map((candidate, index) => {
      if (index !== 0 || candidate.type !== "review") {
        return candidate;
      }
      return { ...candidate, depends_on: [placedBlock.id] };
    })
  ];
  return {
    task: { ...task, blocks: nextBlocks },
    insertIndex: reviewIndex,
    affectedDependsOn: [{ blockRef: `${task.id}#${reviewBlock.id}`, dependsOn: [placedBlock.id] }]
  };
}

function addBlockMutation(
  manifest: PlanPackageManifest,
  task: ManifestTaskNode,
  block: ManifestBlock,
  promptMarkdown: string,
  explicitDependsOn: boolean
): PlanPackageGraphMutation {
  const placement = planNewBlockPlacement(task, block, explicitDependsOn);
  const nextManifest = {
    ...manifest,
    nodes: manifest.nodes.map((node) => (node.type === "task" && node.id === task.id ? placement.task : node))
  };
  const sideEffects: PlanPackageGraphMutationSideEffect[] = [{ kind: "writePrompt", packagePath: block.prompt, markdown: promptMarkdown }];
  return buildPlanPackageManifestChangeMutation(manifest, nextManifest, {
    affectedTasks: [task.id],
    sideEffects
  });
}

function buildTaskNodeForCreate(manifest: PlanPackageManifest, input: DesktopAddTaskInput): {
  node: ManifestTaskNode;
  taskPromptMarkdown: string;
  blockPromptMarkdown: Array<{ blockId: string; markdown: string }>;
} {
  const title = requireNonEmptyTitle(input.title);
  const taskId = nextTaskId(manifest, title);
  const blockTypes = input.blockTypes?.length ? input.blockTypes : defaultTaskBlockTypes();
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
  const explicitDependsOn = input.dependsOn !== undefined;
  const block = createBlock({
    taskId: task.id,
    blockId,
    type: input.type,
    title: input.title,
    dependsOn: explicitDependsOn ? (input.dependsOn ?? []) : (task.blocks.length > 0 ? [task.blocks[task.blocks.length - 1].id] : []),
    executor: normalizeOptionalText(input.executor ?? null),
    maxFeedbackCycles: manifest.review.maxFeedbackCycles
  });
  const placement = planNewBlockPlacement(task, block, explicitDependsOn);
  const snapshot: BlockComponentSnapshot = {
    taskId: task.id,
    block: placement.task.blocks.find((candidate) => candidate.id === block.id) ?? block,
    promptMarkdown: promptFileMarkdown(input.promptMarkdown),
    insertIndex: placement.insertIndex,
    affectedDependsOn: placement.affectedDependsOn
  };
  return executeDesktopPlanGraphCommand(projectRoot, { type: "addBlock", snapshot });
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
    const explicitDependsOn = input.dependsOn !== undefined;
    const block = createBlock({
      taskId: task.id,
      blockId,
      type: input.type,
      title: input.title,
      dependsOn: explicitDependsOn ? (input.dependsOn ?? []) : (task.blocks.length > 0 ? [task.blocks[task.blocks.length - 1].id] : []),
      executor: normalizeOptionalText(input.executor ?? null),
      maxFeedbackCycles: nextManifest.review.maxFeedbackCycles
    });
    const mutation = addBlockMutation(nextManifest, task, block, promptFileMarkdown(input.promptMarkdown), explicitDependsOn);
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
