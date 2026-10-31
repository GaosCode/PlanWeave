import { desktopWorkspaceExecutionResponseSchema } from "../../shared/workspaceExecution";

export function coordinatorView(
  operationId: string,
  blockRef: string,
  events: unknown[] = [],
  progress: { eventCursor?: number; operationRevision?: number } = {}
) {
  return desktopWorkspaceExecutionResponseSchema.parse({
    version: "planweave.workspace-execution-view/v1",
    handle: {
      version: "planweave.workspace-execution-handle/v1",
      target: "remote",
      phase: "attempt",
      runSessionId: "SESSION-0001",
      authorityBindingId: `wxb:sha256:${"a".repeat(64)}`,
      scope: { kind: "block", blockRef },
      capabilities: { interactionResponse: true },
      operationId,
      operationRevision: progress.operationRevision ?? 1,
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      attemptStateVersion: 1,
      leaseId: "lease-1",
      agentEndpointId: "endpoint-1",
      cursor: {
        target: "remote",
        executionAttemptId: "attempt-1",
        eventCursor: progress.eventCursor ?? 0
      }
    },
    session: {
      sessionId: "SESSION-0001",
      stateVersion: 1,
      phase: "running",
      scope: { kind: "block", blockRef },
      startedAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      finishedAt: null,
      error: null,
      interactionStatus: [],
      evidence: { status: "pending", diagnostics: [] }
    },
    events
  });
}
