/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import {
  accessCapabilityFlags,
  type CurrentCanvasAccessView
} from "@planweave-ai/collaboration-protocol/access/control";
import { describe, expect, it, vi } from "vitest";
import {
  type WorkspaceAccessScopeApi,
  useWorkspaceAccessScope
} from "../renderer/hooks/useWorkspaceAccessScope";

const accessView: CurrentCanvasAccessView = {
  scope: {
    scopeKind: "canvas",
    workspaceId: "workspace-1",
    projectId: "remote-project",
    canvasId: "remote-canvas"
  },
  projectVisibility: "private",
  canvasVisibility: "shared",
  projectAclRevision: 1,
  canvasAclRevision: 2,
  project: {
    scope: {
      scopeKind: "project",
      workspaceId: "workspace-1",
      projectId: "remote-project",
      canvasId: null
    },
    aclRevision: 1,
    effectiveRole: "owner",
    roleSource: "scope_owner",
    capabilities: accessCapabilityFlags("owner"),
    disabledReason: null
  },
  canvas: {
    scope: {
      scopeKind: "canvas",
      workspaceId: "workspace-1",
      projectId: "remote-project",
      canvasId: "remote-canvas"
    },
    aclRevision: 2,
    effectiveRole: "owner",
    roleSource: "scope_owner",
    capabilities: accessCapabilityFlags("owner"),
    disabledReason: null
  },
  people: []
};

describe("useWorkspaceAccessScope", () => {
  it("loads a Workspace scope independently of the sidebar selection", async () => {
    const getCurrentCanvasAccess = vi.fn().mockResolvedValue(accessView);
    const updatedAt = "2026-08-22T00:00:00.000Z";
    const api: WorkspaceAccessScopeApi = {
      listCollaborationAuthorizedProjects: vi.fn().mockResolvedValue({
        items: [
          {
            schemaVersion: "project-access/v1",
            registry: {
              projectRegistryId: "registry-project-1",
              workspaceId: "workspace-1",
              projectId: "remote-project"
            },
            visibility: "private",
            acl: { revision: 1, updatedAt },
            owner: "principal-1",
            updatedAt
          }
        ],
        nextCursor: null
      }),
      listCollaborationAuthorizedCanvases: vi.fn().mockResolvedValue({
        items: [
          {
            schemaVersion: "project-access/v1",
            registry: {
              projectRegistryId: "registry-project-1",
              canvasRegistryId: "registry-canvas-1",
              workspaceId: "workspace-1",
              projectId: "remote-project",
              canvasId: "remote-canvas"
            },
            visibility: "shared",
            acl: { revision: 2, updatedAt },
            owner: "principal-1",
            updatedAt
          }
        ],
        nextCursor: null
      }),
      listWorkspaceCanvasSharingCandidates: vi.fn().mockResolvedValue([
        {
          localProjectId: "remote-project",
          projectName: "Tiny Notes",
          canvasId: "local-canvas",
          canvasName: "ACP validation",
          state: "published_shared",
          workspaceCanvasId: "remote-canvas",
          visibility: "shared"
        }
      ]),
      getCurrentCanvasAccess,
      mutateCurrentCanvasAccess: vi.fn()
    };

    const { result } = renderHook(() =>
      useWorkspaceAccessScope({
        api,
        connectionKey: "profile-1",
        status: {
          profiles: [{ profileId: "other-profile", projectId: "sidebar-project" }],
          session: { phase: "disconnected" },
          workspaceConnection: { status: "connected", workspaceId: "workspace-1" }
        }
      })
    );

    await waitFor(() => expect(result.current.access.view).toEqual(accessView));

    expect(result.current.options).toEqual([
      {
        key: "remote-project\0remote-canvas",
        projectId: "remote-project",
        canvasId: "remote-canvas",
        projectLabel: "Tiny Notes",
        canvasLabel: "ACP validation"
      }
    ]);
    expect(result.current.error).toBeNull();
    expect(result.current.selectedKey).toBe("remote-project\0remote-canvas");
    expect(getCurrentCanvasAccess).toHaveBeenCalledWith({
      canvasId: "remote-canvas",
      projectId: "remote-project"
    });

    const previousPage = await api.listCollaborationAuthorizedCanvases({
      projectId: "remote-project"
    });
    vi.mocked(api.listCollaborationAuthorizedCanvases).mockResolvedValue({
      ...previousPage,
      items: previousPage.items.map((canvas) => ({
        ...canvas,
        registry: { ...canvas.registry, canvasId: "replacement-canvas" }
      }))
    });
    await act(async () => {
      await result.current.refreshOptions();
    });
    expect(result.current.selectedKey).toBe("remote-project\0remote-canvas");
    expect(result.current.selectedOption).toBeNull();
    expect(result.current.access.view).toBeNull();
    expect(getCurrentCanvasAccess).not.toHaveBeenCalledWith(
      expect.objectContaining({ canvasId: "replacement-canvas" })
    );
  });
});
