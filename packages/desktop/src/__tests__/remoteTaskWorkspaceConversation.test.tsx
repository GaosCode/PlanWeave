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

  it("parallelizes an active Owner replay and ignores a terminal retirement race", async () => {
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

    await waitFor(() => expect(api.replay).toHaveBeenCalledWith("operation-owner-001", 0));
    expect(result.current?.state).toBe("running");
    resolveObservation({
      operationId: "operation-owner-001",
      state: "completed"
    } as RemoteOperationObservation);
    await waitFor(() => expect(result.current?.state).toBe("completed"));
    expect(result.current?.error).toBeNull();
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it("loads a live ACP conversation through a transport-neutral operation source", async () => {
    const observation = {
      operationId: "operation-owner-001",
      state: "running"
    } as RemoteOperationObservation;
    const replay = {
      executionAttemptId: "attempt-001",
      afterCursor: 0,
      cursor: 0,
      highWatermark: 0,
      hasMore: false,
      events: []
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
    const observation = {
      operationId: "operation-owner-001",
      state: "running"
    } as RemoteOperationObservation;
    const replay = {
      executionAttemptId: "attempt-001",
      afterCursor: 0,
      cursor: 0,
      highWatermark: 0,
      hasMore: false,
      events: []
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

  it("refreshes the disk-backed run at terminal without replaying a retired live operation", async () => {
    let refresh: (() => void) | null = null;
    const observation = {
      operationId: "operation-owner-001",
      state: "completed"
    } as RemoteOperationObservation;
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
    resolveObservation({
      operationId: "operation-owner-001",
      state: "completed"
    } as RemoteOperationObservation);
    await waitFor(() => expect(onTerminal).toHaveBeenCalledOnce());
    expect(api.replay).not.toHaveBeenCalled();
  });

  it("replays only events after the latest cached cursor on refresh", async () => {
    let refresh: (() => void) | null = null;
    const api = {
      observe: vi.fn(async () => ({
        operationId: "operation-workspace-001",
        state: "running" as const
      })),
      replay: vi.fn(async (_operationId: string, afterCursor: number) =>
        afterCursor === 0
          ? {
              executionAttemptId: "attempt-001",
              afterCursor,
              cursor: 1,
              highWatermark: 1,
              hasMore: false,
              events: [{ cursor: 1, kind: "agent_message" as const, text: "first" }]
            }
          : {
              executionAttemptId: "attempt-001",
              afterCursor,
              cursor: 2,
              highWatermark: 2,
              hasMore: false,
              events: [{ cursor: 2, kind: "agent_message" as const, text: "second" }]
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
      observe: vi.fn(async (operationId: string) => ({
        operationId,
        state: "running" as const
      })),
      replay: vi.fn(async (operationId: string, afterCursor: number) => ({
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
        ]
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
        executionAttemptId: "attempt-001",
        afterCursor: 0,
        cursor: 1,
        highWatermark: 1,
        hasMore: false,
        events: [{ cursor: 1, kind: "agent_message", text: "scope-a" }]
      })
      .mockResolvedValueOnce({
        executionAttemptId: "attempt-001",
        afterCursor: 0,
        cursor: 1,
        highWatermark: 1,
        hasMore: false,
        events: [{ cursor: 1, kind: "agent_message", text: "scope-b" }]
      });
    const api = {
      observe: vi.fn(async () => ({
        operationId: "operation-shared-id",
        state: "running" as const
      })),
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

  it("clears cached events and reloads from zero when the cursor rolls back", async () => {
    let refresh: (() => void) | null = null;
    const replay = vi
      .fn()
      .mockResolvedValueOnce({
        executionAttemptId: "attempt-001",
        afterCursor: 0,
        cursor: 2,
        highWatermark: 2,
        hasMore: false,
        events: [{ cursor: 2, kind: "agent_message", text: "stale" }]
      })
      .mockResolvedValueOnce({
        executionAttemptId: "attempt-002",
        afterCursor: 2,
        cursor: 1,
        highWatermark: 1,
        hasMore: false,
        events: []
      })
      .mockResolvedValueOnce({
        executionAttemptId: "attempt-002",
        afterCursor: 0,
        cursor: 1,
        highWatermark: 1,
        hasMore: false,
        events: [{ cursor: 1, kind: "agent_message", text: "fresh" }]
      });
    const api = {
      observe: vi.fn(async () => ({
        operationId: "operation-workspace-001",
        state: "running" as const
      })),
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
    act(() => refresh?.());
    await waitFor(() => expect(replay).toHaveBeenNthCalledWith(3, "operation-workspace-001", 0));
    await waitFor(() =>
      expect(result.current?.timeline).toEqual([expect.objectContaining({ content: "fresh" })])
    );
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
        executionAttemptId: "attempt-001",
        afterCursor: 0,
        cursor: 0,
        highWatermark: 0,
        hasMore: false,
        events: []
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
        executionAttemptId: "attempt-001",
        afterCursor: 0,
        cursor: 0,
        highWatermark: 0,
        hasMore: false,
        events: []
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
      observe: vi.fn(async () => ({
        operationId: "operation-workspace-001",
        state: "running" as const
      })),
      replay: vi.fn(async () => ({
        executionAttemptId: "attempt-001",
        afterCursor: 0,
        cursor: 0,
        highWatermark: 0,
        hasMore: false,
        events: []
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
      observe: vi.fn(async () => ({
        operationId: "operation-workspace-001",
        state: "failed" as const
      })),
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
