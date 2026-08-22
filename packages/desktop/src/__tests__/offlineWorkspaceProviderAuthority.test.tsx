// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { collaborationRemoteCanvasReplicaProjectionSchema } from "../shared/canvasReplicaIpc.js";
import type { WorkspaceCanvasLocator } from "../shared/canvasLocator.js";
import { createTranslator } from "../renderer/i18n.js";
import { useRemoteCanvasWorkspace } from "../renderer/hooks/useRemoteCanvasWorkspace.js";
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
