import type { PlanWeaveWorkspaceExecutionApi } from "../../shared/workspaceExecution";
import type {
  ActiveEndpointScopeRun,
  WorkspaceScopeStart,
  WorkspaceScopeSession
} from "./workspaceScopeCancellationRecovery";

export function createWorkspaceScopeCancellation(input: {
  api: PlanWeaveWorkspaceExecutionApi | null | undefined;
  createId: () => string;
  publish: (run: ActiveEndpointScopeRun) => void;
}) {
  const cancelSession = (
    activeRun: ActiveEndpointScopeRun,
    blockRef: string,
    session: WorkspaceScopeSession
  ): Promise<void> => {
    const existing = activeRun.cancellationRequests.get(session.sessionId);
    if (existing) return existing;
    session.actionId ??= input.createId();
    session.error = null;
    const cancellation = Promise.resolve()
      .then(async () => {
        if (!input.api) throw new Error("workspace_execution_bridge_unavailable");
        if (session.handle.target !== "remote")
          throw new Error("workspace_execution_remote_handle_required");
        const view = await input.api.cancelWorkspaceExecution({
          ...session.input,
          sessionId: session.sessionId,
          actionId: session.actionId!,
          expectedRemoteHandle: session.handle,
          reason: session.reason
        });
        if (
          view.handle.target !== "remote" ||
          view.session.sessionId !== session.sessionId ||
          view.handle.operationId !== session.handle.operationId ||
          view.handle.executionAttemptId !== session.handle.executionAttemptId ||
          view.handle.dispatchId !== session.handle.dispatchId
        ) {
          throw new Error("workspace_execution_cancel_identity_mismatch");
        }
        if (!["completed", "failed", "stopped"].includes(view.session.phase)) {
          throw new Error("workspace_execution_cancel_unconfirmed");
        }
        if (activeRun.workspaceSessions.get(blockRef) === session)
          activeRun.workspaceSessions.delete(blockRef);
      })
      .catch((error: unknown) => {
        session.error = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        activeRun.cancellationRequests.delete(session.sessionId);
        input.publish(activeRun);
      });
    activeRun.cancellationRequests.set(session.sessionId, cancellation);
    input.publish(activeRun);
    return cancellation;
  };
  const cancelStart = (run: ActiveEndpointScopeRun, start: WorkspaceScopeStart): Promise<void> => {
    const existing = run.cancellationRequests.get(start.startRequestId);
    if (existing) return existing;
    start.actionId ??= input.createId();
    start.error = null;
    const cancellation = Promise.resolve()
      .then(async () => {
        if (!input.api) throw new Error("workspace_execution_bridge_unavailable");
        const result = await input.api.cancelWorkspaceExecutionStart({
          input: start.input,
          startRequestId: start.startRequestId,
          actionId: start.actionId!,
          reason: start.reason
        });
        if (!result.confirmed) throw new Error("workspace_execution_cancel_unconfirmed");
        run.workspaceStarts.delete(start.startRequestId);
      })
      .catch((error: unknown) => {
        start.error = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        run.cancellationRequests.delete(start.startRequestId);
        input.publish(run);
      });
    run.cancellationRequests.set(start.startRequestId, cancellation);
    input.publish(run);
    return cancellation;
  };
  const abortRun = async (run: ActiveEndpointScopeRun, retryFailed = false) => {
    run.controller.abort();
    const cancellations = [...run.workspaceSessions.entries()]
      .filter(
        ([, session]) =>
          retryFailed || !session.actionId || run.cancellationRequests.has(session.sessionId)
      )
      .map(([ref, session]) => cancelSession(run, ref, session));
    input.publish(run);
    const starts = [...run.workspaceStarts.values()]
      .filter(
        (start) =>
          retryFailed || !start.actionId || run.cancellationRequests.has(start.startRequestId)
      )
      .map((start) => cancelStart(run, start));
    const results = await Promise.allSettled([
      ...run.pendingWorkspaceStarts,
      ...cancellations,
      ...starts
    ]);
    input.publish(run);
    return run.workspaceSessions.size === 0 && run.workspaceStarts.size === 0
      ? results.filter((result) => result.status === "fulfilled")
      : results;
  };
  return { cancelSession, abortRun };
}
