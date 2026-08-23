/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { graph as graphFixture } from "./helpers/graphFixtures";
import type { CollaborationObserverSignal } from "../shared/collaborationReadModels";
import {
  type WorkspaceRuntimeAvailabilityBridge,
  useWorkspaceRuntimeAvailability
} from "../renderer/hooks/useWorkspaceRuntimeAvailability";

const scope = { workspaceId: "workspace-1", projectId: "project-1", canvasId: "canvas-1" };
const graph = {
  ...graphFixture,
  tasks: graphFixture.tasks.map((task) => ({ ...task, blocks: [], blockPreview: [] }))
};

function runtimeView(runtimeRevision: number) {
  const status = {
    schemaVersion: "canvas-runtime-status/v2" as const,
    scope,
    packageFingerprint: graph.packageFingerprint,
    capturedAt: "2026-08-22T00:00:00.000Z",
    tasks: graph.tasks.map((task) => ({
      taskId: task.taskId,
      status: task.status,
      openFeedbackCount: 0
    })),
    blocks: []
  };
  return {
    schemaVersion: "canvas-runtime-view/v1" as const,
    state: { kind: "initialized" as const, runtimeRevision, status },
    execution: {
      schemaVersion: "canvas-runtime-availability/v1" as const,
      kind: "available" as const,
      status,
      sourceRevision: `source-${runtimeRevision}`,
      graphFingerprint: graph.packageFingerprint
    }
  };
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

  it("fails closed while the Workspace session is disconnected", () => {
    const fixture = createApi();
    const { result } = renderHook(() =>
      useWorkspaceRuntimeAvailability({ ...input(fixture.api), sessionConnected: false })
    );

    expect(result.current.availability).toEqual({ kind: "server_disconnected" });
    expect(
      result.current.graph?.tasks.every((task) => task.blocks.every((block) => !block.dispatchable))
    ).toBe(true);
    expect(fixture.read).not.toHaveBeenCalled();
  });
});
