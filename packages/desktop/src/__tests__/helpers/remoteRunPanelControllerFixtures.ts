import { renderHook } from "@testing-library/react";
import { vi } from "vitest";
import type { RemoteBlockExecutionReadModel } from "@planweave-ai/runtime";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { AvailableAgentEndpoint } from "../../renderer/collaboration/agentEndpointViewModel";
import {
  type RemoteRunExecutionLocator,
  type UseRemoteRunPanelControllerArgs,
  useRemoteRunPanelController
} from "../../renderer/hooks/useRemoteRunPanelController";
import { createTranslator } from "../../renderer/i18n";
import {
  desktopWorkspaceExecutionResponseSchema,
  type DesktopOwnerCanvasExecutionLocator,
  type DesktopWorkspaceExecutionResponse,
  type PlanWeaveWorkspaceExecutionApi
} from "../../shared/workspaceExecution";

export const blockItem: WorkItemRef = {
  kind: "block",
  canvasId: "default",
  blockRef: "T-1#B-1"
};

export const locator: DesktopOwnerCanvasExecutionLocator = {
  kind: "owner_canvas",
  operatorProfileId: "profile-public",
  humanPrincipalId: "human-1",
  projectRoot: "/tmp/project",
  projectId: "project-1",
  canvasId: "default"
};

export const endpoint: AvailableAgentEndpoint = {
  id: "remote:endpoint-vps",
  source: "remote",
  executorName: "codex-acp",
  displayName: "Codex",
  locationName: "VPS",
  available: true,
  unavailableReason: null,
  capabilities: ["acp.codex"],
  remoteEndpointId: "endpoint-vps",
  agentId: "codex"
};

export const runtimeRemoteExecution = {
  identity: { operationId: "operation-1" },
  phase: "active",
  status: "owned",
  actionRequired: false,
  source: { revision: "rev-1", graphFingerprint: `pkg-${"b".repeat(64)}` },
  dispatchAttempt: { dispatchId: "dispatch-1", executionAttemptId: "attempt-1" }
} as const;

export function remoteView(input?: {
  phase?: "running" | "blocked" | "completed" | "failed" | "stopped";
  sessionId?: string;
  operationId?: string;
  blockRef?: string;
  includeInteraction?: boolean;
}): DesktopWorkspaceExecutionResponse {
  const operationId = input?.operationId ?? "operation-1";
  const sessionId = input?.sessionId ?? "SESSION-0001";
  const blockRef = input?.blockRef ?? blockItem.blockRef;
  const phase = input?.phase ?? "running";
  const source = {
    target: "remote" as const,
    operationId,
    executionAttemptId: "attempt-1",
    cursor: 1
  };
  const eventBase = {
    version: "planweave.execution-event/v1" as const,
    observedAt: "2030-01-01T00:00:01.000Z",
    runSessionId: sessionId,
    scope: { kind: "block" as const, blockRef },
    source
  };
  return desktopWorkspaceExecutionResponseSchema.parse({
    version: "planweave.workspace-execution-view/v1",
    handle: {
      version: "planweave.workspace-execution-handle/v1",
      runSessionId: sessionId,
      authorityBindingId: `wxb:sha256:${"a".repeat(64)}`,
      scope: { kind: "block", blockRef },
      capabilities: { interactionResponse: true },
      target: "remote",
      phase: "acp_session",
      operationId,
      operationRevision: 2,
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      attemptStateVersion: 1,
      leaseId: "lease-1",
      agentEndpointId: "endpoint-vps",
      cursor: { target: "remote", executionAttemptId: "attempt-1", eventCursor: 1 }
    },
    session: {
      sessionId,
      stateVersion: 2,
      phase,
      scope: { kind: "block", blockRef },
      startedAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:01.000Z",
      finishedAt: ["completed", "failed", "stopped"].includes(phase)
        ? "2030-01-01T00:00:01.000Z"
        : null,
      error: null,
      interactionStatus: input?.includeInteraction
        ? [{ key: `wxi:sha256:${"c".repeat(64)}`, status: "pending" }]
        : [],
      evidence: { status: "pending", diagnostics: [] }
    },
    events: [
      {
        ...eventBase,
        eventId: "runner-1",
        type: "runner_event",
        data: {
          eventProtocolVersion: 1,
          event: { cursor: 1, kind: "agent_message", text: "remote hello" }
        }
      },
      ...(input?.includeInteraction
        ? [
            {
              ...eventBase,
              eventId: "interaction-1",
              type: "interaction_required",
              data: {
                type: "interaction.permission_requested",
                title: "Write",
                description: "Allow write",
                options: [{ optionId: "write-once", label: "Write", kind: "allow_once" }],
                actionId: "action-1",
                dispatchId: "dispatch-1",
                leaseId: "lease-1",
                executionAttemptId: "attempt-1",
                acpSessionId: "acp-session-1",
                expiresAt: "2030-01-01T01:00:00.000Z"
              }
            }
          ]
        : [])
    ]
  });
}

export function apiReturning(view: DesktopWorkspaceExecutionResponse) {
  const start = vi.fn().mockResolvedValue(view);
  const follow = vi.fn().mockResolvedValue(view);
  const cancel = vi.fn().mockResolvedValue(view);
  const respond = vi.fn().mockResolvedValue(view);
  const api: PlanWeaveWorkspaceExecutionApi = {
    startWorkspaceExecution: start,
    followWorkspaceExecution: follow,
    cancelWorkspaceExecution: cancel,
    respondWorkspaceExecution: respond
  };
  return { api, start, follow, cancel, respond };
}

export function renderController(input: {
  api: PlanWeaveWorkspaceExecutionApi;
  runtime?: UseRemoteRunPanelControllerArgs["runtimeRemoteExecution"];
  executionLocator?: RemoteRunExecutionLocator;
  refreshRuntimeRemoteExecution?: () => Promise<RemoteBlockExecutionReadModel | null>;
}) {
  const initialProps: {
    executionLocator: RemoteRunExecutionLocator;
    workItem: WorkItemRef;
    runtime: UseRemoteRunPanelControllerArgs["runtimeRemoteExecution"];
    open?: boolean;
  } = {
    executionLocator: input.executionLocator ?? locator,
    workItem: blockItem,
    runtime: input.runtime ?? null
  };
  return renderHook(
    ({ executionLocator, workItem, runtime, open }) =>
      useRemoteRunPanelController({
        agentEndpoints: [endpoint],
        workItem,
        runtimeRemoteExecution: runtime,
        refreshRuntimeRemoteExecution: input.refreshRuntimeRemoteExecution,
        executionLocator,
        executionApi: input.api,
        open: open ?? true,
        selectedAgentEndpointId: endpoint.id,
        t: createTranslator("en"),
        createId: () => "action-cancel"
      }),
    { initialProps }
  );
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
