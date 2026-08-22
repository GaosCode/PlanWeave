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

  it("selects only an authorized canvas with exact remote identity and retains it offline", async () => {
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
          connectionProfileId: "profile-1",
          localProjectId,
          sessionConnected: connected,
          api
        }),
      { initialProps: { connected: true, localProjectId: null as string | null } }
    );

    await waitFor(() => expect(result.current.authorizedCanvases).toEqual([canvas]));
    act(() => result.current.select(canvas));
    expect(result.current.locator).toEqual({
      kind: "workspace",
      connectionProfileId: "profile-1",
      workspaceId: "workspace-1",
      projectId: "project-a",
      canvasId: "canvas-a"
    });
    expect(result.current.binding).toEqual({
      kind: "remote",
      workspaceId: "workspace-1",
      projectId: "project-a",
      canvasId: "canvas-a"
    });
    expect(result.current.binding).not.toHaveProperty("connectionProfileId");

    rerender({ connected: true, localProjectId: "local-project" });
    await waitFor(() => expect(result.current.binding).toBeNull());

    rerender({ connected: true, localProjectId: null });
    act(() => result.current.select(canvas));
    rerender({ connected: false, localProjectId: null });
    await waitFor(() =>
      expect(result.current.binding).toEqual({
        kind: "remote",
        workspaceId: "workspace-1",
        projectId: "project-a",
        canvasId: "canvas-a"
      })
    );
  });

  it("restores a persisted exact Workspace locator while disconnected, then revalidates online", async () => {
    const persisted = {
      kind: "workspace" as const,
      connectionProfileId: "profile-1",
      workspaceId: "workspace-1",
      projectId: "project-a",
      canvasId: "cached-canvas"
    };
    const api = {
      listCollaborationAuthorizedProjects: vi.fn(async () => ({ items: [], nextCursor: null })),
      listCollaborationAuthorizedCanvases: vi.fn(async () => ({
        items: [canvas],
        nextCursor: null
      }))
    };
    const { result, rerender } = renderHook(
      ({ connected, activeProjectId, connectionProfileId }) =>
        useRemoteCanvasWorkspace({
          activeProjectId,
          connectionProfileId,
          lastOpenedWorkspaceLocator: persisted,
          localProjectId: null,
          sessionConnected: connected,
          api
        }),
      {
        initialProps: {
          connected: false,
          activeProjectId: undefined as string | undefined,
          connectionProfileId: undefined as string | undefined
        }
      }
    );

    await waitFor(() => expect(result.current.locator).toEqual(persisted));
    expect(result.current.connectionProfileId).toBe("profile-1");
    expect(result.current.activeProjectId).toBe("project-a");
    expect(api.listCollaborationAuthorizedCanvases).not.toHaveBeenCalled();

    rerender({
      connected: true,
      activeProjectId: persisted.projectId,
      connectionProfileId: persisted.connectionProfileId
    });
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    await waitFor(() => expect(result.current.locator).toBeNull());
  });

  it("restores a persisted Workspace locator after the authorized catalog is ready", async () => {
    const persisted = {
      kind: "workspace" as const,
      connectionProfileId: "profile-1",
      workspaceId: "workspace-1",
      projectId: "project-a",
      canvasId: "canvas-a"
    };
    const onWorkspaceLocatorOpened = vi.fn();
    let resolveCatalog!: (page: { items: (typeof canvas)[]; nextCursor: null }) => void;
    const pendingCatalog = new Promise<{ items: (typeof canvas)[]; nextCursor: null }>(
      (resolve) => {
        resolveCatalog = resolve;
      }
    );
    const api = {
      listCollaborationAuthorizedProjects: vi.fn(async () => ({ items: [], nextCursor: null })),
      listCollaborationAuthorizedCanvases: vi.fn(async () => pendingCatalog)
    };
    const { result } = renderHook(() =>
      useRemoteCanvasWorkspace({
        activeProjectId: "project-a",
        connectionProfileId: "profile-1",
        lastOpenedWorkspaceLocator: persisted,
        localProjectId: null,
        onWorkspaceLocatorOpened,
        sessionConnected: true,
        api
      })
    );

    await waitFor(() => expect(result.current.phase).toBe("loading"));
    expect(result.current.locator).toBeNull();
    expect(result.current.binding).toBeNull();

    await act(async () => {
      resolveCatalog({ items: [canvas], nextCursor: null });
    });

    await waitFor(() => expect(result.current.locator).toEqual(persisted));
    expect(result.current.binding).toEqual({
      kind: "remote",
      workspaceId: "workspace-1",
      projectId: "project-a",
      canvasId: "canvas-a"
    });
    expect(onWorkspaceLocatorOpened).not.toHaveBeenCalled();
  });

  it("does not restore a persisted Workspace locator missing from the authorized catalog", async () => {
    const persisted = {
      kind: "workspace" as const,
      connectionProfileId: "profile-1",
      workspaceId: "workspace-1",
      projectId: "project-a",
      canvasId: "expired-canvas"
    };
    const api = {
      listCollaborationAuthorizedProjects: vi.fn(async () => ({ items: [], nextCursor: null })),
      listCollaborationAuthorizedCanvases: vi.fn(async () => ({
        items: [canvas],
        nextCursor: null
      }))
    };
    const { result } = renderHook(() =>
      useRemoteCanvasWorkspace({
        activeProjectId: "project-a",
        connectionProfileId: "profile-1",
        lastOpenedWorkspaceLocator: persisted,
        localProjectId: null,
        sessionConnected: true,
        api
      })
    );

    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(result.current.locator).toBeNull();
    expect(result.current.binding).toBeNull();
  });

  it("clears a selected Workspace locator after it leaves the authorized catalog", async () => {
    let items = [canvas];
    const api = {
      listCollaborationAuthorizedProjects: vi.fn(async () => ({ items: [], nextCursor: null })),
      listCollaborationAuthorizedCanvases: vi.fn(async () => ({ items, nextCursor: null }))
    };
    const { result } = renderHook(() =>
      useRemoteCanvasWorkspace({
        activeProjectId: "project-a",
        connectionProfileId: "profile-1",
        localProjectId: null,
        sessionConnected: true,
        api
      })
    );

    await waitFor(() => expect(result.current.authorizedCanvases).toEqual([canvas]));
    act(() => result.current.select(canvas));
    expect(result.current.locator?.canvasId).toBe("canvas-a");

    items = [];
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.phase).toBe("ready");
    expect(result.current.locator).toBeNull();
    expect(result.current.binding).toBeNull();
  });

  it("persists the Workspace locator chosen from the catalog", async () => {
    const onWorkspaceLocatorOpened = vi.fn();
    const api = {
      listCollaborationAuthorizedProjects: vi.fn(async () => ({ items: [], nextCursor: null })),
      listCollaborationAuthorizedCanvases: vi.fn(async () => ({
        items: [canvas],
        nextCursor: null
      }))
    };
    const { result } = renderHook(() =>
      useRemoteCanvasWorkspace({
        activeProjectId: "project-a",
        connectionProfileId: "profile-1",
        localProjectId: null,
        onWorkspaceLocatorOpened,
        sessionConnected: true,
        api
      })
    );

    await waitFor(() => expect(result.current.authorizedCanvases).toEqual([canvas]));
    act(() => result.current.select(canvas));

    expect(onWorkspaceLocatorOpened).toHaveBeenCalledWith({
      kind: "workspace",
      connectionProfileId: "profile-1",
      workspaceId: "workspace-1",
      projectId: "project-a",
      canvasId: "canvas-a"
    });
  });

  it("keeps an explicitly opened locator before the registry lists the new canvas", async () => {
    const onWorkspaceLocatorOpened = vi.fn();
    const api = {
      listCollaborationAuthorizedProjects: vi.fn(async () => ({ items: [], nextCursor: null })),
      listCollaborationAuthorizedCanvases: vi.fn(async () => ({ items: [], nextCursor: null }))
    };
    const locator = {
      kind: "workspace" as const,
      connectionProfileId: "profile-1",
      workspaceId: "workspace-1",
      projectId: "project-a",
      canvasId: "canvas-new"
    };
    const { result } = renderHook(() =>
      useRemoteCanvasWorkspace({
        activeProjectId: "project-a",
        connectionProfileId: "profile-1",
        localProjectId: null,
        onWorkspaceLocatorOpened,
        sessionConnected: true,
        api
      })
    );

    await waitFor(() => expect(result.current.phase).toBe("ready"));
    act(() => result.current.openLocator(locator));
    expect(result.current.locator).toEqual(locator);
    expect(onWorkspaceLocatorOpened).toHaveBeenCalledWith(locator);
  });
});
