import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  desktopRemoteAcpConversationPageSchema,
  type DesktopRemoteAcpConversationInput
} from "../../shared/remoteAcpConversation";
import { useRemoteAcpContinuation } from "../../renderer/task-workspace/useRemoteAcpContinuation";
const scope = {
  locator: {
    kind: "workspace" as const,
    connectionProfileId: "profile",
    workspaceId: "workspace",
    projectId: "project",
    canvasId: "default"
  },
  operationId: "operation",
  blockRef: "T-1#B-1"
};
const turn = (turnId: string, status = "completed") => ({
  turnId,
  turnOrder: turnId === "second" ? 2 : 1,
  executionAttemptId: "attempt",
  sessionId: "session",
  status,
  createdAt: "2030-01-01T00:00:00.000Z",
  error: null
});
function page(input: Record<string, unknown>) {
  return desktopRemoteAcpConversationPageSchema.parse({
    execution: { state: "completed", cancel: null, interactions: [] },
    available: true,
    reason: null,
    executionAttemptId: "attempt",
    sessionId: "session",
    turns: [],
    events: [],
    cursor: 0,
    hasMore: false,
    turnCursor: null,
    hasMoreTurns: false,
    ...input
  });
}

export function registerRemoteAcpContinuationPaginationCases() {
  describe("remote ACP continuation independent metadata pagination", () => {
    it("advances metadata-only pages, preserves omitted turns, applies an observed terminal, and restarts metadata next poll", async () => {
      vi.useFakeTimers();
      const remoteAcpConversation = vi.fn(async (input: DesktopRemoteAcpConversationInput) => {
        if (input.afterCursor === 1)
          return page({ turns: [turn("first")], cursor: 1, turnCursor: "first" });
        if (!input.afterTurnId)
          return page({
            turns: [turn("first", "running")],
            turnCursor: "first",
            hasMoreTurns: true,
            hasMore: true
          });
        return page({
          turns: [turn("second")],
          cursor: 1,
          turnCursor: "second",
          events: [
            {
              type: "acp_conversation.event",
              protocolVersion: 1,
              operationId: "operation",
              executionAttemptId: "attempt",
              sessionId: "session",
              turnId: "first",
              messageId: "terminal",
              sequence: 1,
              timestamp: "2030-01-01T00:00:00.000Z",
              payload: { kind: "status", status: "completed", error: null }
            }
          ]
        });
      });
      const api = { remoteAcpConversation };
      const { result } = renderHook(() => useRemoteAcpContinuation(api, scope));
      await act(async () => {});
      expect(
        remoteAcpConversation.mock.calls.map(([input]) => [input.afterCursor, input.afterTurnId])
      ).toEqual([
        [0, null],
        [0, "first"]
      ]);
      expect(result.current.turns.map((turn) => [turn.turnId, turn.status])).toEqual([
        ["first", "completed"],
        ["second", "completed"]
      ]);
      expect(result.current.active).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(remoteAcpConversation.mock.calls.at(-1)?.[0]).toMatchObject({
        afterCursor: 1,
        afterTurnId: null
      });
      expect(result.current.turns.map((turn) => turn.turnId)).toEqual(["first", "second"]);
      expect(result.current.error).toBeNull();
    });

    it("reports a stalled metadata cursor without requesting the same unproductive page again", async () => {
      const remoteAcpConversation = vi.fn(async () => page({ hasMore: true, hasMoreTurns: true }));
      const api = { remoteAcpConversation };
      const { result, unmount } = renderHook(() => useRemoteAcpContinuation(api, scope));
      await act(async () => {});
      expect(remoteAcpConversation).toHaveBeenCalledTimes(1);
      expect(result.current.error).toBe("acp_conversation_turn_cursor_stalled");
      unmount();
    });

    it("confirms an ambiguously accepted prompt across metadata and event-only recovery pages", async () => {
      let acceptedTurnId: string | null = null;
      const remoteAcpConversation = vi.fn(async (input: DesktopRemoteAcpConversationInput) => {
        if (input.action?.kind === "prompt") {
          acceptedTurnId = input.action.turnId;
          throw new Error("response_lost_after_acceptance");
        }
        if (!acceptedTurnId) return page({});
        if (!input.afterTurnId)
          return page({
            turns: [turn(acceptedTurnId, "running")],
            turnCursor: acceptedTurnId,
            hasMore: true
          });
        return page({
          cursor: 1,
          turnCursor: acceptedTurnId,
          events: [
            {
              type: "acp_conversation.event",
              protocolVersion: 1,
              operationId: "operation",
              executionAttemptId: "attempt",
              sessionId: "session",
              turnId: acceptedTurnId,
              messageId: "accepted-prompt-terminal",
              sequence: 1,
              timestamp: "2030-01-01T00:00:00.000Z",
              payload: { kind: "status", status: "completed", error: null }
            }
          ]
        });
      });
      const api = { remoteAcpConversation };
      const { result, unmount } = renderHook(() => useRemoteAcpContinuation(api, scope));
      await act(async () => {});
      let accepted = false;
      await act(async () => {
        accepted = await result.current.send("continue after the lost response");
      });
      expect(accepted).toBe(true);
      expect(result.current.error).toBeNull();
      expect(result.current.turns.map((turn) => [turn.turnId, turn.status])).toEqual([
        [acceptedTurnId, "completed"]
      ]);
      expect(result.current.pendingMessages).toMatchObject([
        { turnId: acceptedTurnId, status: "accepted" }
      ]);
      expect(remoteAcpConversation).toHaveBeenCalledTimes(4);
      unmount();
    });
  });
}
