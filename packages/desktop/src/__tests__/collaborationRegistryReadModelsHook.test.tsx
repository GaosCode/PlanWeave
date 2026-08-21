// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCollaborationRegistryReadModels } from "../renderer/hooks/useCollaborationRegistryReadModels.js";
import { useRemoteCanvasWorkspace } from "../renderer/hooks/useRemoteCanvasWorkspace.js";

const canvas = {
  schemaVersion: "project-access/v1" as const,
  registry: {
    projectRegistryId: "project-registry-1",
    canvasRegistryId: "canvas-registry-1",
    workspaceId: "workspace-1",
    projectId: "project-a",
    canvasId: "canvas-a"
  },
  visibility: "workspace" as const,
  acl: { revision: 1, updatedAt: "2030-01-01T00:00:00.000Z" },
  owner: "human-1",
  updatedAt: "2030-01-01T00:00:00.000Z"
};

describe("useCollaborationRegistryReadModels", () => {
  it("loads project and selected-canvas read models through the typed bridge", async () => {
    const api = {
      listCollaborationAuthorizedProjects: vi.fn(async () => ({ items: [], nextCursor: 3 })),
      listCollaborationAuthorizedCanvases: vi.fn(async () => ({ items: [], nextCursor: 5 }))
    };
    const { result, rerender } = renderHook(
      ({ refreshKey }) =>
        useCollaborationRegistryReadModels({
          api,
          projectId: "project-a",
          projectPage: { cursor: 2, limit: 1 },
          canvasPage: { cursor: 4, limit: 1 },
          refreshKey
        }),
      { initialProps: { refreshKey: 0 } }
    );

    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(api.listCollaborationAuthorizedProjects).toHaveBeenCalledWith({ cursor: 2, limit: 1 });
    expect(api.listCollaborationAuthorizedCanvases).toHaveBeenCalledWith({
      projectId: "project-a",
      cursor: 4,
      limit: 1
    });
    expect(result.current.projects).toEqual([]);
    expect(result.current.canvases).toEqual([]);
    expect(result.current.projectNextCursor).toBe(3);
    expect(result.current.canvasNextCursor).toBe(5);

    rerender({ refreshKey: 0 });
    expect(api.listCollaborationAuthorizedProjects).toHaveBeenCalledTimes(1);
    expect(api.listCollaborationAuthorizedCanvases).toHaveBeenCalledTimes(1);
    rerender({ refreshKey: 1 });
    await waitFor(() => expect(api.listCollaborationAuthorizedProjects).toHaveBeenCalledTimes(2));
    expect(api.listCollaborationAuthorizedCanvases).toHaveBeenCalledTimes(2);
  });

  it("redacts bridge failures to a stable read-model error", async () => {
    const api = {
      listCollaborationAuthorizedProjects: vi.fn(async () => {
        throw new Error("absolute path /srv/private/project");
      }),
      listCollaborationAuthorizedCanvases: vi.fn(async () => ({ items: [], nextCursor: null }))
    };
    const { result } = renderHook(() => useCollaborationRegistryReadModels({ api }));

    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error).toBe("collaboration_registry_read_failed");
    expect(result.current.error).not.toContain("/srv");
  });
});

describe("useRemoteCanvasWorkspace", () => {
  it("does not request registry data without an active collaboration session", async () => {
    const api = {
      listCollaborationAuthorizedProjects: vi.fn(async () => {
        throw new Error("collaboration_session_inactive");
      }),
      listCollaborationAuthorizedCanvases: vi.fn(async () => ({ items: [], nextCursor: null }))
    };
    const { result } = renderHook(() =>
      useRemoteCanvasWorkspace({
        activeProjectId: null,
        localProjectId: null,
        sessionConnected: false,
        api
      })
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.listCollaborationAuthorizedProjects).not.toHaveBeenCalled();
    expect(api.listCollaborationAuthorizedCanvases).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
    expect(result.current.error).toBeNull();
  });

  it("selects only an authorized canvas with exact remote identity and clears it offline", async () => {
    const api = {
      listCollaborationAuthorizedProjects: vi.fn(async () => ({ items: [], nextCursor: null })),
      listCollaborationAuthorizedCanvases: vi.fn(async () => ({
        items: [canvas],
        nextCursor: null
      }))
    };
    const { result, rerender } = renderHook(
      ({ connected, localProjectId }) =>
        useRemoteCanvasWorkspace({
          activeProjectId: "project-a",
          localProjectId,
          sessionConnected: connected,
          api
        }),
      { initialProps: { connected: true, localProjectId: null as string | null } }
    );

    await waitFor(() => expect(result.current.authorizedCanvases).toEqual([canvas]));
    act(() => result.current.select(canvas));
    expect(result.current.binding).toEqual({
      kind: "remote",
      workspaceId: "workspace-1",
      projectId: "project-a",
      canvasId: "canvas-a"
    });

    rerender({ connected: true, localProjectId: "local-project" });
    await waitFor(() => expect(result.current.binding).toBeNull());

    rerender({ connected: true, localProjectId: null });
    act(() => result.current.select(canvas));
    rerender({ connected: false, localProjectId: null });
    await waitFor(() => expect(result.current.binding).toBeNull());
  });
});
