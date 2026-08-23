import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import type { CollaborationCanvasBindingReplicaProjection } from "../../shared/canvasReplicaIpc.js";

function replicaExecutorNames(projection: CollaborationCanvasBindingReplicaProjection): string[] {
  const names = new Set<string>();
  for (const task of projection.content.tasks) {
    if (task.executor) names.add(task.executor);
    for (const block of task.blocks) {
      if (block.executor) names.add(block.executor);
    }
  }
  return [...names];
}

/** Adapts replica-owned content while retaining the selected local project's executor catalog. */
export function canvasReplicaProjectionToDesktopGraph(
  projection: CollaborationCanvasBindingReplicaProjection,
  runtimeGraph: DesktopGraphViewModel | null
): DesktopGraphViewModel {
  const executorCatalog =
    !("bindingKind" in projection) && runtimeGraph?.projectId === projection.localProjectId
      ? runtimeGraph
      : null;
  const authoritativeExecutorNames = executorCatalog ? [] : replicaExecutorNames(projection);
  return {
    projectId: "bindingKind" in projection ? projection.projectId : projection.localProjectId,
    projectTitle: projection.content.projectTitle,
    graphVersion: projection.content.graphVersion,
    packageFingerprint: projection.content.packageFingerprint,
    executorOptions: executorCatalog?.executorOptions ?? authoritativeExecutorNames,
    packageExecutorNames: executorCatalog?.packageExecutorNames ?? authoritativeExecutorNames,
    ...(executorCatalog?.executorProfileBindings
      ? { executorProfileBindings: executorCatalog.executorProfileBindings }
      : {}),
    ...(executorCatalog?.agentTransport ? { agentTransport: executorCatalog.agentTransport } : {}),
    autoRunPreflightExecutorHint: null,
    tasks: projection.content.tasks,
    edges: projection.content.edges,
    sharedResourceGroups: projection.content.sharedResourceGroups,
    diagnostics: projection.content.diagnostics,
    dirtyPromptRefs: []
  };
}
