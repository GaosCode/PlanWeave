import {
  loadProjectGraph,
  type ProjectGraphManifest,
  type ProjectTaskRef
} from "../projectGraph/index.js";
import type { ValidationIssue } from "../types.js";
import {
  executePlanGraphCommand,
  type PlanGraphCommandResult,
  type ProjectGraphCommand
} from "../plangraph/index.js";
import { invalidateDesktopProjectProjection } from "./graph/projectProjectionModel.js";

export type ProjectGraphEditResult = {
  ok: boolean;
  diagnostics: ValidationIssue[];
  graph: ProjectGraphManifest;
};

function result(
  graph: ProjectGraphManifest,
  diagnostics: ValidationIssue[] = []
): ProjectGraphEditResult {
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    graph
  };
}

async function graphEditResult(
  projectRoot: string,
  commandResult: PlanGraphCommandResult
): Promise<ProjectGraphEditResult> {
  const loaded = await loadProjectGraph(projectRoot);
  return result(loaded.manifest, commandResult.diagnostics);
}

async function executeProjectGraphEdit(
  projectRoot: string,
  command: ProjectGraphCommand
): Promise<ProjectGraphEditResult> {
  const commandResult = await executePlanGraphCommand({ projectRoot, command });
  invalidateDesktopProjectProjection(projectRoot);
  return graphEditResult(projectRoot, commandResult);
}

export async function addCanvasDependency(
  projectRoot: string,
  fromCanvasId: string,
  toCanvasId: string
): Promise<ProjectGraphEditResult> {
  return executeProjectGraphEdit(projectRoot, {
    type: "addCanvasDependency",
    fromCanvasId,
    toCanvasId
  });
}

export async function removeCanvasDependency(
  projectRoot: string,
  fromCanvasId: string,
  toCanvasId: string
): Promise<ProjectGraphEditResult> {
  return executeProjectGraphEdit(projectRoot, {
    type: "removeCanvasDependency",
    fromCanvasId,
    toCanvasId
  });
}

export async function addCrossTaskDependency(
  projectRoot: string,
  from: ProjectTaskRef,
  to: ProjectTaskRef
): Promise<ProjectGraphEditResult> {
  return executeProjectGraphEdit(projectRoot, { type: "addCrossTaskDependency", from, to });
}

export async function removeCrossTaskDependency(
  projectRoot: string,
  from: ProjectTaskRef,
  to: ProjectTaskRef
): Promise<ProjectGraphEditResult> {
  return executeProjectGraphEdit(projectRoot, { type: "removeCrossTaskDependency", from, to });
}
