import { RemoteAcpRunConversation } from "../renderer/task-workspace/conversation/RemoteAcpRunConversation";
import { remoteInteractionViewSchema } from "@planweave-ai/collaboration-protocol/remote-run";
/* @vitest-environment jsdom */
import { act, render, renderHook, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopRemoteAcpConversationPage } from "../shared/remoteAcpConversation";
import type { DesktopRemoteAcpConversationInput } from "../shared/remoteAcpConversation";
import { useRemoteAcpContinuation } from "../renderer/task-workspace/useRemoteAcpContinuation";
import { RemoteAcpComposer } from "../renderer/task-workspace/conversation/RemoteAcpComposer";
import { createTranslator } from "../renderer/i18n";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import type { RemoteRunnerEventFragment } from "@planweave-ai/agent-host-protocol/browser";
afterEach(cleanupRendererTestEnvironment);
const scope = {
  locator: {
    kind: "workspace" as const,
    connectionProfileId: "profile-one",
    workspaceId: "workspace-one",
    projectId: "project-one",
    canvasId: "canvas-one"
  },
  operationId: "operation-one",
  blockRef: "T-1#B-1"
};
function setup() {
  let page: DesktopRemoteAcpConversationPage = {
    execution: { state: "completed", cancel: null, interactions: [] },
    available: true,
    reason: null,
    executionAttemptId: "attempt-one",
    sessionId: "original-session",
    turns: [],
    events: [],
    cursor: 0,
    hasMore: false
  };
  const remoteAcpConversation = vi.fn(async (input: DesktopRemoteAcpConversationInput) => {
    const action = input.action;
    if (action?.kind === "prompt")
      page = {
        ...page,
        turns: [
          ...page.turns,
          {
            turnId: action.turnId,
            executionAttemptId: action.executionAttemptId,
            sessionId: action.sessionId,
            status: "running",
            createdAt: new Date().toISOString(),
            error: null
          }
        ]
      };
    if (action?.kind === "cancel")
      page = { ...page, turns: page.turns.map((turn) => ({ ...turn, status: "cancelled" })) };
    return page;
  });
  return {
    api: { remoteAcpConversation },
    get page() {
      return page;
    }
  };
}
describe("remote ACP composer continuation", () => {
  it("projects telemetry within the latest follow-up record without merging initial snapshots across turns", async () => {
    const f = setup();
    const timestamp = "2026-09-05T12:00:00.000Z";
    const turns = ["first", "second"].map((turnId) => ({
      turnId,
      executionAttemptId: "attempt-one",
      sessionId: "original-session",
      status: "completed" as const,
      createdAt: timestamp,
      error: null
    }));
    const fragments = (usedTokens: number): RemoteRunnerEventFragment[] => [
      {
        kind: "engine_evidence",
        evidence: { kind: "session_started", sessionId: "original-session", loaded: true }
      },
      {
        kind: "runner_body",
        body: {
          kind: "session_configuration_snapshot",
          phase: "initial",
          configuration: { modes: null, configOptions: [] }
        }
      },
      {
        kind: "runner_body",
        body: { kind: "usage_update", usedTokens, contextWindowTokens: 1000, cost: null }
      }
    ];
    const page: DesktopRemoteAcpConversationPage = {
      ...f.page,
      turns,
      events: turns.flatMap((turn, index) =>
        fragments(index === 0 ? 200 : 50).map((fragment, sequence) => ({
          protocolVersion: 1 as const,
          type: "acp_conversation.event" as const,
          operationId: scope.operationId,
          executionAttemptId: turn.executionAttemptId,
          sessionId: turn.sessionId,
          messageId: `${turn.turnId}-${sequence}`,
          turnId: turn.turnId,
          sequence: sequence + 1,
          timestamp,
          payload: { kind: "runner" as const, fragment }
        }))
      ),
      cursor: 6
    };
    f.api.remoteAcpConversation.mockImplementation(async () => page);
    const { result } = renderHook(() => useRemoteAcpContinuation(f.api, scope));
    await waitFor(() => expect(result.current.turns).toHaveLength(2));
    expect(result.current.telemetry?.actualConfiguration.available).toBe(true);
    expect(result.current.telemetry?.currentContext?.usedTokens).toBe(50);
  });

  it("shows the pending message before acknowledgement and consumes the acknowledgement without a second request", async () => {
    const f = setup();
    const original = f.api.remoteAcpConversation.getMockImplementation()!;
    let acknowledge!: () => void;
    const gate = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    f.api.remoteAcpConversation.mockImplementation(async (input) => {
      if (input.action?.kind === "prompt") await gate;
      return original(input);
    });
    const { result, rerender } = renderHook(({ input }) => useRemoteAcpContinuation(f.api, input), {
      initialProps: { input: scope }
    });
    await waitFor(() => expect(result.current.available).toBe(true));
    const reads = f.api.remoteAcpConversation.mock.calls.length;
    let sent!: Promise<boolean>;
    act(() => {
      sent = result.current.send("Continue now");
    });
    expect(result.current.pendingMessage).toMatchObject({
      text: "Continue now",
      status: "sending"
    });
    expect(result.current.active).toBeNull();
    await act(async () => {
      acknowledge();
      expect(await sent).toBe(true);
    });
    expect(result.current.active?.status).toBe("running");
    expect(result.current.pendingMessage).toMatchObject({
      text: "Continue now",
      status: "accepted"
    });
    expect(f.api.remoteAcpConversation.mock.calls).toHaveLength(reads + 1);
    rerender({ input: { ...scope, operationId: "operation-two" } });
    expect(result.current.pendingMessage).toBeNull();
  });

  it("shows a completed follow-up separately from its cancelled source execution", async () => {
    const f = setup();
    const page: DesktopRemoteAcpConversationPage = {
      ...f.page,
      execution: { state: "cancelled", cancel: null, interactions: [] },
      turns: [
        {
          turnId: "turn-done",
          executionAttemptId: "attempt-one",
          sessionId: "original-session",
          status: "completed",
          createdAt: new Date().toISOString(),
          error: null
        }
      ]
    };
    f.api.remoteAcpConversation.mockImplementation(async () => page);
    function View() {
      const continuation = useRemoteAcpContinuation(f.api, scope);
      return (
        <RemoteAcpRunConversation
          conversation={{
            ...scope,
            continuation,
            cursor: 0,
            error: null,
            eventProtocolVersion: 2,
            executionAttemptId: "attempt-one",
            replayDiagnostics: [],
            state: "cancelled",
            terminalOutcome: "cancelled",
            timeline: [],
            telemetry: null
          }}
          t={createTranslator("en")}
        />
      );
    }
    render(<View />);
    expect(await screen.findByText("Follow-up · Completed")).toBeDefined();
    expect(screen.getByText(/Original run · Cancelled/)).toBeDefined();
    expect(screen.getByText(/does not resubmit the task result/)).toBeDefined();
    expect(page.execution.state).toBe("cancelled");
  });

  it("responds to first-run permissions and cancels that execution without creating a follow-up turn", async () => {
    const f = setup();
    const request = remoteInteractionViewSchema.parse({
      operationId: scope.operationId,
      hostId: "host-one",
      status: "pending",
      createdAt: new Date().toISOString(),
      request: {
        type: "interaction.permission_requested",
        actionId: "permission-one",
        dispatchId: "dispatch-one",
        leaseId: "lease-one",
        executionAttemptId: "attempt-one",
        acpSessionId: "original-session",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        title: "Read workspace file",
        description: "Read README.md"
      }
    });
    const cancel = {
      kind: "cancel" as const,
      actionId: "cancel-one",
      operationId: scope.operationId,
      dispatchId: request.request.dispatchId,
      leaseId: request.request.leaseId,
      executionAttemptId: request.request.executionAttemptId,
      expectedAttemptVersion: 3,
      reason: "User cancellation"
    };
    const page: DesktopRemoteAcpConversationPage = {
      ...f.page,
      available: false,
      reason: "acp_conversation_execution_not_completed",
      execution: { state: "running", cancel, interactions: [request] }
    };
    f.api.remoteAcpConversation.mockImplementation(async () => page);
    function View() {
      const continuation = useRemoteAcpContinuation(f.api, scope);
      return <RemoteAcpComposer continuation={continuation} t={createTranslator("en")} />;
    }
    render(<View />);
    fireEvent.click(await screen.findByRole("button", { name: "Allow once" }));
    await waitFor(() =>
      expect(f.api.remoteAcpConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          action: {
            kind: "execution_respond",
            response: {
              type: "interaction.permission_response",
              decision: "allow_once",
              actionId: "permission-one",
              dispatchId: "dispatch-one",
              leaseId: "lease-one",
              executionAttemptId: "attempt-one",
              acpSessionId: "original-session"
            }
          }
        })
      )
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel run" }).hasAttribute("disabled")).toBe(
        false
      )
    );
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    expect(screen.queryByText("Cancel run")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    await waitFor(() =>
      expect(f.api.remoteAcpConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          action: { kind: "execution_cancel", command: cancel }
        })
      )
    );
    expect(
      f.api.remoteAcpConversation.mock.calls.some(([input]) => input.action?.kind === "prompt")
    ).toBe(false);
  });
  it("uses the existing composer surface to send, cancel, and then send another turn", async () => {
    const f = setup();
    function View() {
      const continuation = useRemoteAcpContinuation(f.api, scope);
      return <RemoteAcpComposer continuation={continuation} t={createTranslator("en")} />;
    }
    render(<View />);
    const input = screen.getByRole("textbox", { name: "Message the agent" });
    await waitFor(() => expect(input.hasAttribute("disabled")).toBe(false));
    fireEvent.change(input, { target: { value: "Continue this session" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("button", { name: "Stop follow-up" });
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    expect(
      f.api.remoteAcpConversation.mock.calls.find(([input]) => input.action?.kind === "prompt")?.[0]
        .action
    ).toMatchObject({ sessionId: "original-session", text: "Continue this session" });
    fireEvent.click(screen.getByRole("button", { name: "Stop follow-up" }));
    await waitFor(() => expect(input.hasAttribute("disabled")).toBe(false));
    expect(screen.getByRole("button", { name: "Send message" })).toBeDefined();
    fireEvent.change(input, { target: { value: "Another question" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(f.page.turns).toHaveLength(2));
    expect(f.page.turns[0]?.turnId).not.toBe(f.page.turns[1]?.turnId);
  });
  it("retries an uncertain send with the same turn id and fences stale completions after navigation", async () => {
    const f = setup();
    const original = f.api.remoteAcpConversation.getMockImplementation()!;
    let fail = true;
    f.api.remoteAcpConversation.mockImplementation(async (input) => {
      if (input.action && fail) throw new Error("network_unavailable");
      return original(input);
    });
    const { result, rerender } = renderHook(({ input }) => useRemoteAcpContinuation(f.api, input), {
      initialProps: { input: scope }
    });
    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => {
      expect(await result.current.send("Retry me")).toBe(false);
    });
    expect(result.current.pendingMessage).toMatchObject({
      text: "Retry me",
      status: "unconfirmed"
    });
    fail = false;
    await act(async () => {
      expect(await result.current.send("Retry me")).toBe(true);
    });
    const sends = f.api.remoteAcpConversation.mock.calls.filter(
      ([input]) => input.action?.kind === "prompt"
    );
    expect((sends[0]?.[0].action as { turnId: string })?.turnId).toBe(
      (sends[1]?.[0].action as { turnId: string })?.turnId
    );
    rerender({ input: { ...scope, operationId: "operation-two" } });
    await waitFor(() =>
      expect(f.api.remoteAcpConversation).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: "operation-two", afterCursor: 0 })
      )
    );
  });
});
