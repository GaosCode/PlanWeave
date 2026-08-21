/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import {
  exampleCanvasCommandAccepted,
  exampleCanvasReconnectAfterDisconnect,
  exampleCanvasReconnectTruncatedJournal
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { createTranslator } from "../renderer/i18n";
import type {
  CollaborationCanvasCommandSessionView,
  CollaborationCanvasReconnectResult,
  CollaborationObserverSignal
} from "../shared/collaboration";
import {
  collaborationCanvasReplicaProjectionSchema,
  type CollaborationCanvasBindingReplicaProjection,
  type CollaborationCanvasReplicaProjection,
  type CollaborationCanvasBindingReplicaSignal
} from "../shared/canvasReplicaIpc";
import {
  SHARED_CANVAS_RECONNECT_INTERVAL_MS,
  type SharedCanvasCommandBridge,
  useSharedCanvasCommands
} from "../renderer/hooks/useSharedCanvasCommands";
import { canUseLocalOwnerDirectWrites } from "../renderer/hooks/useCollaborationSurface";

const initialSession: CollaborationCanvasCommandSessionView = {
  canvasId: "default",
  revision: 0,
  contentDigest: null,
  lastOperationId: null,
  lastJournalEntryId: null,
  pendingOperationId: null,
  lastConflict: null,
  lastRejectCode: null
};
const translator = createTranslator("en");

const remoteSession: CollaborationCanvasCommandSessionView = {
  ...initialSession,
  revision: exampleCanvasReconnectAfterDisconnect.headRevision,
  contentDigest: exampleCanvasReconnectAfterDisconnect.headContentDigest,
  lastOperationId: exampleCanvasReconnectAfterDisconnect.entries[0]!.operationId,
  lastJournalEntryId: exampleCanvasReconnectAfterDisconnect.entries[0]!.entryId
};

function reconnectResult(
  session: CollaborationCanvasCommandSessionView | null,
  entries: typeof exampleCanvasReconnectAfterDisconnect.entries = []
): CollaborationCanvasReconnectResult {
  return {
    response: { ...exampleCanvasReconnectAfterDisconnect, entries },
    entriesToApply: [...entries],
    snapshotRequired: false,
    session
  };
}

function createBridge(options?: {
  bindError?: Error;
  reconnect?: SharedCanvasCommandBridge["reconnectCollaborationCanvas"];
  resolveScope?: SharedCanvasCommandBridge["resolveCollaborationCanvasBindingScope"];
  flush?: SharedCanvasCommandBridge["flushCollaborationCanvasReplicaMaterialization"];
  submit?: SharedCanvasCommandBridge["submitCollaborationCanvasCommand"];
}) {
  const observerListeners = new Set<(signal: CollaborationObserverSignal) => void>();
  const replicaListeners = new Set<(signal: CollaborationCanvasBindingReplicaSignal) => void>();
  const reconnect = vi.fn<SharedCanvasCommandBridge["reconnectCollaborationCanvas"]>(
    options?.reconnect ?? (async () => reconnectResult(initialSession))
  );
  const bind = vi.fn<SharedCanvasCommandBridge["bindCollaborationCanvasBindingSession"]>(
    async () => {
      if (options?.bindError) throw options.bindError;
      return initialSession;
    }
  );
  return {
    api: {
      submitCollaborationCanvasCommand:
        options?.submit ??
        (async () => {
          throw new Error("not used by this hook test");
        }),
      reconnectCollaborationCanvas: reconnect,
      bindCollaborationCanvasBindingSession: bind,
      getCollaborationCanvasCommandSession: async () => initialSession,
      resolveCollaborationCanvasBindingScope:
        options?.resolveScope ??
        (async ({ canvasId }) => ({
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId
        })),
      onCollaborationObserverSignal: (listener: (signal: CollaborationObserverSignal) => void) => {
        observerListeners.add(listener);
        return () => observerListeners.delete(listener);
      },
      getCollaborationCanvasBindingReplicaProjection: async () => null,
      flushCollaborationCanvasReplicaMaterialization: options?.flush ?? (async () => undefined),
      onCollaborationCanvasBindingReplicaSignal: (
        listener: (signal: CollaborationCanvasBindingReplicaSignal) => void
      ) => {
        replicaListeners.add(listener);
        return () => replicaListeners.delete(listener);
      }
    },
    reconnect,
    bind,
    emitObserver(signal: CollaborationObserverSignal) {
      for (const listener of observerListeners) listener(signal);
    },
    emitReplica(projection: CollaborationCanvasBindingReplicaProjection) {
      for (const listener of replicaListeners) {
        listener({ type: "canvas.replica.changed", projection });
      }
    }
  };
}

function replicaProjection(revision: number): CollaborationCanvasReplicaProjection {
  return collaborationCanvasReplicaProjectionSchema.parse({
    authorityId: "authority-1",
    localProjectId: "project-1",
    localCanvasId: "default",
    workspaceId: "workspace-1",
    projectId: "project-1",
    canvasId: "default",
    revision,
    contentDigest: "a".repeat(64),
    canEdit: true,
    optimisticOperationIds: [],
    rejections: [],
    content: {
      projectTitle: "Shared",
      graphVersion: "1",
      packageFingerprint: `pkg-${"b".repeat(64)}`,
      tasks: [],
      edges: [],
      sharedResourceGroups: [],
      diagnostics: [],
      layout: {
        version: "desktop-layout/v1",
        projectId: "project-1",
        nodes: [],
        updatedAt: "2026-08-02T00:00:00.000Z"
      },
      blockDependenciesByRef: {},
      taskOpenFeedbackCountByTaskId: {},
      blockPromptMarkdownByRef: {}
    }
  });
}

function remoteReplicaProjection(input: {
  canvasId: string;
  projectId?: string;
  revision: number;
  workspaceId?: string;
}): CollaborationCanvasBindingReplicaProjection {
  const local = replicaProjection(input.revision);
  const { localProjectId: _project, localCanvasId: _canvas, ...projection } = local;
  return {
    ...projection,
    bindingKind: "remote",
    workspaceId: input.workspaceId ?? "workspace-1",
    projectId: input.projectId ?? "project-1",
    canvasId: input.canvasId
  };
}

function hookInput(
  api: SharedCanvasCommandBridge,
  onAuthoritativeChange?: () => void | Promise<void>
) {
  return {
    api,
    enabled: true,
    sessionConnected: true,
    binding: { kind: "local" as const, localProjectId: "project-1", canvasId: "default" },
    profileId: "profile-1",
    activeProjectId: "project-1",
    localOwnerDirectWriteAvailable: false,
    t: translator,
    onAuthoritativeChange
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

afterEach(() => {
  vi.useRealTimers();
  cleanupRendererTestEnvironment();
});

describe("useSharedCanvasCommands", () => {
  it("opens direct writes only for a stopped local owner authority", () => {
    expect(
      canUseLocalOwnerDirectWrites("planweave-local-project", {
        state: "error",
        reason: "start_failed"
      })
    ).toBe(true);
    expect(
      canUseLocalOwnerDirectWrites("planweave-local-project", {
        state: "error",
        reason: "stop_failed"
      })
    ).toBe(false);
    expect(
      canUseLocalOwnerDirectWrites("remote-workspace", {
        state: "stopped",
        reason: null
      })
    ).toBe(false);
  });

  it("adopts a live replica projection without refreshing local disk state", async () => {
    vi.useFakeTimers();
    const bridge = createBridge();
    const { result } = renderHook(() => useSharedCanvasCommands(hookInput(bridge.api)));
    await flushEffects();

    act(() => bridge.emitReplica(replicaProjection(4)));

    expect(result.current.projection?.revision).toBe(4);
    expect(result.current.projection?.content.projectTitle).toBe("Shared");
  });

  it("retains the last confirmed projection as a read-only view after disconnect", async () => {
    vi.useFakeTimers();
    const bridge = createBridge();
    const { result, rerender } = renderHook(
      ({ connected }) =>
        useSharedCanvasCommands({
          ...hookInput(bridge.api),
          sessionConnected: connected
        }),
      { initialProps: { connected: true } }
    );
    await flushEffects();

    act(() => bridge.emitReplica(replicaProjection(4)));
    expect(result.current.projection?.revision).toBe(4);

    rerender({ connected: false });
    await flushEffects();

    expect(result.current.enabled).toBe(true);
    expect(result.current.offline).toBe(true);
    expect(result.current.projection?.revision).toBe(4);
    expect(result.current.projection?.canEdit).toBe(false);
    expect(result.current.projection?.optimisticOperationIds).toEqual([]);
  });

  it("drops unconfirmed optimistic content when the shared session disconnects", async () => {
    vi.useFakeTimers();
    const bridge = createBridge();
    const { result, rerender } = renderHook(
      ({ connected }) =>
        useSharedCanvasCommands({
          ...hookInput(bridge.api),
          sessionConnected: connected
        }),
      { initialProps: { connected: true } }
    );
    await flushEffects();

    act(() => bridge.emitReplica(replicaProjection(4)));
    act(() =>
      bridge.emitReplica(
        collaborationCanvasReplicaProjectionSchema.parse({
          ...replicaProjection(4),
          optimisticOperationIds: ["operation-pending"],
          content: {
            ...replicaProjection(4).content,
            projectTitle: "Unconfirmed"
          }
        })
      )
    );
    expect(result.current.projection?.content.projectTitle).toBe("Unconfirmed");

    rerender({ connected: false });
    await flushEffects();

    expect(result.current.projection?.content.projectTitle).toBe("Shared");
    expect(result.current.projection?.optimisticOperationIds).toEqual([]);
  });

  it("does not mark an unmapped local canvas as shared while collaboration is offline", async () => {
    vi.useFakeTimers();
    const resolveScope = vi.fn<SharedCanvasCommandBridge["resolveCollaborationCanvasBindingScope"]>(
      async () => null
    );
    const bridge = createBridge({ resolveScope });

    const { result } = renderHook(() =>
      useSharedCanvasCommands({
        ...hookInput(bridge.api),
        sessionConnected: false
      })
    );
    await flushEffects();

    expect(resolveScope).toHaveBeenCalledWith({
      kind: "local",
      localProjectId: "project-1",
      canvasId: "default"
    });
    expect(bridge.bind).not.toHaveBeenCalled();
    expect(bridge.reconnect).not.toHaveBeenCalled();
    expect(result.current.enabled).toBe(false);
    expect(result.current.offline).toBe(false);
  });

  it("does not show an offline replica banner before local scope resolution finishes", async () => {
    vi.useFakeTimers();
    type ScopeResolution = Awaited<
      ReturnType<SharedCanvasCommandBridge["resolveCollaborationCanvasBindingScope"]>
    >;
    let resolveScope!: (value: ScopeResolution) => void;
    const pendingScope = new Promise<ScopeResolution>((resolve) => {
      resolveScope = resolve;
    });
    const bridge = createBridge({ resolveScope: async () => pendingScope });

    const { result } = renderHook(() =>
      useSharedCanvasCommands({
        ...hookInput(bridge.api),
        sessionConnected: false
      })
    );

    expect(result.current.enabled).toBe(true);
    expect(result.current.authorityMode).toBe("resolving");
    expect(result.current.offline).toBe(false);

    resolveScope(null);
    await flushEffects();
    expect(result.current.enabled).toBe(false);
    expect(result.current.offline).toBe(false);
  });

  it("keeps the command facade stable when its inputs and snapshot are unchanged", () => {
    const t = createTranslator("en");
    const { result, rerender } = renderHook(() =>
      useSharedCanvasCommands({
        api: null,
        enabled: false,
        sessionConnected: false,
        binding: null,
        profileId: null,
        activeProjectId: null,
        localOwnerDirectWriteAvailable: false,
        t
      })
    );
    const initialFacade = result.current;

    rerender();

    expect(result.current).toBe(initialFacade);
  });

  it("returns a stopped local owner authority to direct local writes", async () => {
    vi.useFakeTimers();
    const bridge = createBridge();
    const { result, rerender } = renderHook(
      ({ directWrite }) =>
        useSharedCanvasCommands({
          ...hookInput(bridge.api),
          localOwnerDirectWriteAvailable: directWrite
        }),
      { initialProps: { directWrite: false } }
    );
    await flushEffects();
    act(() => bridge.emitReplica(replicaProjection(4)));

    rerender({ directWrite: true });
    await flushEffects();

    expect(result.current.enabled).toBe(false);
    expect(result.current.offline).toBe(false);
    expect(result.current.projection).toBeNull();
  });

  it("returns an accepted drag before the background disk mirror finishes", async () => {
    vi.useFakeTimers();
    let releaseFlush!: () => void;
    const flush = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const onAuthoritativeChange = vi.fn();
    const bridge = createBridge({
      flush: async () => flush,
      submit: async () => ({
        outcome: exampleCanvasCommandAccepted,
        session: {
          ...initialSession,
          revision: exampleCanvasCommandAccepted.revision,
          contentDigest: exampleCanvasCommandAccepted.contentDigest
        }
      })
    });
    const { result } = renderHook(() =>
      useSharedCanvasCommands(hookInput(bridge.api, onAuthoritativeChange))
    );
    await flushEffects();
    onAuthoritativeChange.mockClear();

    const submitted = await result.current.submit({
      intent: {
        kind: "update_layout",
        nodes: [{ nodeId: "T-001", x: 40, y: 80 }],
        updatedAt: "2026-08-03T00:00:00.000Z"
      }
    });

    expect(submitted.ok).toBe(true);
    expect(onAuthoritativeChange).not.toHaveBeenCalled();
    releaseFlush();
    await flushEffects();
    expect(onAuthoritativeChange).toHaveBeenCalledTimes(1);
  });

  it("polls a remote delta and refreshes the authoritative canvas", async () => {
    vi.useFakeTimers();
    const onAuthoritativeChange = vi.fn();
    const bridge = createBridge({
      reconnect: vi
        .fn<SharedCanvasCommandBridge["reconnectCollaborationCanvas"]>()
        .mockResolvedValueOnce(reconnectResult(initialSession))
        .mockResolvedValueOnce(
          reconnectResult(remoteSession, exampleCanvasReconnectAfterDisconnect.entries)
        )
    });

    const { result } = renderHook(() =>
      useSharedCanvasCommands(hookInput(bridge.api, onAuthoritativeChange))
    );
    await flushEffects();
    expect(bridge.bind).toHaveBeenCalledWith({
      kind: "local",
      localProjectId: "project-1",
      canvasId: "default"
    });
    expect(bridge.reconnect).toHaveBeenCalledTimes(1);
    onAuthoritativeChange.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARED_CANVAS_RECONNECT_INTERVAL_MS);
    });

    expect(bridge.reconnect).toHaveBeenCalledTimes(2);
    expect(onAuthoritativeChange).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot.session?.revision).toBe(remoteSession.revision);
  });

  it("refreshes the renderer after a snapshot-only reconnect", async () => {
    vi.useFakeTimers();
    const onAuthoritativeChange = vi.fn();
    const bridge = createBridge({
      reconnect: vi
        .fn<SharedCanvasCommandBridge["reconnectCollaborationCanvas"]>()
        .mockResolvedValueOnce(reconnectResult(initialSession))
        .mockResolvedValueOnce({
          response: exampleCanvasReconnectTruncatedJournal,
          entriesToApply: [],
          snapshotRequired: true,
          session: remoteSession
        })
    });
    renderHook(() => useSharedCanvasCommands(hookInput(bridge.api, onAuthoritativeChange)));
    await flushEffects();
    onAuthoritativeChange.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARED_CANVAS_RECONNECT_INTERVAL_MS);
    });

    expect(onAuthoritativeChange).toHaveBeenCalledTimes(1);
  });

  it("reconnects immediately when the observer reports a newer revision for this canvas", async () => {
    vi.useFakeTimers();
    const onAuthoritativeChange = vi.fn();
    const bridge = createBridge({
      reconnect: vi
        .fn<SharedCanvasCommandBridge["reconnectCollaborationCanvas"]>()
        .mockResolvedValueOnce(reconnectResult(initialSession))
        .mockResolvedValueOnce(
          reconnectResult(remoteSession, exampleCanvasReconnectAfterDisconnect.entries)
        )
    });

    const { result } = renderHook(() =>
      useSharedCanvasCommands(hookInput(bridge.api, onAuthoritativeChange))
    );
    await flushEffects();
    expect(bridge.reconnect).toHaveBeenCalledTimes(1);
    onAuthoritativeChange.mockClear();

    bridge.emitObserver({
      type: "human.observer.event",
      profileId: "profile-1",
      projectId: "project-1",
      event: {
        type: "human.observer.event",
        protocolVersion: 1,
        cursor: 2,
        previousCursor: 1,
        occurredAt: "2030-01-01T00:00:00.000Z",
        kind: "canvas",
        canvasId: "default",
        canvasRevision: remoteSession.revision,
        canvasContentDigest: remoteSession.contentDigest
      }
    } as unknown as CollaborationObserverSignal);
    await flushEffects();

    expect(bridge.reconnect).toHaveBeenCalledTimes(2);
    expect(onAuthoritativeChange).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot.session?.revision).toBe(remoteSession.revision);
  });

  it("binds an imported local replica to its remote canvas scope", async () => {
    vi.useFakeTimers();
    const bridge = createBridge({
      resolveScope: async () => ({ projectId: "remote-project", canvasId: "remote-canvas" })
    });

    const { result } = renderHook(() =>
      useSharedCanvasCommands({
        ...hookInput(bridge.api),
        binding: { kind: "local", localProjectId: "local-replica", canvasId: "default" },
        activeProjectId: "remote-project"
      })
    );
    await flushEffects();

    expect(result.current.authorityMode).toBe("shared");
    expect(bridge.bind).toHaveBeenCalledWith({
      kind: "local",
      localProjectId: "local-replica",
      canvasId: "default"
    });
  });

  it("keeps an unrelated local project on direct runtime writes after scope resolution", async () => {
    vi.useFakeTimers();
    const bridge = createBridge({ resolveScope: async () => null });

    const { result } = renderHook(() =>
      useSharedCanvasCommands({
        ...hookInput(bridge.api),
        binding: {
          kind: "local",
          localProjectId: "unrelated-local-project",
          canvasId: "default"
        }
      })
    );
    await flushEffects();

    expect(result.current.enabled).toBe(false);
    expect(result.current.authorityMode).toBe("local");
    expect(bridge.bind).not.toHaveBeenCalled();
  });

  it("stops polling after unmount", async () => {
    vi.useFakeTimers();
    const bridge = createBridge();
    const { unmount } = renderHook(() => useSharedCanvasCommands(hookInput(bridge.api)));
    await flushEffects();
    expect(bridge.reconnect).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARED_CANVAS_RECONNECT_INTERVAL_MS * 2);
    });

    expect(bridge.reconnect).toHaveBeenCalledTimes(1);
  });

  it("does not overlap background reconnect requests", async () => {
    vi.useFakeTimers();
    let resolveRemoteReconnect: (() => void) | null = null;
    const remoteReconnect = new Promise<void>((resolve) => {
      resolveRemoteReconnect = resolve;
    });
    const bridge = createBridge({
      reconnect: vi
        .fn<SharedCanvasCommandBridge["reconnectCollaborationCanvas"]>()
        .mockResolvedValueOnce(reconnectResult(initialSession))
        .mockImplementationOnce(async () => {
          await remoteReconnect;
          return reconnectResult(initialSession);
        })
        .mockResolvedValue(reconnectResult(initialSession))
    });
    renderHook(() => useSharedCanvasCommands(hookInput(bridge.api)));
    await flushEffects();

    await act(async () => {
      vi.advanceTimersByTime(SHARED_CANVAS_RECONNECT_INTERVAL_MS * 3);
    });
    expect(bridge.reconnect).toHaveBeenCalledTimes(2);

    resolveRemoteReconnect?.();
    await flushEffects();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARED_CANVAS_RECONNECT_INTERVAL_MS);
    });
    expect(bridge.reconnect).toHaveBeenCalledTimes(3);
  });

  it("does not poll when local canvas binding fails", async () => {
    vi.useFakeTimers();
    const bridge = createBridge({ bindError: new Error("local canvas binding failed") });
    renderHook(() => useSharedCanvasCommands(hookInput(bridge.api)));
    await flushEffects();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARED_CANVAS_RECONNECT_INTERVAL_MS * 2);
    });
    expect(bridge.reconnect).not.toHaveBeenCalled();
  });

  it("treats a background reconnect transport failure as offline without exposing IPC details", async () => {
    vi.useFakeTimers();
    const submit = vi.fn<SharedCanvasCommandBridge["submitCollaborationCanvasCommand"]>();
    const bridge = createBridge({
      reconnect: vi
        .fn<SharedCanvasCommandBridge["reconnectCollaborationCanvas"]>()
        .mockResolvedValueOnce(reconnectResult(initialSession))
        .mockRejectedValueOnce(
          new Error(
            "Error invoking remote method 'planweave-collaboration:reconnectCanvas': CollaborationClientError: Network request failed."
          )
        )
        .mockResolvedValue(reconnectResult(initialSession)),
      submit
    });
    const { result } = renderHook(() => useSharedCanvasCommands(hookInput(bridge.api)));
    await flushEffects();

    act(() => bridge.emitReplica(replicaProjection(4)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARED_CANVAS_RECONNECT_INTERVAL_MS);
    });

    expect(result.current.offline).toBe(true);
    expect(result.current.snapshot.lastError).toBeNull();
    expect(result.current.projection?.revision).toBe(4);
    expect(result.current.projection?.canEdit).toBe(false);

    let submitted: Awaited<ReturnType<typeof result.current.submit>> | undefined;
    await act(async () => {
      submitted = await result.current.submit({
        intent: {
          kind: "update_layout",
          nodes: [{ nodeId: "T-001", x: 40, y: 80 }],
          updatedAt: "2026-08-03T00:00:00.000Z"
        }
      });
    });

    expect(submitted).toEqual({ ok: false, error: null, staleConflict: null });
    expect(submit).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARED_CANVAS_RECONNECT_INTERVAL_MS);
    });

    expect(result.current.offline).toBe(false);
    expect(result.current.projection?.canEdit).toBe(true);
  });

  it("treats a disconnected canvas command session as offline without a raw error banner", async () => {
    vi.useFakeTimers();
    const bridge = createBridge({
      submit: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'planweave-collaboration:submitCanvasCommand': CollaborationClientError: canvas_replica_session_disconnected"
          )
        )
    });
    const { result } = renderHook(() => useSharedCanvasCommands(hookInput(bridge.api)));
    await flushEffects();
    act(() => bridge.emitReplica(replicaProjection(4)));

    let submitted: Awaited<ReturnType<typeof result.current.submit>> | undefined;
    await act(async () => {
      submitted = await result.current.submit({
        intent: {
          kind: "update_layout",
          nodes: [{ nodeId: "T-001", x: 40, y: 80 }],
          updatedAt: "2026-08-03T00:00:00.000Z"
        }
      });
    });

    expect(submitted).toEqual({ ok: false, error: null, staleConflict: null });
    expect(result.current.offline).toBe(true);
    expect(result.current.snapshot.lastError).toBeNull();
    expect(result.current.projection?.canEdit).toBe(false);
  });

  it("keeps unexpected canvas command failures visible", async () => {
    vi.useFakeTimers();
    const bridge = createBridge({
      submit: vi.fn().mockRejectedValue(new Error("unexpected protocol failure"))
    });
    const { result } = renderHook(() => useSharedCanvasCommands(hookInput(bridge.api)));
    await flushEffects();

    const submitted = await result.current.submit({
      intent: {
        kind: "update_layout",
        nodes: [{ nodeId: "T-001", x: 40, y: 80 }],
        updatedAt: "2026-08-03T00:00:00.000Z"
      }
    });

    expect(submitted.error).toBe("unexpected protocol failure");
    expect(result.current.offline).toBe(false);
  });

  it("accepts an exact remote replica signal without materializing it to disk", async () => {
    vi.useFakeTimers();
    const flush = vi.fn().mockResolvedValue(undefined);
    const bridge = createBridge({ flush });
    const local = replicaProjection(7);
    const { localProjectId: _project, localCanvasId: _canvas, ...projection } = local;
    const remoteProjection: CollaborationCanvasBindingReplicaProjection = {
      ...projection,
      bindingKind: "remote"
    };
    const { result } = renderHook(() =>
      useSharedCanvasCommands({
        ...hookInput(bridge.api),
        binding: {
          kind: "remote",
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "default"
        }
      })
    );

    await flushEffects();
    act(() => bridge.emitReplica(remoteProjection));

    expect(result.current.projection).toEqual(remoteProjection);
    expect(bridge.bind).toHaveBeenCalledWith({
      kind: "remote",
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "default"
    });
    expect(flush).not.toHaveBeenCalled();
  });

  it("hides a stale remote projection immediately when canvas or profile identity changes", async () => {
    vi.useFakeTimers();
    const bridge = createBridge();
    const initialBinding = {
      kind: "remote" as const,
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "default"
    };
    const { result, rerender } = renderHook(
      ({ binding, profileId }) =>
        useSharedCanvasCommands({
          ...hookInput(bridge.api),
          binding,
          profileId
        }),
      { initialProps: { binding: initialBinding, profileId: "profile-1" } }
    );
    await flushEffects();

    act(() => bridge.emitReplica(remoteReplicaProjection({ canvasId: "default", revision: 7 })));
    expect(result.current.projection?.canvasId).toBe("default");

    rerender({
      binding: { ...initialBinding, canvasId: "secondary" },
      profileId: "profile-1"
    });
    expect(result.current.projection).toBeNull();

    rerender({ binding: initialBinding, profileId: "profile-2" });
    expect(result.current.projection).toBeNull();
  });
});
