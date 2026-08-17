import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AcpLiveRunTransport } from "./acpConnectionProvider.js";
import type { ActiveAgentRunHandle, ActiveAgentRunIdentity } from "./activeAgentRunRegistry.js";
import type { AgentRunControlLeaseId } from "./agentRunControlContract.js";
import { createLiveOwnership, type LivePendingRequestHandle } from "./liveControl.js";

export function createLocalAcpActiveRunHandle(options: {
  readonly identity: Omit<ActiveAgentRunIdentity, "sessionId">;
  readonly connection: AcpLiveRunTransport;
  readonly abortController: AbortController;
  readonly eventSink: (notification: SessionNotification) => void | Promise<void>;
  readonly agentRunControlLeaseId: AgentRunControlLeaseId;
  readonly pendingRequests: ReadonlyMap<string, LivePendingRequestHandle>;
  readonly supportsSessionClose: () => boolean;
}): ActiveAgentRunHandle {
  const ownership = createLiveOwnership(
    `${options.identity.scope}:${options.identity.executorRunId}`,
    1
  );
  return {
    identity: {
      ...options.identity,
      desktopRunId: options.identity.desktopRunId ?? null
    },
    connection: options.connection,
    abortController: options.abortController,
    eventSink: options.eventSink,
    ownership,
    lifecycleState: "initializing",
    agentRunControlLeaseId: options.agentRunControlLeaseId,
    control: {
      ownership,
      process: {
        pid: options.connection.processId,
        terminate: async () => undefined
      },
      connection: {
        send: async () => {
          throw new Error("ACP raw sends are not available outside the protocol connection.");
        },
        close: async () => undefined,
        cancelSession: async (sessionId) => {
          options.abortController.abort(new Error("ACP session cancellation was requested."));
          await options.connection.cancel({ sessionId });
        },
        closeSession: async () => undefined,
        get supportsSessionClose() {
          return options.supportsSessionClose();
        }
      },
      sessionId: null,
      interventionCapabilities: {
        cancel: false,
        permission: false,
        elicitationPreview: false
      },
      pendingRequests: options.pendingRequests,
      pendingOperations: options.connection.pendingOperations
    }
  };
}
