import type { WorkspaceExecutionCoordinatorResult } from "./coordinator.js";
import {
  workspaceExecutionCoordinatorViewSchema,
  type WorkspaceExecutionCoordinatorView
} from "./view.js";

export function projectWorkspaceExecutionCoordinatorView(
  result: WorkspaceExecutionCoordinatorResult
): WorkspaceExecutionCoordinatorView {
  const state = result.session.workspaceExecution;
  return workspaceExecutionCoordinatorViewSchema.parse({
    version: "planweave.workspace-execution-view/v1",
    handle: result.handle,
    session: {
      sessionId: result.session.sessionId,
      stateVersion: result.session.stateVersion,
      phase: result.session.phase,
      scope: result.session.scope,
      startedAt: result.session.startedAt,
      updatedAt: result.session.updatedAt,
      finishedAt: result.session.finishedAt,
      error: result.session.error,
      interactionStatus: state?.interactions ?? [],
      evidence: state?.evidence ?? { status: "complete", diagnostics: [] }
    },
    events: result.events
  });
}
