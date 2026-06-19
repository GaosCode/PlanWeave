import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { loadPackage } from "../package/loadPackage.js";
import type { CompiledTaskGraph, PlanPackageManifest, ProjectWorkspace, ValidationIssue } from "../types.js";
import { findCycle, reachable } from "./graphAlgorithms.js";
import { parseProjectTaskRefKey, projectCanvasEdgeKey, projectCrossTaskEdgeKey, projectTaskRefKey } from "./projectGraphKeys.js";
import { projectCanvasWorkspace } from "./projectGraphWorkspace.js";
import type {
  CompiledProjectGraph,
  LoadedProjectGraph,
  ProjectCanvasNode,
  ProjectTaskRef,
  ProjectTaskRefString
} from "./types.js";

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

function addUnique(map: Map<string, string[]>, from: string, to: string): void {
  const values = map.get(from);
  if (!values) {
    map.set(from, [to]);
    return;
  }
  if (!values.includes(to)) {
    values.push(to);
  }
}

type CanvasReadResult = {
  canvas: ProjectCanvasNode;
  manifest: PlanPackageManifest | null;
  graph: CompiledTaskGraph | null;
  taskIds: Set<string>;
  taskIdsInManifestOrder: string[];
  error?: ValidationIssue;
};

async function readCanvasPackage(projectWorkspace: ProjectWorkspace, canvas: ProjectCanvasNode): Promise<CanvasReadResult> {
  try {
    const packageManifest = (await loadPackage(projectCanvasWorkspace(projectWorkspace, canvas))).manifest;
    const graph = compileTaskGraph(packageManifest);
    const taskIdsInManifestOrder = [...graph.taskNodesInManifestOrder];
    return {
      canvas,
      manifest: packageManifest,
      graph,
      taskIds: new Set(taskIdsInManifestOrder),
      taskIdsInManifestOrder
    };
  } catch (caught) {
    return {
      canvas,
      manifest: null,
      graph: null,
      taskIds: new Set(),
      taskIdsInManifestOrder: [],
      error: issue("project_canvas_manifest_read_failed", caught instanceof Error ? caught.message : String(caught), canvas.id)
    };
  }
}

export async function compileProjectGraph(loaded: LoadedProjectGraph): Promise<CompiledProjectGraph> {
  const { workspace, manifest, source } = loaded;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [...loaded.diagnostics];
  const canvasesById = new Map(manifest.canvases.map((canvas) => [canvas.id, canvas]));
  const canvasIdsInOrder = manifest.canvases.map((canvas) => canvas.id);
  const duplicateCanvasIds = new Set<string>();
  const seenCanvasIds = new Set<string>();
  for (const canvas of manifest.canvases) {
    if (seenCanvasIds.has(canvas.id)) {
      duplicateCanvasIds.add(canvas.id);
    }
    seenCanvasIds.add(canvas.id);
  }
  for (const id of duplicateCanvasIds) {
    errors.push(issue("project_canvas_id_duplicate", `Canvas id '${id}' is duplicated.`, "canvases"));
  }

  const canvasDependenciesByCanvas = new Map<string, string[]>();
  const canvasDependentsByCanvas = new Map<string, string[]>();
  const canvasAdjacency = new Map<string, string[]>();
  const crossTaskDependenciesByTaskRef = new Map<ProjectTaskRefString, ProjectTaskRefString[]>();
  const crossTaskDependentsByTaskRef = new Map<ProjectTaskRefString, ProjectTaskRefString[]>();
  const taskDependenciesByTaskRef = new Map<ProjectTaskRefString, ProjectTaskRefString[]>();
  const taskDependentsByTaskRef = new Map<ProjectTaskRefString, ProjectTaskRefString[]>();
  const taskAdjacency = new Map<ProjectTaskRefString, ProjectTaskRefString[]>();
  const taskRefsInProjectOrder: ProjectTaskRef[] = [];

  for (const canvasId of canvasIdsInOrder) {
    canvasDependenciesByCanvas.set(canvasId, []);
    canvasDependentsByCanvas.set(canvasId, []);
    canvasAdjacency.set(canvasId, []);
  }

  const seenEdges = new Set<string>();
  for (const edge of manifest.edges) {
    const key = projectCanvasEdgeKey(edge);
    if (seenEdges.has(key)) {
      errors.push(issue("project_canvas_edge_duplicate", `Canvas edge '${edge.from} --${edge.type}--> ${edge.to}' is duplicated.`, "edges"));
    }
    seenEdges.add(key);
    if (!canvasesById.has(edge.from)) {
      errors.push(issue("project_canvas_edge_from_missing", `Canvas edge references missing from canvas '${edge.from}'.`, "edges"));
    }
    if (!canvasesById.has(edge.to)) {
      errors.push(issue("project_canvas_edge_to_missing", `Canvas edge references missing to canvas '${edge.to}'.`, "edges"));
    }
    if (!canvasesById.has(edge.from) || !canvasesById.has(edge.to)) {
      continue;
    }
    addUnique(canvasDependenciesByCanvas, edge.from, edge.to);
    addUnique(canvasDependentsByCanvas, edge.to, edge.from);
    addUnique(canvasAdjacency, edge.from, edge.to);
  }

  const taskIdsByCanvas = new Map<string, Set<string>>();
  const taskOrderByCanvas = new Map<string, string[]>();
  const canvasPackageResults = await Promise.all(manifest.canvases.map((canvas) => readCanvasPackage(workspace, canvas)));
  for (const result of canvasPackageResults) {
    if (result.error) {
      errors.push(result.error);
      continue;
    }
    if (!result.manifest) {
      continue;
    }
    taskIdsByCanvas.set(result.canvas.id, result.taskIds);
    taskOrderByCanvas.set(result.canvas.id, result.taskIdsInManifestOrder);
    for (const taskId of result.taskIdsInManifestOrder) {
      const taskRef = { canvasId: result.canvas.id, taskId };
      const ref = projectTaskRefKey(taskRef);
      taskRefsInProjectOrder.push(taskRef);
      taskDependenciesByTaskRef.set(ref, taskDependenciesByTaskRef.get(ref) ?? []);
      taskDependentsByTaskRef.set(ref, taskDependentsByTaskRef.get(ref) ?? []);
      taskAdjacency.set(ref, taskAdjacency.get(ref) ?? []);
    }
    for (const edge of result.manifest.edges) {
      const from = projectTaskRefKey({ canvasId: result.canvas.id, taskId: edge.from });
      const to = projectTaskRefKey({ canvasId: result.canvas.id, taskId: edge.to });
      addUnique(taskDependenciesByTaskRef, from, to);
      addUnique(taskDependentsByTaskRef, to, from);
      addUnique(taskAdjacency, from, to);
    }
  }

  const seenCrossTaskEdges = new Set<string>();
  for (const edge of manifest.crossTaskEdges) {
    const key = projectCrossTaskEdgeKey(edge);
    if (seenCrossTaskEdges.has(key)) {
      errors.push(issue("project_cross_task_edge_duplicate", `Cross task edge '${key}' is duplicated.`, "crossTaskEdges"));
    }
    seenCrossTaskEdges.add(key);
    const fromTaskIds = taskIdsByCanvas.get(edge.from.canvasId);
    const toTaskIds = taskIdsByCanvas.get(edge.to.canvasId);
    if (!canvasesById.has(edge.from.canvasId)) {
      errors.push(issue("project_cross_task_from_canvas_missing", `Cross task edge references missing from canvas '${edge.from.canvasId}'.`, "crossTaskEdges"));
    }
    if (!canvasesById.has(edge.to.canvasId)) {
      errors.push(issue("project_cross_task_to_canvas_missing", `Cross task edge references missing to canvas '${edge.to.canvasId}'.`, "crossTaskEdges"));
    }
    if (fromTaskIds && !fromTaskIds.has(edge.from.taskId)) {
      errors.push(issue("project_cross_task_from_missing", `Cross task edge references missing from task '${edge.from.canvasId}::${edge.from.taskId}'.`, "crossTaskEdges"));
    }
    if (toTaskIds && !toTaskIds.has(edge.to.taskId)) {
      errors.push(issue("project_cross_task_to_missing", `Cross task edge references missing to task '${edge.to.canvasId}::${edge.to.taskId}'.`, "crossTaskEdges"));
    }
    const from = projectTaskRefKey(edge.from);
    const to = projectTaskRefKey(edge.to);
    if (!taskAdjacency.has(from) || !taskAdjacency.has(to)) {
      continue;
    }
    addUnique(crossTaskDependenciesByTaskRef, from, to);
    addUnique(crossTaskDependentsByTaskRef, to, from);
    addUnique(taskDependenciesByTaskRef, from, to);
    addUnique(taskDependentsByTaskRef, to, from);
    addUnique(taskAdjacency, from, to);
  }

  for (const edge of manifest.edges) {
    const fromTaskIds = taskOrderByCanvas.get(edge.from);
    const toTaskIds = taskOrderByCanvas.get(edge.to);
    if (!fromTaskIds || !toTaskIds) {
      continue;
    }
    for (const fromTaskId of fromTaskIds) {
      const from = projectTaskRefKey({ canvasId: edge.from, taskId: fromTaskId });
      for (const toTaskId of toTaskIds) {
        const to = projectTaskRefKey({ canvasId: edge.to, taskId: toTaskId });
        addUnique(taskDependenciesByTaskRef, from, to);
        addUnique(taskDependentsByTaskRef, to, from);
        addUnique(taskAdjacency, from, to);
      }
    }
  }

  const canvasCycle = findCycle(canvasAdjacency);
  if (canvasCycle) {
    errors.push(issue("project_canvas_depends_on_cycle", `Canvas dependency cycle detected: ${canvasCycle.join(" -> ")}.`, "edges"));
  }
  const taskCycle = findCycle(taskAdjacency);
  if (taskCycle) {
    errors.push(issue("project_task_depends_on_cycle", `Cross-canvas task dependency cycle detected: ${taskCycle.join(" -> ")}.`, "crossTaskEdges"));
  }

  return {
    manifest,
    source,
    canvasesById,
    canvasIdsInOrder,
    taskRefsInProjectOrder,
    canvasDependenciesByCanvas,
    canvasDependentsByCanvas,
    crossTaskDependenciesByTaskRef,
    crossTaskDependentsByTaskRef,
    taskDependenciesByTaskRef,
    taskDependentsByTaskRef,
    crossTaskEdges: manifest.crossTaskEdges,
    diagnostics: { errors, warnings },
    canvasReachable: (from, to) => reachable(canvasAdjacency, from, to),
    taskDependencies: (ref) => (taskDependenciesByTaskRef.get(projectTaskRefKey(ref)) ?? []).map(parseProjectTaskRefKey),
    taskDependents: (ref) => (taskDependentsByTaskRef.get(projectTaskRefKey(ref)) ?? []).map(parseProjectTaskRefKey),
    crossTaskDependencies: (ref) => (crossTaskDependenciesByTaskRef.get(projectTaskRefKey(ref)) ?? []).map(parseProjectTaskRefKey),
    crossTaskDependents: (ref) => (crossTaskDependentsByTaskRef.get(projectTaskRefKey(ref)) ?? []).map(parseProjectTaskRefKey),
    taskReachable: (from, to) => reachable(taskAdjacency, projectTaskRefKey(from), projectTaskRefKey(to))
  };
}
