import { compileTaskGraph } from "../graph/compileTaskGraph.js";
import { loadPackage } from "../package/loadPackage.js";
import type { PlanPackageManifest, ProjectWorkspace, ValidationIssue } from "../types.js";
import { findCycle, reachable } from "./graphAlgorithms.js";
import { parseProjectTaskRefKey, projectCanvasEdgeKey, projectCrossTaskEdgeKey, projectTaskRefKey } from "./projectGraphKeys.js";
import { projectCanvasWorkspace } from "./projectGraphWorkspace.js";
import type {
  CompiledProjectGraph,
  LoadedProjectGraph,
  ProjectGraphManifest,
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

async function canvasManifest(projectWorkspace: ProjectWorkspace, canvasId: string, manifest: ProjectGraphManifest): Promise<PlanPackageManifest | null> {
  const canvas = manifest.canvases.find((candidate) => candidate.id === canvasId);
  if (!canvas) {
    return null;
  }
  return (await loadPackage(projectCanvasWorkspace(projectWorkspace, canvas))).manifest;
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

  const manifestsByCanvas = new Map<string, PlanPackageManifest>();
  for (const canvas of manifest.canvases) {
    try {
      const packageManifest = await canvasManifest(workspace, canvas.id, manifest);
      if (packageManifest) {
        manifestsByCanvas.set(canvas.id, packageManifest);
        const graph = compileTaskGraph(packageManifest);
        for (const taskId of graph.taskNodesInManifestOrder) {
          const taskRef = { canvasId: canvas.id, taskId };
          const ref = projectTaskRefKey(taskRef);
          taskRefsInProjectOrder.push(taskRef);
          taskDependenciesByTaskRef.set(ref, taskDependenciesByTaskRef.get(ref) ?? []);
          taskDependentsByTaskRef.set(ref, taskDependentsByTaskRef.get(ref) ?? []);
          taskAdjacency.set(ref, taskAdjacency.get(ref) ?? []);
        }
        for (const edge of packageManifest.edges) {
          const from = projectTaskRefKey({ canvasId: canvas.id, taskId: edge.from });
          const to = projectTaskRefKey({ canvasId: canvas.id, taskId: edge.to });
          addUnique(taskDependenciesByTaskRef, from, to);
          addUnique(taskDependentsByTaskRef, to, from);
          addUnique(taskAdjacency, from, to);
        }
      }
    } catch (caught) {
      errors.push(issue("project_canvas_manifest_read_failed", caught instanceof Error ? caught.message : String(caught), canvas.id));
    }
  }

  const seenCrossTaskEdges = new Set<string>();
  for (const edge of manifest.crossTaskEdges) {
    const key = projectCrossTaskEdgeKey(edge);
    if (seenCrossTaskEdges.has(key)) {
      errors.push(issue("project_cross_task_edge_duplicate", `Cross task edge '${key}' is duplicated.`, "crossTaskEdges"));
    }
    seenCrossTaskEdges.add(key);
    const fromManifest = manifestsByCanvas.get(edge.from.canvasId);
    const toManifest = manifestsByCanvas.get(edge.to.canvasId);
    if (!canvasesById.has(edge.from.canvasId)) {
      errors.push(issue("project_cross_task_from_canvas_missing", `Cross task edge references missing from canvas '${edge.from.canvasId}'.`, "crossTaskEdges"));
    }
    if (!canvasesById.has(edge.to.canvasId)) {
      errors.push(issue("project_cross_task_to_canvas_missing", `Cross task edge references missing to canvas '${edge.to.canvasId}'.`, "crossTaskEdges"));
    }
    if (fromManifest && !fromManifest.nodes.some((node) => node.type === "task" && node.id === edge.from.taskId)) {
      errors.push(issue("project_cross_task_from_missing", `Cross task edge references missing from task '${edge.from.canvasId}::${edge.from.taskId}'.`, "crossTaskEdges"));
    }
    if (toManifest && !toManifest.nodes.some((node) => node.type === "task" && node.id === edge.to.taskId)) {
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
    const fromManifest = manifestsByCanvas.get(edge.from);
    const toManifest = manifestsByCanvas.get(edge.to);
    if (!fromManifest || !toManifest) {
      continue;
    }
    const toTasks = toManifest.nodes.filter((node) => node.type === "task").map((node) => node.id);
    for (const fromTask of fromManifest.nodes.filter((node) => node.type === "task")) {
      const from = projectTaskRefKey({ canvasId: edge.from, taskId: fromTask.id });
      for (const toTaskId of toTasks) {
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
