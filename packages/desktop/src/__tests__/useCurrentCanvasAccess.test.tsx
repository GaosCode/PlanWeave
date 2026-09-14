/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import {
  accessCapabilityFlags,
  activeCanvasPersonGrantSchema,
  canvasPersonAccessViewSchema,
  type CurrentCanvasAccessView
} from "@planweave-ai/collaboration-protocol/access/control";
import { describe, expect, it, vi } from "vitest";
import {
  type CurrentCanvasAccessApi,
  useCurrentCanvasAccess
} from "../renderer/hooks/useCurrentCanvasAccess";

const scope = {
  scopeKind: "canvas" as const,
  workspaceId: "workspace-access-001",
  projectId: "project-access-001",
  canvasId: "canvas-access-001"
};

const view: CurrentCanvasAccessView = {
  scope,
  projectVisibility: "private",
  canvasVisibility: "shared",
  projectAclRevision: 3,
  canvasAclRevision: 5,
  project: {
    scope: { ...scope, scopeKind: "project", canvasId: null },
    aclRevision: 3,
    effectiveRole: "owner",
    roleSource: "scope_owner",
    capabilities: accessCapabilityFlags("owner"),
    disabledReason: null
  },
  canvas: {
    scope,
    aclRevision: 5,
    effectiveRole: "owner",
    roleSource: "scope_owner",
    capabilities: accessCapabilityFlags("owner"),
    disabledReason: null
  },
  people: []
};

describe("useCurrentCanvasAccess", () => {
  it("does not load access controls until a prepared local session is connected", async () => {
    const getCurrentCanvasAccess = vi.fn().mockResolvedValue(view);
    const api: CurrentCanvasAccessApi = {
      getCurrentCanvasAccess,
      mutateCurrentCanvasAccess: vi.fn()
    };

    const { result } = renderHook(() =>
      useCurrentCanvasAccess({
        api,
        canvasId: scope.canvasId,
        status: {
          session: { phase: "ready" },
          workspaceConnection: { status: "local_only" }
        }
      })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.view).toBeNull();
    expect(getCurrentCanvasAccess).not.toHaveBeenCalled();
  });

  it("uses the matching project revision and refreshes after a CAS conflict", async () => {
    const getCurrentCanvasAccess = vi.fn().mockResolvedValue(view);
    const mutateCurrentCanvasAccess = vi.fn().mockResolvedValue({
      status: "conflict",
      reason: "acl_revision_conflict",
      aclRevision: 4
    });
    const api: CurrentCanvasAccessApi = {
      getCurrentCanvasAccess,
      mutateCurrentCanvasAccess
    };
    const { result } = renderHook(() =>
      useCurrentCanvasAccess({
        api,
        canvasId: scope.canvasId,
        status: {
          session: { phase: "connected" },
          workspaceConnection: { status: "connected" }
        }
      })
    );

    await waitFor(() => expect(result.current.view).toEqual(view));
    await result.current.updateVisibility("project", "shared");

    expect(mutateCurrentCanvasAccess).toHaveBeenCalledWith({
      canvasId: scope.canvasId,
      request: {
        operation: "visibility",
        scope: {
          scopeKind: "project",
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          canvasId: null
        },
        expectedAclRevision: 3,
        visibility: "shared"
      }
    });
    await waitFor(() => expect(getCurrentCanvasAccess).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.error).toBe("acl_revision_conflict"));
  });

  it("uses the canvas revision for exact grant and revoke commands", async () => {
    const getCurrentCanvasAccess = vi.fn().mockResolvedValue(view);
    const mutateCurrentCanvasAccess = vi.fn().mockResolvedValue({
      status: "applied",
      aclRevision: 6,
      updatedAt: "2030-01-01T00:00:00.000Z"
    });
    const api: CurrentCanvasAccessApi = { getCurrentCanvasAccess, mutateCurrentCanvasAccess };
    const person = canvasPersonAccessViewSchema.parse({
      humanPrincipalId: "human-member-001",
      displayName: "Member",
      membership: "active",
      effectiveRole: "viewer",
      capabilities: accessCapabilityFlags("viewer"),
      disabledReason: null,
      grants: []
    });
    const grant = activeCanvasPersonGrantSchema.parse({
      grantId: "grant-canvas-viewer-001",
      scopeKind: "canvas",
      role: "viewer"
    });
    const { result } = renderHook(() =>
      useCurrentCanvasAccess({
        api,
        canvasId: scope.canvasId,
        status: {
          session: { phase: "connected" },
          workspaceConnection: { status: "connected" }
        }
      })
    );

    await waitFor(() => expect(result.current.view).toEqual(view));
    await result.current.grant(person.humanPrincipalId, "editor", "canvas");
    await result.current.revoke(grant);

    expect(mutateCurrentCanvasAccess).toHaveBeenNthCalledWith(1, {
      canvasId: scope.canvasId,
      request: {
        operation: "grant",
        scope,
        expectedAclRevision: 5,
        humanPrincipalId: person.humanPrincipalId,
        role: "editor"
      }
    });
    expect(mutateCurrentCanvasAccess).toHaveBeenNthCalledWith(2, {
      canvasId: scope.canvasId,
      request: {
        operation: "revoke",
        scope,
        expectedAclRevision: 5,
        grantId: grant.grantId
      }
    });
  });
  it("rejects a stale mutation callback after switching the explicit canvas scope", async () => {
    const getCurrentCanvasAccess = vi.fn().mockResolvedValue(view);
    const mutateCurrentCanvasAccess = vi.fn();
    const api = { getCurrentCanvasAccess, mutateCurrentCanvasAccess };
    const { result, rerender } = renderHook(
      ({ canvasId }) =>
        useCurrentCanvasAccess({
          api,
          canvasId,
          projectId: scope.projectId,
          connectionKey: "workspace-profile",
          status: { session: { phase: "connected" }, workspaceConnection: { status: "connected" } }
        }),
      { initialProps: { canvasId: scope.canvasId } }
    );
    await waitFor(() => expect(result.current.view).toEqual(view));
    const oldSave = result.current.updateVisibility;
    getCurrentCanvasAccess.mockReturnValue(new Promise(() => {}));
    rerender({ canvasId: "different-canvas" });
    expect(result.current.view).toBeNull();
    await act(async () => {
      expect(await oldSave("canvas", "private")).toBeNull();
    });
    expect(mutateCurrentCanvasAccess).not.toHaveBeenCalled();
  });
});
