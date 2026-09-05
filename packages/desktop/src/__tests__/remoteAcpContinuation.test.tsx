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
    expect(
      f.api.remoteAcpConversation.mock.calls.find(([input]) => input.action?.kind === "prompt")?.[0]
        .action
    ).toMatchObject({ sessionId: "original-session", text: "Continue this session" });
    fireEvent.click(screen.getByRole("button", { name: "Stop follow-up" }));
    await waitFor(() => expect(input.hasAttribute("disabled")).toBe(false));
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
