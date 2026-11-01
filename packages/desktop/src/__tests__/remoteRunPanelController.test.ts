/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RemoteBlockExecutionReadModel } from "@planweave-ai/runtime";
import {
  type RemoteRunExecutionLocator,
  useRemoteRunPanelController
} from "../renderer/hooks/useRemoteRunPanelController";
import { createTranslator } from "../renderer/i18n";
import type {
  DesktopWorkspaceExecutionResponse,
  PlanWeaveWorkspaceExecutionApi
} from "../shared/workspaceExecution";
import {
  apiReturning,
  blockItem,
  deferred,
  endpoint,
  locator,
  remoteView,
  renderController,
  runtimeRemoteExecution
} from "./helpers/remoteRunPanelControllerFixtures";

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

  it("retires the previous session when the same block receives a new operation", async () => {
    const fixture = apiReturning(remoteView({ phase: "blocked", includeInteraction: true }));
    const { result, rerender } = renderController({
      api: fixture.api,
      runtime: runtimeRemoteExecution
    });
    await waitFor(() => expect(result.current.viewModel.pendingInteractions).toHaveLength(1));
    act(() => result.current.setConfirmKind("cancel"));
    fixture.follow.mockResolvedValueOnce(
      remoteView({ operationId: "operation-2", sessionId: "SESSION-0002", phase: "completed" })
    );
    rerender({
      executionLocator: locator,
      workItem: blockItem,
      runtime: { ...runtimeRemoteExecution, identity: { operationId: "operation-2" } }
    });
    expect(result.current.confirmKind).toBeNull();
    expect(result.current.viewModel.pendingInteractions).toHaveLength(0);
    expect(fixture.follow).toHaveBeenLastCalledWith({
      locator,
      blockRef: blockItem.blockRef,
      operationId: "operation-2"
    });
    await waitFor(() => expect(result.current.viewModel.phase).toBe("terminal_success"));
    fixture.follow.mockResolvedValueOnce(
      remoteView({ operationId: "operation-2", sessionId: "SESSION-0002", phase: "completed" })
    );
    await act(async () => result.current.refresh());
    expect(fixture.follow).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "SESSION-0002" })
    );
    expect(result.current.viewModel.identity?.operationId).toBe("operation-2");
  });

  it("keeps an accepted start across old and empty Runtime echoes until acknowledgement", async () => {
    const fixture = apiReturning(remoteView({ phase: "completed" }));
    const { result, rerender } = renderController({
      api: fixture.api,
      runtime: runtimeRemoteExecution
    });
    await waitFor(() => expect(result.current.viewModel.phase).toBe("terminal_success"));
    const started = remoteView({ operationId: "operation-2", sessionId: "SESSION-0002" });
    const pendingStart = deferred<DesktopWorkspaceExecutionResponse>();
    fixture.start.mockImplementationOnce(() => pendingStart.promise);
    fixture.follow.mockResolvedValue(started);
    const previousFollowCount = fixture.follow.mock.calls.length;
    let startCall!: Promise<void>;
    act(() => {
      startCall = result.current.dispatch();
      void result.current.refresh();
    });
    expect(fixture.follow).toHaveBeenCalledTimes(previousFollowCount);
    await act(async () => {
      pendingStart.resolve(started);
      await startCall;
    });
    for (const runtime of [
      null,
      runtimeRemoteExecution,
      { ...runtimeRemoteExecution, identity: { operationId: "operation-2" } }
    ]) {
      rerender({ executionLocator: locator, workItem: blockItem, runtime });
      await act(async () => Promise.resolve());
      expect(result.current.viewModel.identity?.operationId).toBe("operation-2");
    }
    await act(async () => result.current.refresh());
    expect(fixture.follow).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "SESSION-0002" })
    );
    rerender({ executionLocator: locator, workItem: blockItem, runtime: null });
    expect(result.current.viewModel.identity).toBeNull();
  });

  it.each([
    "resolve",
    "reject"
  ] as const)("ignores an older refresh %s within the same operation", async (settlement) => {
    const fixture = apiReturning(remoteView());
    const { result } = renderController({ api: fixture.api, runtime: runtimeRemoteExecution });
    await waitFor(() => expect(result.current.viewModel.identity).not.toBeNull());
    const old = deferred<DesktopWorkspaceExecutionResponse>();
    fixture.follow
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(remoteView({ phase: "completed" }));
    let oldCall!: Promise<void>;
    act(() => {
      oldCall = result.current.refresh();
    });
    await act(async () => result.current.refresh());
    expect(result.current.viewModel.phase).toBe("terminal_success");
    await act(async () => {
      settlement === "resolve"
        ? old.resolve(remoteView({ phase: "running" }))
        : old.reject(new Error("obsolete refresh"));
      await oldCall;
    });
    expect(result.current.viewModel.phase).toBe("terminal_success");
    expect(result.current.actionError).toBeNull();
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
        decision: "select_option",
        optionId: "write-once",
        actionId: request.actionId,
        dispatchId: request.dispatchId,
        leaseId: request.leaseId,
        executionAttemptId: request.executionAttemptId,
        acpSessionId: request.acpSessionId
      })
    );
    await act(async () => result.current.cancel("stop"));

    expect(fixture.respond).toHaveBeenCalledOnce();
    expect(fixture.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        response: {
          type: "interaction.permission_response",
          decision: "select_option",
          optionId: "write-once",
          actionId: request.actionId,
          dispatchId: request.dispatchId,
          leaseId: request.leaseId,
          executionAttemptId: request.executionAttemptId,
          acpSessionId: request.acpSessionId
        }
      })
    );
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
    rerender({
      executionLocator: { ...locator, canvasId: "next" },
      workItem: blockItem,
      runtime: runtimeRemoteExecution
    });

    await waitFor(() =>
      expect(result.current.viewModel.identity?.operationId).toBe("operation-new")
    );
    resolveOld(remoteView({ operationId: "operation-old" }));
    await act(async () => Promise.resolve());

    expect(result.current.viewModel.identity?.operationId).toBe("operation-new");
  });
  it.each([
    "resolve",
    "reject"
  ] as const)("isolates pending dispatch and its late %s after block navigation", async (settlement) => {
    const old = deferred<DesktopWorkspaceExecutionResponse>();
    const next = deferred<DesktopWorkspaceExecutionResponse>();
    const fixture = apiReturning(remoteView());
    fixture.start
      .mockImplementationOnce(() => old.promise)
      .mockImplementationOnce(() => next.promise);
    const { result, rerender } = renderController({ api: fixture.api });
    let oldCall!: Promise<void>;
    act(() => {
      oldCall = result.current.dispatch();
      void result.current.dispatch();
      result.current.setConfirmKind("cancel");
    });
    expect(result.current.actionInFlight).toBe("dispatch");
    expect(fixture.start).toHaveBeenCalledTimes(1);
    rerender({
      executionLocator: locator,
      workItem: { ...blockItem, blockRef: "T-1#B-2" },
      runtime: null
    });
    expect(result.current.actionInFlight).toBeNull();
    expect(result.current.confirmKind).toBeNull();
    expect(result.current.actionError).toBeNull();
    expect(result.current.loading).toBe(false);
    let nextCall!: Promise<void>;
    act(() => {
      nextCall = result.current.dispatch();
    });
    expect(fixture.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ blockRef: "T-1#B-2" })
    );
    await act(async () => {
      settlement === "resolve"
        ? old.resolve(remoteView({ operationId: "old" }))
        : old.reject(new Error("old failure"));
      await oldCall;
    });
    expect(result.current.actionInFlight).toBe("dispatch");
    expect(result.current.actionError).toBeNull();
    expect(result.current.viewModel.identity).toBeNull();
    await act(async () => {
      next.resolve(remoteView({ operationId: "new", blockRef: "T-1#B-2" }));
      await nextCall;
    });
    expect(result.current.actionInFlight).toBeNull();
    expect(result.current.viewModel.identity?.operationId).toBe("new");
  });

  it.each([
    { kind: "follow", settlement: "resolve", boundary: "profile" },
    { kind: "follow", settlement: "reject", boundary: "canvas" },
    { kind: "cancel", settlement: "resolve", boundary: "canvas" },
    { kind: "cancel", settlement: "reject", boundary: "profile" }
  ] as const)("keeps B busy after A $kind $settlement across $boundary", async ({
    kind,
    settlement,
    boundary
  }) => {
    const old = deferred<DesktopWorkspaceExecutionResponse>();
    const next = deferred<DesktopWorkspaceExecutionResponse>();
    const fixture = apiReturning(remoteView());
    const { result, rerender } = renderController({
      api: fixture.api,
      runtime: runtimeRemoteExecution
    });
    await waitFor(() => expect(result.current.viewModel.identity).not.toBeNull());
    const method = kind === "follow" ? fixture.follow : fixture.cancel;
    method.mockImplementationOnce(() => old.promise);
    let oldCall!: Promise<void>;
    act(() => {
      oldCall = kind === "follow" ? result.current.refresh() : result.current.cancel("stop A");
    });
    expect(kind === "follow" ? result.current.loading : result.current.actionInFlight).toBe(
      kind === "follow" ? true : "cancel"
    );
    fixture.follow.mockImplementationOnce(() => next.promise);
    rerender({
      executionLocator: {
        ...locator,
        ...(boundary === "profile" ? { operatorProfileId: "profile-B" } : { canvasId: "B" })
      },
      workItem: blockItem,
      runtime: runtimeRemoteExecution
    });
    expect(result.current.actionInFlight).toBeNull();
    expect(result.current.actionError).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => {
      settlement === "resolve"
        ? old.resolve(remoteView({ operationId: "old" }))
        : old.reject(new Error("old failure"));
      await oldCall;
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.viewModel.identity?.operationId).not.toBe("old");
    expect(result.current.actionError).toBeNull();
    await act(async () => {
      next.resolve(remoteView({ operationId: "B" }));
      await next.promise;
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.viewModel.identity?.operationId).toBe("B");
    expect(fixture.cancel).toHaveBeenCalledTimes(kind === "cancel" ? 1 : 0);
  });

  it("retires pending work on unmount without cancelling the operation", async () => {
    const pending = deferred<DesktopWorkspaceExecutionResponse>();
    const fixture = apiReturning(remoteView());
    fixture.start.mockImplementationOnce(() => pending.promise);
    const { result, unmount } = renderController({ api: fixture.api });
    let call!: Promise<void>;
    act(() => {
      call = result.current.dispatch();
    });
    unmount();
    await act(async () => {
      pending.reject(new Error("late failure"));
      await call;
    });
    expect(fixture.cancel).not.toHaveBeenCalled();
  });

  it("clears follow loading and current errors on navigation to an idle block", async () => {
    const pending = deferred<DesktopWorkspaceExecutionResponse>();
    const fixture = apiReturning(remoteView());
    fixture.follow.mockImplementationOnce(() => pending.promise);
    const { result, rerender } = renderHook(
      ({ blockRef, active }) =>
        useRemoteRunPanelController({
          workItem: { ...blockItem, blockRef },
          executionLocator: locator,
          executionApi: fixture.api,
          runtimeRemoteExecution: active ? runtimeRemoteExecution : null,
          agentEndpoints: [endpoint],
          selectedAgentEndpointId: endpoint.id,
          open: true,
          t: createTranslator("en")
        }),
      { initialProps: { blockRef: blockItem.blockRef, active: true } }
    );
    expect(result.current.loading).toBe(true);
    rerender({ blockRef: "T-1#B-2", active: false });
    expect(result.current.loading).toBe(false);
    expect(result.current.actionInFlight).toBeNull();
    expect(fixture.follow).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.reject(new Error("A failure"));
      await pending.promise.catch(() => undefined);
    });
    expect(result.current.actionError).toBeNull();
    fixture.start.mockRejectedValueOnce(new Error("B failure"));
    await act(async () => result.current.dispatch());
    expect(result.current.actionError).toBe("B failure");
    rerender({ blockRef: "T-1#B-3", active: false });
    expect(result.current.actionError).toBeNull();
  });
  it.each([
    "resolve",
    "reject"
  ] as const)("keeps the new operation loading and its error after an old follow %s", async (settlement) => {
    const fixture = apiReturning(remoteView());
    const { result, rerender } = renderController({
      api: fixture.api,
      runtime: runtimeRemoteExecution
    });
    await waitFor(() => expect(result.current.viewModel.identity).not.toBeNull());
    const old = deferred<DesktopWorkspaceExecutionResponse>();
    const current = deferred<DesktopWorkspaceExecutionResponse>();
    fixture.follow
      .mockImplementationOnce(() => old.promise)
      .mockImplementationOnce(() => current.promise);
    let oldCall!: Promise<void>;
    act(() => {
      oldCall = result.current.refresh();
    });
    rerender({
      executionLocator: locator,
      workItem: blockItem,
      runtime: { ...runtimeRemoteExecution, identity: { operationId: "operation-2" } }
    });
    expect(fixture.follow).toHaveBeenLastCalledWith({
      locator,
      blockRef: blockItem.blockRef,
      operationId: "operation-2"
    });
    await act(async () => {
      settlement === "resolve"
        ? old.resolve(remoteView())
        : old.reject(new Error("old follow failure"));
      await oldCall;
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.actionError).toBeNull();
    expect(result.current.viewModel.identity).toBeNull();
    expect(result.current.viewModel.pendingInteractions).toHaveLength(0);
    expect(result.current.viewModel.events).toHaveLength(0);
    await act(async () => {
      current.reject(new Error("new observe failure"));
      await current.promise.catch(() => undefined);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.actionError).toBe("new observe failure");
    fixture.follow.mockResolvedValue(
      remoteView({ operationId: "operation-2", sessionId: "SESSION-0002" })
    );
    await act(async () => result.current.refresh());
    expect(fixture.follow).toHaveBeenLastCalledWith({
      locator,
      blockRef: blockItem.blockRef,
      operationId: "operation-2"
    });
    expect(result.current.actionError).toBeNull();
    await act(async () => result.current.refresh());
    expect(fixture.follow).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "SESSION-0002" })
    );
  });

  it.each([
    { kind: "cancel", settlement: "resolve", currentState: "busy" },
    { kind: "cancel", settlement: "reject", currentState: "busy" },
    { kind: "respond", settlement: "resolve", currentState: "busy" },
    { kind: "respond", settlement: "reject", currentState: "busy" },
    { kind: "cancel", settlement: "resolve", currentState: "error" },
    { kind: "cancel", settlement: "reject", currentState: "error" },
    { kind: "respond", settlement: "resolve", currentState: "error" },
    { kind: "respond", settlement: "reject", currentState: "error" }
  ] as const)("preserves new operation $currentState and confirmation after old $kind $settlement", async ({
    kind,
    settlement,
    currentState
  }) => {
    const fixture = apiReturning(remoteView({ phase: "blocked", includeInteraction: true }));
    const { result, rerender } = renderController({
      api: fixture.api,
      runtime: runtimeRemoteExecution
    });
    await waitFor(() => expect(result.current.viewModel.pendingInteractions).toHaveLength(1));
    const old = deferred<DesktopWorkspaceExecutionResponse>();
    const current = deferred<DesktopWorkspaceExecutionResponse>();
    const method = kind === "cancel" ? fixture.cancel : fixture.respond;
    method.mockImplementationOnce(() => old.promise);
    let oldCall!: Promise<void>;
    act(() => {
      oldCall =
        kind === "cancel"
          ? result.current.cancel("stop old")
          : result.current.answerInteraction({
              type: "interaction.permission_response",
              decision: "select_option",
              optionId: "write-once",
              actionId: "action-1",
              dispatchId: "dispatch-1",
              leaseId: "lease-1",
              executionAttemptId: "attempt-1",
              acpSessionId: "acp-session-1"
            });
    });
    fixture.follow.mockResolvedValueOnce(
      remoteView({ operationId: "operation-2", sessionId: "SESSION-0002", phase: "blocked" })
    );
    rerender({
      executionLocator: locator,
      workItem: blockItem,
      runtime: { ...runtimeRemoteExecution, identity: { operationId: "operation-2" } }
    });
    await waitFor(() => expect(result.current.viewModel.identity?.operationId).toBe("operation-2"));
    fixture.cancel.mockImplementationOnce(() => current.promise);
    let currentCall!: Promise<void>;
    act(() => {
      result.current.setConfirmKind("cancel");
      currentCall = result.current.cancel("stop new");
    });
    expect(fixture.cancel).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "SESSION-0002", reason: "stop new" })
    );
    if (currentState === "error") {
      await act(async () => {
        current.reject(new Error("new cancel failure"));
        await currentCall;
      });
    }
    await act(async () => {
      settlement === "resolve"
        ? old.resolve(remoteView({ phase: "stopped" }))
        : old.reject(new Error("old action failure"));
      await oldCall;
    });
    expect(result.current.viewModel.identity?.operationId).toBe("operation-2");
    expect(result.current.viewModel.phase).toBe("action_required");
    expect(result.current.confirmKind).toBe("cancel");
    expect(result.current.actionInFlight).toBe(currentState === "busy" ? "cancel" : null);
    expect(result.current.actionError).toBe(currentState === "error" ? "new cancel failure" : null);
    if (currentState === "busy") {
      await act(async () => {
        current.resolve(
          remoteView({ operationId: "operation-2", sessionId: "SESSION-0002", phase: "stopped" })
        );
        await currentCall;
      });
      expect(result.current.actionInFlight).toBeNull();
      expect(result.current.confirmKind).toBeNull();
      expect(result.current.viewModel.phase).toBe("terminal_cancelled");
    }
  });

  it.each([
    {
      boundary: "workspace connection",
      from: {
        kind: "workspace",
        connectionProfileId: "connection-A",
        workspaceId: "workspace-A",
        projectId: "project-1",
        canvasId: "default"
      },
      to: {
        kind: "workspace",
        connectionProfileId: "connection-B",
        workspaceId: "workspace-A",
        projectId: "project-1",
        canvasId: "default"
      }
    },
    {
      boundary: "workspace ID",
      from: {
        kind: "workspace",
        connectionProfileId: "connection-A",
        workspaceId: "workspace-A",
        projectId: "project-1",
        canvasId: "default"
      },
      to: {
        kind: "workspace",
        connectionProfileId: "connection-A",
        workspaceId: "workspace-B",
        projectId: "project-1",
        canvasId: "default"
      }
    },
    {
      boundary: "owner to workspace",
      from: locator,
      to: {
        kind: "workspace",
        connectionProfileId: "connection-A",
        workspaceId: "workspace-A",
        projectId: "project-1",
        canvasId: "default"
      }
    },
    {
      boundary: "workspace to owner",
      from: {
        kind: "workspace",
        connectionProfileId: "connection-A",
        workspaceId: "workspace-A",
        projectId: "project-1",
        canvasId: "default"
      },
      to: locator
    }
  ] satisfies {
    boundary: string;
    from: RemoteRunExecutionLocator;
    to: RemoteRunExecutionLocator;
  }[])("observes the current authority after changing $boundary with the same operation ID", async ({
    from,
    to
  }) => {
    const old = deferred<DesktopWorkspaceExecutionResponse>();
    const fixture = apiReturning(remoteView());
    fixture.follow
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(remoteView({ sessionId: "SESSION-0002", phase: "completed" }));
    const { result, rerender } = renderController({
      api: fixture.api,
      runtime: runtimeRemoteExecution,
      executionLocator: from
    });
    rerender({ executionLocator: to, workItem: blockItem, runtime: runtimeRemoteExecution });
    expect(fixture.follow).toHaveBeenLastCalledWith({
      locator: to,
      blockRef: blockItem.blockRef,
      operationId: "operation-1"
    });
    await waitFor(() => expect(result.current.viewModel.phase).toBe("terminal_success"));
    await act(async () => {
      old.reject(new Error("previous authority unavailable"));
      await old.promise.catch(() => undefined);
    });
    expect(result.current.actionError).toBeNull();
    expect(result.current.viewModel.phase).toBe("terminal_success");
    await act(async () => result.current.refresh());
    expect(fixture.follow).toHaveBeenLastCalledWith(
      expect.objectContaining({ locator: to, sessionId: "SESSION-0002" })
    );
  });

  it("keeps an initially empty Runtime start until a different authoritative operation replaces it", async () => {
    const fixture = apiReturning(
      remoteView({ operationId: "operation-started", sessionId: "SESSION-0002" })
    );
    const { result, rerender } = renderController({ api: fixture.api });
    await act(async () => result.current.dispatch());
    rerender({ executionLocator: locator, workItem: blockItem, runtime: null });
    expect(result.current.viewModel.identity?.operationId).toBe("operation-started");
    fixture.follow.mockResolvedValueOnce(
      remoteView({
        operationId: "operation-authoritative",
        sessionId: "SESSION-0003",
        phase: "completed"
      })
    );
    rerender({
      executionLocator: locator,
      workItem: blockItem,
      runtime: { ...runtimeRemoteExecution, identity: { operationId: "operation-authoritative" } }
    });
    expect(fixture.follow).toHaveBeenLastCalledWith({
      locator,
      blockRef: blockItem.blockRef,
      operationId: "operation-authoritative"
    });
    await waitFor(() => expect(result.current.viewModel.phase).toBe("terminal_success"));
    expect(result.current.viewModel.identity?.operationId).toBe("operation-authoritative");
    const followCount = fixture.follow.mock.calls.length;
    act(() => result.current.setConfirmKind("cancel"));
    rerender({
      executionLocator: locator,
      workItem: blockItem,
      runtime: {
        ...runtimeRemoteExecution,
        identity: { operationId: "operation-authoritative" },
        source: { ...runtimeRemoteExecution.source, revision: "rev-updated" }
      }
    });
    expect(fixture.follow).toHaveBeenCalledTimes(followCount);
    expect(result.current.confirmKind).toBe("cancel");
    expect(result.current.viewModel.phase).toBe("terminal_success");
  });
});

describe("Remote Run runtime refresh ownership", () => {
  it.each([
    false,
    true
  ])("reads the current runtime before following a changed operation (initial=%s)", async (hasInitial) => {
    const fixture = apiReturning(remoteView());
    const next: RemoteBlockExecutionReadModel = {
      ...runtimeRemoteExecution,
      controlPlane: "owner",
      identity: { operationId: "operation-2" }
    };
    const reader = vi.fn().mockResolvedValue(next);
    const { result, rerender } = renderController({
      api: fixture.api,
      runtime: hasInitial ? { ...runtimeRemoteExecution, controlPlane: "owner" } : null,
      refreshRuntimeRemoteExecution: reader
    });
    if (hasInitial)
      await waitFor(() =>
        expect(result.current.viewModel.identity?.operationId).toBe("operation-1")
      );
    fixture.follow.mockClear();
    await act(async () => result.current.refresh());
    expect(reader).toHaveBeenCalledOnce();
    expect(fixture.follow).not.toHaveBeenCalled();
    fixture.follow.mockResolvedValue(
      remoteView({ operationId: "operation-2", sessionId: "SESSION-0002" })
    );
    rerender({ executionLocator: locator, workItem: blockItem, runtime: next });
    await waitFor(() => expect(result.current.viewModel.identity?.operationId).toBe("operation-2"));
    expect(fixture.follow).toHaveBeenCalledWith({
      locator,
      blockRef: blockItem.blockRef,
      operationId: "operation-2"
    });
    await act(async () => result.current.refresh());
    expect(fixture.follow).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "SESSION-0002" })
    );
  });

  it.each([
    "resolve",
    "reject"
  ] as const)("retires a runtime reader that later %s after authority changes", async (completion) => {
    const fixture = apiReturning(remoteView());
    const pending = deferred<RemoteBlockExecutionReadModel | null>();
    const reader = vi.fn(() => pending.promise);
    const { result, rerender } = renderController({
      api: fixture.api,
      runtime: { ...runtimeRemoteExecution, controlPlane: "owner" },
      refreshRuntimeRemoteExecution: reader
    });
    await waitFor(() => expect(result.current.viewModel.identity?.operationId).toBe("operation-1"));
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = result.current.refresh();
    });
    expect(reader).toHaveBeenCalledOnce();
    fixture.follow.mockResolvedValue(remoteView({ sessionId: "SESSION-0009" }));
    rerender({
      executionLocator: { ...locator, operatorProfileId: "different-authority" },
      workItem: blockItem,
      runtime: { ...runtimeRemoteExecution, controlPlane: "owner" }
    });
    await waitFor(() => expect(result.current.viewModel.identity?.operationId).toBe("operation-1"));
    fixture.follow.mockClear();
    await act(async () => {
      if (completion === "resolve")
        pending.resolve({ ...runtimeRemoteExecution, controlPlane: "owner" });
      else pending.reject(new Error("retired runtime reader"));
      await refreshing;
    });
    expect(fixture.follow).not.toHaveBeenCalled();
    expect(result.current.actionError).not.toBe("retired runtime reader");
  });
});

it("shows a current runtime reader failure without following the cached session", async () => {
  const fixture = apiReturning(remoteView());
  const { result } = renderController({
    api: fixture.api,
    runtime: { ...runtimeRemoteExecution, controlPlane: "owner" },
    refreshRuntimeRemoteExecution: vi.fn().mockRejectedValue(new Error("runtime read failed"))
  });
  await waitFor(() => expect(result.current.viewModel.identity?.operationId).toBe("operation-1"));
  fixture.follow.mockClear();
  await act(async () => result.current.refresh());
  expect(result.current.actionError).toBe("runtime read failed");
  expect(fixture.follow).not.toHaveBeenCalled();
});
