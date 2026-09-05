/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import type {
  RemoteEventReplay,
  RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRemoteTaskWorkspaceConversation } from "../renderer/task-workspace/useRemoteTaskWorkspaceConversation";
import { remoteTaskWorkspaceConversationSource } from "../renderer/task-workspace/remoteTaskWorkspaceConversationSource";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function operationObservation(
  operationId: string,
  state: RemoteOperationObservation["state"] = "running",
  executionAttemptId = "attempt-001"
): RemoteOperationObservation {
  return {
    operationId,
    projectId: "project-1",
    canvasId: "default",
    blockRef: "T-001#B-001",
    state,
    dispatchId: "dispatch-1",
    executionAttemptId,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:01:00.000Z",
    attempt: {
      executionAttemptId,
      dispatchId: "dispatch-1",
      status: state === "running" ? "running" : state,
      hostId: "host-1",
      leaseId: "lease-1",
      stateVersion: 1
    },
    dispatchStatus: state === "running" ? "running" : undefined,
    runtime: {
      ref: "T-001#B-001",
      status: state === "completed" ? "completed" : state === "running" ? "in_progress" : state
    }
  };
}

describe("remote Task Workspace conversation", () => {
  it("projects the authoritative initial state before effects run", () => {
    const api = {
      observe: vi.fn(),
      replay: vi.fn()
    };
    let firstState: string | undefined;
    function FirstRenderProbe() {
      firstState = useRemoteTaskWorkspaceConversation({
        api,
        blockRef: "T-001#B-001",
        cacheScopeKey: "owner:profile-001",
        initialState: "completed",
        operationId: "operation-owner-001",
        onTerminal: vi.fn()
      })?.state;
      return null;
    }

    renderToString(<FirstRenderProbe />);

    expect(firstState).toBe("completed");
    expect(api.observe).not.toHaveBeenCalled();
  });

  it("observes attempt identity before deciding whether a terminal operation may replay", async () => {
    let resolveObservation!: (value: RemoteOperationObservation) => void;
    const observationPromise = new Promise<RemoteOperationObservation>((resolve) => {
      resolveObservation = resolve;
    });
    const api = {
      observe: vi.fn(() => observationPromise),
      replay: vi.fn(async () => {
        throw new Error("operator_resource_not_found");
      }),
      replayTerminal: false
    };
    const onTerminal = vi.fn();

    const { result } = renderHook(() =>
      useRemoteTaskWorkspaceConversation({
        api,
        blockRef: "T-001#B-001",
        initialState: "running",
        operationId: "operation-owner-001",
        onTerminal
      })
    );

    expect(result.current?.state).toBe("running");
    expect(api.replay).not.toHaveBeenCalled();
    resolveObservation(operationObservation("operation-owner-001", "completed"));
    await waitFor(() => expect(result.current?.state).toBe("completed"));
    expect(result.current?.error).toBeNull();
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it("loads a live ACP conversation through a transport-neutral operation source", async () => {
    const observation = operationObservation("operation-owner-001");
    const replay = {
      eventProtocolVersion: 1,
      executionAttemptId: "attempt-001",
      afterCursor: 0,
      cursor: 0,
      highWatermark: 0,
      hasMore: false,
      events: [],
      diagnostics: []
    } as RemoteEventReplay;
    const api = {
      observe: vi.fn(async () => observation),
      replay: vi.fn(async () => replay),
      subscribe: vi.fn(() => () => undefined)
    };
    const onTerminal = vi.fn();

    const { result } = renderHook(() =>
      useRemoteTaskWorkspaceConversation({
        api,
        blockRef: "T-001#B-001",
        operationId: "operation-owner-001",
        onTerminal
      })
    );

    await waitFor(() => expect(api.observe).toHaveBeenCalledWith("operation-owner-001"));
    expect(api.replay).toHaveBeenCalledWith("operation-owner-001", 0);
    await waitFor(() =>
      expect(result.current).toMatchObject({
        error: null,
        operationId: "operation-owner-001",
        state: "running"
      })
    );
  });

  it("routes Owner live operations through operator control without a collaboration session", async () => {
    const observation = operationObservation("operation-owner-001");
    const replay = {
      eventProtocolVersion: 1,
      executionAttemptId: "attempt-001",
      afterCursor: 0,
      cursor: 0,
      highWatermark: 0,
      hasMore: false,
      events: [],
      diagnostics: []
    } as RemoteEventReplay;
    const collaborationApi = {
      observeCollaborationRemoteOperation: vi.fn(async () => observation),
      replayCollaborationRemoteOperationEvents: vi.fn(async () => replay),
      onCollaborationObserverSignal: vi.fn(() => () => undefined)
    };
    const operatorApi = {
      observeOwnerFleetRemoteOperation: vi.fn(async () => observation),
      replayOwnerFleetRemoteOperationEvents: vi.fn(async () => replay)
    };
    const source = remoteTaskWorkspaceConversationSource({
      controlPlane: "owner",
      collaborationApi,
      operatorApi,
      operatorProfileId: "operator-profile-001"
    });

    await expect(source.observe("operation-owner-001")).resolves.toBe(observation);
    await expect(source.replay("operation-owner-001", 0)).resolves.toBe(replay);
    expect(operatorApi.observeOwnerFleetRemoteOperation).toHaveBeenCalledWith({
      profileId: "operator-profile-001",
      operationId: "operation-owner-001"
    });
    expect(collaborationApi.observeCollaborationRemoteOperation).not.toHaveBeenCalled();
    expect(collaborationApi.replayCollaborationRemoteOperationEvents).not.toHaveBeenCalled();
  });

  it("projects v2 Runner bodies and engine evidence with replay identity and timestamps", async () => {
    const api = {
      observe: vi.fn(async () => operationObservation("operation-v2", "running", "attempt-v2")),
      replay: vi.fn(async () => ({
        eventProtocolVersion: 2 as const,
        executionAttemptId: "attempt-v2",
        afterCursor: 0,
        cursor: 2,
        highWatermark: 2,
        hasMore: false,
        diagnostics: [{ code: "remote_acp_event_retention_gap" as const, droppedThroughCursor: 4 }],
        events: [
          {
            eventVersion: 2 as const,
            cursor: 1,
            sourceSequence: 41,
            timestamp: "2030-01-01T00:00:01.000Z",
            fragment: {
              kind: "runner_body" as const,
              body: {
                kind: "message" as const,
                role: "assistant" as const,
                messageId: "message-v2",
                chunk: false,
                content: "v2 hello",
                redaction: { classes: [], replaced: 0 }
              }
            }
          },
          {
            eventVersion: 2 as const,
            cursor: 2,
            sourceSequence: 42,
            timestamp: "2030-01-01T00:00:02.000Z",
            fragment: {
              kind: "engine_evidence" as const,
              evidence: {
                kind: "usage_snapshot" as const,
                usage: {
                  semantics: "cumulative_session_total" as const,
                  totalTokens: 13,
                  inputTokens: 8,
                  outputTokens: 5,
                  thoughtTokens: null,
                  cachedReadTokens: null,
                  cachedWriteTokens: null
                }
              }
            }
          }
        ]
      }))
    };

    const { result } = renderHook(() =>
      useRemoteTaskWorkspaceConversation({
        api,
        blockRef: "T-001#B-001",
        operationId: "operation-v2",
        onTerminal: vi.fn()
      })
    );

    await waitFor(() => expect(result.current?.timeline).toHaveLength(1));
    expect(result.current).toMatchObject({
      eventProtocolVersion: 2,
      executionAttemptId: "attempt-v2",
      replayDiagnostics: [{ code: "remote_acp_event_retention_gap", droppedThroughCursor: 4 }]
    });
    expect(result.current?.timeline).toEqual([
      expect.objectContaining({
        content: "v2 hello",
        timestamp: "2030-01-01T00:00:01.000Z"
      })
    ]);
    expect(result.current?.telemetry?.cumulativeUsage?.totalTokens).toBe(13);
    expect(result.current?.telemetry?.currentContext).toBeNull();
  });

  it("retains both v1 retention and degraded replay diagnostics", async () => {
    const api = {
      observe: vi.fn(async () =>
        operationObservation("operation-v1-degraded", "running", "attempt-v1")
      ),
      replay: vi.fn(async () => ({
        eventProtocolVersion: 1 as const,
        executionAttemptId: "attempt-v1",
        afterCursor: 0,
        cursor: 1,
        highWatermark: 1,
        hasMore: false,
        events: [{ cursor: 1, kind: "agent_message" as const, text: "legacy" }],
        diagnostics: [
          { code: "remote_acp_event_retention_gap" as const, droppedThroughCursor: 3 },
          { code: "remote_acp_event_contract_degraded" as const }
        ]
      }))
    };

    const { result } = renderHook(() =>
      useRemoteTaskWorkspaceConversation({
        api,
        blockRef: "T-001#B-001",
        operationId: "operation-v1-degraded",
        onTerminal: vi.fn()
      })
    );

    await waitFor(() => expect(result.current?.timeline).toHaveLength(1));
    expect(result.current).toMatchObject({
      eventProtocolVersion: 1,
      executionAttemptId: "attempt-v1",
      replayDiagnostics: [
        { code: "remote_acp_event_retention_gap", droppedThroughCursor: 3 },
        { code: "remote_acp_event_contract_degraded" }
      ]
    });
  });

  it("refreshes the disk-backed run at terminal without replaying a retired live operation", async () => {
    let refresh: (() => void) | null = null;
    const observation = operationObservation("operation-owner-001", "completed");
    const api = {
      observe: vi.fn(async () => observation),
      replay: vi.fn(async () => {
        throw new Error("operator_resource_not_found");
      }),
      replayTerminal: false,
      subscribe: vi.fn((listener: () => void) => {
        refresh = listener;
        return () => undefined;
      })
    };
    const onTerminal = vi.fn();

    const { result } = renderHook(() =>
      useRemoteTaskWorkspaceConversation({
        api,
        blockRef: "T-001#B-001",
        operationId: "operation-owner-001",
        onTerminal
      })
    );

    await waitFor(() => expect(onTerminal).toHaveBeenCalledOnce());
    expect(api.replay).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ error: null, state: "completed" });
    act(() => refresh?.());
    await act(async () => Promise.resolve());
    expect(api.observe).toHaveBeenCalledOnce();
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it("shows an authoritative projected terminal state while observe calibrates it", async () => {
    let resolveObservation!: (value: RemoteOperationObservation) => void;
    const api = {
      observe: vi.fn(
        () =>
          new Promise<RemoteOperationObservation>((resolve) => {
            resolveObservation = resolve;
          })
      ),
      replay: vi.fn(async () => {
        throw new Error("retired operation must not replay");
      }),
      replayTerminal: false
    };
    const onTerminal = vi.fn();

    const { result } = renderHook(() =>
      useRemoteTaskWorkspaceConversation({
        api,
        blockRef: "T-001#B-001",
        initialState: "completed",
        operationId: "operation-owner-001",
        onTerminal
      })
    );

    expect(result.current?.state).toBe("completed");
    await waitFor(() => expect(api.observe).toHaveBeenCalledOnce());
    expect(onTerminal).not.toHaveBeenCalled();
    resolveObservation(operationObservation("operation-owner-001", "completed"));
    await waitFor(() => expect(onTerminal).toHaveBeenCalledOnce());
    expect(api.replay).not.toHaveBeenCalled();
  });

  it("replays only events after the latest cached cursor on refresh", async () => {
    let refresh: (() => void) | null = null;
    const api = {
      observe: vi.fn(async () => operationObservation("operation-workspace-001")),
      replay: vi.fn(async (_operationId: string, afterCursor: number) =>
        afterCursor === 0
          ? {
              eventProtocolVersion: 1 as const,
              executionAttemptId: "attempt-001",
              afterCursor,
              cursor: 1,
              highWatermark: 1,
              hasMore: false,
              events: [{ cursor: 1, kind: "agent_message" as const, text: "first" }],
              diagnostics: []
            }
          : {
              eventProtocolVersion: 1 as const,
              executionAttemptId: "attempt-001",
              afterCursor,
              cursor: 2,
              highWatermark: 2,
              hasMore: false,
              events: [{ cursor: 2, kind: "agent_message" as const, text: "second" }],
              diagnostics: []
            }
      ),
      subscribe: vi.fn((listener: () => void) => {
        refresh = listener;
        return () => undefined;
      })
    };

    const { result } = renderHook(() =>
      useRemoteTaskWorkspaceConversation({
        api,
        blockRef: "T-001#B-001",
        operationId: "operation-workspace-001",
        onTerminal: vi.fn()
      })
    );

    await waitFor(() => expect(result.current?.timeline).toHaveLength(1));
    act(() => refresh?.());
    await waitFor(() => expect(api.replay).toHaveBeenCalledWith("operation-workspace-001", 1));
    await waitFor(() =>
      expect(result.current?.timeline).toEqual([
        expect.objectContaining({ content: "firstsecond" })
      ])
    );
  });

  it("keeps bounded per-operation caches while reloading on identity changes", async () => {
    const api = {
      observe: vi.fn(async (operationId: string) =>
        operationObservation(operationId, "running", `attempt-${operationId}`)
      ),
      replay: vi.fn(async (operationId: string, afterCursor: number) => ({
        eventProtocolVersion: 1 as const,
        executionAttemptId: `attempt-${operationId}`,
        afterCursor,
        cursor: 1,
        highWatermark: 1,
        hasMore: false,
        events: [
          {
            cursor: 1,
            kind: "agent_message" as const,
            text: operationId
          }
        ],
        diagnostics: []
      }))
    };

    const { result, rerender } = renderHook(
      ({ operationId }: { operationId: string }) =>
        useRemoteTaskWorkspaceConversation({
          api,
          blockRef: "T-001#B-001",
          operationId,
          onTerminal: vi.fn()
        }),
      { initialProps: { operationId: "operation-001" } }
    );

    await waitFor(() =>
      expect(result.current?.timeline[0]).toMatchObject({ content: "operation-001" })
    );
    rerender({ operationId: "operation-002" });
    expect(result.current?.timeline).toEqual([]);
    await waitFor(() => expect(api.replay).toHaveBeenCalledWith("operation-002", 0));
    await waitFor(() =>
      expect(result.current?.timeline).toEqual([
        expect.objectContaining({ content: "operation-002" })
      ])
    );
    rerender({ operationId: "operation-001" });
    await waitFor(() => expect(api.replay).toHaveBeenCalledWith("operation-001", 1));
    expect(result.current?.timeline).toEqual([
      expect.objectContaining({ content: "operation-001" })
    ]);
  });

  it("does not reuse an operation cache across authority scopes", async () => {
    const replay = vi
      .fn()
      .mockResolvedValueOnce({
        eventProtocolVersion: 1,
        executionAttemptId: "attempt-001",
        afterCursor: 0,
        cursor: 1,
        highWatermark: 1,
        hasMore: false,
        events: [{ cursor: 1, kind: "agent_message", text: "scope-a" }],
        diagnostics: []
      })
      .mockResolvedValueOnce({
        eventProtocolVersion: 1,
        executionAttemptId: "attempt-001",
        afterCursor: 0,
        cursor: 1,
        highWatermark: 1,
        hasMore: false,
        events: [{ cursor: 1, kind: "agent_message", text: "scope-b" }],
        diagnostics: []
      });
    const api = {
      observe: vi.fn(async () => operationObservation("operation-shared-id")),
      replay
    };

    const { result, rerender } = renderHook(
      ({ cacheScopeKey }: { cacheScopeKey: string }) =>
        useRemoteTaskWorkspaceConversation({
          api,
          blockRef: "T-001#B-001",
          cacheScopeKey,
          operationId: "operation-shared-id",
          onTerminal: vi.fn()
        }),
      { initialProps: { cacheScopeKey: "server-a/profile-a/workspace-a" } }
    );

    await waitFor(() => expect(result.current?.timeline[0]).toMatchObject({ content: "scope-a" }));
    rerender({ cacheScopeKey: "server-b/profile-b/workspace-b" });
    expect(result.current?.timeline).toEqual([]);
    await waitFor(() => expect(replay).toHaveBeenNthCalledWith(2, "operation-shared-id", 0));
    await waitFor(() =>
      expect(result.current?.timeline).toEqual([expect.objectContaining({ content: "scope-b" })])
    );
  });

  it("resets cached events before replay when the observed attempt changes", async () => {
    let refresh: (() => void) | null = null;
    const replay = vi
      .fn()
      .mockResolvedValueOnce({
        eventProtocolVersion: 1,
        executionAttemptId: "attempt-001",
        afterCursor: 0,
        cursor: 2,
        highWatermark: 2,
        hasMore: false,
        events: [{ cursor: 2, kind: "agent_message", text: "stale" }],
        diagnostics: []
      })
      .mockResolvedValueOnce({
        eventProtocolVersion: 1,
        executionAttemptId: "attempt-002",
        afterCursor: 0,
        cursor: 1,
        highWatermark: 1,
        hasMore: false,
        events: [{ cursor: 1, kind: "agent_message", text: "fresh" }],
        diagnostics: []
      });
    let observedAttemptId = "attempt-001";
    const api = {
      observe: vi.fn(async () =>
        operationObservation("operation-workspace-001", "running", observedAttemptId)
      ),
      replay,
      subscribe: vi.fn((listener: () => void) => {
        refresh = listener;
        return () => undefined;
      })
    };

    const { result } = renderHook(() =>
      useRemoteTaskWorkspaceConversation({
        api,
        blockRef: "T-001#B-001",
        operationId: "operation-workspace-001",
        onTerminal: vi.fn()
      })
    );

    await waitFor(() => expect(result.current?.timeline[0]).toMatchObject({ content: "stale" }));
    observedAttemptId = "attempt-002";
    act(() => refresh?.());
    await waitFor(() => expect(replay).toHaveBeenNthCalledWith(2, "operation-workspace-001", 0));
    await waitFor(() =>
      expect(result.current?.timeline).toEqual([expect.objectContaining({ content: "fresh" })])
    );
  });

  it("ignores a late old-attempt replay after a new attempt resets the cursor", async () => {
    let refresh: (() => void) | null = null;
    const lateAttemptA = deferred<RemoteEventReplay>();
    const observe = vi
      .fn()
      .mockResolvedValueOnce(
        operationObservation("operation-workspace-001", "running", "attempt-A")
      )
      .mockResolvedValueOnce(
        operationObservation("operation-workspace-001", "running", "attempt-A")
      )
      .mockResolvedValue(operationObservation("operation-workspace-001", "running", "attempt-B"));
    const replay = vi
      .fn()
      .mockResolvedValueOnce({
        eventProtocolVersion: 1,
        executionAttemptId: "attempt-A",
        afterCursor: 0,
        cursor: 20,
        highWatermark: 20,
        hasMore: false,
        events: [{ cursor: 20, kind: "agent_message", text: "attempt A" }],
        diagnostics: []
      })
      .mockImplementationOnce(() => lateAttemptA.promise)
      .mockResolvedValueOnce({
        eventProtocolVersion: 1,
        executionAttemptId: "attempt-B",
        afterCursor: 0,
        cursor: 1,
        highWatermark: 1,
        hasMore: false,
        events: [{ cursor: 1, kind: "agent_message", text: "attempt B" }],
        diagnostics: []
      });
    const api = {
      observe,
      replay,
      subscribe: vi.fn((listener: () => void) => {
        refresh = listener;
        return () => undefined;
      })
    };
    const { result } = renderHook(() =>
      useRemoteTaskWorkspaceConversation({
        api,
        blockRef: "T-001#B-001",
        operationId: "operation-workspace-001",
        onTerminal: vi.fn()
      })
    );

    await waitFor(() =>
      expect(result.current?.timeline[0]).toMatchObject({ content: "attempt A" })
    );
    act(() => refresh?.());
    await waitFor(() => expect(replay).toHaveBeenNthCalledWith(2, "operation-workspace-001", 20));
    act(() => refresh?.());
    await waitFor(() => expect(replay).toHaveBeenNthCalledWith(3, "operation-workspace-001", 0));
    await waitFor(() => {
      expect(result.current?.executionAttemptId).toBe("attempt-B");
      expect(result.current?.timeline).toEqual([expect.objectContaining({ content: "attempt B" })]);
    });

    await act(async () => {
      lateAttemptA.resolve({
        eventProtocolVersion: 1,
        executionAttemptId: "attempt-A",
        afterCursor: 20,
        cursor: 21,
        highWatermark: 21,
        hasMore: false,
        events: [{ cursor: 21, kind: "agent_message", text: "late attempt A" }],
        diagnostics: []
      });
      await Promise.resolve();
    });
    expect(result.current?.executionAttemptId).toBe("attempt-B");
    expect(result.current?.timeline).toEqual([expect.objectContaining({ content: "attempt B" })]);
  });

  it("does not refresh again after a forbidden response", async () => {
    let refresh: (() => void) | null = null;
    const forbidden = Object.assign(new Error("Workspace forbidden"), {
      kind: "forbidden",
      code: "http_403",
      httpStatus: 403
    });
    const api = {
      observe: vi.fn(async () => {
        throw forbidden;
      }),
      replay: vi.fn(async () => ({
        eventProtocolVersion: 1 as const,
        executionAttemptId: "attempt-001",
        afterCursor: 0,
        cursor: 0,
        highWatermark: 0,
        hasMore: false,
        events: [],
        diagnostics: []
      })),
      subscribe: vi.fn((listener: () => void) => {
        refresh = listener;
        return () => undefined;
      })
    };

    const { result } = renderHook(() =>
      useRemoteTaskWorkspaceConversation({
        api,
        blockRef: "T-001#B-001",
        operationId: "operation-workspace-001",
        onTerminal: vi.fn()
      })
    );

    await waitFor(() => expect(result.current?.error).toBe("Workspace forbidden"));
    expect(api.observe).toHaveBeenCalledOnce();
    act(() => refresh?.());
    await act(async () => Promise.resolve());
    expect(api.observe).toHaveBeenCalledOnce();
  });

  it("does not refresh again after Electron serializes a generic 403", async () => {
    let refresh: (() => void) | null = null;
    const api = {
      observe: vi.fn(async () => {
        throw new Error(
          "Error invoking remote method 'observeRemoteOperation': OperatorControlError: http_403"
        );
      }),
      replay: vi.fn(async () => ({
        eventProtocolVersion: 1 as const,
        executionAttemptId: "attempt-001",
        afterCursor: 0,
        cursor: 0,
        highWatermark: 0,
        hasMore: false,
        events: [],
        diagnostics: []
      })),
      subscribe: vi.fn((listener: () => void) => {
        refresh = listener;
        return () => undefined;
      })
    };

    const { result } = renderHook(() =>
      useRemoteTaskWorkspaceConversation({
        api,
        blockRef: "T-001#B-001",
        operationId: "operation-workspace-001",
        onTerminal: vi.fn()
      })
    );

    await waitFor(() => expect(result.current?.error).toContain("http_403"));
    expect(api.observe).toHaveBeenCalledOnce();
    act(() => refresh?.());
    await act(async () => Promise.resolve());
    expect(api.observe).toHaveBeenCalledOnce();
  });

  it("pauses refresh while hidden and refreshes immediately when visible", async () => {
    let visibilityState: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
    const api = {
      observe: vi.fn(async () => operationObservation("operation-workspace-001")),
      replay: vi.fn(async () => ({
        eventProtocolVersion: 1 as const,
        executionAttemptId: "attempt-001",
        afterCursor: 0,
        cursor: 0,
        highWatermark: 0,
        hasMore: false,
        events: [],
        diagnostics: []
      }))
    };

    const { result } = renderHook(() =>
      useRemoteTaskWorkspaceConversation({
        api,
        blockRef: "T-001#B-001",
        operationId: "operation-workspace-001",
        onTerminal: vi.fn()
      })
    );

    await act(async () => Promise.resolve());
    expect(api.observe).not.toHaveBeenCalled();
    expect(result.current?.state).toBe("loading");

    visibilityState = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(api.observe).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current?.state).toBe("running"));
  });

  it("preserves a durable terminal state when its event replay is unavailable", async () => {
    const api = {
      observe: vi.fn(async () => operationObservation("operation-workspace-001", "failed")),
      replay: vi.fn(async () => {
        throw new Error("collaboration_event_replay_unavailable");
      }),
      replayTerminal: true
    };
    const onTerminal = vi.fn();

    const { result } = renderHook(() =>
      useRemoteTaskWorkspaceConversation({
        api,
        blockRef: "T-001#B-001",
        operationId: "operation-workspace-001",
        onTerminal
      })
    );

    await waitFor(() => expect(onTerminal).toHaveBeenCalledOnce());
    expect(result.current).toMatchObject({
      error: "collaboration_event_replay_unavailable",
      state: "failed",
      timeline: []
    });
  });
});
