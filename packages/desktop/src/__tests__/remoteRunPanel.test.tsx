/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AvailableAgentEndpoint } from "../renderer/collaboration/agentEndpointViewModel";
import { createTranslator } from "../renderer/i18n";
import { RemoteRunPanel } from "../renderer/team/RemoteRunPanel";
import {
  desktopWorkspaceExecutionResponseSchema,
  type DesktopOwnerCanvasExecutionLocator,
  type PlanWeaveWorkspaceExecutionApi
} from "../shared/workspaceExecution";

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

const view = desktopWorkspaceExecutionResponseSchema.parse({
  version: "planweave.workspace-execution-view/v1",
  handle: {
    version: "planweave.workspace-execution-handle/v1",
    runSessionId: "SESSION-0001",
    authorityBindingId: `wxb:sha256:${"a".repeat(64)}`,
    scope: { kind: "block", blockRef: "T-1#B-1" },
    capabilities: { interactionResponse: true },
    target: "remote",
    phase: "acp_session",
    operationId: "operation-1",
    operationRevision: 2,
    dispatchId: "dispatch-1",
    executionAttemptId: "attempt-1",
    attemptStateVersion: 1,
    leaseId: "lease-1",
    agentEndpointId: "endpoint-vps",
    cursor: { target: "remote", executionAttemptId: "attempt-1", eventCursor: 2 }
  },
  session: {
    sessionId: "SESSION-0001",
    stateVersion: 2,
    phase: "blocked",
    scope: { kind: "block", blockRef: "T-1#B-1" },
    startedAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:01.000Z",
    finishedAt: null,
    error: null,
    interactionStatus: [{ key: `wxi:sha256:${"c".repeat(64)}`, status: "pending" }],
    evidence: { status: "pending", diagnostics: [] }
  },
  events: [
    {
      version: "planweave.execution-event/v1",
      eventId: "runner-1",
      observedAt: "2030-01-01T00:00:01.000Z",
      runSessionId: "SESSION-0001",
      scope: { kind: "block", blockRef: "T-1#B-1" },
      source: {
        target: "remote",
        operationId: "operation-1",
        executionAttemptId: "attempt-1",
        cursor: 1
      },
      type: "runner_event",
      data: {
        eventProtocolVersion: 1,
        event: { cursor: 1, kind: "agent_message", text: "remote hello" }
      }
    },
    {
      version: "planweave.execution-event/v1",
      eventId: "interaction-1",
      observedAt: "2030-01-01T00:00:02.000Z",
      runSessionId: "SESSION-0001",
      scope: { kind: "block", blockRef: "T-1#B-1" },
      source: {
        target: "remote",
        operationId: "operation-1",
        executionAttemptId: "attempt-1",
        cursor: 2
      },
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
});

function createApi() {
  const cancel = vi.fn().mockResolvedValue(view);
  const respond = vi.fn().mockResolvedValue(view);
  const api: PlanWeaveWorkspaceExecutionApi = {
    startWorkspaceExecution: vi.fn().mockResolvedValue(view),
    followWorkspaceExecution: vi.fn().mockResolvedValue(view),
    cancelWorkspaceExecution: cancel,
    respondWorkspaceExecution: respond
  };
  return { api, cancel, respond };
}

function renderPanel(api: PlanWeaveWorkspaceExecutionApi) {
  return render(
    <RemoteRunPanel
      agentEndpoints={[endpoint]}
      workItem={{ kind: "block", canvasId: "default", blockRef: "T-1#B-1" }}
      runtimeRemoteExecution={{
        identity: { operationId: "operation-1" },
        phase: "active",
        status: "owned",
        actionRequired: false,
        source: { revision: "rev-1", graphFingerprint: `pkg-${"b".repeat(64)}` },
        dispatchAttempt: { dispatchId: "dispatch-1", executionAttemptId: "attempt-1" }
      }}
      executionLocator={locator}
      executionApi={api}
      selectedAgentEndpointId={endpoint.id}
      open
      t={createTranslator("en")}
    />
  );
}

afterEach(cleanup);

describe("RemoteRunPanel", () => {
  it("renders Coordinator identity, events, and pending interaction", async () => {
    const { api } = createApi();
    renderPanel(api);

    await waitFor(() => expect(screen.getByTestId("remote-run-identity")).toBeInTheDocument());
    expect(screen.getByText("operation-1")).toBeInTheDocument();
    expect(screen.getByText(/remote hello/)).toBeInTheDocument();
    expect(screen.getByTestId("remote-run-interaction")).toBeInTheDocument();
    expect(screen.queryByTestId("remote-run-action-fail_interruption")).not.toBeInTheDocument();
    expect(screen.queryByTestId("remote-run-action-retry_new_attempt")).not.toBeInTheDocument();
  });

  it("responds and cancels through the Coordinator bridge", async () => {
    const user = userEvent.setup();
    const { api, cancel, respond } = createApi();
    renderPanel(api);
    await waitFor(() => expect(screen.getByTestId("remote-run-interaction")).toBeInTheDocument());

    await user.click(screen.getByTestId("remote-run-interaction-allow"));
    await waitFor(() => expect(respond).toHaveBeenCalledOnce());
    await user.click(screen.getByTestId("remote-run-action-cancel"));
    await user.click(screen.getByTestId("remote-run-confirm-yes"));

    await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({ locator, sessionId: "SESSION-0001" })
    );
  });
});
