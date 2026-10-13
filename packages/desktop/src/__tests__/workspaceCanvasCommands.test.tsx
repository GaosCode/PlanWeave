/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { createTranslator } from "../renderer/i18n";
import {
  type WorkspaceCanvasCommandBridge,
  useWorkspaceCanvasCommands
} from "../renderer/hooks/useWorkspaceCanvasCommands";
import type { WorkspaceCanvasProjection } from "../shared/workspaceCanvasProjection";

const locator = {
  kind: "workspace" as const,
  connectionProfileId: "profile-1",
  workspaceId: "workspace-1",
  projectId: "project-1",
  canvasId: "canvas-1"
};
const t = createTranslator("en");

function projection(readOnly = false): WorkspaceCanvasProjection {
  return {
    locator,
    status: "accepted",
    authorityMode: readOnly ? "offline_cache_readonly" : "server_authoritative",
    readOnly,
    cachedAt: readOnly ? "2026-08-22T00:00:00.000Z" : null,
    initialRuntimeAvailability: null,
    conflict: null,
    rejectCode: null,
    replica: {
      authorityId: "workspace:workspace-1:project-1:canvas-1",
      bindingKind: "remote",
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "canvas-1",
      revision: 4,
      contentDigest: "a".repeat(64),
      canEdit: !readOnly,
      optimisticOperationIds: [],
      rejections: [],
      content: {
        projectTitle: "Workspace plan",
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
          updatedAt: "2026-08-22T00:00:00.000Z"
        },
        blockDependenciesByRef: {},
        taskOpenFeedbackCountByTaskId: {},
        blockPromptMarkdownByRef: {}
      }
    }
  };
}

function projectionForLocator(
  nextLocator: WorkspaceCanvasProjection["locator"],
  initialRuntimeAvailability: WorkspaceCanvasProjection["initialRuntimeAvailability"] = null
): WorkspaceCanvasProjection {
  return {
    ...projection(),
    locator: nextLocator,
    initialRuntimeAvailability,
    replica: {
      ...projection().replica,
      workspaceId: nextLocator.workspaceId,
      projectId: nextLocator.projectId,
      canvasId: nextLocator.canvasId
    }
  };
}

function bridge(initial: WorkspaceCanvasProjection) {
  const submitWorkspaceCanvasCommand = vi.fn().mockResolvedValue(initial);
  const api: WorkspaceCanvasCommandBridge = {
    openWorkspaceCanvasSession: vi.fn().mockResolvedValue(initial),
    submitWorkspaceCanvasCommand,
    reconnectWorkspaceCanvasSession: vi.fn().mockResolvedValue(initial),
    closeWorkspaceCanvasSession: vi.fn().mockResolvedValue(undefined),
    onWorkspaceCanvasProjectionSignal: vi.fn(() => () => undefined)
  };
  return { api, submitWorkspaceCanvasCommand };
}

afterEach(cleanupRendererTestEnvironment);

describe("useWorkspaceCanvasCommands", () => {
  it("does not publish a retired error into the next Canvas render", async () => {
    const { api } = bridge(projection());
    vi.mocked(api.openWorkspaceCanvasSession).mockImplementation(async (requested) => {
      if (requested.canvasId === locator.canvasId) throw new Error("current_canvas_failure");
      return projectionForLocator(requested);
    });
    const renders: Array<{ canvasId: string | null; error: string | null }> = [];
    const { result, rerender } = renderHook(
      ({ selectedLocator }) => {
        const commands = useWorkspaceCanvasCommands({
          api,
          authorityKey: "test-authority",
          locator: selectedLocator,
          sessionConnected: true,
          t
        });
        renders.push({
          canvasId: selectedLocator?.canvasId ?? null,
          error: commands.snapshot.lastError
        });
        return commands;
      },
      { initialProps: { selectedLocator: locator as typeof locator | null } }
    );
    await waitFor(() => expect(result.current.snapshot.lastError).toBe("current_canvas_failure"));
    const nextLocator = { ...locator, canvasId: "canvas-next" };
    rerender({ selectedLocator: null });
    expect(result.current.snapshot.lastError).toBeNull();
    rerender({ selectedLocator: nextLocator });
    await waitFor(() => expect(result.current.projection?.canvasId).toBe(nextLocator.canvasId));
    expect(
      renders.filter((render) => render.canvasId !== locator.canvasId && render.error)
    ).toEqual([]);
  });

  it("ignores a retired reconnect after navigating A to B to A", async () => {
    const { api } = bridge(projection());
    api.openWorkspaceCanvasSession = vi.fn(async (requested) => projectionForLocator(requested));
    let finish!: (value: WorkspaceCanvasProjection) => void;
    api.reconnectWorkspaceCanvasSession = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const { result, rerender } = renderHook(
      ({ selectedLocator }) =>
        useWorkspaceCanvasCommands({
          api,
          authorityKey: "test-authority",
          locator: selectedLocator,
          sessionConnected: true,
          t
        }),
      { initialProps: { selectedLocator: locator } }
    );
    await waitFor(() => expect(result.current.projection?.revision).toBe(4));
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.reconnect();
    });
    rerender({ selectedLocator: { ...locator, canvasId: "canvas-next" } });
    await waitFor(() => expect(result.current.projection?.canvasId).toBe("canvas-next"));
    rerender({ selectedLocator: locator });
    await waitFor(() => expect(result.current.projection?.canvasId).toBe(locator.canvasId));
    await act(async () => {
      finish({ ...projection(), replica: { ...projection().replica, revision: 99 } });
      await expect(pending).resolves.toBe(false);
    });
    expect(result.current.projection?.revision).toBe(4);
  });

  it("ignores an old submission completion after navigating A to B to A", async () => {
    const { api, submitWorkspaceCanvasCommand } = bridge(projection());
    api.openWorkspaceCanvasSession = vi.fn(async (value) => projectionForLocator(value));
    let finish!: (value: WorkspaceCanvasProjection) => void;
    submitWorkspaceCanvasCommand.mockImplementation(
      () =>
        new Promise<WorkspaceCanvasProjection>((resolve) => {
          finish = resolve;
        })
    );
    const { result, rerender } = renderHook(
      ({ selectedLocator }) =>
        useWorkspaceCanvasCommands({
          api,
          authorityKey: "test-authority",
          locator: selectedLocator,
          sessionConnected: true,
          t
        }),
      { initialProps: { selectedLocator: locator } }
    );
    await waitFor(() => expect(result.current.snapshot.connectionPhase).toBe("connected"));
    let pending!: ReturnType<typeof result.current.submit>;
    act(() => {
      pending = result.current.submit({
        intent: { kind: "remove_task_dependency", fromTaskId: "A", toTaskId: "B" }
      });
    });
    rerender({ selectedLocator: { ...locator, canvasId: "canvas-2" } });
    await waitFor(() => expect(result.current.snapshot.session?.canvasId).toBe("canvas-2"));
    rerender({ selectedLocator: locator });
    await waitFor(() => expect(result.current.snapshot.session?.canvasId).toBe("canvas-1"));
    await act(async () => {
      finish({ ...projection(), replica: { ...projection().replica, revision: 99 } });
      await pending;
    });
    expect(result.current.snapshot.session?.revision).toBe(4);
  });

  it("does not call a collaboration adapter for a Local Canvas", () => {
    const openWorkspaceCanvasSession = vi.fn();
    const api: WorkspaceCanvasCommandBridge = {
      openWorkspaceCanvasSession,
      submitWorkspaceCanvasCommand: vi.fn(),
      reconnectWorkspaceCanvasSession: vi.fn(),
      closeWorkspaceCanvasSession: vi.fn(),
      onWorkspaceCanvasProjectionSignal: vi.fn(() => () => undefined)
    };
    const { result } = renderHook(() =>
      useWorkspaceCanvasCommands({
        api,
        authorityKey: "test-authority",
        locator: null,
        sessionConnected: true,
        t
      })
    );

    expect(result.current.enabled).toBe(false);
    expect(result.current.offline).toBe(false);
    expect(openWorkspaceCanvasSession).not.toHaveBeenCalled();
  });

  it("submits Workspace mutations through the Workspace session", async () => {
    const port = bridge(projection());
    const { result } = renderHook(() =>
      useWorkspaceCanvasCommands({
        api: port.api,
        authorityKey: "test-authority",
        locator,
        sessionConnected: true,
        t
      })
    );
    await waitFor(() => expect(result.current.projection?.revision).toBe(4));

    await act(async () => {
      await expect(
        result.current.submit({
          intent: {
            kind: "update_layout",
            nodes: [{ nodeId: "T-001", x: 1, y: 2 }],
            updatedAt: "2026-08-22T00:00:00.000Z"
          }
        })
      ).resolves.toMatchObject({ ok: true });
    });
    expect(port.submitWorkspaceCanvasCommand).toHaveBeenCalledTimes(1);
  });

  it("renders an offline cached snapshot read-only and rejects mutations", async () => {
    const port = bridge(projection(true));
    const { result } = renderHook(() =>
      useWorkspaceCanvasCommands({
        api: port.api,
        authorityKey: "test-authority",
        locator,
        sessionConnected: false,
        t
      })
    );
    await waitFor(() => expect(result.current.projection?.revision).toBe(4));

    expect(result.current.offline).toBe(true);
    expect(result.current.projection?.canEdit).toBe(false);
    await expect(
      result.current.submit({
        intent: {
          kind: "update_layout",
          nodes: [{ nodeId: "T-001", x: 1, y: 2 }],
          updatedAt: "2026-08-22T00:00:00.000Z"
        }
      })
    ).resolves.toMatchObject({ ok: false });
    expect(port.submitWorkspaceCanvasCommand).not.toHaveBeenCalled();
  });

  it("does not expose the previous Workspace projection while a new locator is opening", async () => {
    const nextLocator = { ...locator, canvasId: "canvas-2" };
    let resolveNext: ((value: WorkspaceCanvasProjection) => void) | null = null;
    const nextProjection = new Promise<WorkspaceCanvasProjection>((resolve) => {
      resolveNext = resolve;
    });
    const seed = {
      schemaVersion: "canvas-runtime-view/v1" as const,
      state: { kind: "uninitialized" as const },
      execution: {
        schemaVersion: "canvas-runtime-availability/v1" as const,
        kind: "unavailable" as const,
        reason: "runtime_not_attached" as const
      }
    };
    const api = bridge(projection()).api;
    vi.mocked(api.openWorkspaceCanvasSession).mockImplementation(async (requested) =>
      requested.canvasId === locator.canvasId ? projectionForLocator(locator, seed) : nextProjection
    );
    const { result, rerender } = renderHook(
      ({ selectedLocator }) =>
        useWorkspaceCanvasCommands({
          api,
          authorityKey: "test-authority",
          locator: selectedLocator,
          sessionConnected: true,
          t
        }),
      { initialProps: { selectedLocator: locator } }
    );
    await waitFor(() => expect(result.current.initialRuntimeAvailability).toEqual(seed));

    rerender({ selectedLocator: nextLocator });
    expect(result.current.projection).toBeNull();
    expect(result.current.initialRuntimeAvailability).toBeNull();

    act(() => resolveNext?.(projectionForLocator(nextLocator)));
    await waitFor(() => expect(result.current.projection?.canvasId).toBe(nextLocator.canvasId));
  });
});
