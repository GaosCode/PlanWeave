import type {
  DesktopWorkspaceExecutionStartInput,
  DesktopWorkspaceExecutionResponse,
  DesktopWorkspaceExecutionCancellationRecovery
} from "../../shared/workspaceExecution";
import { desktopWorkspaceExecutionStartInputSchema } from "../../shared/workspaceExecution";

export type EndpointScopeCancellationState = {
  scopeIdentity: string;
  phase: "recovering" | "cancelling" | "failed";
  sessions: {
    blockRef: string;
    sessionId: string;
    status: "pending" | "in_flight" | "failed";
    error: string | null;
  }[];
};

export type WorkspaceScopeSession = {
  input: DesktopWorkspaceExecutionStartInput;
  sessionId: string;
  handle: DesktopWorkspaceExecutionResponse["handle"];
  actionId: string | null;
  reason: string;
  error: string | null;
};

export type ActiveEndpointScopeRun = {
  scopeIdentity: string;
  lifecycle?: WorkspaceAgentEndpointScopeLifecycle;
  settled: boolean;
  failed: boolean;
  cancellationRequests: Map<string, Promise<void>>;
  controller: AbortController;
  pendingWorkspaceStarts: Set<Promise<void>>;
  workspaceSessions: Map<string, WorkspaceScopeSession>;
};

export type WorkspaceAgentEndpointScopeLifecycle = {
  onStarted: () => void;
  onCompleted: () => void;
  onFailed: (message: string) => void;
  onCancelled?: () => void;
  onCancellationChanged?: (state: EndpointScopeCancellationState) => void;
};

export function restoreWorkspaceScopeCancellation(input: {
  recovered: DesktopWorkspaceExecutionCancellationRecovery;
  locator: DesktopWorkspaceExecutionStartInput["locator"];
  scopeIdentity: string;
}): ActiveEndpointScopeRun | null {
  if (!input.recovered.sessions.length) return null;
  const controller = new AbortController();
  controller.abort();
  return {
    scopeIdentity: input.scopeIdentity,
    controller,
    settled: true,
    failed: false,
    cancellationRequests: new Map(),
    pendingWorkspaceStarts: new Set(),
    workspaceSessions: new Map(
      input.recovered.sessions.map(({ sessionId, blockRef, intent }) => [
        blockRef,
        {
          sessionId,
          handle: intent.expectedRemoteHandle,
          actionId: intent.actionId,
          reason: intent.reason,
          error: "workspace_execution_cancel_unconfirmed",
          input: desktopWorkspaceExecutionStartInputSchema.parse({
            locator: input.locator,
            blockRef,
            agentEndpointId: intent.expectedRemoteHandle.agentEndpointId,
            effectiveExecutor: intent.effectiveExecutor
          })
        }
      ])
    )
  };
}
