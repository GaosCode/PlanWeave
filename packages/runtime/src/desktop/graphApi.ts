import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { addEdge, addNode, removeEdge, removeNode, updateNode } from "../graph/editGraph.js";
import { loadPackage } from "../package/loadPackage.js";
import { resolvePackagePath } from "../package/resolvePackagePath.js";
import { readState } from "../state.js";
import { getExecutionStatus } from "../taskManager/index.js";
import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { listExecutorProfiles } from "../autoRun/executors.js";
import type {
  BlockStatus,
  BlockType,
  CompiledExecutionGraph,
  GraphEditResult,
  ManifestBlock,
  ManifestContextNode,
  ManifestTaskNode,
  NodeType,
  PlanPackageManifest
} from "../types.js";
import type {
  DesktopAddBlockInput,
  DesktopAddContextNodeInput,
  DesktopAddTaskInput,
  DesktopBlockDetail,
  DesktopBlockPreview,
  DesktopGraphEditValidationInput,
  DesktopGraphViewModel,
  DesktopSearchFilters,
  DesktopSearchResult,
  DesktopSearchResultKind,
  DesktopStatistics,
  DesktopTaskDraft,
  DesktopTaskDetail,
  DesktopTaskExecutionOrder,
  DesktopTaskException,
  DesktopTodoGroups,
  DesktopTodoItem
} from "./types.js";

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function listResultFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await listResultFiles(path)));
      } else if (entry.isFile() && /\.(md|json|log|txt)$/.test(entry.name)) {
        files.push(path);
      }
    }
    return files;
  } catch {
    return [];
  }
}

async function smallTextFile(path: string): Promise<string> {
  const metadata = await stat(path);
  if (metadata.size > 256_000) {
    return "";
  }
  return readFile(path, "utf8");
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function blockRef(taskId: string, blockId: string): string {
  return `${taskId}#${blockId}`;
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

function runRecordIdFromResultPath(path: string): string | null {
  const match = /^([^/]+)\/blocks\/([^/]+)\/runs\/([^/]+)\//.exec(path);
  if (!match) {
    return null;
  }
  return `${match[1]}#${match[2]}::${match[3]}`;
}

function getTask(graph: CompiledExecutionGraph, taskId: string): ManifestTaskNode {
  const task = graph.tasksById.get(taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' does not exist.`);
  }
  return task;
}

function getBlock(graph: CompiledExecutionGraph, ref: string): ManifestBlock {
  const block = graph.blocksByRef.get(ref);
  if (!block) {
    throw new Error(`Block '${ref}' does not exist.`);
  }
  return block;
}

function sortBlockRefsForTask(graph: CompiledExecutionGraph, taskId: string): string[] {
  const refs = graph.blocksByTask.get(taskId) ?? [];
  const order = new Map(refs.map((ref, index) => [ref, index]));
  const dependencies = new Map(refs.map((ref) => [ref, new Set(graph.blockDependenciesByRef.get(ref) ?? [])]));
  const sorted: string[] = [];
  const ready = refs.filter((ref) => (dependencies.get(ref)?.size ?? 0) === 0);

  while (ready.length > 0) {
    ready.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
    const current = ready.shift();
    if (!current || sorted.includes(current)) {
      continue;
    }
    sorted.push(current);
    for (const dependent of graph.blockDependentsByRef.get(current) ?? []) {
      const remaining = dependencies.get(dependent);
      if (!remaining) {
        continue;
      }
      remaining.delete(current);
      if (remaining.size === 0) {
        ready.push(dependent);
      }
    }
  }

  return sorted.length === refs.length ? sorted : refs;
}

function exceptionForBlock(ref: string, status: BlockStatus, reason?: string | null): DesktopTaskException | null {
  if (status === "blocked") {
    return { ref, source: "blocked", reason: reason ?? `${ref} is blocked.` };
  }
  if (status === "diverged") {
    return { ref, source: "diverged", reason: reason ?? `${ref} diverged from expected work.` };
  }
  if (status === "needs_changes") {
    return { ref, source: "needs_changes", reason: reason ?? `${ref} needs changes.` };
  }
  return null;
}

function executorLabel(task: ManifestTaskNode): string {
  const blockExecutors = new Set(task.blocks.map((block) => block.executor ?? task.executor ?? null));
  if (blockExecutors.size > 1) {
    return "Mixed";
  }
  return task.executor ?? "manual";
}

function promptPreview(markdown: string): string {
  return markdown.replace(/\s+/g, " ").trim().slice(0, 220);
}

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

function draftTitle(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (firstLine ?? "New task").replace(/^#+\s*/, "").slice(0, 80);
}

function acceptanceFromText(text: string): string[] {
  const bullets = text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter((line) => line.length > 0)
    .slice(0, 3);
  return bullets.length > 0 ? bullets : ["Task is implemented and reviewed."];
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

async function writePromptFile(packageDir: string, packagePath: string, markdown: string): Promise<void> {
  const promptPath = await resolvePackagePath(packageDir, packagePath, { forWrite: true });
  await mkdir(dirname(promptPath), { recursive: true });
  await writeFile(promptPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
}

export async function getGraphViewModel(projectRoot: string): Promise<DesktopGraphViewModel> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const graph = await import("../graph/compileTaskGraph.js").then((module) => module.compilePackageGraph(manifest, workspace.packageDir));
  const state = await readState(workspace.stateFile);
  const status = await getExecutionStatus({ projectRoot });
  const statusByBlock = new Map(status.blocks.map((block) => [block.ref, block]));
  const dirtyPromptRefs = new Set<string>();
  const executorOptions = (await listExecutorProfiles({ projectRoot })).map((profile) => profile.name);

  const tasks = await Promise.all(
    graph.taskNodesInManifestOrder.map(async (taskId) => {
      const task = getTask(graph, taskId);
      const taskStatus = status.tasks.find((item) => item.taskId === taskId)?.status ?? "planned";
      const markdown = await readOptionalFile(await resolvePackagePath(workspace.packageDir, task.prompt));
      const orderedRefs = sortBlockRefsForTask(graph, taskId);
      const blockPreview: DesktopBlockPreview[] = orderedRefs.slice(0, 4).map((ref) => {
        const block = getBlock(graph, ref);
        const blockStatus = statusByBlock.get(ref);
        return {
          ref,
          blockId: parseBlockRef(ref).blockId,
          type: block.type,
          title: block.title,
          status: blockStatus?.status ?? "planned",
          executor: block.executor ?? task.executor ?? manifest.execution.defaultExecutor ?? null,
          exceptionReason: blockStatus?.reason ?? null
        };
      });
      const exceptions = orderedRefs
        .map((ref) => {
          const blockStatus = statusByBlock.get(ref);
          if (!blockStatus) {
            return null;
          }
          return exceptionForBlock(ref, blockStatus.status, blockStatus.reason);
        })
        .filter((item): item is DesktopTaskException => item !== null);
      if ((state.tasks[taskId]?.openFeedbackCount ?? 0) > 0) {
        exceptions.push({
          ref: taskId,
          source: "feedback",
          reason: `${state.tasks[taskId].openFeedbackCount} unresolved feedback item(s).`
        });
      }
      return {
        taskId,
        title: task.title,
        status: taskStatus,
        executor: task.executor ?? null,
        executorLabel: executorLabel(task),
        promptMarkdown: markdown,
        promptPreview: promptPreview(markdown),
        blockPreview,
        overflowBlockCount: Math.max(0, orderedRefs.length - blockPreview.length),
        exceptions
      };
    })
  );

  return {
    projectId: workspace.id,
    projectTitle: manifest.project.title,
    executorOptions,
    tasks,
    contextNodes: manifest.nodes
      .filter((node): node is ManifestContextNode => node.type !== "task")
      .map((node) => ({
        nodeId: node.id,
        type: node.type,
        title: node.title,
        summary: node.summary
      })),
    edges: manifest.edges.map((edge) => ({ from: edge.from, to: edge.to, type: edge.type })),
    diagnostics: graph.diagnostics.errors,
    dirtyPromptRefs: [...dirtyPromptRefs]
  };
}

export async function getTaskDetail(projectRoot: string, taskId: string): Promise<DesktopTaskDetail> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  const task = getTask(graph, taskId);
  const status = await getExecutionStatus({ projectRoot });
  return {
    taskId,
    title: task.title,
    status: status.tasks.find((item) => item.taskId === taskId)?.status ?? "planned",
    executor: task.executor ?? null,
    promptMarkdown: await readOptionalFile(await resolvePackagePath(workspace.packageDir, task.prompt)),
    acceptance: task.acceptance,
    blockOrder: sortBlockRefsForTask(graph, taskId)
  };
}

export async function getTaskExecutionOrder(projectRoot: string, taskId: string): Promise<DesktopTaskExecutionOrder> {
  const { manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  getTask(graph, taskId);
  return {
    taskId,
    blockRefs: sortBlockRefsForTask(graph, taskId)
  };
}

export async function getBlockDetail(projectRoot: string, ref: string): Promise<DesktopBlockDetail> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  const { taskId, blockId } = parseBlockRef(ref);
  const task = getTask(graph, taskId);
  const block = getBlock(graph, ref);
  const status = await getExecutionStatus({ projectRoot });
  const blockStatus = status.blocks.find((item) => item.ref === ref);
  return {
    ref,
    taskId,
    blockId,
    type: block.type,
    title: block.title,
    status: blockStatus?.status ?? "planned",
    executor: block.executor ?? null,
    effectiveExecutor: block.executor ?? task.executor ?? manifest.execution.defaultExecutor ?? null,
    promptMarkdown: await readOptionalFile(await resolvePackagePath(workspace.packageDir, block.prompt)),
    dependencies: graph.blockDependenciesByRef.get(ref) ?? [],
    latestRunId: blockStatus?.lastRunId ?? null,
    latestReviewAttemptId: blockStatus?.latestReviewAttemptId ?? null,
    activeFeedbackId: blockStatus?.activeFeedbackId ?? null,
    exceptionReason: blockStatus?.reason ?? null
  };
}

export async function createTaskDraft(projectRoot: string, input: {
  mode: "task" | "blocks" | "document";
  text: string;
  targetTaskId?: string | null;
}): Promise<DesktopTaskDraft> {
  const text = input.text.trim();
  if (!text) {
    throw new Error("Task draft text must not be empty.");
  }
  if (input.mode === "blocks") {
    if (!input.targetTaskId) {
      throw new Error("Appending blocks requires a target task.");
    }
    getTask(compileTaskGraph((await loadPackage(projectRoot)).manifest), input.targetTaskId);
    return {
      mode: "blocks",
      targetTaskId: input.targetTaskId,
      tasks: [],
      blocks: [
        {
          taskId: input.targetTaskId,
          type: "implementation",
          title: draftTitle(text),
          promptMarkdown: text
        }
      ]
    };
  }
  if (input.mode === "document") {
    const sections = text
      .split(/\n(?=#+\s+)/)
      .map((section) => section.trim())
      .filter(Boolean);
    const taskSections = sections.length > 1 ? sections : [text];
    return {
      mode: "document",
      targetTaskId: null,
      tasks: taskSections.slice(0, 6).map((section) => ({
        title: draftTitle(section),
        promptMarkdown: section,
        acceptance: acceptanceFromText(section),
        blockTypes: ["implementation", "check", "review"]
      })),
      blocks: []
    };
  }
  return {
    mode: "task",
    targetTaskId: null,
    tasks: [
      {
        title: draftTitle(text),
        promptMarkdown: text,
        acceptance: acceptanceFromText(text),
        blockTypes: ["implementation", "check", "review"]
      }
    ],
    blocks: []
  };
}

export async function addTaskNode(projectRoot: string, input: DesktopAddTaskInput): Promise<GraphEditResult> {
  const { workspace, manifest } = await loadPackage(projectRoot);
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
  const result = await addNode({ projectRoot, node, promptMarkdown: input.promptMarkdown });
  if (!result.ok) {
    return result;
  }
  for (const block of blocks) {
    await writePromptFile(workspace.packageDir, block.prompt, `# ${block.title}\n\n${input.promptMarkdown}`);
  }
  return result;
}

export async function addBlock(projectRoot: string, input: DesktopAddBlockInput): Promise<GraphEditResult> {
  const { workspace, manifest } = await loadPackage(projectRoot);
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
  const nextTask: ManifestTaskNode = { ...task, blocks: [...task.blocks, block] };
  const result = await updateNode({ projectRoot, node: nextTask });
  if (!result.ok) {
    return result;
  }
  await writePromptFile(workspace.packageDir, block.prompt, input.promptMarkdown);
  return result;
}

export async function addContextNode(projectRoot: string, input: DesktopAddContextNodeInput): Promise<GraphEditResult> {
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

export async function removeTaskNode(projectRoot: string, taskId: string): Promise<GraphEditResult> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const task = getTask(compileTaskGraph(manifest), taskId);
  const result = await removeNode({ projectRoot, nodeId: taskId, removePrompt: false });
  if (!result.ok) {
    return result;
  }
  await rm(dirname(await resolvePackagePath(workspace.packageDir, task.prompt)), { recursive: true, force: true });
  return result;
}

export async function removeBlock(projectRoot: string, ref: string): Promise<GraphEditResult> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  const { taskId, blockId } = parseBlockRef(ref);
  const task = getTask(graph, taskId);
  const block = getBlock(graph, ref);
  const nextTask: ManifestTaskNode = {
    ...task,
    blocks: task.blocks
      .filter((candidate) => candidate.id !== blockId)
      .map((candidate) => ({
        ...candidate,
        depends_on: candidate.depends_on.filter((dependency) => dependency !== blockId)
      }))
  };
  const result = await updateNode({ projectRoot, node: nextTask });
  if (!result.ok) {
    return result;
  }
  await rm(await resolvePackagePath(workspace.packageDir, block.prompt), { force: true });
  return result;
}

export async function validateGraphEdit(projectRoot: string, input: DesktopGraphEditValidationInput): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  if (input.kind === "addDependencyEdge") {
    return graphEditResult(
      { ...manifest, edges: [...manifest.edges, { from: input.fromTaskId, to: input.toTaskId, type: "depends_on" }] },
      [input.fromTaskId]
    );
  }
  if (input.kind === "removeDependencyEdge") {
    return graphEditResult(
      {
        ...manifest,
        edges: manifest.edges.filter(
          (edge) => !(edge.from === input.fromTaskId && edge.to === input.toTaskId && edge.type === "depends_on")
        )
      },
      [input.fromTaskId]
    );
  }
  if (input.kind === "removeTaskNode") {
    return graphEditResult(
      {
        ...manifest,
        nodes: manifest.nodes.filter((node) => node.id !== input.taskId),
        edges: manifest.edges.filter((edge) => edge.from !== input.taskId && edge.to !== input.taskId)
      },
      [input.taskId]
    );
  }

  const graph = compileTaskGraph(manifest);
  const { taskId, blockId } = parseBlockRef(input.blockRef);
  const task = getTask(graph, taskId);
  getBlock(graph, input.blockRef);
  return graphEditResult(
    {
      ...manifest,
      nodes: manifest.nodes.map((node) =>
        node.id === taskId && node.type === "task"
          ? {
              ...task,
              blocks: task.blocks
                .filter((block) => block.id !== blockId)
                .map((block) => ({ ...block, depends_on: block.depends_on.filter((dependency) => dependency !== blockId) }))
            }
          : node
      )
    },
    [taskId]
  );
}

export async function updateTaskTitle(projectRoot: string, taskId: string, title: string): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  const task = getTask(graph, taskId);
  return updateNode({ projectRoot, node: { ...task, title: requireNonEmptyTitle(title) } });
}

export async function updateTaskPrompt(projectRoot: string, taskId: string, markdown: string): Promise<GraphEditResult> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const task = getTask(compileTaskGraph(manifest), taskId);
  const promptPath = await resolvePackagePath(workspace.packageDir, task.prompt);
  await mkdir(dirname(promptPath), { recursive: true });
  await writeFile(promptPath, markdown, "utf8");
  return { ok: true, affectedTasks: [taskId], diagnostics: [], graph: compileTaskGraph(manifest) };
}

export async function updateBlockTitle(projectRoot: string, ref: string, title: string): Promise<GraphEditResult> {
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

export async function updateBlockPrompt(projectRoot: string, ref: string, markdown: string): Promise<GraphEditResult> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  const block = getBlock(graph, ref);
  const promptPath = await resolvePackagePath(workspace.packageDir, block.prompt);
  await mkdir(dirname(promptPath), { recursive: true });
  await writeFile(promptPath, markdown, "utf8");
  return { ok: true, affectedTasks: [graph.blockTaskByRef.get(ref) ?? parseBlockRef(ref).taskId], diagnostics: [], graph };
}

export async function updateTaskExecutor(projectRoot: string, taskId: string, executorName: string | null): Promise<GraphEditResult> {
  const { manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  const task = getTask(graph, taskId);
  const executor = normalizeOptionalText(executorName);
  return updateNode({
    projectRoot,
    node: executor === undefined ? { ...task, executor: undefined } : { ...task, executor }
  });
}

export async function updateBlockExecutor(projectRoot: string, ref: string, executorName: string | null): Promise<GraphEditResult> {
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

export function addDependencyEdge(projectRoot: string, fromTaskId: string, toTaskId: string): Promise<GraphEditResult> {
  return addEdge({ projectRoot, edge: { from: fromTaskId, to: toTaskId, type: "depends_on" } });
}

export function removeDependencyEdge(projectRoot: string, fromTaskId: string, toTaskId: string): Promise<GraphEditResult> {
  return removeEdge({ projectRoot, edge: { from: fromTaskId, to: toTaskId, type: "depends_on" } });
}

export async function getTodoGroups(projectRoot: string): Promise<DesktopTodoGroups> {
  const { manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  const status = await getExecutionStatus({ projectRoot });
  const taskStatusById = new Map(status.tasks.map((task) => [task.taskId, task.status]));
  const groups: DesktopTodoGroups = {
    planned: [],
    ready: [],
    in_progress: [],
    completed: [],
    needs_changes: [],
    blocked: [],
    diverged: [],
    implemented: []
  };
  for (const blockStatus of status.blocks) {
    const block = getBlock(graph, blockStatus.ref);
    const taskDependencyBlockers = (graph.taskDependenciesByTask.get(blockStatus.taskId) ?? []).filter(
      (taskId) => taskStatusById.get(taskId) !== "implemented"
    );
    const blockDependencyBlockers = (graph.blockDependenciesByRef.get(blockStatus.ref) ?? []).filter((dependency) => {
      const dependencyStatus = status.blocks.find((candidate) => candidate.ref === dependency)?.status;
      return dependencyStatus !== "completed";
    });
    const dependencyBlockers = [...taskDependencyBlockers, ...blockDependencyBlockers];
    const displayStatus = blockStatus.status === "ready" && dependencyBlockers.length > 0 ? "planned" : blockStatus.status;
    const groupName: keyof DesktopTodoGroups = taskStatusById.get(blockStatus.taskId) === "implemented" ? "implemented" : displayStatus;
    const item: DesktopTodoItem = {
      ref: blockStatus.ref,
      taskId: blockStatus.taskId,
      blockId: blockStatus.blockId,
      title: block.title,
      status: displayStatus,
      dependencyBlockers,
      parallelSafe: graph.parallelSafeByBlockRef.get(blockStatus.ref) ?? false,
      locks: graph.locksByBlockRef.get(blockStatus.ref) ?? []
    };
    groups[groupName].push(item);
  }
  return groups;
}

export async function getStatistics(projectRoot: string): Promise<DesktopStatistics> {
  const { workspace } = await loadPackage(projectRoot);
  const status = await getExecutionStatus({ projectRoot });
  const implementationDurations: number[] = [];
  for (const file of await listResultFiles(workspace.resultsDir)) {
    const relativePath = toPosixPath(relative(workspace.resultsDir, file));
    if (!relativePath.includes("/blocks/") || !relativePath.endsWith("/metadata.json")) {
      continue;
    }
    const metadata = await readJsonObject(file);
    const startedAt = typeof metadata?.startedAt === "string" ? Date.parse(metadata.startedAt) : Number.NaN;
    const finishedAt = typeof metadata?.finishedAt === "string" ? Date.parse(metadata.finishedAt) : Number.NaN;
    if (Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt) {
      implementationDurations.push(finishedAt - startedAt);
    }
  }
  const reviewBlockCount = status.blocks.filter((block) => block.type === "review").length;
  const reviewPassedCount = status.blocks.filter((block) => block.type === "review" && block.completionReason === "passed").length;
  const feedbackEnvelopeCount = Object.values(status.counts.feedback).reduce((sum, count) => sum + count, 0);
  return {
    taskTotal: status.taskTotal,
    implementedTaskCount: status.counts.tasks.implemented,
    implementedRatio: status.taskTotal === 0 ? 0 : status.counts.tasks.implemented / status.taskTotal,
    taskThroughput: status.counts.tasks.implemented,
    blockTotal: status.blockTotal,
    completedBlockCount: status.counts.blocks.completed,
    averageImplementationTimeMs:
      implementationDurations.length === 0
        ? null
        : Math.round(implementationDurations.reduce((sum, duration) => sum + duration, 0) / implementationDurations.length),
    reviewPassedCount,
    reviewPassedRatio: reviewBlockCount === 0 ? 0 : reviewPassedCount / reviewBlockCount,
    feedbackEnvelopeCount,
    reworkCount: feedbackEnvelopeCount,
    estimatedRemainingBlocks: status.blockTotal - status.counts.blocks.completed
  };
}

export async function searchProject(projectRoot: string, query: string, filters: DesktopSearchFilters = {}): Promise<DesktopSearchResult[]> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const allowedKinds = filters.kinds?.length ? new Set<DesktopSearchResultKind>(filters.kinds) : null;
  const { workspace, manifest } = await loadPackage(projectRoot);
  const graph = compileTaskGraph(manifest);
  const state = await readState(workspace.stateFile);
  const results: DesktopSearchResult[] = [];
  const reviewBlockRefFromResultPath = (path: string): string | null => {
    const match = path.match(/^([^/]+)\/reviews\/([^/]+)\/attempts\//);
    return match ? blockRef(match[1], match[2]) : null;
  };
  const pushResult = (result: DesktopSearchResult) => {
    if (!allowedKinds || allowedKinds.has(result.kind)) {
      results.push(result);
    }
  };
  for (const taskId of graph.taskNodesInManifestOrder) {
    const task = getTask(graph, taskId);
    const taskPrompt = await readOptionalFile(await resolvePackagePath(workspace.packageDir, task.prompt));
    if (task.title.toLowerCase().includes(normalized)) {
      pushResult({ kind: "task", ref: taskId, title: task.title, excerpt: task.title });
    }
    if (taskPrompt.toLowerCase().includes(normalized)) {
      pushResult({ kind: "prompt", ref: taskId, targetRef: taskId, title: task.title, excerpt: promptPreview(taskPrompt) });
    }
    for (const block of task.blocks) {
      const ref = blockRef(taskId, block.id);
      const blockPrompt = await readOptionalFile(await resolvePackagePath(workspace.packageDir, block.prompt));
      if (block.title.toLowerCase().includes(normalized)) {
        pushResult({ kind: "block", ref, title: block.title, excerpt: block.title });
      }
      if (blockPrompt.toLowerCase().includes(normalized)) {
        pushResult({ kind: "prompt", ref, targetRef: ref, title: block.title, excerpt: promptPreview(blockPrompt) });
      }
    }
  }
  for (const node of manifest.nodes) {
    if (node.type === "task") {
      continue;
    }
    if (node.title.toLowerCase().includes(normalized) || node.summary.toLowerCase().includes(normalized)) {
      pushResult({
        kind: "context",
        ref: node.id,
        targetRef: node.id,
        title: node.title,
        excerpt: promptPreview(node.summary)
      });
    }
  }
  for (const [feedbackId, feedback] of Object.entries(state.feedback)) {
    if (feedback.content.toLowerCase().includes(normalized)) {
      pushResult({
        kind: "feedback",
        ref: feedbackId,
        targetRef: feedback.sourceReviewBlockRef,
        title: `${feedbackId} · ${feedback.sourceReviewBlockRef}`,
        excerpt: promptPreview(feedback.content)
      });
    }
  }
  for (const file of await listResultFiles(workspace.resultsDir)) {
    const content = await smallTextFile(file);
    if (!content.toLowerCase().includes(normalized)) {
      continue;
    }
    const relativePath = relative(workspace.resultsDir, file);
    const kind = relativePath.includes("/reviews/") ? "review_attempt" : "run_record";
    pushResult({
      kind,
      ref: relativePath,
      targetRef:
        kind === "review_attempt"
          ? reviewBlockRefFromResultPath(toPosixPath(relativePath)) ?? undefined
          : runRecordIdFromResultPath(toPosixPath(relativePath))?.split("::")[0],
      title: relativePath,
      excerpt: promptPreview(content),
      path: relativePath,
      recordId: kind === "run_record" ? runRecordIdFromResultPath(toPosixPath(relativePath)) ?? undefined : undefined
    });
  }
  return results;
}
