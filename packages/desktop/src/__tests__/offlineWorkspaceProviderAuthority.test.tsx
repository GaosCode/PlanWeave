// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { useEffect, useMemo } from "react";
import { describe, expect, it, vi } from "vitest";
import { collaborationRemoteCanvasReplicaProjectionSchema } from "../shared/canvasReplicaIpc.js";
import type { WorkspaceCanvasLocator } from "../shared/canvasLocator.js";
import { createTranslator } from "../renderer/i18n.js";
import { useRemoteCanvasWorkspace } from "../renderer/hooks/useRemoteCanvasWorkspace.js";
import { canvasReplicaProjectionToDesktopGraph } from "../renderer/collaboration/canvasReplicaGraphAdapter.js";
import type { WorkspaceCanvasProjection } from "../shared/workspaceCanvasProjection.js";
import {
  type WorkspaceCanvasCommandBridge,
  useWorkspaceCanvasCommands
} from "../renderer/hooks/useWorkspaceCanvasCommands.js";

const locator: WorkspaceCanvasLocator = {
  kind: "workspace",
  connectionProfileId: "profile-offline",
  workspaceId: "workspace-1",
  projectId: "project-1",
  canvasId: "canvas-1"
};
const translator = createTranslator("en");

function cachedProjection() {
  return collaborationRemoteCanvasReplicaProjectionSchema.parse({
    authorityId: "profile-offline\u0000https://workspace.example.test\u0000project-1",
    bindingKind: "remote",
    workspaceId: locator.workspaceId,
    projectId: locator.projectId,
    canvasId: locator.canvasId,
    revision: 4,
    contentDigest: "a".repeat(64),
    canEdit: false,
    optimisticOperationIds: [],
    rejections: [],
    content: {
      projectTitle: "Cached Workspace",
      graphVersion: "1",
      packageFingerprint: `pkg-${"b".repeat(64)}`,
      tasks: [],
      edges: [],
      sharedResourceGroups: [],
      diagnostics: [],
      layout: {
        version: "desktop-layout/v1",
        projectId: locator.projectId,
        nodes: [],
        updatedAt: "2026-08-22T00:00:00.000Z"
      },
      blockDependenciesByRef: {},
      taskOpenFeedbackCountByTaskId: {},
      blockPromptMarkdownByRef: {}
    }
  });
}

function createBridge(
  openWorkspaceCanvasSession: WorkspaceCanvasCommandBridge["openWorkspaceCanvasSession"]
) {
  const submitWorkspaceCanvasCommand = vi.fn();
  const api = {
    openWorkspaceCanvasSession,
    submitWorkspaceCanvasCommand,
    reconnectWorkspaceCanvasSession: vi.fn(async () => {
      throw new Error("offline_reconnect_must_not_run");
    }),
    closeWorkspaceCanvasSession: vi.fn(async () => undefined),
    onWorkspaceCanvasProjectionSignal: vi.fn(() => () => undefined)
  } satisfies WorkspaceCanvasCommandBridge;
  return { api, submitWorkspaceCanvasCommand };
}

function useOfflineWorkspaceProviderPipeline(api: WorkspaceCanvasCommandBridge) {
  const remoteWorkspace = useRemoteCanvasWorkspace({
    lastOpenedWorkspaceLocator: locator,
    localProjectId: null,
    sessionConnected: false,
    api: null
  });
  const commands = useWorkspaceCanvasCommands({
    api,
    locator: remoteWorkspace.locator,
    sessionConnected: false,
    t: translator
  });
  return { remoteWorkspace, commands };
}

describe("offline Workspace Provider authority", () => {
  it("does not rebuild the restored graph on unrelated renders while offline", async () => {
    const replica = cachedProjection();
    const open = vi.fn(async () => ({
      locator,
      status: "accepted" as const,
      authorityMode: "offline_cache_readonly" as const,
      readOnly: true,
      cachedAt: "2026-08-22T00:00:00.000Z",
      initialRuntimeAvailability: null,
      conflict: null,
      rejectCode: null,
      replica
    }));
    const bridge = createBridge(open);
    const rebuildGraph = vi.fn();
    const { result, rerender } = renderHook(() => {
      const { commands } = useOfflineWorkspaceProviderPipeline(bridge.api);
      const graph = useMemo(
        () =>
          commands.projection
            ? canvasReplicaProjectionToDesktopGraph(commands.projection, null)
            : null,
        [commands.projection]
      );
      useEffect(() => {
        if (graph) rebuildGraph(graph);
      }, [graph]);
      return { commands, graph };
    });

    await waitFor(() => expect(result.current.graph?.projectTitle).toBe("Cached Workspace"));
    const restored = result.current;
    rebuildGraph.mockClear();
    rerender();
    rerender();

    expect(rebuildGraph).not.toHaveBeenCalled();
    expect(result.current.graph).toBe(restored.graph);
    expect(result.current.commands).toBe(restored.commands);
    expect(result.current.commands.projection).toMatchObject({
      canEdit: false,
      optimisticOperationIds: []
    });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("replaces the read-only cache with fresh Server content after reconnection", async () => {
    const cached: WorkspaceCanvasProjection = {
      locator,
      status: "accepted",
      authorityMode: "offline_cache_readonly",
      readOnly: true,
      cachedAt: "2026-08-22T00:00:00.000Z",
      initialRuntimeAvailability: null,
      conflict: null,
      rejectCode: null,
      replica: cachedProjection()
    };
    const connected: WorkspaceCanvasProjection = {
      ...cached,
      authorityMode: "server_authoritative",
      readOnly: false,
      cachedAt: null,
      replica: {
        ...cached.replica,
        revision: 5,
        canEdit: true,
        content: { ...cached.replica.content, projectTitle: "Updated Workspace" }
      }
    };
    const open = vi
      .fn<WorkspaceCanvasCommandBridge["openWorkspaceCanvasSession"]>()
      .mockResolvedValueOnce(cached)
      .mockResolvedValue(connected);
    const bridge = createBridge(open);
    const { result, rerender } = renderHook(
      ({ sessionConnected }) =>
        useWorkspaceCanvasCommands({ api: bridge.api, locator, sessionConnected, t: translator }),
      { initialProps: { sessionConnected: false } }
    );

    await waitFor(() => expect(result.current.projection?.revision).toBe(4));
    const offlineProjection = result.current.projection;
    expect(result.current.offline).toBe(true);

    rerender({ sessionConnected: true });

    await waitFor(() => expect(result.current.projection?.revision).toBe(5));
    expect(result.current.offline).toBe(false);
    expect(result.current.projection).toBe(connected.replica);
    expect(result.current.projection?.content.projectTitle).toBe("Updated Workspace");
    expect(result.current.projection?.canEdit).toBe(true);
    expect(offlineProjection?.canEdit).toBe(false);
    expect(cached.replica.canEdit).toBe(false);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("opens a persisted Workspace cache and exposes it read-only without local fallback", async () => {
    const replica = cachedProjection();
    const open = vi.fn(async () => ({
      locator,
      status: "accepted" as const,
      authorityMode: "offline_cache_readonly" as const,
      readOnly: true,
      cachedAt: "2026-08-22T00:00:00.000Z",
      conflict: null,
      rejectCode: null,
      replica
    }));
    const bridge = createBridge(open);
    const { result } = renderHook(() => useOfflineWorkspaceProviderPipeline(bridge.api));

    await waitFor(() => expect(open).toHaveBeenCalledWith(locator));
    await waitFor(() => expect(result.current.commands.projection?.revision).toBe(4));
    expect(result.current.commands).toMatchObject({ offline: true, enabled: true });
    expect(result.current.commands.projection?.canEdit).toBe(false);

    await act(async () => {
      await expect(
        result.current.commands.submit({
          intent: {
            kind: "update_layout",
            nodes: [{ nodeId: "T-001", x: 1, y: 2 }],
            updatedAt: "2026-08-22T00:00:00.000Z"
          }
        })
      ).resolves.toMatchObject({ ok: false });
    });
    expect(bridge.submitWorkspaceCanvasCommand).not.toHaveBeenCalled();
  });

  it("surfaces a missing-cache error without opening a Local Canvas", async () => {
    const open = vi.fn(async () => {
      throw new Error("workspace_canvas_offline_cache_unavailable");
    });
    const bridge = createBridge(open);
    const { result } = renderHook(() => useOfflineWorkspaceProviderPipeline(bridge.api));

    await waitFor(() => expect(open).toHaveBeenCalledWith(locator));
    await waitFor(() =>
      expect(result.current.commands.snapshot.lastError).toBe(
        "workspace_canvas_offline_cache_unavailable"
      )
    );
    expect(result.current.commands.projection).toBeNull();
  });
});
