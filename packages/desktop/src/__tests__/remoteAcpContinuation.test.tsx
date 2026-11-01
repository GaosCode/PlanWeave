import { Profiler } from "react";
import { desktopRemoteAcpConversationPageSchema } from "../shared/remoteAcpConversation";
import type { AcpPermissionOption } from "@planweave-ai/agent-host-protocol/browser";
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
import { registerRemoteAcpContinuationPaginationCases } from "./helpers/remoteAcpContinuationPaginationCases";
import type { RemoteRunnerEventFragment } from "@planweave-ai/agent-host-protocol/browser";
afterEach(cleanupRendererTestEnvironment);
registerRemoteAcpContinuationPaginationCases();
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
    canRestoreTask: false,
    restoredOperationId: null,
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
            turnOrder: page.turns.length + 1,
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
  it("removes cached compacted content, shows explicit truncation, and keeps later turns", async () => {
    const f = setup();
    const timestamp = "2030-01-01T00:00:00.000Z";
    const turn = {
      turnId: "old-turn",
      turnOrder: 1,
      executionAttemptId: "attempt-one",
      sessionId: "original-session",
      status: "completed" as const,
      createdAt: timestamp,
      error: null
    };
    let page: DesktopRemoteAcpConversationPage = {
      ...f.page,
      turns: [turn],
      cursor: 1,
      events: [
        {
          protocolVersion: 1,
          type: "acp_conversation.event",
          operationId: scope.operationId,
          executionAttemptId: turn.executionAttemptId,
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          sequence: 1,
          messageId: "old-message",
          timestamp,
          payload: {
            kind: "runner",
            fragment: {
              kind: "runner_body",
              body: {
                kind: "message",
                role: "assistant",
                messageId: "reply-old",
                chunk: false,
                content: "Old cached payload",
                redaction: { classes: [], replaced: 0 }
              }
            }
          }
        }
      ]
    };
    f.api.remoteAcpConversation.mockImplementation(async () => page);
    let continuation: ReturnType<typeof useRemoteAcpContinuation> | undefined;
    function View() {
      continuation = useRemoteAcpContinuation(f.api, scope);
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
            state: "completed",
            terminalOutcome: "completed",
            timeline: [],
            telemetry: null
          }}
          t={createTranslator("zh-CN")}
        />
      );
    }
    render(<View />);
    await screen.findByText("Old cached payload");
    expect(screen.getByTestId("remote-acp-history-unknown")).toBeTruthy();
    vi.useFakeTimers();
    try {
      page = { ...page, events: [], retention: { compactedTurnIds: [turn.turnId] } };
      await act(async () => {
        expect(await continuation!.send("New message")).toBe(true);
      });
      expect(screen.queryByText("Old cached payload")).toBeNull();
      expect(screen.getByTestId("remote-acp-history-compacted").textContent).toContain(
        "正文已按保留策略清理"
      );
      expect(screen.getByText("New message")).toBeTruthy();
      const sentPrompt = f.api.remoteAcpConversation.mock.calls.at(-1)?.[0].action;
      if (sentPrompt?.kind !== "prompt") throw new Error("Expected a prompt action");
      const nextTurn = { ...turn, turnId: sentPrompt.turnId };
      page = {
        ...page,
        turns: [turn, nextTurn],
        cursor: 2,
        events: [
          {
            protocolVersion: 1,
            type: "acp_conversation.event",
            operationId: scope.operationId,
            executionAttemptId: turn.executionAttemptId,
            sessionId: turn.sessionId,
            turnId: nextTurn.turnId,
            sequence: 1,
            messageId: "new-message",
            timestamp,
            payload: {
              kind: "runner",
              fragment: {
                kind: "runner_body",
                body: {
                  kind: "message",
                  role: "assistant",
                  messageId: "reply-new",
                  chunk: false,
                  content: "New retained reply",
                  redaction: { classes: [], replaced: 0 }
                }
              }
            }
          }
        ]
      };
      await act(async () => {
        expect(await continuation!.send("New message")).toBe(true);
      });
      expect(screen.getByText("New retained reply")).toBeTruthy();
      expect(screen.queryByText("Old cached payload")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores only from the explicit composer action and retains the original session identity", async () => {
    const f = setup();
    f.page.canRestoreTask = true;
    f.api.remoteAcpConversation.mockImplementation(async (input) =>
      input.action?.kind === "restore_task"
        ? {
            ...f.page,
            available: false,
            canRestoreTask: false,
            restoredOperationId: "new-operation"
          }
        : f.page
    );
    const t = createTranslator("zh-CN");
    function Composer() {
      const continuation = useRemoteAcpContinuation(f.api, scope);
      return <RemoteAcpComposer continuation={continuation} t={t} />;
    }
    render(<Composer />);
    const button = await screen.findByRole("button", { name: "恢复任务" });
    expect(screen.getByText("任务已停止")).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole("button", { name: "恢复任务" })).toBeNull());
    const actions = f.api.remoteAcpConversation.mock.calls.flatMap(([input]) =>
      input.action ? [input.action] : []
    );
    expect(actions).toEqual([
      expect.objectContaining({
        kind: "restore_task",
        executionAttemptId: "attempt-one",
        sessionId: "original-session"
      })
    ]);
  });

  it("projects telemetry within the latest follow-up record without merging initial snapshots across turns", async () => {
    const f = setup();
    const timestamp = "2026-09-05T12:00:00.000Z";
    const turns = ["first", "second"].map((turnId, index) => ({
      turnOrder: index + 1,
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
    expect(result.current.pendingMessages[0]).toMatchObject({
      text: "Continue now",
      status: "sending"
    });
    expect(result.current.active).toBeNull();
    await act(async () => {
      acknowledge();
      expect(await sent).toBe(true);
    });
    expect(result.current.active?.status).toBe("running");
    expect(result.current.pendingMessages[0]).toMatchObject({
      text: "Continue now",
      status: "accepted"
    });
    expect(f.api.remoteAcpConversation.mock.calls).toHaveLength(reads + 1);
    rerender({ input: { ...scope, operationId: "operation-two" } });
    expect(result.current.pendingMessages).toHaveLength(0);
  });

  it("shows the latest reply status without treating later messages as a separate conversation", async () => {
    const f = setup();
    const page: DesktopRemoteAcpConversationPage = {
      ...f.page,
      execution: { state: "cancelled", cancel: null, interactions: [] },
      turns: [
        {
          turnId: "turn-done",
          turnOrder: 1,
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
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Completed"));
    expect(screen.queryByText(/Follow-up|Original run|operationId:/)).toBeNull();
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
        description: "Read README.md",
        options: [
          { optionId: "read-always", label: "Read", kind: "allow_always" },
          { optionId: "read-once", label: "Read", kind: "allow_once" }
        ]
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
    fireEvent.click(await screen.findByRole("button", { name: "Read — Allow once" }));
    await waitFor(() =>
      expect(f.api.remoteAcpConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          action: {
            kind: "execution_respond",
            response: {
              type: "interaction.permission_response",
              decision: "select_option",
              optionId: "read-once",
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
      expect(screen.getByRole("button", { name: "Stop response" }).hasAttribute("disabled")).toBe(
        false
      )
    );
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    expect(screen.queryByText("Cancel run")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop response" }));
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
    await screen.findByRole("button", { name: "Stop response" });
    expect(screen.queryByText(createTranslator("en")("acpPromptSending"))).toBeNull();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    expect(
      f.api.remoteAcpConversation.mock.calls.find(([input]) => input.action?.kind === "prompt")?.[0]
        .action
    ).toMatchObject({ sessionId: "original-session", text: "Continue this session" });
    fireEvent.click(screen.getByRole("button", { name: "Stop response" }));
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
    expect(result.current.pendingMessages[0]).toMatchObject({
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

describe("remote ACP execution permission choices", () => {
  function renderPermission(options: AcpPermissionOption[] | null) {
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
        title: "Write file",
        description: "Write README.md",
        ...(options === null ? {} : { options })
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
      execution: { state: "running", cancel, interactions: [request] }
    };
    f.api.remoteAcpConversation.mockImplementation(async () => page);
    function View() {
      const continuation = useRemoteAcpContinuation(f.api, scope);
      return <RemoteAcpComposer continuation={continuation} t={createTranslator("en")} />;
    }
    render(<View />);
    return {
      ...f,
      cancel,
      actions: () =>
        f.api.remoteAcpConversation.mock.calls.flatMap(([input]) =>
          input.action ? [input.action] : []
        )
    };
  }

  it.each([
    {
      name: "only always",
      options: [{ optionId: "write-always", label: "Write", kind: "allow_always" }],
      label: "Write — Always allow",
      optionId: "write-always"
    },
    {
      name: "same kind options",
      options: [
        { optionId: "read-a", label: "Read A", kind: "allow_once" },
        { optionId: "read-b", label: "Read B", kind: "allow_once" }
      ],
      label: "Read B — Allow once",
      optionId: "read-b"
    },
    {
      name: "explicit permanent rejection",
      options: [{ optionId: "reject-always", label: "Reject", kind: "reject_always" }],
      label: "Reject — Always reject",
      optionId: "reject-always"
    }
  ] satisfies {
    name: string;
    options: AcpPermissionOption[];
    label: string;
    optionId: string;
  }[])("submits the exact option for $name", async ({ options, label, optionId }) => {
    const f = renderPermission(options);
    const button = await screen.findByRole("button", { name: label });
    expect(screen.getAllByTestId("acp-permission-option")).toHaveLength(options.length);
    if (options[0].kind === "allow_always")
      expect(screen.queryByRole("button", { name: /Allow once/ })).toBeNull();
    fireEvent.click(button);
    await waitFor(() =>
      expect(f.actions()).toEqual([
        {
          kind: "execution_respond",
          response: {
            type: "interaction.permission_response",
            decision: "select_option",
            optionId,
            actionId: "permission-one",
            dispatchId: "dispatch-one",
            leaseId: "lease-one",
            executionAttemptId: "attempt-one",
            acpSessionId: "original-session"
          }
        }
      ])
    );
  });

  it.each([
    "allow_always",
    "reject_always"
  ] as const)("cancels the request without selecting %s", async (kind) => {
    const f = renderPermission([{ optionId: "scope-always", label: "Permission", kind }]);
    fireEvent.click(await screen.findByTestId("acp-permission-cancel"));
    await waitFor(() =>
      expect(f.actions()).toEqual([
        {
          kind: "execution_respond",
          response: {
            type: "interaction.permission_response",
            decision: "deny",
            actionId: "permission-one",
            dispatchId: "dispatch-one",
            leaseId: "lease-one",
            executionAttemptId: "attempt-one",
            acpSessionId: "original-session"
          }
        }
      ])
    );
  });

  it("only stops the entire execution for a legacy request", async () => {
    const f = renderPermission(null);
    fireEvent.click(await screen.findByRole("button", { name: "Stop entire execution" }));
    expect(screen.queryByTestId("acp-permission-option")).toBeNull();
    expect(screen.queryByTestId("acp-permission-cancel")).toBeNull();
    expect(
      screen.getByText(/older request does not include exact permission options/)
    ).toBeTruthy();
    await waitFor(() =>
      expect(f.actions()).toEqual([
        {
          kind: "execution_cancel",
          command: f.cancel
        }
      ])
    );
  });
});

const timestamp = "2030-01-01T00:00:00.000Z";

function message(turnId: string, sequence: number, content: string) {
  return {
    protocolVersion: 1,
    type: "acp_conversation.event",
    operationId: scope.operationId,
    executionAttemptId: "attempt-one",
    sessionId: "original-session",
    turnId,
    sequence,
    messageId: `${turnId}-${sequence}`,
    timestamp,
    payload: {
      kind: "runner",
      fragment: {
        kind: "runner_body",
        body: {
          kind: "message",
          role: "assistant",
          messageId: `${turnId}-${sequence}`,
          chunk: false,
          content,
          redaction: { classes: [], replaced: 0 }
        }
      }
    }
  };
}

function initialPage() {
  return desktopRemoteAcpConversationPageSchema.parse({
    execution: { state: "completed", cancel: null, interactions: [] },
    available: true,
    canRestoreTask: false,
    restoredOperationId: null,
    reason: null,
    executionAttemptId: "attempt-one",
    sessionId: "original-session",
    turns: ["first", "second"].map((turnId, index) => ({
      turnOrder: index + 1,
      turnId,
      executionAttemptId: "attempt-one",
      sessionId: "original-session",
      status: "completed",
      createdAt: timestamp,
      error: null
    })),
    events: [message("first", 1, "First reply"), message("second", 1, "Second reply")],
    cursor: 2,
    hasMore: false
  });
}

async function poll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
}

describe("remote ACP continuation incremental projection", () => {
  it.each([
    [1000, 1],
    [1000, 10],
    [10000, 1],
    [10000, 100]
  ])("avoids empty or duplicate page commits and limits append commits for %i events across %i turns", async (eventCount, turnCount) => {
    vi.useFakeTimers();
    const base = initialPage();
    const turnIds = Array.from({ length: turnCount }, (_, index) => `turn-${index}`);
    let page = desktopRemoteAcpConversationPageSchema.parse({
      ...base,
      turns: turnIds.map((turnId) => ({ ...base.turns[0], turnId })),
      events: turnIds.flatMap((turnId) =>
        Array.from({ length: eventCount / turnCount }, (_, index) =>
          message(turnId, index + 1, `${turnId}:${index + 1}`)
        )
      ),
      cursor: eventCount
    });
    const original = page;
    const api = { remoteAcpConversation: vi.fn(async () => structuredClone(page)) };
    const commits = vi.fn();
    const { result } = renderHook(() => useRemoteAcpContinuation(api, scope), {
      wrapper: ({ children }) => (
        <Profiler id="continuation" onRender={commits}>
          {children}
        </Profiler>
      )
    });
    await act(async () => {});
    expect(result.current.turns[0].timeline[0]).toMatchObject({
      kind: "message",
      content: "turn-0:1"
    });
    const turns = result.current.turns;
    const initialCommits = commits.mock.calls.length;
    page = { ...page, events: [] };
    await poll();
    await poll();
    expect(api.remoteAcpConversation).toHaveBeenCalledTimes(3);
    expect(result.current.turns).toBe(turns);
    expect(commits).toHaveBeenCalledTimes(initialCommits);
    page = original;
    await poll();
    expect(result.current.turns).toBe(turns);
    expect(commits).toHaveBeenCalledTimes(initialCommits);
    page = {
      ...page,
      events: [message("turn-0", eventCount / turnCount + 1, "Append")],
      cursor: eventCount + 1
    };
    await poll();
    expect(result.current.turns[0].timeline.at(-1)).toMatchObject({ content: "Append" });
    expect(commits.mock.calls.length - initialCommits).toBeGreaterThan(0);
    expect(commits.mock.calls.length - initialCommits).toBeLessThanOrEqual(2);
    console.info(
      JSON.stringify({
        events: eventCount,
        turns: turnCount,
        emptyPollReactCommits: 0,
        duplicatePageReactCommits: 0,
        appendReactCommits: commits.mock.calls.length - initialCommits,
        appendCommitPhases: commits.mock.calls.slice(initialCommits).map((call) => call[1])
      })
    );
  });

  it("updates only the changed turn and publishes metadata changes without a new cursor", async () => {
    vi.useFakeTimers();
    let page: DesktopRemoteAcpConversationPage = initialPage();
    const api = {
      remoteAcpConversation: vi.fn(async () => desktopRemoteAcpConversationPageSchema.parse(page))
    };
    const { result } = renderHook(() => useRemoteAcpContinuation(api, scope));
    await act(async () => {});
    const first = result.current.turns[0];
    const second = result.current.turns[1];
    page = desktopRemoteAcpConversationPageSchema.parse({
      ...page,
      cursor: 3,
      events: [message("second", 2, "Another reply")]
    });
    await poll();
    expect(result.current.turns[0]).toBe(first);
    expect(result.current.turns[1]).not.toBe(second);
    expect(result.current.turns[1].timeline).toEqual([
      expect.objectContaining({ kind: "message", content: "Second reply" }),
      expect.objectContaining({ kind: "message", content: "Another reply" })
    ]);
    const timeline = result.current.turns[1].timeline;
    page = {
      ...page,
      events: [],
      available: false,
      reason: "session_unavailable",
      canRestoreTask: true,
      turns: page.turns.map((turn) =>
        turn.turnId === "second" ? { ...turn, status: "failed", error: "Agent failed" } : turn
      )
    };
    await poll();
    expect(result.current).toMatchObject({
      available: false,
      reason: "session_unavailable",
      canRestoreTask: true
    });
    expect(result.current.turns[0]).toBe(first);
    expect(result.current.turns[1]).toMatchObject({ status: "failed", error: "Agent failed" });
    expect(result.current.turns[1].timeline).toBe(timeline);
  });
});

describe("remote ACP continuation cache lifecycle", () => {
  it("publishes each same-cursor metadata change and invalidates only a changed turn identity", async () => {
    vi.useFakeTimers();
    let page: DesktopRemoteAcpConversationPage = initialPage();
    page.turns[1].status = "running";
    const api = {
      remoteAcpConversation: vi.fn(async (_input: DesktopRemoteAcpConversationInput) =>
        structuredClone(page)
      )
    };
    const { result } = renderHook(() => useRemoteAcpContinuation(api, scope));
    await act(async () => {});
    expect(result.current.active?.turnId).toBe("second");
    const timeline = result.current.turns[1].timeline;
    const first = result.current.turns[0];
    page = {
      ...page,
      events: [],
      turns: [page.turns[0], { ...page.turns[1], status: "completed" }]
    };
    await poll();
    expect(result.current.active).toBeNull();
    expect(result.current.turns[1].timeline).toBe(timeline);
    page = {
      ...page,
      turns: [
        page.turns[0],
        { ...page.turns[1], createdAt: "2030-01-02T00:00:00.000Z", error: "updated detail" }
      ]
    };
    await poll();
    expect(result.current.turns[1]).toMatchObject({
      createdAt: "2030-01-02T00:00:00.000Z",
      error: "updated detail"
    });
    expect(result.current.turns[1].timeline).toBe(timeline);
    page = { ...page, available: false };
    await poll();
    expect(result.current.available).toBe(false);
    page = { ...page, reason: "session_unavailable" };
    await poll();
    expect(result.current.reason).toBe("session_unavailable");
    page = { ...page, canRestoreTask: true };
    await poll();
    expect(result.current.canRestoreTask).toBe(true);
    page = { ...page, restoredOperationId: "restored-operation" };
    await poll();
    expect(result.current.restoredOperationId).toBe("restored-operation");
    page = { ...page, execution: { state: "cancelled", cancel: null, interactions: [] } };
    await poll();
    expect(result.current.execution?.state).toBe("cancelled");
    page = {
      ...page,
      available: true,
      executionAttemptId: "attempt-two",
      sessionId: "session-two"
    };
    await poll();
    await act(async () => {
      expect(await result.current.restoreTask()).toBe(true);
    });
    expect(api.remoteAcpConversation.mock.calls.at(-1)?.[0].action).toMatchObject({
      kind: "restore_task",
      executionAttemptId: "attempt-two",
      sessionId: "session-two"
    });
    page = {
      ...page,
      turns: [page.turns[0], { ...page.turns[1], executionAttemptId: "attempt-two" }]
    };
    await poll();
    expect(result.current.turns[0]).toBe(first);
    expect(result.current.turns[1]).toMatchObject({
      executionAttemptId: "attempt-two",
      sessionId: "original-session"
    });
    expect(result.current.turns[1].projected[0].executionAttemptId).toBe("attempt-two");
    expect(result.current.turns[1].timeline).not.toBe(timeline);
    const nextTimeline = result.current.turns[1].timeline;
    page = { ...page, turns: [page.turns[0], { ...page.turns[1], sessionId: "session-three" }] };
    await poll();
    expect(result.current.turns[1].timeline).not.toBe(nextTimeline);
    expect(result.current.turns[1].timeline).toEqual([
      expect.objectContaining({ content: "Second reply" })
    ]);
    page = { ...page, sessionId: null };
    await poll();
    const requests = api.remoteAcpConversation.mock.calls.length;
    await act(async () => {
      expect(await result.current.send("No session")).toBe(false);
    });
    expect(api.remoteAcpConversation).toHaveBeenCalledTimes(requests);
  });

  it("clears optimistic text and replay on same-cursor compaction and never revives delayed payloads", async () => {
    vi.useFakeTimers();
    let page = initialPage();
    const api = {
      remoteAcpConversation: vi.fn(async (_input: DesktopRemoteAcpConversationInput) =>
        structuredClone(page)
      )
    };
    const { result } = renderHook(() => useRemoteAcpContinuation(api, scope));
    await act(async () => {});
    const second = result.current.turns[1];
    await act(async () => {
      expect(await result.current.send("Waiting for replay")).toBe(true);
    });
    const action = api.remoteAcpConversation.mock.calls.at(-1)?.[0].action;
    if (action?.kind !== "prompt") throw new Error("Expected a prompt action");
    expect(result.current.pendingMessages).toEqual([
      expect.objectContaining({ text: "Waiting for replay" })
    ]);
    page = {
      ...page,
      events: [],
      turns: [
        ...page.turns,
        {
          ...page.turns[0],
          turnId: action.turnId,
          turnOrder: page.turns.length + 1,
          createdAt: new Date(Date.parse(page.turns.at(-1)!.createdAt) + 1).toISOString()
        }
      ],
      retention: { compactedTurnIds: ["first", action.turnId] }
    };
    await poll();
    expect(result.current.pendingMessages).toEqual([]);
    expect(result.current.turns[0]).toMatchObject({
      history: "compacted",
      timeline: [],
      projected: []
    });
    expect(result.current.turns[2]).toMatchObject({
      history: "compacted",
      timeline: [],
      projected: []
    });
    expect(result.current.turns[1]).toBe(second);
    const { retention: _retention, ...withoutRetention } = page;
    page = {
      ...withoutRetention,
      events: [message("first", 1, "Old body"), message(action.turnId, 1, "Late body")]
    };
    await poll();
    expect(result.current.pendingMessages).toEqual([]);
    expect(result.current.turns.map((turn) => turn.timeline.length)).toEqual([0, 1, 0]);
    expect(result.current.turns[0].history).toBe("compacted");
    expect(result.current.turns[1]).toBe(second);
  });

  it.each([
    "resolve",
    "reject"
  ] as const)("releases the old scope cache and fences a delayed %s", async (outcome) => {
    vi.useFakeTimers();
    const oldPage = initialPage();
    let resolve!: (value: DesktopRemoteAcpConversationPage) => void;
    let reject!: (cause: Error) => void;
    const delayed = new Promise<DesktopRemoteAcpConversationPage>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const api = {
      remoteAcpConversation: vi.fn(async (_input: DesktopRemoteAcpConversationInput) => oldPage)
    };
    const { result, rerender, unmount } = renderHook(
      ({ input }) => useRemoteAcpContinuation(api, input),
      { initialProps: { input: scope } }
    );
    await act(async () => {});
    const oldTimeline = result.current.turns[0].timeline;
    api.remoteAcpConversation.mockImplementationOnce(() => delayed);
    await poll();
    const newPage = { ...initialPage(), events: [] };
    api.remoteAcpConversation.mockImplementation(async () => newPage);
    rerender({ input: { ...scope, operationId: "operation-two" } });
    await act(async () => {});
    expect(result.current.turns[0].timeline).toEqual([]);
    expect(result.current.turns[0].timeline).not.toBe(oldTimeline);
    await act(async () => {
      if (outcome === "resolve") resolve(oldPage);
      else reject(new Error("old_scope_failure"));
    });
    expect(result.current.error).toBeNull();
    expect(result.current.turns.map((turn) => turn.timeline.length)).toEqual([0, 0]);
    let finish!: (value: DesktopRemoteAcpConversationPage) => void;
    const afterUnmount = new Promise<DesktopRemoteAcpConversationPage>((yes) => {
      finish = yes;
    });
    api.remoteAcpConversation.mockImplementationOnce(() => afterUnmount);
    await poll();
    const calls = api.remoteAcpConversation.mock.calls.length;
    unmount();
    await act(async () => {
      finish(oldPage);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(api.remoteAcpConversation).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the action response when an older same-scope poll arrives later", async () => {
    vi.useFakeTimers();
    const initial = initialPage();
    let resolve!: (value: DesktopRemoteAcpConversationPage) => void;
    const delayed = new Promise<DesktopRemoteAcpConversationPage>((yes) => {
      resolve = yes;
    });
    const api = {
      remoteAcpConversation: vi.fn(async (_input: DesktopRemoteAcpConversationInput) => initial)
    };
    const { result } = renderHook(() => useRemoteAcpContinuation(api, scope));
    await act(async () => {});
    api.remoteAcpConversation.mockImplementationOnce(() => delayed);
    await poll();
    api.remoteAcpConversation.mockImplementationOnce(async (input) => {
      const action = input.action;
      if (action?.kind !== "prompt") throw new Error("Expected a prompt action");
      return {
        ...initial,
        events: [message(action.turnId, 1, "Action reply")],
        turns: [
          ...initial.turns,
          {
            ...initial.turns[0],
            turnId: action.turnId,
            status: "running",
            turnOrder: initial.turns.length + 1,
            createdAt: new Date(Date.parse(initial.turns.at(-1)!.createdAt) + 1).toISOString()
          }
        ]
      };
    });
    await act(async () => {
      expect(await result.current.send("Accepted action")).toBe(true);
    });
    expect(result.current.active).not.toBeNull();
    const turns = result.current.turns;
    await act(async () => {
      resolve({ ...initial, available: false, reason: "stale_response" });
    });
    expect(result.current.available).toBe(true);
    expect(result.current.reason).toBeNull();
    expect(result.current.turns).toBe(turns);
    expect(result.current.turns.at(-1)?.timeline).toEqual([
      expect.objectContaining({ content: "Action reply" })
    ]);
  });
});
