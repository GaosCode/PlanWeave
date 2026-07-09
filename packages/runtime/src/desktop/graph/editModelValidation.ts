import { resolve } from "node:path";
import { compileTaskGraph } from "../../graph/compileTaskGraph.js";
import { loadPackage } from "../../package/loadPackage.js";
import { loadProjectGraphForWorkspace, projectCanvasWorkspace } from "../../projectGraph/index.js";
import { manifestSchema } from "../../schema/manifest.js";
import type {
  GraphEditResult,
  PackageWorkspaceRef,
  PlanPackageManifest,
  ValidationIssue
} from "../../types.js";

export function requireNonEmptyTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new Error("Title must not be empty.");
  }
  return trimmed;
}

export function hasFieldEditValue(fields: Record<string, unknown>): boolean {
  return Object.values(fields).some((value) => value !== undefined);
}

export function graphEditResult(
  manifest: PlanPackageManifest,
  affectedTasks: string[] = []
): GraphEditResult {
  const graph = compileTaskGraph(manifest);
  return {
    ok: graph.diagnostics.errors.length === 0,
    affectedTasks: [...new Set(affectedTasks)],
    diagnostics: graph.diagnostics.errors,
    graph
  };
}

export function graphEditDiagnostics(
  manifest: PlanPackageManifest,
  diagnostics: ValidationIssue[]
): GraphEditResult {
  return {
    ok: false,
    affectedTasks: [],
    diagnostics,
    graph: compileTaskGraph(manifest)
  };
}

export function manifestValidationResult(
  manifest: PlanPackageManifest,
  affectedTasks: string[]
): GraphEditResult {
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

export async function crossTaskEdgeDeleteDiagnostic(
  projectRoot: PackageWorkspaceRef,
  taskId: string
): Promise<GraphEditResult | null> {
  const { workspace, manifest } = await loadPackage(projectRoot);
  const projectGraph = await loadProjectGraphForWorkspace(workspace);
  if (projectGraph.source !== "project_graph") {
    return null;
  }
  const canvas = projectGraph.manifest.canvases.find(
    (candidate) =>
      resolve(projectCanvasWorkspace(projectGraph.workspace, candidate).packageDir) ===
      resolve(workspace.packageDir)
  );
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
