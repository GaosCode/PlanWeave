import {
  currentProjectCanvasForWorkspace,
  loadProjectCanvasRuntimeAggregation,
  projectBlockersForTask,
  projectBlockerReasonForTask,
  projectGraphDiagnosticNote,
  type ProjectCanvasRuntimeAggregationContext
} from "../projectGraph/runtimeAggregation.js";
import type { ValidationIssue } from "../types.js";
import type { RuntimeContext } from "./runtimeContext.js";

export type ProjectGraphClaimGuard = {
  blockersForTask(taskId: string): string[];
  blockerReasonForTask(taskId: string): string | null;
};

const noProjectGraphBlockers: ProjectGraphClaimGuard = {
  blockersForTask: () => [],
  blockerReasonForTask: () => null
};

function issueDisplayName(issue: ValidationIssue): string {
  return projectGraphDiagnosticNote(issue);
}

export function createProjectGraphClaimGuardFromAggregation(
  context: RuntimeContext,
  aggregation: ProjectCanvasRuntimeAggregationContext
): ProjectGraphClaimGuard {
  if (aggregation.loaded.source !== "project_graph") {
    return noProjectGraphBlockers;
  }
  if (aggregation.graph.diagnostics.errors.length > 0) {
    const reason = [
      "Project graph is invalid; no task canvas work can be claimed.",
      ...aggregation.graph.diagnostics.errors.map((error) => `- ${issueDisplayName(error)}`)
    ].join("\n");
    return { blockersForTask: () => [reason], blockerReasonForTask: () => reason };
  }
  const currentCanvas = currentProjectCanvasForWorkspace(aggregation, context.workspace);
  if (!currentCanvas) {
    return {
      blockersForTask: () => ["Current task canvas is not listed in project-graph.json."],
      blockerReasonForTask: () => "Current task canvas is not listed in project-graph.json."
    };
  }

  return {
    blockersForTask: (taskId: string) =>
      projectBlockersForTask(aggregation, currentCanvas.canvasId, taskId),
    blockerReasonForTask: (taskId: string) =>
      projectBlockerReasonForTask(aggregation, currentCanvas.canvasId, taskId)
  };
}

export async function createProjectGraphClaimGuard(
  context: RuntimeContext
): Promise<ProjectGraphClaimGuard> {
  return createProjectGraphClaimGuardFromAggregation(
    context,
    await loadProjectCanvasRuntimeAggregation(context.workspace)
  );
}
