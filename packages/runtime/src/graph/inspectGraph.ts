import { sep } from "node:path";
import { compilePackageGraph } from "./compileTaskGraph.js";
import { requireMapValue } from "./requireMapValue.js";
import { loadPackage } from "../package/loadPackage.js";
import { ensureStateForManifest, readState } from "../state.js";
import type {
  CompiledExecutionGraph,
  GraphInspectionBlock,
  GraphInspectionBoundedSection,
  GraphInspectionCounts,
  GraphInspectionEdge,
  GraphInspectionPage,
  GraphInspectionResult,
  GraphInspectionTask,
  InspectGraphInput,
  ManifestTaskNode,
  PlanPackageManifest,
  RuntimeState
} from "../types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Graph inspection limit must be a positive integer.");
  }
  return Math.min(limit, MAX_LIMIT);
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const match = /^next:(\d+)$/.exec(cursor);
  if (!match) {
    throw new Error(`Invalid graph inspection cursor '${cursor}'.`);
  }
  return Number.parseInt(match[1], 10);
}

function pageFor(
  total: number,
  limit: number,
  offset: number,
  cursor: string | undefined
): GraphInspectionPage {
  const nextOffset = offset + limit;
  const nextCursor = nextOffset < total ? `next:${nextOffset}` : null;
  return {
    limit,
    cursor: cursor ?? null,
    nextCursor,
    total,
    truncated: nextCursor !== null
  };
}

function pageItems<T>(items: T[], limit: number, offset: number): T[] {
  return items.slice(offset, offset + limit);
}

function boundedSection<T>(items: T[], limit: number): GraphInspectionBoundedSection<T> {
  return {
    limit,
    total: items.length,
    truncated: items.length > limit,
    items: items.slice(0, limit)
  };
}

function promptMissingPaths(graph: CompiledExecutionGraph): Set<string> {
  return new Set(
    graph.diagnostics.errors
      .filter((diagnostic) => diagnostic.code === "prompt_missing" && diagnostic.path)
      .map((diagnostic) => diagnostic.path as string)
  );
}

function inspectTask(
  task: ManifestTaskNode,
  graph: CompiledExecutionGraph,
  state: RuntimeState,
  missingPromptPaths: Set<string>
): GraphInspectionTask {
  return {
    taskId: task.id,
    title: task.title,
    status: state.tasks[task.id]?.status ?? "planned",
    acceptanceCount: task.acceptance.length,
    blockCount: task.blocks.length,
    reviewBlockCount: task.blocks.filter((block) => block.type === "review").length,
    dependsOn: requireMapValue(graph.taskDependenciesByTask, task.id, "taskDependenciesByTask"),
    dependents: requireMapValue(graph.taskDependentsByTask, task.id, "taskDependentsByTask"),
    promptMissing: missingPromptPaths.has(task.prompt)
  };
}

function inspectTasks(graph: CompiledExecutionGraph, state: RuntimeState): GraphInspectionTask[] {
  const missingPromptPaths = promptMissingPaths(graph);
  return graph.taskNodesInManifestOrder.map((taskId) => {
    const task = requireMapValue(graph.tasksById, taskId, "tasksById");
    return inspectTask(task, graph, state, missingPromptPaths);
  });
}

function countsFor(graph: CompiledExecutionGraph, state: RuntimeState): GraphInspectionCounts {
  return {
    taskCount: graph.taskNodesInManifestOrder.length,
    blockCount: graph.blockRefsInManifestOrder.length,
    taskDependencyCount: [...graph.taskDependenciesByTask.values()].reduce(
      (count, dependencies) => count + dependencies.length,
      0
    ),
    reviewBlockCount: [...graph.reviewBlocksByTask.values()].reduce(
      (count, refs) => count + refs.length,
      0
    ),
    readyBlockCount: graph.blockRefsInManifestOrder.filter(
      (ref) => state.blocks[ref]?.status === "ready"
    ).length,
    diagnosticCount: graph.diagnostics.errors.length + graph.diagnostics.warnings.length
  };
}

function deriveCanvasId(packageDir: string): string | null {
  const parts = packageDir.split(sep);
  const packageIndex = parts.length - 1;
  if (
    parts[packageIndex] !== "package" ||
    packageIndex < 2 ||
    parts[packageIndex - 2] !== "canvases"
  ) {
    return null;
  }
  return parts[packageIndex - 1] ?? null;
}

function inspectBlock(
  ref: string,
  graph: CompiledExecutionGraph,
  state: RuntimeState
): GraphInspectionBlock {
  const block = requireMapValue(graph.blocksByRef, ref, "blocksByRef");
  return {
    ref,
    blockId: block.id,
    type: block.type,
    title: block.title,
    status: state.blocks[ref]?.status ?? "planned",
    dependsOn: requireMapValue(graph.blockDependenciesByRef, ref, "blockDependenciesByRef")
  };
}

function taskEdgesFor(taskIds: Set<string>, manifest: PlanPackageManifest): GraphInspectionEdge[] {
  return manifest.edges
    .filter((edge) => edge.type === "depends_on" && taskIds.has(edge.from) && taskIds.has(edge.to))
    .map((edge) => ({ from: edge.from, to: edge.to, type: edge.type }));
}

export async function inspectGraph(input: InspectGraphInput): Promise<GraphInspectionResult> {
  const limit = normalizeLimit(input.limit);
  if (input.view === "slice" && input.cursor) {
    throw new Error("Graph inspection slice view does not support cursor pagination.");
  }
  const offset = input.view === "slice" ? 0 : parseCursor(input.cursor);
  const { workspace, manifest } = await loadPackage(input.projectRoot);
  const graph = await compilePackageGraph(manifest, workspace.packageDir, {
    validatePromptContents: false
  });
  const state = ensureStateForManifest(manifest, await readState(workspace.stateFile));
  const tasks = inspectTasks(graph, state);

  if (input.view === "summary") {
    const preview = tasks.slice(offset, offset + limit);
    return {
      view: "summary",
      project: {
        id: workspace.id,
        title: manifest.project.title,
        description: manifest.project.description
      },
      canvas: {
        id: deriveCanvasId(workspace.packageDir),
        title: manifest.project.title
      },
      counts: countsFor(graph, state),
      tasksPreview: preview,
      page: pageFor(tasks.length, limit, offset, input.cursor)
    };
  }

  if (input.view === "tasks") {
    return {
      view: "tasks",
      tasks: tasks.slice(offset, offset + limit),
      page: pageFor(tasks.length, limit, offset, input.cursor)
    };
  }

  if (!input.taskId) {
    throw new Error("Graph inspection slice view requires taskId.");
  }
  const center = tasks.find((task) => task.taskId === input.taskId);
  if (!center) {
    throw new Error(`Task '${input.taskId}' does not exist in the graph.`);
  }
  const dependencies = center.dependsOn
    .map((taskId) => tasks.find((task) => task.taskId === taskId))
    .filter((task) => task !== undefined);
  const dependents = center.dependents
    .map((taskId) => tasks.find((task) => task.taskId === taskId))
    .filter((task) => task !== undefined);
  const boundedDependencies = boundedSection(dependencies, limit);
  const boundedDependents = boundedSection(dependents, limit);
  const visibleTaskIds = new Set([
    center.taskId,
    ...boundedDependencies.items.map((task) => task.taskId),
    ...boundedDependents.items.map((task) => task.taskId)
  ]);
  const edges = taskEdgesFor(visibleTaskIds, manifest);
  const blocks = requireMapValue(graph.blocksByTask, center.taskId, "blocksByTask").map((ref) =>
    inspectBlock(ref, graph, state)
  );
  return {
    view: "slice",
    taskId: center.taskId,
    center,
    dependencies: boundedDependencies,
    dependents: boundedDependents,
    edges: boundedSection(edges, limit),
    blocks: boundedSection(blocks, limit)
  };
}
