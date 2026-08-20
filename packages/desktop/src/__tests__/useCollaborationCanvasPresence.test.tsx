/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { OnSelectionChangeParams } from "@xyflow/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCollaborationCanvasPresence } from "../renderer/hooks/useCollaborationCanvasPresence";
import type { CanvasPresenceBridge } from "../renderer/collaboration/CanvasPresenceController";
import type { CollaborationPresenceSignal } from "../shared/collaboration";
import { createTranslator } from "../renderer/i18n";

const t = createTranslator("en");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function bridgeFixture() {
  let onSignal: ((signal: CollaborationPresenceSignal) => void) | null = null;
  const api: CanvasPresenceBridge = {
    resolveCollaborationCanvasBindingScope: vi.fn(async (input) => ({
      workspaceId: "workspace-1",
      projectId: input.kind === "local" ? input.localProjectId : input.projectId,
      canvasId: input.canvasId
    })),
    startCollaborationPresence: vi.fn(async ({ canvasId }) => {
      queueMicrotask(() =>
        onSignal?.({
          profileId: "profile-1",
          message: {
            type: "canvas.presence.snapshot",
            protocolVersion: 1,
            projectId: "project-1",
            canvasId,
            sessions: []
          }
        })
      );
    }),
    stopCollaborationPresence: vi.fn().mockResolvedValue(undefined),
    publishCollaborationPresence: vi.fn().mockResolvedValue(undefined),
    onCollaborationPresenceSignal: vi.fn((callback) => {
      onSignal = callback;
      return () => {
        onSignal = null;
      };
    })
  };
  return {
    api,
    emit: (signal: CollaborationPresenceSignal) => onSignal?.(signal)
  };
}

const selection: OnSelectionChangeParams = {
  nodes: [{ id: "T-002" }],
  edges: [{ id: "T-002-depends_on-T-001" }]
};

describe("useCollaborationCanvasPresence", () => {
  it("does not start presence before collaboration is connected", async () => {
    const fixture = bridgeFixture();

    renderHook(() =>
      useCollaborationCanvasPresence({
        api: fixture.api,
        binding: { kind: "local", localProjectId: "project-1", canvasId: "canvas-main" },
        enabled: true,
        sessionConnected: false,
        profileId: "profile-1",
        activeProjectId: "project-1",
        t
      })
    );
    await act(async () => Promise.resolve());

    expect(fixture.api.startCollaborationPresence).not.toHaveBeenCalled();
  });

  it("publishes presence without depending on the Runtime availability bridge", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let frame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const fixture = bridgeFixture();
    expect(fixture.api).not.toHaveProperty("readCollaborationCanvasBindingRuntimeAvailability");
    const { result } = renderHook(() =>
      useCollaborationCanvasPresence({
        api: fixture.api,
        binding: { kind: "local", localProjectId: "project-1", canvasId: "canvas-main" },
        enabled: true,
        sessionConnected: true,
        profileId: "profile-1",
        activeProjectId: "project-1",
        t
      })
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(fixture.api.startCollaborationPresence).toHaveBeenCalled();

    act(() => result.current.onSelectionChange(selection));
    expect(fixture.api.publishCollaborationPresence).toHaveBeenCalledTimes(1);
    act(() => result.current.onSelectionChange(selection));
    expect(fixture.api.publishCollaborationPresence).toHaveBeenCalledTimes(1);

    act(() => result.current.onPointerMove({ x: 10, y: 20 }));
    act(() => result.current.onPointerMove({ x: 11, y: 21 }));
    act(() => frame?.(0));
    expect(fixture.api.publishCollaborationPresence).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(20);
      result.current.onPointerMove({ x: 12, y: 22 });
      frame?.(20);
    });
    expect(fixture.api.publishCollaborationPresence).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(30);
      frame?.(50);
    });
    expect(fixture.api.publishCollaborationPresence).toHaveBeenCalledTimes(3);
    expect(fixture.api.publishCollaborationPresence).toHaveBeenLastCalledWith({
      pointer: { x: 12, y: 22 },
      selectionIds: ["T-002", "T-002-depends_on-T-001"]
    });
  });

  it("renders validated remote snapshots and clears them when the canvas is hidden", async () => {
    const fixture = bridgeFixture();
    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useCollaborationCanvasPresence({
          api: fixture.api,
          binding: { kind: "local", localProjectId: "project-1", canvasId: "canvas-main" },
          enabled,
          sessionConnected: true,
          profileId: "profile-1",
          activeProjectId: "project-1",
          t
        }),
      { initialProps: { enabled: true } }
    );
    await waitFor(() => expect(fixture.api.startCollaborationPresence).toHaveBeenCalled());
    act(() =>
      fixture.emit({
        profileId: "profile-1",
        message: {
          type: "canvas.presence.snapshot",
          protocolVersion: 1,
          projectId: "project-1",
          canvasId: "canvas-main",
          sessions: [
            {
              identity: {
                sessionId: "session-b",
                humanPrincipalId: "human-b",
                displayName: "  Bob "
              },
              pointer: { x: 10, y: 20 },
              selectionIds: ["T-001"]
            }
          ]
        }
      })
    );
    expect(result.current.remoteSessions[0]?.displayName).toBe("Bob");
    rerender({ enabled: false });
    await waitFor(() => expect(result.current.remoteSessions).toEqual([]));
    expect(fixture.api.stopCollaborationPresence).toHaveBeenCalled();
  });

  it("resolves an imported local replica before starting presence", async () => {
    const fixture = bridgeFixture();
    vi.mocked(fixture.api.resolveCollaborationCanvasBindingScope).mockResolvedValue({
      workspaceId: "workspace-1",
      projectId: "remote-project",
      canvasId: "remote-canvas"
    });
    const { result } = renderHook(() =>
      useCollaborationCanvasPresence({
        api: fixture.api,
        binding: {
          kind: "local",
          localProjectId: "imported-local-project",
          canvasId: "default"
        },
        enabled: true,
        sessionConnected: true,
        profileId: "profile-1",
        activeProjectId: "remote-project",
        t
      })
    );

    await waitFor(() =>
      expect(fixture.api.resolveCollaborationCanvasBindingScope).toHaveBeenCalledWith({
        kind: "local",
        localProjectId: "imported-local-project",
        canvasId: "default"
      })
    );
    await waitFor(() =>
      expect(fixture.api.startCollaborationPresence).toHaveBeenCalledWith({
        canvasId: "remote-canvas"
      })
    );
    act(() => result.current.onSelectionChange(selection));
    expect(fixture.api.publishCollaborationPresence).toHaveBeenCalledTimes(1);
  });

  it("publishes pointer leave as null immediately without waiting for the 20Hz coalescer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let frame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const fixture = bridgeFixture();
    const { result } = renderHook(() =>
      useCollaborationCanvasPresence({
        api: fixture.api,
        binding: { kind: "local", localProjectId: "project-1", canvasId: "canvas-main" },
        enabled: true,
        sessionConnected: true,
        profileId: "profile-1",
        activeProjectId: "project-1",
        t
      })
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => result.current.onPointerMove({ x: 5, y: 6 }));
    act(() => frame?.(0));
    expect(fixture.api.publishCollaborationPresence).toHaveBeenLastCalledWith({
      pointer: { x: 5, y: 6 },
      selectionIds: []
    });
    act(() => result.current.onPointerLeave());
    expect(fixture.api.publishCollaborationPresence).toHaveBeenLastCalledWith({
      pointer: null,
      selectionIds: []
    });
  });
});
