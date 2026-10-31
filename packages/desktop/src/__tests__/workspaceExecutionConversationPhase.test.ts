/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coordinatorView } from "./helpers/workspaceExecutionConversationFixture";
import { useWorkspaceExecutionTaskWorkspaceConversation } from "../renderer/task-workspace/useWorkspaceExecutionTaskWorkspaceConversation";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const locator = {
  kind: "workspace",
  connectionProfileId: "profile-1",
  workspaceId: "workspace-1",
  projectId: "project-1",
  canvasId: "canvas-1"
} as const;
const blockRef = "T-001#B-001";
function pendingView(operationId: string) {
  return coordinatorView(operationId, blockRef, [
    {
      version: "planweave.execution-event/v1",
      eventId: `${operationId}:interaction`,
      type: "interaction_required",
      observedAt: "2026-08-30T00:00:01.000Z",
      runSessionId: "SESSION-0001",
      scope: { kind: "block", blockRef },
      source: { target: "remote", operationId, executionAttemptId: "attempt-1", cursor: 1 },
      data: {
        type: "interaction.authentication_required",
        dispatchId: "dispatch-1",
        leaseId: "lease-1",
        executionAttemptId: "attempt-1",
        acpSessionId: "acp-1",
        actionId: "action-1",
        expiresAt: "2030-01-01T00:05:00.000Z",
        agentProfileId: "codex-acp",
        hostInstruction: "Login required"
      }
    }
  ]);
}
function terminalView(operationId: string, phase: "completed" | "failed" | "stopped") {
  const view = coordinatorView(operationId, blockRef);
  return { ...view, session: { ...view.session, phase } };
}
function apiFor(followWorkspaceExecution: ReturnType<typeof vi.fn>) {
  return {
    startWorkspaceExecution: vi.fn(),
    followWorkspaceExecution,
    respondWorkspaceExecution: vi.fn(),
    cancelWorkspaceExecution: vi.fn()
  };
}
afterEach(() => {
  vi.useRealTimers();
  cleanupRendererTestEnvironment();
});

describe("Workspace conversation authoritative phase", () => {
  it.each([
    ["completed", "completed"],
    ["failed", "failed"],
    ["stopped", "cancelled"]
  ] as const)("publishes %s after a pending interaction without a resolved delta", async (phase, expected) => {
    vi.useFakeTimers();
    const terminal = vi.fn();
    const api = apiFor(
      vi
        .fn()
        .mockResolvedValueOnce(pendingView("operation-1"))
        .mockResolvedValue(terminalView("operation-1", phase))
    );
    const { result, unmount } = renderHook(() =>
      useWorkspaceExecutionTaskWorkspaceConversation({
        api,
        locator,
        blockRef,
        operationId: "operation-1",
        scopeKey: "scope-1",
        onTerminal: terminal
      })
    );
    await act(async () => Promise.resolve());
    expect(result.current?.state).toBe("action_required");
    expect(terminal).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(result.current?.state).toBe(expected);
    expect(terminal).toHaveBeenCalledOnce();
    expect(api.followWorkspaceExecution).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(api.followWorkspaceExecution).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("discards a deferred old terminal result after changing operation", async () => {
    let resolveOld!: (value: ReturnType<typeof terminalView>) => void;
    const old = new Promise<ReturnType<typeof terminalView>>((resolve) => {
      resolveOld = resolve;
    });
    const terminal = vi.fn();
    const api = apiFor(
      vi.fn().mockReturnValueOnce(old).mockResolvedValue(pendingView("operation-new"))
    );
    const { result, rerender, unmount } = renderHook(
      ({ operationId }) =>
        useWorkspaceExecutionTaskWorkspaceConversation({
          api,
          locator,
          blockRef,
          operationId,
          scopeKey: "scope-1",
          onTerminal: terminal
        }),
      { initialProps: { operationId: "operation-old" } }
    );
    rerender({ operationId: "operation-new" });
    await act(async () => Promise.resolve());
    expect(result.current).toMatchObject({
      operationId: "operation-new",
      state: "action_required"
    });
    await act(async () => resolveOld(terminalView("operation-old", "completed")));
    expect(result.current).toMatchObject({
      operationId: "operation-new",
      state: "action_required"
    });
    expect(terminal).not.toHaveBeenCalled();
    unmount();
  });
});
