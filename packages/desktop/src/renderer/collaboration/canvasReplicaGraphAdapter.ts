import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import type { CollaborationCanvasBindingReplicaProjection } from "../../shared/canvasReplicaIpc.js";

/** Adapts replica-owned content while retaining the selected local project's executor catalog. */
export function canvasReplicaProjectionToDesktopGraph(
  projection: CollaborationCanvasBindingReplicaProjection,
  runtimeGraph: DesktopGraphViewModel | null
): DesktopGraphViewModel {
  const executorCatalog =
    !("bindingKind" in projection) && runtimeGraph?.projectId === projection.localProjectId
      ? runtimeGraph
      : null;
  return {
    projectId: "bindingKind" in projection ? projection.projectId : projection.localProjectId,
    projectTitle: projection.content.projectTitle,
    graphVersion: projection.content.graphVersion,
    packageFingerprint: projection.content.packageFingerprint,
    executorOptions: executorCatalog?.executorOptions ?? [],
    packageExecutorNames: executorCatalog?.packageExecutorNames ?? [],
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
