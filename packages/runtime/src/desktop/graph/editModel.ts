import { resolve } from "node:path";
import { compileTaskGraph } from "../../graph/compileTaskGraph.js";
import { buildPlanPackageGraphMutation } from "../../graph/mutation.js";
import { writeJsonFile } from "../../json.js";
import { loadPackage } from "../../package/loadPackage.js";
import { loadProjectGraphForWorkspace, projectCanvasWorkspace } from "../../projectGraph/index.js";
import { manifestSchema } from "../../schema/manifest.js";
import {
  executePlanGraphCommand,
  redoPlanGraphCommand,
  undoPlanGraphCommand,
  type BlockComponentSnapshot,
  type PlanGraphCommandResult,
  type TaskComponentSnapshot
} from "../../plangraph/index.js";
import type {
  BlockType,
  GraphEditResult,
  ManifestBlock,
  ManifestTaskNode,
  PackageWorkspaceRef,
  PlanPackageManifest,
  ReviewHookDefinition
} from "../../types.js";
import type { DesktopAddBlockInput, DesktopAddTaskInput, DesktopGraphEditValidationInput, DesktopLayout, DesktopPromptSaveOptions } from "../types.js";
import { getDesktopLayout, saveDesktopLayoutDirect } from "../layoutApi.js";
import { getTask } from "./graphHelpers.js";
import { invalidateDesktopProjectProjection } from "./projectProjectionModel.js";

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
  const snapshot: TaskComponentSnapshot = {
    task: node,
    taskPromptMarkdown: input.promptMarkdown,
    blockPromptMarkdown: blocks.map((block) => ({ blockId: block.id, markdown: promptFileMarkdown(`# ${block.title}\n\n${input.promptMarkdown}`) })),
    insertIndex: null,
    affectedTaskEdges: [],
    layoutNode: input.layoutPosition ? { nodeId: taskId, x: input.layoutPosition.x, y: input.layoutPosition.y } : null
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

export async function updateTaskTitle(projectRoot: PackageWorkspaceRef, taskId: string, title: string): Promise<GraphEditResult> {
  return executeDesktopPlanGraphCommand(projectRoot, { type: "updateTaskFields", taskId, fields: { title: requireNonEmptyTitle(title) } });
}

export async function updateTaskPrompt(
  projectRoot: PackageWorkspaceRef,
  taskId: string,
  markdown: string,
  options: DesktopPromptSaveOptions = {}
): Promise<GraphEditResult> {
  return executeDesktopPlanGraphCommand(projectRoot, {
    type: "updateTaskFields",
    taskId,
    baseGraphVersion: options.baseGraphVersion,
    fields: { promptMarkdown: markdown, basePromptHash: options.basePromptHash }
  });
}

export async function updateBlockTitle(projectRoot: PackageWorkspaceRef, ref: string, title: string): Promise<GraphEditResult> {
  return executeDesktopPlanGraphCommand(projectRoot, { type: "updateBlockFields", blockRef: ref, fields: { title: requireNonEmptyTitle(title) } });
}

export async function updateBlockPrompt(
  projectRoot: PackageWorkspaceRef,
  ref: string,
  markdown: string,
  options: DesktopPromptSaveOptions = {}
): Promise<GraphEditResult> {
  return executeDesktopPlanGraphCommand(projectRoot, {
    type: "updateBlockFields",
    blockRef: ref,
    baseGraphVersion: options.baseGraphVersion,
    fields: { promptMarkdown: markdown, basePromptHash: options.basePromptHash }
  });
}

export async function updateTaskExecutor(projectRoot: PackageWorkspaceRef, taskId: string, executorName: string | null): Promise<GraphEditResult> {
  return executeDesktopPlanGraphCommand(projectRoot, { type: "updateTaskFields", taskId, fields: { executor: executorName } });
}

export async function updateTaskAcceptance(projectRoot: PackageWorkspaceRef, taskId: string, acceptance: string[]): Promise<GraphEditResult> {
  return executeDesktopPlanGraphCommand(projectRoot, { type: "updateTaskFields", taskId, fields: { acceptance } });
}

export async function updateBlockExecutor(projectRoot: PackageWorkspaceRef, ref: string, executorName: string | null): Promise<GraphEditResult> {
  return executeDesktopPlanGraphCommand(projectRoot, { type: "updateBlockFields", blockRef: ref, fields: { executor: executorName } });
}

export async function updateBlockDependencies(projectRoot: PackageWorkspaceRef, ref: string, dependsOn: string[]): Promise<GraphEditResult> {
  return executeDesktopPlanGraphCommand(projectRoot, { type: "updateBlockFields", blockRef: ref, fields: { dependsOn } });
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
  return executeDesktopPlanGraphCommand(projectRoot, { type: "updateBlockFields", blockRef: ref, fields: input });
}

export async function updateCanvasExecutionPolicy(
  projectRoot: PackageWorkspaceRef,
  input: {
    defaultExecutor?: string | null;
    parallelEnabled?: boolean;
    maxConcurrent?: number;
  }
): Promise<GraphEditResult> {
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

  const { workspace, manifest } = await loadPackage(projectRoot);
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

  const affectedTasks = nextManifest.nodes.map((node) => node.id);
  const result = manifestValidationResult(nextManifest, affectedTasks);
  if (!result.ok) {
    return result;
  }

  await writeJsonFile(workspace.manifestFile, nextManifest);
  invalidateDesktopProjectProjection(workspace);
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
