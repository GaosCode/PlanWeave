/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import { defaultDesktopSettings } from "../shared/desktopSettings";
import {
  apiReturning,
  endpoint as windowEndpoint,
  remoteView
} from "./helpers/remoteRunPanelControllerFixtures";
import type { AcpPermissionOption } from "@planweave-ai/agent-host-protocol/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AvailableAgentEndpoint } from "../renderer/collaboration/agentEndpointViewModel";
import { createTranslator } from "../renderer/i18n";
import { registerBlockInspectorRemoteExecutionCases } from "./helpers/blockInspectorRemoteExecutionCases";
import { RemoteRunPanel } from "../renderer/team/RemoteRunPanel";
import {
  desktopWorkspaceExecutionResponseSchema,
  type DesktopOwnerCanvasExecutionLocator,
  type PlanWeaveWorkspaceExecutionApi
} from "../shared/workspaceExecution";

const ports = vi.hoisted(() => ({
  desktop: null as DesktopBridgeApi | null,
  execution: null as PlanWeaveWorkspaceExecutionApi | null,
  profileId: "profile-public"
}));
vi.mock("../renderer/bridge", () => ({
  get bridge() {
    return ports.desktop;
  },
  get workspaceExecutionBridge() {
    return ports.execution;
  },
  collaborationBridge: null,
  operatorControlBridge: null
}));
vi.mock("../renderer/hooks/useDesktopSettingsBridge", () => ({
  useDesktopSettingsBridge: () => ({
    settings: defaultDesktopSettings,
    updateSettingsAndWait: vi.fn()
  })
}));
vi.mock("../renderer/hooks/useOwnerControlPlaneAvailability", () => ({
  useOwnerControlPlaneAvailability: () => ({
    operatorProfileId: ports.profileId,
    humanPrincipalId: "human-1",
    fleetCatalogEnabled: true,
    fleetCatalogBlockedCode: null
  })
}));
vi.mock("../renderer/hooks/useWorkspaceAgentEndpointCatalog", () => ({
  useWorkspaceAgentEndpointCatalog: () => ({
    endpoints: [windowEndpoint],
    refresh: vi.fn(),
    refreshing: false,
    savePreference: vi.fn()
  })
}));
vi.mock("../renderer/team/AssigneeInspectorField", () => ({ AssigneeInspectorField: () => null }));
vi.mock("../renderer/team/WorkItemCollaborationPanel", () => ({
  WorkItemCollaborationPanel: () => null
}));

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

const exactOptions: AcpPermissionOption[] = [
  { optionId: "always-write", label: "Write", kind: "allow_always" },
  { optionId: "once-write", label: "Write", kind: "allow_once" }
];

function createApi(options: AcpPermissionOption[] | null = exactOptions) {
  const response = desktopWorkspaceExecutionResponseSchema.parse({
    ...view,
    events: view.events.map((event) =>
      event.type === "interaction_required"
        ? { ...event, data: { ...event.data, ...(options === null ? {} : { options }) } }
        : event
    )
  });
  const cancel = vi.fn().mockResolvedValue(response);
  const respond = vi.fn().mockResolvedValue(response);
  const api: PlanWeaveWorkspaceExecutionApi = {
    startWorkspaceExecution: vi.fn().mockResolvedValue(response),
    followWorkspaceExecution: vi.fn().mockResolvedValue(response),
    cancelWorkspaceExecution: cancel,
    respondWorkspaceExecution: respond
  };
  return { api, cancel, respond, follow: api.followWorkspaceExecution };
}

function panel(api: PlanWeaveWorkspaceExecutionApi, operationId = "operation-1") {
  return (
    <RemoteRunPanel
      agentEndpoints={[endpoint]}
      workItem={{ kind: "block", canvasId: "default", blockRef: "T-1#B-1" }}
      runtimeRemoteExecution={{
        identity: { operationId },
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

function renderPanel(api: PlanWeaveWorkspaceExecutionApi) {
  return render(panel(api));
}

function withLoadedAcpSession(running: ReturnType<typeof remoteView>) {
  if (running.handle.target !== "remote") throw new Error("remote_handle_required");
  return desktopWorkspaceExecutionResponseSchema.parse({
    ...running,
    handle: {
      ...running.handle,
      cursor: { ...running.handle.cursor, eventCursor: 2 }
    },
    events: [
      ...running.events,
      {
        ...running.events[0],
        eventId: "session-loaded",
        source: { ...running.events[0].source, cursor: 2 },
        type: "runner_event",
        data: {
          eventProtocolVersion: 2,
          event: {
            eventVersion: 2,
            cursor: 2,
            sourceSequence: 2,
            timestamp: "2030-01-01T00:00:02.000Z",
            fragment: {
              kind: "engine_evidence",
              evidence: { kind: "session_started", loaded: true, sessionId: "acp-session-1" }
            }
          }
        }
      }
    ]
  });
}

afterEach(cleanup);

describe("Block Inspector Window remote execution reads", () =>
  registerBlockInspectorRemoteExecutionCases(ports));

describe("RemoteRunPanel", () => {
  it("offers recovery from authority, supports retry, and confirms only Host-observed progress", async () => {
    const user = userEvent.setup();
    const interrupted = remoteView({ phase: "blocked", remoteResume: { available: true } });
    const { api, follow, resume } = apiReturning(interrupted);
    resume.mockRejectedValueOnce(new Error("remote_resume_host_unavailable"));
    resume.mockImplementation(async (input) =>
      input.mode === "observe"
        ? { state: "not_recorded" }
        : { state: "delivered", leaseId: "lease-2" }
    );
    renderPanel(api);

    const button = await screen.findByRole("button", { name: "Resume session" });
    expect(screen.getByTestId("remote-run-phase")).toHaveTextContent("Interrupted");
    await user.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("The Host is unavailable.");
    await waitFor(() => expect(button).toBeEnabled());

    follow.mockResolvedValueOnce(
      remoteView({
        observation: {
          state: "activated",
          attemptStatus: "activated",
          revision: 3,
          leaseId: "lease-2"
        }
      })
    );
    const running = remoteView({
      observation: { state: "running", attemptStatus: "running", revision: 4, leaseId: "lease-2" }
    });
    follow.mockResolvedValue(running);
    await user.click(button);
    expect(screen.getByRole("status")).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Resuming the ACP session");
    expect(follow).toHaveBeenLastCalledWith({
      locator,
      blockRef: "T-1#B-1",
      operationId: "operation-1"
    });
    await user.click(screen.getByTestId("remote-run-refresh"));
    await waitFor(() =>
      expect(screen.getByTestId("remote-run-phase")).toHaveTextContent("Running")
    );
    expect(screen.getByRole("status")).toHaveTextContent("Resuming the ACP session");

    follow.mockResolvedValue(withLoadedAcpSession(running));
    await waitFor(
      () =>
        expect(screen.getByRole("status")).toHaveTextContent("The original ACP session resumed."),
      { timeout: 2500 }
    );
    follow.mockResolvedValue(running);
    await user.click(screen.getByTestId("remote-run-refresh"));
    expect(screen.getByRole("status")).toHaveTextContent("The original ACP session resumed.");
    const submissions = resume.mock.calls.filter(([input]) => input.mode !== "observe");
    expect(submissions).toHaveLength(2);
    expect(submissions[0]).toEqual(submissions[1]);
    expect(screen.queryByRole("button", { name: "Resume session" })).not.toBeInTheDocument();
  });

  it.each([
    "follow",
    "receipt"
  ] as const)("observes the original resume after a transient %s failure in the same Inspector", async (failure) => {
    const user = userEvent.setup();
    const interrupted = remoteView({ phase: "blocked", remoteResume: { available: true } });
    const { api, follow, resume } = apiReturning(interrupted);
    renderPanel(api);
    const button = await screen.findByRole("button", { name: "Resume session" });
    const running = withLoadedAcpSession(
      remoteView({
        observation: { state: "running", attemptStatus: "running", revision: 4, leaseId: "lease-2" }
      })
    );
    const readReceipt = failure === "receipt";
    if (readReceipt) {
      resume.mockRejectedValueOnce(new Error("remote_resume_status_unavailable"));
      resume.mockRejectedValueOnce(new Error("remote_resume_status_unavailable"));
    } else {
      follow.mockRejectedValueOnce(new Error("workspace_execution_request_failed"));
    }
    follow.mockResolvedValue(running);
    await user.click(button);
    await waitFor(
      () =>
        expect(screen.getByRole("status")).toHaveTextContent("The original ACP session resumed."),
      { timeout: 4500 }
    );
    expect(resume.mock.calls.filter(([request]) => request.mode !== "observe")).toHaveLength(1);
    if (readReceipt) {
      expect(
        resume.mock.calls.filter(([request]) => request.mode === "observe").length
      ).toBeGreaterThanOrEqual(1);
    }
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not attribute loaded evidence from a different lease to the original action", async () => {
    const interrupted = remoteView({ phase: "blocked", remoteResume: { available: true } });
    const { api, follow } = apiReturning(interrupted);
    renderPanel(api);
    const button = await screen.findByRole("button", { name: "Resume session" });
    follow.mockResolvedValue(
      withLoadedAcpSession(
        remoteView({
          observation: {
            state: "running",
            attemptStatus: "running",
            revision: 4,
            leaseId: "lease-later"
          }
        })
      )
    );
    await userEvent.setup().click(button);
    await waitFor(() =>
      expect(screen.getByTestId("remote-run-phase")).toHaveTextContent("Running")
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      createTranslator("en")("remoteRunResumeChanged")
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("The original ACP session resumed.");
  });

  it("renders Coordinator identity, events, and pending interaction", async () => {
    const { api } = createApi();
    renderPanel(api);

    await waitFor(() => expect(screen.getByTestId("remote-run-identity")).toBeInTheDocument());
    expect(screen.getByText("operation-1")).toBeInTheDocument();
    expect(screen.getByText(/remote hello/)).toBeInTheDocument();
    expect(screen.getByTestId("remote-run-interaction")).toBeInTheDocument();
    expect(screen.queryByTestId("remote-run-action-resume_same_session")).not.toBeInTheDocument();
    expect(screen.queryByTestId("remote-run-action-fail_interruption")).not.toBeInTheDocument();
    expect(screen.queryByTestId("remote-run-action-retry_new_attempt")).not.toBeInTheDocument();
  });

  it("responds and cancels through the Coordinator bridge", async () => {
    const user = userEvent.setup();
    const { api, cancel, respond } = createApi();
    renderPanel(api);
    await waitFor(() => expect(screen.getByTestId("remote-run-interaction")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Write — Allow once" }));
    await waitFor(() => expect(respond).toHaveBeenCalledOnce());
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        response: {
          type: "interaction.permission_response",
          decision: "select_option",
          optionId: "once-write",
          actionId: "action-1",
          dispatchId: "dispatch-1",
          leaseId: "lease-1",
          executionAttemptId: "attempt-1",
          acpSessionId: "acp-session-1"
        }
      })
    );
    await user.click(screen.getByTestId("remote-run-action-cancel"));
    await user.click(screen.getByTestId("remote-run-confirm-yes"));

    await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({ locator, sessionId: "SESSION-0001" })
    );
  });
});

describe("RemoteRunPanel navigation", () => {
  it("refreshes endpoints on open or user request, without refreshing when the callback changes", async () => {
    const firstRefresh = vi.fn(async () => undefined);
    const currentRefresh = vi.fn(async () => undefined);
    const renderPanel = (onRefreshAgentEndpoints: () => Promise<void>, open: boolean) => (
      <RemoteRunPanel
        agentEndpoints={[endpoint]}
        workItem={{ kind: "block", canvasId: "default", blockRef: "T-1#B-1" }}
        onRefreshAgentEndpoints={onRefreshAgentEndpoints}
        open={open}
        t={createTranslator("en")}
      />
    );
    const { rerender } = render(renderPanel(firstRefresh, true));
    await waitFor(() => expect(firstRefresh).toHaveBeenCalledOnce());
    rerender(renderPanel(currentRefresh, true));
    expect(currentRefresh).not.toHaveBeenCalled();

    await userEvent.setup().click(
      within(screen.getByTestId("agent-endpoint-selector")).getByRole("button", {
        name: "Refresh"
      })
    );
    expect(currentRefresh).toHaveBeenCalledOnce();
    rerender(renderPanel(currentRefresh, false));
    expect(currentRefresh).toHaveBeenCalledOnce();
    rerender(renderPanel(currentRefresh, true));
    expect(currentRefresh).toHaveBeenCalledTimes(2);
  });

  it("closes A's cancel confirmation and enables B dispatch without remounting", async () => {
    const { api, cancel } = createApi();
    const { rerender } = renderPanel(api);
    await userEvent.setup().click(await screen.findByTestId("remote-run-action-cancel"));
    expect(screen.getByTestId("remote-run-confirm-yes")).toBeInTheDocument();
    rerender(
      <RemoteRunPanel
        agentEndpoints={[endpoint]}
        workItem={{ kind: "block", canvasId: "default", blockRef: "T-1#B-2" }}
        executionLocator={locator}
        executionApi={api}
        selectedAgentEndpointId={endpoint.id}
        open
        t={createTranslator("en")}
      />
    );
    expect(screen.queryByTestId("remote-run-confirm-yes")).toBeNull();
    expect(screen.getByTestId("remote-run-action-dispatch")).toBeEnabled();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("RemoteRunPanel operation routing", () => {
  it("retires old confirmation and sends refresh, permission, and cancellation to the new session", async () => {
    const user = userEvent.setup();
    const { api, cancel, respond, follow } = createApi();
    const { rerender } = renderPanel(api);
    await user.click(await screen.findByTestId("remote-run-action-cancel"));
    expect(screen.getByTestId("remote-run-confirm-yes")).toBeInTheDocument();
    const next = desktopWorkspaceExecutionResponseSchema.parse({
      ...view,
      handle: { ...view.handle, operationId: "operation-2", runSessionId: "SESSION-0002" },
      session: { ...view.session, sessionId: "SESSION-0002" },
      events: view.events.map((event) => ({
        ...event,
        runSessionId: "SESSION-0002",
        source: { ...event.source, operationId: "operation-2" },
        data:
          event.type === "interaction_required"
            ? {
                ...event.data,
                actionId: "action-2",
                acpSessionId: "acp-session-2",
                options: exactOptions
              }
            : event.data
      }))
    });
    vi.mocked(follow).mockResolvedValue(next);
    respond.mockResolvedValue(next);
    cancel.mockResolvedValue(next);
    rerender(panel(api, "operation-2"));
    expect(screen.queryByTestId("remote-run-confirm-yes")).toBeNull();
    await waitFor(() => expect(screen.getByText("operation-2")).toBeInTheDocument());
    expect(screen.queryByText("operation-1")).toBeNull();
    expect(follow).toHaveBeenLastCalledWith({
      locator,
      blockRef: "T-1#B-1",
      operationId: "operation-2"
    });
    await user.click(screen.getByTestId("remote-run-refresh"));
    expect(follow).toHaveBeenLastCalledWith({
      locator,
      blockRef: "T-1#B-1",
      sessionId: "SESSION-0002",
      agentEndpointId: "endpoint-vps",
      effectiveExecutor: { name: "codex-acp", agentId: "codex" }
    });
    await user.click(screen.getByRole("button", { name: "Write — Allow once" }));
    expect(respond).toHaveBeenCalledWith({
      locator,
      blockRef: "T-1#B-1",
      sessionId: "SESSION-0002",
      agentEndpointId: "endpoint-vps",
      effectiveExecutor: { name: "codex-acp", agentId: "codex" },
      response: {
        type: "interaction.permission_response",
        decision: "select_option",
        optionId: "once-write",
        actionId: "action-2",
        dispatchId: "dispatch-1",
        leaseId: "lease-1",
        executionAttemptId: "attempt-1",
        acpSessionId: "acp-session-2"
      }
    });
    await user.click(screen.getByTestId("remote-run-action-cancel"));
    await user.click(screen.getByTestId("remote-run-confirm-yes"));
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({ locator, blockRef: "T-1#B-1", sessionId: "SESSION-0002" })
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("RemoteRunPanel exact permissions", () => {
  it.each([
    { name: "only always", options: [exactOptions[0]], optionId: "always-write" },
    {
      name: "same kind options",
      options: [
        { optionId: "read-a", label: "Read A", kind: "allow_once" },
        { optionId: "read-b", label: "Read B", kind: "allow_once" }
      ],
      optionId: "read-b"
    },
    {
      name: "explicit permanent rejection",
      options: [{ optionId: "reject-forever", label: "Reject", kind: "reject_always" }],
      optionId: "reject-forever"
    }
  ] satisfies {
    name: string;
    options: AcpPermissionOption[];
    optionId: string;
  }[])("submits the selected ID for $name", async ({ options, optionId }) => {
    const { api, respond } = createApi(options);
    renderPanel(api);
    const buttons = await screen.findAllByTestId("acp-permission-option");
    expect(buttons).toHaveLength(options.length);
    const selected = buttons.find((button) => button.getAttribute("data-option-id") === optionId);
    expect(selected).toBeDefined();
    if (!selected) throw new Error("Expected exact option button");
    if (options[0].kind === "allow_always") {
      expect(selected).toHaveTextContent("Always allow");
      expect(screen.queryByRole("button", { name: /Allow once/ })).toBeNull();
    }
    await userEvent.setup().click(selected);
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({
          response: expect.objectContaining({ decision: "select_option", optionId })
        })
      )
    );
  });

  it.each([
    "allow_always",
    "reject_always"
  ] as const)("cancels the request without selecting %s", async (kind) => {
    const { api, respond, cancel } = createApi([
      { optionId: "scope-always", label: "Permission", kind }
    ]);
    renderPanel(api);
    await userEvent.setup().click(await screen.findByTestId("acp-permission-cancel"));
    await waitFor(() => expect(respond).toHaveBeenCalledOnce());
    expect(respond.mock.calls[0][0].response).toEqual({
      type: "interaction.permission_response",
      decision: "deny",
      actionId: "action-1",
      dispatchId: "dispatch-1",
      leaseId: "lease-1",
      executionAttemptId: "attempt-1",
      acpSessionId: "acp-session-1"
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("only stops the entire execution for legacy requests without options", async () => {
    const { api, respond, cancel } = createApi(null);
    renderPanel(api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Stop entire execution" }));
    expect(screen.queryByTestId("acp-permission-option")).toBeNull();
    expect(screen.queryByTestId("acp-permission-cancel")).toBeNull();
    expect(
      screen.getByText(/older request does not include exact permission options/)
    ).toBeInTheDocument();
    await user.click(screen.getByTestId("remote-run-confirm-yes"));
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(respond).not.toHaveBeenCalled();
  });
});
