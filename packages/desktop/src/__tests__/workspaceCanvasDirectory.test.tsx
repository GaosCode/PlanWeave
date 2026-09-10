/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CanvasAccessRecord,
  ProjectAccessRecord
} from "@planweave-ai/collaboration-protocol/access/project";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";
import {
  readWorkspaceCanvasDirectory,
  useWorkspaceCanvasDirectory
} from "../renderer/hooks/useWorkspaceCanvasDirectory";
import { WorkspaceCanvasDirectory } from "../renderer/team/WorkspaceCanvasDirectory";
import { createTranslator } from "../renderer/i18n";

const t = createTranslator("en");
function project(id: string): ProjectAccessRecord {
  return {
    schemaVersion: "project-access/v1",
    registry: { workspaceId: "workspace-1", projectId: id, projectRegistryId: `registry-${id}` },
    visibility: "private",
    acl: { revision: 1, updatedAt: "2030-01-01T00:00:00.000Z" },
    owner: "owner-1",
    updatedAt: "2030-01-01T00:00:00.000Z"
  };
}
function canvas(
  projectId: string,
  id: string,
  visibility: CanvasAccessRecord["visibility"] = "shared"
): CanvasAccessRecord {
  return {
    ...project(projectId),
    registry: { ...project(projectId).registry, canvasId: id, canvasRegistryId: `registry-${id}` },
    visibility
  };
}
function apiFixture() {
  return {
    listCollaborationAuthorizedProjects: vi
      .fn()
      .mockResolvedValue({ items: [project("project-a")], nextCursor: null }),
    listCollaborationAuthorizedCanvases: vi
      .fn()
      .mockResolvedValue({ items: [canvas("project-a", "canvas-a")], nextCursor: null }),
    listWorkspaceCanvasSharingCandidates: vi.fn().mockResolvedValue([])
  };
}
afterEach(cleanup);

describe("Workspace canvas directory", () => {
  it("reads every authorized project and canvas page without using the selected local project", async () => {
    const api = apiFixture();
    api.listCollaborationAuthorizedProjects.mockImplementation(async ({ cursor }) => ({
      items: [project(cursor === 0 ? "project-a" : "project-b")],
      nextCursor: cursor === 0 ? 1 : null
    }));
    api.listCollaborationAuthorizedCanvases.mockImplementation(async ({ projectId, cursor }) => ({
      items: [canvas(projectId, `canvas-${projectId}-${cursor}`)],
      nextCursor: cursor === 0 ? 1 : null
    }));
    const rows = await readWorkspaceCanvasDirectory(api, () => true);
    expect(rows.map((row) => row.registry.canvasId)).toEqual([
      "canvas-project-a-0",
      "canvas-project-a-1",
      "canvas-project-b-0",
      "canvas-project-b-1"
    ]);
    expect(api.listCollaborationAuthorizedProjects).toHaveBeenCalledTimes(2);
  });

  it("keeps canvases within the selected Workspace when a Server authorizes multiple Workspaces", async () => {
    const api = apiFixture();
    api.listCollaborationAuthorizedProjects.mockResolvedValue({
      items: [
        project("project-a"),
        {
          ...project("foreign"),
          registry: { ...project("foreign").registry, workspaceId: "other-workspace" }
        }
      ],
      nextCursor: null
    });
    const rows = await readWorkspaceCanvasDirectory(api, () => true, "workspace-1");
    expect(rows.map((row) => row.registry.canvasId)).toEqual(["canvas-a"]);
    expect(api.listCollaborationAuthorizedCanvases).toHaveBeenCalledTimes(1);
  });

  it("rejects a repeated pagination cursor instead of looping indefinitely", async () => {
    const api = apiFixture();
    api.listCollaborationAuthorizedCanvases.mockResolvedValue({ items: [], nextCursor: 0 });
    await expect(readWorkspaceCanvasDirectory(api, () => true)).rejects.toThrow(
      "collaboration_registry_pagination_invalid"
    );
  });

  it("opens only shared canvases with an exact Workspace locator and supports filtering", async () => {
    const api = apiFixture();
    api.listCollaborationAuthorizedCanvases.mockResolvedValue({
      items: [canvas("project-a", "canvas-a"), canvas("project-a", "private", "private")],
      nextCursor: null
    });
    const onOpen = vi.fn();
    render(
      <WorkspaceCanvasDirectory
        api={api as unknown as PlanWeaveCollaborationApi}
        connectionKey="profile-a"
        connected
        onOpen={onOpen}
        onReconnect={vi.fn()}
        t={t}
      />
    );
    expect(await screen.findByTestId("workspace-directory-row")).toHaveTextContent("canvas-a");
    expect(screen.queryByText("private")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open", exact: true }));
    expect(onOpen).toHaveBeenCalledWith({
      kind: "workspace",
      connectionProfileId: "profile-a",
      workspaceId: "workspace-1",
      projectId: "project-a",
      canvasId: "canvas-a"
    });
    await userEvent.type(screen.getByRole("textbox", { name: "Search canvases" }), "missing");
    expect(screen.queryByTestId("workspace-directory-row")).not.toBeInTheDocument();
    expect(screen.getByText("No matching results")).toBeVisible();
  });

  it("retains authorized canvas rows and reports a failed local name lookup", async () => {
    const api = apiFixture();
    api.listWorkspaceCanvasSharingCandidates.mockRejectedValue(new Error("local_catalog_failed"));
    render(
      <WorkspaceCanvasDirectory
        api={api as unknown as PlanWeaveCollaborationApi}
        connectionKey="profile-a"
        connected
        onReconnect={vi.fn()}
        t={t}
      />
    );
    expect(await screen.findByTestId("workspace-directory-row")).toHaveTextContent("canvas-a");
    expect(screen.getByRole("alert")).toBeVisible();
  });

  it("discards a late response after switching Workspace", async () => {
    const first = apiFixture();
    let resolve!: (value: { items: CanvasAccessRecord[]; nextCursor: null }) => void;
    first.listCollaborationAuthorizedCanvases.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const second = apiFixture();
    second.listCollaborationAuthorizedCanvases.mockResolvedValue({
      items: [canvas("project-b", "new-canvas")],
      nextCursor: null
    });
    const { result, rerender } = renderHook(
      ({ api, connectionKey }) =>
        useWorkspaceCanvasDirectory({
          api: api as unknown as PlanWeaveCollaborationApi,
          connectionKey,
          connected: true
        }),
      { initialProps: { api: first, connectionKey: "first" } }
    );
    await act(async () => {});
    rerender({ api: second, connectionKey: "second" });
    await act(async () => {});
    expect(result.current.canvases[0]?.registry.canvasId).toBe("new-canvas");
    await act(async () => {
      resolve({ items: [canvas("project-a", "stale-canvas")], nextCursor: null });
    });
    expect(result.current.canvases.map((row) => row.registry.canvasId)).toEqual(["new-canvas"]);
  });

  it("distinguishes offline from a connected Workspace with no shared project", () => {
    const api = apiFixture();
    const props = {
      api: api as unknown as PlanWeaveCollaborationApi,
      connectionKey: "profile-a",
      connected: false,
      onReconnect: vi.fn(),
      t
    };
    const { rerender } = render(<WorkspaceCanvasDirectory {...props} />);
    expect(screen.getByText(t("workspaceUnavailable"))).toBeVisible();
    rerender(<WorkspaceCanvasDirectory {...props} emptyWorkspace />);
    expect(screen.queryByText(t("workspaceUnavailable"))).not.toBeInTheDocument();
    expect(screen.getByText(t("workspaceNoSharedCanvases"))).toBeVisible();
    expect(api.listCollaborationAuthorizedProjects).not.toHaveBeenCalled();
  });
});
