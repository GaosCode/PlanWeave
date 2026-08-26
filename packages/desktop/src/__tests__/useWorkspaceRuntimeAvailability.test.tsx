/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { graph as graphFixture } from "./helpers/graphFixtures";
import type { CollaborationObserverSignal } from "../shared/collaborationReadModels";
import {
  type WorkspaceRuntimeAvailabilityBridge,
  useWorkspaceRuntimeAvailability
} from "../renderer/hooks/useWorkspaceRuntimeAvailability";
import {
  type WorkspaceRuntimeBridge,
  useWorkspaceRuntime
} from "../renderer/hooks/useWorkspaceRuntime";
import {
  collaborationRuntimeOperationsAllowed,
  collaborationRuntimeStartAllowed,
  collaborationRuntimeUnavailableCode,
  collaborationRuntimeStatusKnown
} from "../renderer/collaboration/runtimeAvailabilityView";
import { createTranslator } from "../renderer/i18n";

const scope = { workspaceId: "workspace-1", projectId: "project-1", canvasId: "canvas-1" };
const graph = {
  ...graphFixture,
  tasks: graphFixture.tasks.map((task) => ({ ...task, blocks: [], blockPreview: [] }))
};
const graphWithDispatchableBlock = {
  ...graph,
  tasks: graph.tasks.map((task, index) =>
    index === 0
      ? {
          ...task,
          blocks: [
            {
              ref: `${task.taskId}#B-001`,
              blockId: "B-001",
              type: "implementation" as const,
              title: "Implementation",
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

function runtimeView(
  runtimeRevision: number,
  packageFingerprint = graph.packageFingerprint,
  taskStatus: "implemented" | "ready" | null = null,
  currentGraph = graph
) {
  const status = {
    schemaVersion: "canvas-runtime-status/v2" as const,
    scope,
    packageFingerprint,
    capturedAt: "2026-08-22T00:00:00.000Z",
    tasks: currentGraph.tasks.map((task) => ({
      taskId: task.taskId,
      status: taskStatus ?? task.status,
      openFeedbackCount: 0
    })),
    blocks: currentGraph.tasks.flatMap((task) =>
      task.blocks.map((block) => ({
        ref: block.ref,
        status: block.status,
        completionReason: null,
        blockedReason: null,
        divergenceReason: null,
        dispatchable: block.dispatchable
      }))
    )
  };
  return {
    schemaVersion: "canvas-runtime-view/v1" as const,
    state: { kind: "initialized" as const, runtimeRevision, status },
    execution: {
      schemaVersion: "canvas-runtime-availability/v1" as const,
      kind: "available" as const,
      status,
      sourceRevision: `source-${runtimeRevision}`,
      graphFingerprint: packageFingerprint
    }
  };
}

function runtimeViewForScope(
  runtimeRevision: number,
  nextScope: typeof scope,
  taskStatus: "implemented" | "ready"
) {
  const view = runtimeView(runtimeRevision, graph.packageFingerprint, taskStatus);
  const status = { ...view.state.status, scope: nextScope };
  return {
    ...view,
    state: { ...view.state, status },
    execution: { ...view.execution, status }
  };
}

function uninitializedRuntimeView() {
  const view = runtimeView(1);
  return { ...view, state: { kind: "uninitialized" as const } };
}

function createApi() {
  let observer: ((signal: CollaborationObserverSignal) => void) | null = null;
  const read = vi.fn().mockResolvedValueOnce(runtimeView(1)).mockResolvedValue(runtimeView(2));
  const api = {
    getCollaborationStatus: vi.fn().mockRejectedValue(new Error("observer_status_unavailable")),
    readCollaborationCanvasBindingRuntimeAvailability: read,
    onCollaborationObserverSignal: vi.fn((listener) => {
      observer = listener;
      return () => undefined;
    })
  } as WorkspaceRuntimeAvailabilityBridge;
  return { api, read, emit: (signal: CollaborationObserverSignal) => observer?.(signal) };
}

function input(api: WorkspaceRuntimeAvailabilityBridge, enabled = true) {
  return {
    enabled,
    sessionConnected: true,
    profileId: "profile-1",
    activeProjectId: scope.projectId,
    binding: { kind: "remote" as const, ...scope },
    graph,
    api
  };
}

describe("useWorkspaceRuntimeAvailability", () => {
  it("allows Run preparation without enabling Reset for an unattached runtime", () => {
    const uninitialized = { kind: "state_uninitialized" } as const;
    const unattached = {
      kind: "unavailable",
      reason: "runtime_not_attached",
      statusKnown: false
    } as const;

    expect(collaborationRuntimeStartAllowed(uninitialized)).toBe(true);
    expect(collaborationRuntimeOperationsAllowed(uninitialized)).toBe(false);
    expect(collaborationRuntimeUnavailableCode(uninitialized)).toBeNull();
    expect(collaborationRuntimeStartAllowed(unattached)).toBe(true);
    expect(collaborationRuntimeOperationsAllowed(unattached)).toBe(false);
    expect(collaborationRuntimeUnavailableCode(unattached)).toBeNull();
  });

  it("leaves a Local Canvas on its direct runtime path without collaboration reads", () => {
    const fixture = createApi();
    const { result } = renderHook(() => useWorkspaceRuntimeAvailability(input(fixture.api, false)));

    expect(result.current.availability).toEqual({ kind: "not_applicable" });
    expect(result.current.graph).toBe(graph);
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it("reads Workspace execution from the exact remote binding", async () => {
    const fixture = createApi();
    const { result } = renderHook(() => useWorkspaceRuntimeAvailability(input(fixture.api)));

    await waitFor(() => expect(result.current.availability).toEqual({ kind: "available" }));
    expect(fixture.read).toHaveBeenCalledWith({ kind: "remote", ...scope });
    expect(result.current.authoritativeRuntime?.state).toMatchObject({ runtimeRevision: 1 });
  });

  it("uses the Workspace session runtime seed without a duplicate cold-open read", () => {
    const fixture = createApi();
    const seeded = runtimeView(7);
    const { result } = renderHook(() =>
      useWorkspaceRuntimeAvailability({
        ...input(fixture.api),
        initialRuntimeAvailability: seeded
      })
    );

    expect(result.current.availability).toEqual({ kind: "available" });
    expect(result.current.authoritativeRuntime).toEqual(seeded);
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it("consumes the session seed once and keeps the previous ready state during an explicit refresh", async () => {
    const fixture = createApi();
    fixture.read.mockReset().mockResolvedValue(runtimeView(2));
    const seeded = runtimeView(1);
    const { result, rerender } = renderHook(
      ({ refreshRevision }) =>
        useWorkspaceRuntimeAvailability({
          ...input(fixture.api),
          initialRuntimeAvailability: seeded,
          refreshRevision
        }),
      { initialProps: { refreshRevision: 0 } }
    );

    expect(result.current.authoritativeRuntime?.state).toMatchObject({ runtimeRevision: 1 });
    expect(fixture.read).not.toHaveBeenCalled();

    rerender({ refreshRevision: 1 });
    expect(result.current.availability).toEqual({ kind: "available" });
    expect(result.current.authoritativeRuntime?.state).toMatchObject({ runtimeRevision: 1 });
    await waitFor(() =>
      expect(result.current.authoritativeRuntime?.state).toMatchObject({ runtimeRevision: 2 })
    );
    expect(fixture.read).toHaveBeenCalledOnce();
  });

  it("does not reuse the session seed when the accepted graph fingerprint changes", async () => {
    let resolveAvailability: ((value: ReturnType<typeof runtimeView>) => void) | null = null;
    const pendingAvailability = new Promise<ReturnType<typeof runtimeView>>((resolve) => {
      resolveAvailability = resolve;
    });
    const fixture = createApi();
    fixture.read.mockReset().mockReturnValue(pendingAvailability);
    const seeded = runtimeView(1);
    const { result, rerender } = renderHook(
      ({ currentGraph }) =>
        useWorkspaceRuntimeAvailability({
          ...input(fixture.api),
          graph: currentGraph,
          initialRuntimeAvailability: seeded
        }),
      { initialProps: { currentGraph: graph } }
    );

    expect(result.current.authoritativeRuntime).toEqual(seeded);
    expect(fixture.read).not.toHaveBeenCalled();

    const nextFingerprint = `pkg-${"c".repeat(64)}`;
    rerender({ currentGraph: { ...graph, packageFingerprint: nextFingerprint } });
    await waitFor(() => expect(fixture.read).toHaveBeenCalledOnce());
    expect(result.current.authoritativeRuntime).toEqual(seeded);

    act(() => resolveAvailability?.(runtimeView(2, nextFingerprint)));
    await waitFor(() =>
      expect(result.current.authoritativeRuntime?.state).toMatchObject({ runtimeRevision: 2 })
    );
  });

  it("keeps an accepted Workspace graph stable while execution capability is checking", async () => {
    let resolveAvailability: ((value: ReturnType<typeof runtimeView>) => void) | null = null;
    const pendingAvailability = new Promise<ReturnType<typeof runtimeView>>((resolve) => {
      resolveAvailability = resolve;
    });
    const fixture = createApi();
    fixture.read.mockReset();
    fixture.read.mockReturnValue(pendingAvailability);
    const { result } = renderHook(() => useWorkspaceRuntimeAvailability(input(fixture.api)));

    await waitFor(() => expect(fixture.read).toHaveBeenCalledOnce());
    expect(result.current.availability).toEqual({ kind: "checking" });
    expect(result.current.graph).toBe(graph);

    act(() => resolveAvailability?.(runtimeView(1)));
    await waitFor(() => expect(result.current.availability).toEqual({ kind: "available" }));
  });

  it("treats a pending Workspace projection as checking instead of a scope failure", async () => {
    const fixture = createApi();
    const { result, rerender } = renderHook(
      ({ currentGraph }) =>
        useWorkspaceRuntimeAvailability({ ...input(fixture.api), graph: currentGraph }),
      { initialProps: { currentGraph: null as typeof graph | null } }
    );

    expect(result.current.availability).toEqual({ kind: "checking" });
    expect(fixture.read).not.toHaveBeenCalled();

    rerender({ currentGraph: graph });
    await waitFor(() => expect(result.current.availability).toEqual({ kind: "available" }));
  });

  it("refreshes Workspace execution through the runtime observer event path", async () => {
    const fixture = createApi();
    const { result } = renderHook(() => useWorkspaceRuntimeAvailability(input(fixture.api)));
    await waitFor(() =>
      expect(result.current.authoritativeRuntime?.state).toMatchObject({ runtimeRevision: 1 })
    );

    act(() => {
      fixture.emit({
        type: "human.observer.event",
        profileId: "profile-1",
        projectId: scope.projectId,
        event: {
          kind: "runtime",
          sequence: 2,
          canvasId: scope.canvasId,
          runtimeRevision: 2
        }
      });
    });

    await waitFor(() =>
      expect(result.current.authoritativeRuntime?.state).toMatchObject({ runtimeRevision: 2 })
    );
    expect(fixture.read).toHaveBeenCalledTimes(2);
  });

  it("does not publish an uninitialized response invalidated while it was in flight", async () => {
    let resolveFirst: ((value: ReturnType<typeof uninitializedRuntimeView>) => void) | null = null;
    let resolveSecond: ((value: ReturnType<typeof runtimeView>) => void) | null = null;
    const first = new Promise<ReturnType<typeof uninitializedRuntimeView>>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<ReturnType<typeof runtimeView>>((resolve) => {
      resolveSecond = resolve;
    });
    const fixture = createApi();
    fixture.read.mockReset();
    fixture.read.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const { result } = renderHook(() => useWorkspaceRuntimeAvailability(input(fixture.api)));

    await waitFor(() => expect(fixture.read).toHaveBeenCalledOnce());
    act(() => {
      fixture.emit({
        type: "human.observer.event",
        profileId: "profile-1",
        projectId: scope.projectId,
        event: {
          kind: "runtime",
          sequence: 2,
          canvasId: scope.canvasId,
          runtimeRevision: 2
        }
      });
      resolveFirst?.(uninitializedRuntimeView());
    });

    await waitFor(() => expect(fixture.read).toHaveBeenCalledTimes(2));
    expect(result.current.availability).toEqual({ kind: "checking" });

    act(() => resolveSecond?.(runtimeView(2)));
    await waitFor(() => expect(result.current.availability).toEqual({ kind: "available" }));
  });

  it("fails closed without inferring the Server transport state from a disconnected session", () => {
    const fixture = createApi();
    const { result } = renderHook(() =>
      useWorkspaceRuntimeAvailability({
        ...input(fixture.api),
        sessionConnected: false
      })
    );

    expect(result.current.availability).toEqual({
      kind: "session_disconnected",
      statusKnown: false
    });
    expect(
      result.current.graph?.tasks.every((task) => task.blocks.every((block) => !block.dispatchable))
    ).toBe(true);
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it("keeps the last authoritative runtime status visible across a transient disconnect", async () => {
    const fixture = createApi();
    fixture.read
      .mockReset()
      .mockResolvedValue(
        runtimeView(1, graph.packageFingerprint, "implemented", graphWithDispatchableBlock)
      );
    const { result, rerender } = renderHook(
      ({ sessionConnected }) =>
        useWorkspaceRuntimeAvailability({
          ...input(fixture.api),
          graph: graphWithDispatchableBlock,
          sessionConnected
        }),
      { initialProps: { sessionConnected: true as boolean | null } }
    );

    await waitFor(() => expect(result.current.availability).toEqual({ kind: "available" }));

    rerender({ sessionConnected: false });

    expect(result.current.availability).toEqual({
      kind: "session_disconnected",
      statusKnown: true
    });
    expect(collaborationRuntimeStatusKnown(result.current.availability)).toBe(true);
    expect(collaborationRuntimeOperationsAllowed(result.current.availability)).toBe(false);
    expect(result.current.graph?.tasks.every((task) => task.status === "implemented")).toBe(true);
    expect(result.current.graph?.tasks[0]?.blocks).toHaveLength(1);
    expect(result.current.graph?.tasks[0]?.blocks[0]?.dispatchable).toBe(false);
  });

  it("does not flash a disconnect while connection status is still loading", () => {
    const fixture = createApi();
    const { result } = renderHook(() =>
      useWorkspaceRuntimeAvailability({
        ...input(fixture.api),
        sessionConnected: null
      })
    );

    expect(result.current.availability).toEqual({ kind: "checking" });
    expect(fixture.read).not.toHaveBeenCalled();
  });
});

describe("useWorkspaceRuntime", () => {
  it("does not initialize when opening a Workspace canvas or reading availability", async () => {
    const uninitializedRuntime = uninitializedRuntimeView();
    const api = {
      getCollaborationStatus: vi.fn().mockRejectedValue(new Error("observer unavailable")),
      readCollaborationCanvasBindingRuntimeAvailability: vi
        .fn()
        .mockResolvedValue(uninitializedRuntime),
      resetWorkspaceCanvasRuntime: vi.fn()
    } satisfies WorkspaceRuntimeBridge;
    const { result } = renderHook(() =>
      useWorkspaceRuntime({
        activeProfileId: "profile-1",
        activeProjectId: scope.projectId,
        graph,
        sessionConnected: true,
        binding: { kind: "remote", ...scope },
        initialRuntimeAvailability: uninitializedRuntime,
        locator: {
          kind: "workspace",
          connectionProfileId: "profile-1",
          ...scope
        },
        setError: vi.fn(),
        setSuccessMessage: vi.fn(),
        t: createTranslator("en"),
        api
      })
    );

    await waitFor(() =>
      expect(result.current.availability).toEqual({ kind: "state_uninitialized" })
    );
    expect(result.current.ensureWorkspaceRuntimeInitialized).toBeUndefined();
  });

  it("projects an accepted reset immediately without a duplicate availability read", async () => {
    const initialRuntime = runtimeView(1, graph.packageFingerprint, "implemented");
    const resetRuntime = runtimeView(2, graph.packageFingerprint, "ready");
    const readRuntimeAvailability = vi.fn();
    const resetWorkspaceCanvasRuntime = vi.fn().mockResolvedValue({
      type: "canvas.runtime.reset.accepted" as const,
      operationId: "operation-1",
      runtimeRevision: 2,
      sourceRevision: "source-2",
      graphFingerprint: graph.packageFingerprint,
      status: resetRuntime.execution.status
    });
    const api = {
      getCollaborationStatus: vi.fn().mockRejectedValue(new Error("observer unavailable")),
      readCollaborationCanvasBindingRuntimeAvailability: readRuntimeAvailability,
      resetWorkspaceCanvasRuntime
    } satisfies WorkspaceRuntimeBridge;
    const setSuccessMessage = vi.fn();
    const setError = vi.fn();
    const { result } = renderHook(() =>
      useWorkspaceRuntime({
        activeProfileId: "profile-1",
        activeProjectId: scope.projectId,
        graph,
        sessionConnected: true,
        binding: { kind: "remote", ...scope },
        initialRuntimeAvailability: initialRuntime,
        locator: {
          kind: "workspace",
          connectionProfileId: "profile-1",
          ...scope
        },
        setError,
        setSuccessMessage,
        t: createTranslator("en"),
        api
      })
    );

    expect(result.current.graph?.tasks.every((task) => task.status === "implemented")).toBe(true);
    expect(readRuntimeAvailability).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.resetWorkspaceRuntime?.();
    });

    await waitFor(() =>
      expect(result.current.authoritativeRuntime?.state).toMatchObject({
        kind: "initialized",
        runtimeRevision: 2
      })
    );
    expect(result.current.graph?.tasks.every((task) => task.status === "ready")).toBe(true);
    expect(resetWorkspaceCanvasRuntime).toHaveBeenCalledOnce();
    expect(readRuntimeAvailability).not.toHaveBeenCalled();
    expect(setSuccessMessage).toHaveBeenCalledWith(
      "Runtime state reset from the authoritative Server projection."
    );
    expect(setError).not.toHaveBeenCalled();
  });

  it("does not reuse an accepted projection after leaving and reopening the Workspace canvas", async () => {
    const initialRuntime = runtimeView(1, graph.packageFingerprint, "implemented");
    const resetRuntime = runtimeView(2, graph.packageFingerprint, "ready");
    const reopenedRuntime = runtimeView(3, graph.packageFingerprint, "implemented");
    const resetWorkspaceCanvasRuntime = vi.fn().mockResolvedValue({
      type: "canvas.runtime.reset.accepted" as const,
      operationId: "operation-1",
      runtimeRevision: 2,
      sourceRevision: "source-2",
      graphFingerprint: graph.packageFingerprint,
      status: resetRuntime.execution.status
    });
    const api = {
      getCollaborationStatus: vi.fn().mockRejectedValue(new Error("observer unavailable")),
      readCollaborationCanvasBindingRuntimeAvailability: vi.fn(),
      resetWorkspaceCanvasRuntime
    } satisfies WorkspaceRuntimeBridge;
    const workspaceProps = {
      activeProfileId: "profile-1",
      activeProjectId: scope.projectId,
      graph,
      sessionConnected: true,
      binding: { kind: "remote" as const, ...scope },
      initialRuntimeAvailability: initialRuntime,
      locator: {
        kind: "workspace" as const,
        connectionProfileId: "profile-1",
        ...scope
      }
    };
    const { result, rerender } = renderHook(
      ({ props }) =>
        useWorkspaceRuntime({
          ...props,
          setError: vi.fn(),
          setSuccessMessage: vi.fn(),
          t: createTranslator("en"),
          api
        }),
      { initialProps: { props: workspaceProps } }
    );

    await act(async () => {
      await result.current.resetWorkspaceRuntime?.();
    });
    expect(result.current.authoritativeRuntime?.state).toMatchObject({ runtimeRevision: 2 });

    rerender({
      props: {
        ...workspaceProps,
        activeProfileId: null,
        activeProjectId: null,
        binding: null,
        initialRuntimeAvailability: null,
        locator: null
      }
    });
    rerender({
      props: {
        ...workspaceProps,
        initialRuntimeAvailability: reopenedRuntime
      }
    });

    await waitFor(() =>
      expect(result.current.authoritativeRuntime?.state).toMatchObject({ runtimeRevision: 3 })
    );
    expect(result.current.graph?.tasks.every((task) => task.status === "implemented")).toBe(true);
  });

  it("does not let a late accepted response overwrite a newer Server revision", async () => {
    let observer: ((signal: CollaborationObserverSignal) => void) | null = null;
    let resolveReset:
      | ((
          value: Awaited<ReturnType<WorkspaceRuntimeBridge["resetWorkspaceCanvasRuntime"]>>
        ) => void)
      | null = null;
    const resetOutcome = new Promise<
      Awaited<ReturnType<WorkspaceRuntimeBridge["resetWorkspaceCanvasRuntime"]>>
    >((resolve) => {
      resolveReset = resolve;
    });
    let resolveRead: ((value: ReturnType<typeof runtimeView>) => void) | null = null;
    const readOutcome = new Promise<ReturnType<typeof runtimeView>>((resolve) => {
      resolveRead = resolve;
    });
    const initialRuntime = runtimeView(1, graph.packageFingerprint, "implemented");
    const newerRuntime = runtimeView(3, graph.packageFingerprint, "ready");
    const resetRuntime = runtimeView(2, graph.packageFingerprint, "implemented");
    const api = {
      getCollaborationStatus: vi.fn().mockRejectedValue(new Error("observer unavailable")),
      readCollaborationCanvasBindingRuntimeAvailability: vi.fn().mockReturnValue(readOutcome),
      onCollaborationObserverSignal: vi.fn((listener) => {
        observer = listener;
        return () => undefined;
      }),
      resetWorkspaceCanvasRuntime: vi.fn().mockReturnValue(resetOutcome)
    } satisfies WorkspaceRuntimeBridge;
    const baseProps = {
      activeProfileId: "profile-1",
      activeProjectId: scope.projectId,
      graph,
      sessionConnected: true,
      binding: { kind: "remote" as const, ...scope },
      locator: {
        kind: "workspace" as const,
        connectionProfileId: "profile-1",
        ...scope
      }
    };
    const { result } = renderHook(() =>
      useWorkspaceRuntime({
        ...baseProps,
        initialRuntimeAvailability: initialRuntime,
        setError: vi.fn(),
        setSuccessMessage: vi.fn(),
        t: createTranslator("en"),
        api
      })
    );

    let pendingReset: Promise<void> | undefined;
    act(() => {
      pendingReset = result.current.resetWorkspaceRuntime?.();
    });
    act(() => {
      observer?.({
        type: "human.observer.event",
        profileId: "profile-1",
        projectId: scope.projectId,
        event: {
          kind: "runtime",
          sequence: 3,
          canvasId: scope.canvasId,
          runtimeRevision: 3
        }
      });
    });
    await waitFor(() =>
      expect(api.readCollaborationCanvasBindingRuntimeAvailability).toHaveBeenCalledOnce()
    );

    await act(async () => {
      resolveRead?.(newerRuntime);
      resolveReset?.({
        type: "canvas.runtime.reset.accepted",
        operationId: "operation-1",
        runtimeRevision: 2,
        sourceRevision: "source-2",
        graphFingerprint: graph.packageFingerprint,
        status: resetRuntime.execution.status
      });
      await pendingReset;
    });

    expect(result.current.authoritativeRuntime?.state).toMatchObject({ runtimeRevision: 3 });
    expect(result.current.graph?.tasks.every((task) => task.status === "ready")).toBe(true);
  });

  it("does not let a stale Server read overwrite a newer accepted revision", async () => {
    let observer: ((signal: CollaborationObserverSignal) => void) | null = null;
    let resolveRead: ((value: ReturnType<typeof runtimeView>) => void) | null = null;
    const readOutcome = new Promise<ReturnType<typeof runtimeView>>((resolve) => {
      resolveRead = resolve;
    });
    const initialRuntime = runtimeView(1, graph.packageFingerprint, "implemented");
    const staleRuntime = runtimeView(2, graph.packageFingerprint, "implemented");
    const resetRuntime = runtimeView(3, graph.packageFingerprint, "ready");
    const api = {
      getCollaborationStatus: vi.fn().mockRejectedValue(new Error("observer unavailable")),
      readCollaborationCanvasBindingRuntimeAvailability: vi.fn().mockReturnValue(readOutcome),
      onCollaborationObserverSignal: vi.fn((listener) => {
        observer = listener;
        return () => undefined;
      }),
      resetWorkspaceCanvasRuntime: vi.fn().mockResolvedValue({
        type: "canvas.runtime.reset.accepted" as const,
        operationId: "operation-1",
        runtimeRevision: 3,
        sourceRevision: "source-3",
        graphFingerprint: graph.packageFingerprint,
        status: resetRuntime.execution.status
      })
    } satisfies WorkspaceRuntimeBridge;
    const { result } = renderHook(() =>
      useWorkspaceRuntime({
        activeProfileId: "profile-1",
        activeProjectId: scope.projectId,
        graph,
        sessionConnected: true,
        binding: { kind: "remote", ...scope },
        initialRuntimeAvailability: initialRuntime,
        locator: {
          kind: "workspace",
          connectionProfileId: "profile-1",
          ...scope
        },
        setError: vi.fn(),
        setSuccessMessage: vi.fn(),
        t: createTranslator("en"),
        api
      })
    );

    act(() => {
      observer?.({
        type: "human.observer.event",
        profileId: "profile-1",
        projectId: scope.projectId,
        event: {
          kind: "runtime",
          sequence: 2,
          canvasId: scope.canvasId,
          runtimeRevision: 2
        }
      });
    });
    await waitFor(() =>
      expect(api.readCollaborationCanvasBindingRuntimeAvailability).toHaveBeenCalledOnce()
    );
    await act(async () => {
      await result.current.resetWorkspaceRuntime?.();
    });
    expect(result.current.authoritativeRuntime?.state).toMatchObject({ runtimeRevision: 3 });

    await act(async () => {
      resolveRead?.(staleRuntime);
    });

    expect(result.current.authoritativeRuntime?.state).toMatchObject({ runtimeRevision: 3 });
    expect(result.current.graph?.tasks.every((task) => task.status === "ready")).toBe(true);
  });

  it("ignores an accepted response after switching to another Workspace canvas", async () => {
    let resolveReset:
      | ((
          value: Awaited<ReturnType<WorkspaceRuntimeBridge["resetWorkspaceCanvasRuntime"]>>
        ) => void)
      | null = null;
    const resetOutcome = new Promise<
      Awaited<ReturnType<WorkspaceRuntimeBridge["resetWorkspaceCanvasRuntime"]>>
    >((resolve) => {
      resolveReset = resolve;
    });
    const scopeB = { ...scope, canvasId: "canvas-2" };
    const runtimeA = runtimeViewForScope(1, scope, "implemented");
    const runtimeB = runtimeViewForScope(5, scopeB, "ready");
    const resetRuntimeA = runtimeViewForScope(2, scope, "ready");
    const api = {
      getCollaborationStatus: vi.fn().mockRejectedValue(new Error("observer unavailable")),
      readCollaborationCanvasBindingRuntimeAvailability: vi.fn(),
      resetWorkspaceCanvasRuntime: vi.fn().mockReturnValue(resetOutcome)
    } satisfies WorkspaceRuntimeBridge;
    const { result, rerender } = renderHook(
      ({ currentScope, initialRuntimeAvailability }) =>
        useWorkspaceRuntime({
          activeProfileId: "profile-1",
          activeProjectId: currentScope.projectId,
          graph,
          sessionConnected: true,
          binding: { kind: "remote", ...currentScope },
          initialRuntimeAvailability,
          locator: {
            kind: "workspace",
            connectionProfileId: "profile-1",
            ...currentScope
          },
          setError: vi.fn(),
          setSuccessMessage: vi.fn(),
          t: createTranslator("en"),
          api
        }),
      { initialProps: { currentScope: scope, initialRuntimeAvailability: runtimeA } }
    );

    let pendingReset: Promise<void> | undefined;
    act(() => {
      pendingReset = result.current.resetWorkspaceRuntime?.();
    });
    rerender({ currentScope: scopeB, initialRuntimeAvailability: runtimeB });
    await waitFor(() =>
      expect(result.current.authoritativeRuntime?.state).toMatchObject({ runtimeRevision: 5 })
    );

    resolveReset?.({
      type: "canvas.runtime.reset.accepted",
      operationId: "operation-1",
      runtimeRevision: 2,
      sourceRevision: "source-2",
      graphFingerprint: graph.packageFingerprint,
      status: resetRuntimeA.execution.status
    });
    await act(async () => {
      await pendingReset;
    });

    expect(result.current.authoritativeRuntime?.state).toMatchObject({ runtimeRevision: 5 });
    expect(result.current.graph?.tasks.every((task) => task.status === "ready")).toBe(true);
  });
});
