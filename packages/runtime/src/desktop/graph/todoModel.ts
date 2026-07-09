import { buildExecutionStatus, type ExecutionStatus } from "../../taskManager/executionStatus.js";
import { createProjectGraphClaimGuardFromAggregation } from "../../taskManager/projectGraphClaimGuard.js";
import { loadRuntimeReadonly, type RuntimeContext } from "../../taskManager/runtimeContext.js";
import type { ValidationIssue } from "../../types.js";
import { appendDesktopDiagnostic, desktopDiagnostic, errorMessage } from "./desktopDiagnostics.js";
import {
  loadProjectCanvasAggregation,
  runtimeSnapshotFromGraphState,
  type ProjectCanvasAggregationContext
} from "./projectCanvasAggregation.js";
import { loadPlanGraphPackageMetadata } from "../../plangraph/packageRepository.js";
import {
  buildProjectExecutionPlanProjection,
  buildTodoGroupsFromContext as projectTodoGroupsFromContext,
  buildTodoProjection,
  emptyTodoGroups,
  type CanvasExecutionSnapshot,
  type ProjectTodoContext
} from "../../plangraph/projections/index.js";
import type { DesktopProjectExecutionPlan, DesktopTodoGroups } from "../types.js";

export { emptyTodoGroups };
export type { CanvasExecutionSnapshot, ProjectTodoContext };

export function failedCanvasExecutionSnapshot(taskCount: number, error: unknown): CanvasExecutionSnapshot {
  return {
    groups: emptyTodoGroups(),
    projectBlockedReadyCount: 0,
    taskCount,
    runtime: null,
    status: null,
    error,
    graphVersion: null
  };
}

export async function buildCanvasExecutionSnapshot(
  aggregation: ProjectCanvasAggregationContext,
  canvasId: string,
  runtime: RuntimeContext | undefined
): Promise<CanvasExecutionSnapshot> {
  const canvas = aggregation.canvasesById.get(canvasId);
  if (!canvas) {
    throw new Error(`Project canvas '${canvasId}' is missing from aggregation.`);
  }
  let canvasRuntime: RuntimeContext;
  let status: ExecutionStatus;
  try {
    const loadedPlanGraph = await loadPlanGraphPackageMetadata(canvas.workspace);
    canvasRuntime = runtime ?? await loadRuntimeReadonly({ projectRoot: canvas.workspace });
    status = await buildExecutionStatus(canvasRuntime, {
      claimGuard: createProjectGraphClaimGuardFromAggregation(canvasRuntime, aggregation)
    });
    const { groups, projectBlockedReadyCount, graphVersion } = buildTodoProjection({
      graphVersion: loadedPlanGraph.graph.graphVersion,
      runtime: canvasRuntime,
      status,
      planGraph: loadedPlanGraph.graph,
      canvasMeta: {
        canvasId,
        canvasName: canvas.canvasName
      }
    });
    return {
      groups,
      projectBlockedReadyCount,
      taskCount: canvasRuntime.graph.taskNodesInManifestOrder.length,
      runtime: canvasRuntime,
      status,
      error: null,
      graphVersion
    };
  } catch (error) {
    throw new Error(`Canvas '${canvasId}' execution snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadProjectTodoContext(projectRoot: string): Promise<ProjectTodoContext> {
  const runtimesByCanvas = new Map<string, RuntimeContext>();
  const diagnostics: ValidationIssue[] = [];
  const aggregation = await loadProjectCanvasAggregation(projectRoot, {
    loadRuntimeSnapshot: async (workspace, canvasId) => {
      const runtime = await loadRuntimeReadonly({ projectRoot: workspace });
      runtimesByCanvas.set(canvasId, runtime);
      return runtimeSnapshotFromGraphState(runtime.graph, runtime.state);
    }
  });
  const snapshotsByCanvas = new Map<string, CanvasExecutionSnapshot>();

  for (const canvasId of aggregation.orderedCanvasIds) {
    const canvas = aggregation.canvasesById.get(canvasId);
    try {
      snapshotsByCanvas.set(canvasId, await buildCanvasExecutionSnapshot(aggregation, canvasId, runtimesByCanvas.get(canvasId)));
    } catch (caught) {
      appendDesktopDiagnostic(
        diagnostics,
        desktopDiagnostic("desktop_canvas_execution_snapshot_failed", errorMessage(caught), canvasId)
      );
      snapshotsByCanvas.set(canvasId, failedCanvasExecutionSnapshot(canvas?.canvas.taskCount ?? 0, caught));
    }
  }
  return { aggregation, snapshotsByCanvas, diagnostics };
}

export function buildTodoGroupsFromContext(context: ProjectTodoContext): DesktopTodoGroups {
  return projectTodoGroupsFromContext(context);
}

export async function getTodoGroups(projectRoot: string): Promise<DesktopTodoGroups> {
  return buildTodoGroupsFromContext(await loadProjectTodoContext(projectRoot));
}

export function buildProjectExecutionPlanFromContext(context: ProjectTodoContext): DesktopProjectExecutionPlan {
  return buildProjectExecutionPlanProjection(context);
}

export async function getProjectExecutionPlan(projectRoot: string): Promise<DesktopProjectExecutionPlan> {
  return buildProjectExecutionPlanFromContext(await loadProjectTodoContext(projectRoot));
}
