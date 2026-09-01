/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { AvailableAgentEndpoint } from "../renderer/collaboration/agentEndpointViewModel";
import { useRemoteRunPanelController } from "../renderer/hooks/useRemoteRunPanelController";
import { createTranslator } from "../renderer/i18n";
import {
  desktopWorkspaceExecutionResponseSchema,
  type DesktopOwnerCanvasExecutionLocator,
  type DesktopWorkspaceExecutionResponse,
  type PlanWeaveWorkspaceExecutionApi
} from "../shared/workspaceExecution";

const blockItem: WorkItemRef = {
  kind: "block",
  canvasId: "default",
  blockRef: "T-1#B-1"
};

const locator: DesktopOwnerCanvasExecutionLocator = {
  kind: "owner_canvas",
  operatorProfileId: "profile-public",
  humanPrincipalId: "human-1",
  projectRoot: "/tmp/project",
  projectId: "project-1",
  canvasId: "default"
};

const endpoint: AvailableAgentEndpoint = {
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

const runtimeRemoteExecution = {
  identity: { operationId: "operation-1" },
  phase: "active",
  status: "owned",
  actionRequired: false,
  source: { revision: "rev-1", graphFingerprint: `pkg-${"b".repeat(64)}` },
  dispatchAttempt: { dispatchId: "dispatch-1", executionAttemptId: "attempt-1" }
} as const;

function remoteView(input?: {
  phase?: "running" | "blocked" | "completed" | "failed" | "stopped";
  operationId?: string;
  includeInteraction?: boolean;
}): DesktopWorkspaceExecutionResponse {
  const operationId = input?.operationId ?? "operation-1";
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
    runSessionId: "SESSION-0001",
    scope: { kind: "block" as const, blockRef: blockItem.blockRef },
    source
  };
  return desktopWorkspaceExecutionResponseSchema.parse({
    version: "planweave.workspace-execution-view/v1",
    handle: {
      version: "planweave.workspace-execution-handle/v1",
      runSessionId: "SESSION-0001",
      authorityBindingId: `wxb:sha256:${"a".repeat(64)}`,
      scope: { kind: "block", blockRef: blockItem.blockRef },
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
      sessionId: "SESSION-0001",
      stateVersion: 2,
      phase,
      scope: { kind: "block", blockRef: blockItem.blockRef },
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

function apiReturning(view: DesktopWorkspaceExecutionResponse) {
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

function renderController(input: {
  api: PlanWeaveWorkspaceExecutionApi;
  runtime?: typeof runtimeRemoteExecution | null;
  executionLocator?: DesktopOwnerCanvasExecutionLocator;
}) {
  return renderHook(
    ({ executionLocator }) =>
      useRemoteRunPanelController({
        agentEndpoints: [endpoint],
        workItem: blockItem,
        runtimeRemoteExecution: input.runtime ?? null,
        executionLocator,
        executionApi: input.api,
        open: true,
        selectedAgentEndpointId: endpoint.id,
        t: createTranslator("en"),
        createId: () => "action-cancel"
      }),
    { initialProps: { executionLocator: input.executionLocator ?? locator } }
  );
}

describe("useRemoteRunPanelController", () => {
  it("dispatches an ordinary owner Canvas through the shared Coordinator API", async () => {
    const fixture = apiReturning(remoteView());
    const { result } = renderController({ api: fixture.api });

    await act(async () => result.current.dispatch());

    expect(fixture.start).toHaveBeenCalledWith({
      locator,
      blockRef: blockItem.blockRef,
      agentEndpointId: "endpoint-vps",
      effectiveExecutor: { name: "codex-acp", agentId: "codex" }
    });
    expect(result.current.viewModel.identity?.operationId).toBe("operation-1");
  });

  it("attaches an existing operation, then follows the Coordinator session", async () => {
    const fixture = apiReturning(remoteView());
    const { result } = renderController({ api: fixture.api, runtime: runtimeRemoteExecution });

    await waitFor(() => expect(result.current.viewModel.identity?.operationId).toBe("operation-1"));
    expect(fixture.follow).toHaveBeenNthCalledWith(1, {
      locator,
      blockRef: blockItem.blockRef,
      operationId: "operation-1"
    });

    await act(async () => result.current.refresh());
    expect(fixture.follow).toHaveBeenLastCalledWith({
      locator,
      blockRef: blockItem.blockRef,
      agentEndpointId: "endpoint-vps",
      effectiveExecutor: { name: "codex-acp", agentId: "codex" },
      sessionId: "SESSION-0001"
    });
    expect(result.current.viewModel.events[0]?.summary).toBe("remote hello");
  });

  it("routes interaction response and cancellation through the Coordinator API", async () => {
    const fixture = apiReturning(remoteView({ phase: "blocked", includeInteraction: true }));
    const { result } = renderController({ api: fixture.api, runtime: runtimeRemoteExecution });
    await waitFor(() => expect(result.current.viewModel.pendingInteractions).toHaveLength(1));

    const request = result.current.viewModel.pendingInteractions[0]?.request;
    if (!request) throw new Error("missing_interaction_fixture");
    await act(async () =>
      result.current.answerInteraction({
        type: "interaction.permission_response",
        decision: "allow_once",
        actionId: request.actionId,
        dispatchId: request.dispatchId,
        leaseId: request.leaseId,
        executionAttemptId: request.executionAttemptId,
        acpSessionId: request.acpSessionId
      })
    );
    await act(async () => result.current.cancel("stop"));

    expect(fixture.respond).toHaveBeenCalledOnce();
    expect(fixture.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        locator,
        sessionId: "SESSION-0001",
        actionId: "action-cancel",
        reason: "stop"
      })
    );
  });

  it("ignores a late result after the owner Canvas scope changes", async () => {
    let resolveOld!: (view: DesktopWorkspaceExecutionResponse) => void;
    const old = new Promise<DesktopWorkspaceExecutionResponse>((resolve) => {
      resolveOld = resolve;
    });
    const follow = vi
      .fn()
      .mockImplementationOnce(() => old)
      .mockResolvedValueOnce(remoteView({ operationId: "operation-new" }));
    const api: PlanWeaveWorkspaceExecutionApi = {
      startWorkspaceExecution: vi.fn(),
      followWorkspaceExecution: follow,
      cancelWorkspaceExecution: vi.fn(),
      respondWorkspaceExecution: vi.fn()
    };
    const { result, rerender } = renderController({ api, runtime: runtimeRemoteExecution });
    rerender({ executionLocator: { ...locator, canvasId: "next" } });

    await waitFor(() =>
      expect(result.current.viewModel.identity?.operationId).toBe("operation-new")
    );
    resolveOld(remoteView({ operationId: "operation-old" }));
    await act(async () => Promise.resolve());

    expect(result.current.viewModel.identity?.operationId).toBe("operation-new");
  });
});
