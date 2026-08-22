// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollaborationStatus } from "../shared/collaboration";
import type { CollaborationObserverSignal } from "../shared/collaborationReadModels";
import { graph as graphFixture } from "./helpers/graphFixtures";
import {
  COLLABORATION_RUNTIME_AVAILABILITY_POLL_MS,
  useWorkspaceRuntimeAvailability
} from "../renderer/hooks/useWorkspaceRuntimeAvailability";

const scope = { workspaceId: "w", projectId: "remote-project", canvasId: "default" };
const graph = {
  ...graphFixture,
  tasks: graphFixture.tasks.map((task) =>
    task.taskId === "T-ALPHA"
      ? {
          ...task,
          blocks: [
            {
              ref: "T-ALPHA#B-001",
              blockId: "B-001",
              type: "implementation" as const,
              title: "Alpha implementation",
              status: "ready" as const,
              executor: null,
              requiredCapabilities: [],
              promptMissing: false,
              exceptionReason: null,
              dispatchable: true,
              remoteExecution: null
            }
          ],
          blockPreview: []
        }
      : task
  )
};
const status = {
  schemaVersion: "canvas-runtime-status/v2" as const,
  scope,
  packageFingerprint: graphFixture.packageFingerprint,
  capturedAt: "2026-08-20T00:00:00.000Z",
  tasks: [
    { taskId: "T-ALPHA", status: "implemented" as const, openFeedbackCount: 0 },
    { taskId: "T-BETA", status: "ready" as const, openFeedbackCount: 0 }
  ],
  blocks: [
    {
      ref: "T-ALPHA#B-001",
      status: "completed" as const,
      completionReason: "submitted" as const,
      blockedReason: null,
      divergenceReason: null,
      dispatchable: true
    }
  ]
};
const available = {
  schemaVersion: "canvas-runtime-view/v1" as const,
  state: { kind: "initialized" as const, runtimeRevision: 1, status },
  execution: {
    schemaVersion: "canvas-runtime-availability/v1" as const,
    kind: "available" as const,
    status,
    sourceRevision: "src-revision-001",
    graphFingerprint: status.packageFingerprint
  }
};

function runtimeView(revision: number) {
  return { ...available, state: { ...available.state, runtimeRevision: revision } };
}

function runtimeEvent(
  runtimeRevision: number,
  override: Partial<CollaborationObserverSignal> = {}
) {
  return {
    type: "human.observer.event" as const,
    profileId: "profile-1",
    projectId: scope.projectId,
    event: {
      type: "human.observer.event" as const,
      protocolVersion: "human-observer/v1" as const,
      cursor: runtimeRevision + 10,
      previousCursor: runtimeRevision + 9,
      occurredAt: "2026-08-20T00:00:00.000Z",
      kind: "runtime" as const,
      canvasId: scope.canvasId,
      runtimeRevision
    },
    ...override
  } satisfies CollaborationObserverSignal;
}

function observerStatus(detail: string): CollaborationStatus {
  return {
    profiles: [],
    activeProfileId: "profile-1",
    credentialStorage: "available",
    nonPersistenceWarning: null,
    session: {
      phase: "connected",
      activeProfileId: "profile-1",
      detail,
      lastErrorCode: null,
      lastErrorMessage: null
    },
    workspaceConnection: {
      schemaVersion: "workspace-setup/v1",
      status: "local_only",
      profile: null,
      workspaceId: null,
      workspaceDisplayName: null,
      connectedAt: null,
      error: null
    },
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
    updatedAt: "2026-08-20T00:00:00.000Z"
  };
}

function api(
  read = vi.fn().mockResolvedValue(available),
  initialObserverStatus = observerStatus("observer:connected")
) {
  let observerListener: ((signal: CollaborationObserverSignal) => void) | null = null;
  return {
    getCollaborationStatus: vi.fn().mockResolvedValue(initialObserverStatus),
    readCollaborationCanvasBindingRuntimeAvailability: read,
    onCollaborationObserverSignal: vi.fn(
      (listener: (signal: CollaborationObserverSignal) => void) => {
        observerListener = listener;
        return () => {
          observerListener = null;
        };
      }
    ),
    emitObserver(signal: CollaborationObserverSignal) {
      observerListener?.(signal);
    }
  };
}

function hookInput(bridge: ReturnType<typeof api>) {
  return {
    enabled: true,
    sessionConnected: true,
    profileId: "profile-1",
    activeProjectId: scope.projectId,
    binding: { kind: "remote" as const, ...scope },
    graph,
    api: bridge
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Workspace Runtime observer refresh", () => {
  it("uses the current connected observer snapshot when connection preceded mount", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(available);
    const bridge = api(read);
    renderHook(() => useWorkspaceRuntimeAvailability(hookInput(bridge)));
    await settle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(COLLABORATION_RUNTIME_AVAILABILITY_POLL_MS * 2);
    });

    expect(bridge.getCollaborationStatus).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("refreshes immediately from a scoped runtime event without advancing timers", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(available).mockResolvedValueOnce(runtimeView(2));
    const bridge = api(read);
    const { result } = renderHook(() => useWorkspaceRuntimeAvailability(hookInput(bridge)));
    await settle();

    act(() => bridge.emitObserver(runtimeEvent(2)));
    await settle();

    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.authoritativeRuntime?.state).toMatchObject({ runtimeRevision: 2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COLLABORATION_RUNTIME_AVAILABILITY_POLL_MS * 2);
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("deduplicates duplicate, late, and out-of-order runtime revisions", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(available)
      .mockResolvedValueOnce(runtimeView(2))
      .mockResolvedValueOnce(runtimeView(3));
    const bridge = api(read);
    renderHook(() => useWorkspaceRuntimeAvailability(hookInput(bridge)));
    await settle();

    act(() => bridge.emitObserver(runtimeEvent(2)));
    await settle();
    act(() => {
      bridge.emitObserver(runtimeEvent(2));
      bridge.emitObserver(runtimeEvent(1));
      bridge.emitObserver(runtimeEvent(3));
      bridge.emitObserver(runtimeEvent(2));
    });
    await settle();

    expect(read).toHaveBeenCalledTimes(3);
  });

  it("coalesces concurrent invalidations without letting an older read replace high-water", async () => {
    let resolveRead: ((value: typeof available) => void) | null = null;
    const pendingRead = new Promise<typeof available>((resolve) => {
      resolveRead = resolve;
    });
    const read = vi.fn().mockResolvedValueOnce(available).mockReturnValueOnce(pendingRead);
    const bridge = api(read);
    const { result } = renderHook(() => useWorkspaceRuntimeAvailability(hookInput(bridge)));
    await settle();

    act(() => bridge.emitObserver(runtimeEvent(2)));
    await settle();
    act(() => bridge.emitObserver(runtimeEvent(3)));
    await act(async () => {
      resolveRead?.(runtimeView(3));
      await pendingRead;
    });
    await settle();

    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.authoritativeRuntime?.state).toMatchObject({ runtimeRevision: 3 });
  });

  it("performs one authoritative recovery read for catchup_required", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(available);
    const bridge = api(read);
    renderHook(() => useWorkspaceRuntimeAvailability(hookInput(bridge)));
    await settle();

    act(() => {
      const catchup: CollaborationObserverSignal = {
        type: "human.observer.catchup_required",
        profileId: "profile-1",
        projectId: scope.projectId,
        reason: "retention_gap",
        resumeCursor: 20,
        droppedThroughCursor: 19
      };
      bridge.emitObserver(catchup);
      bridge.emitObserver(catchup);
    });
    await settle();

    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COLLABORATION_RUNTIME_AVAILABILITY_POLL_MS * 2);
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("polls while observer refresh is unavailable and stops after observer recovery", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("observer_unavailable"))
      .mockResolvedValue(available);
    const bridge = api(read, observerStatus("observer:reconnecting:attempt=1:delay_ms=1000"));
    const { result } = renderHook(() => useWorkspaceRuntimeAvailability(hookInput(bridge)));
    await settle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(COLLABORATION_RUNTIME_AVAILABILITY_POLL_MS);
    });
    expect(result.current.availability).toEqual({ kind: "available" });
    expect(read).toHaveBeenCalledTimes(2);

    act(() =>
      bridge.emitObserver({
        type: "human.observer.cursor",
        profileId: "profile-1",
        projectId: scope.projectId,
        cursor: 21
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COLLABORATION_RUNTIME_AVAILABILITY_POLL_MS * 2);
    });

    expect(read).toHaveBeenCalledTimes(2);
  });

  it("retries a failed runtime revision on cursor recovery before leaving fallback", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn()
      .mockResolvedValueOnce(available)
      .mockRejectedValueOnce(new Error("runtime_read_failed"))
      .mockResolvedValueOnce(runtimeView(2));
    const bridge = api(read);
    const { result } = renderHook(() => useWorkspaceRuntimeAvailability(hookInput(bridge)));
    await settle();

    act(() => bridge.emitObserver(runtimeEvent(2)));
    await settle();
    expect(result.current.availability).toEqual({ kind: "error", message: "runtime_read_failed" });

    act(() => {
      const cursor: CollaborationObserverSignal = {
        type: "human.observer.cursor",
        profileId: "profile-1",
        projectId: scope.projectId,
        cursor: 22
      };
      bridge.emitObserver(cursor);
      bridge.emitObserver(cursor);
    });
    await settle();

    expect(read).toHaveBeenCalledTimes(3);
    expect(result.current.authoritativeRuntime?.state).toMatchObject({ runtimeRevision: 2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COLLABORATION_RUNTIME_AVAILABILITY_POLL_MS * 2);
    });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("ignores invalidations from another profile, project, or canvas", async () => {
    const read = vi.fn().mockResolvedValue(available);
    const bridge = api(read);
    renderHook(() => useWorkspaceRuntimeAvailability(hookInput(bridge)));
    await settle();

    act(() => {
      bridge.emitObserver(runtimeEvent(2, { profileId: "profile-other" }));
      bridge.emitObserver(runtimeEvent(2, { projectId: "project-other" }));
      bridge.emitObserver({
        ...runtimeEvent(2),
        event: { ...runtimeEvent(2).event, canvasId: "canvas-other" }
      });
    });
    await settle();

    expect(read).toHaveBeenCalledTimes(1);
  });
});
