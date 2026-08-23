/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration.js";
import type {
  WorkspaceCanvasPublishResult,
  WorkspaceCanvasSharingCandidate
} from "../shared/workspaceCanvasSharing.js";
import { WorkspaceCanvasSharingPanel } from "../renderer/collaboration/WorkspaceCanvasSharingPanel";
import { createTranslator } from "../renderer/i18n";
import {
  cleanupRendererTestEnvironment,
  stubSelectLayoutApis
} from "./helpers/rendererTestEnvironment";

beforeEach(() => stubSelectLayoutApis());

afterEach(() => cleanupRendererTestEnvironment());

const publishedCandidate: WorkspaceCanvasSharingCandidate = {
  localProjectId: "project-local",
  projectName: "Local project",
  canvasId: "default",
  canvasName: "Default canvas",
  state: "published_private",
  workspaceCanvasId: "server-default",
  visibility: "private"
};

const publishedResult: WorkspaceCanvasPublishResult = {
  outcome: "published",
  operationId: "publish-operation-1",
  recoveryToken: "wp-publish-operation-1",
  locator: {
    kind: "workspace",
    connectionProfileId: "profile-a",
    workspaceId: "workspace-a",
    projectId: "project-a",
    canvasId: "server-default"
  },
  revision: 1,
  content: {
    versionId: "version-a",
    canonicalDigest: "a".repeat(64),
    verification: "complete"
  },
  visibility: "private",
  authoritySwitch: "opened",
  localSourceRetained: true,
  candidate: publishedCandidate
};

async function expandCanvasAdder(): Promise<void> {
  const toggle = screen.getByTestId("workspace-canvas-add-toggle");
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
}

describe("WorkspaceCanvasSharingPanel", () => {
  it("shows a Server-shared canvas even when this Desktop has no publish receipt", async () => {
    const api = {
      listWorkspaceCanvasSharingCandidates: vi.fn().mockResolvedValue([
        {
          localProjectId: "project-local",
          projectName: "Local project",
          canvasId: "default",
          canvasName: "Default canvas",
          state: "local_only",
          workspaceCanvasId: null,
          visibility: null
        }
      ]),
      listCollaborationAuthorizedCanvases: vi.fn().mockResolvedValue({
        items: [
          {
            schemaVersion: "project-access/v1",
            registry: {
              projectRegistryId: "project-registry-a",
              canvasRegistryId: "canvas-registry-a",
              workspaceId: "workspace-a",
              projectId: "project-local",
              canvasId: "default"
            },
            visibility: "shared",
            acl: { revision: 3, updatedAt: "2030-01-01T00:00:00.000Z" },
            owner: "human-owner",
            updatedAt: "2030-01-01T00:00:00.000Z"
          },
          {
            schemaVersion: "project-access/v1",
            registry: {
              projectRegistryId: "project-registry-a",
              canvasRegistryId: "canvas-registry-private",
              workspaceId: "workspace-a",
              projectId: "project-local",
              canvasId: "private-canvas"
            },
            visibility: "private",
            acl: { revision: 4, updatedAt: "2030-01-01T00:00:00.000Z" },
            owner: "human-owner",
            updatedAt: "2030-01-01T00:00:00.000Z"
          }
        ],
        nextCursor: null
      })
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <WorkspaceCanvasSharingPanel
        api={api}
        connected
        connectionKey="profile-a"
        workspaceProjectId="project-local"
        t={createTranslator("en")}
      />
    );

    await waitFor(() => expect(api.listWorkspaceCanvasSharingCandidates).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByTestId("workspace-canvas-sharing-toggle"));

    expect(await screen.findByText("Default canvas")).toBeVisible();
    expect(screen.getByText("1 shared")).toBeVisible();
    expect(screen.queryByText("No shared canvases yet")).not.toBeInTheDocument();
    expect(screen.queryByText("private-canvas")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-canvas-add-toggle")).not.toBeInTheDocument();
  });

  it("removes a stale local shared state when the Server record is private", async () => {
    const privateRecord = {
      registry: {
        workspaceId: "workspace-a",
        projectId: "project-local",
        canvasId: "server-default"
      },
      visibility: "private" as const
    };
    const mutateCurrentCanvasAccess = vi.fn().mockResolvedValue({
      status: "applied",
      aclRevision: 5,
      updatedAt: "2030-01-01T00:00:00.000Z"
    });
    const api = {
      listWorkspaceCanvasSharingCandidates: vi.fn().mockResolvedValue([
        {
          localProjectId: "project-local",
          projectName: "Local project",
          canvasId: "default",
          canvasName: "Default canvas",
          state: "published_shared",
          workspaceCanvasId: "server-default",
          visibility: "shared"
        }
      ]),
      listCollaborationAuthorizedCanvases: vi
        .fn()
        .mockResolvedValueOnce({ items: [privateRecord], nextCursor: null })
        .mockResolvedValue({
          items: [{ ...privateRecord, visibility: "shared" }],
          nextCursor: null
        }),
      publishWorkspaceCanvas: vi.fn(),
      getCurrentCanvasAccess: vi.fn().mockResolvedValue({
        scope: {
          scopeKind: "canvas",
          workspaceId: "workspace-a",
          projectId: "project-local",
          canvasId: "server-default"
        },
        projectAclRevision: 3,
        canvasAclRevision: 4
      }),
      mutateCurrentCanvasAccess
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <WorkspaceCanvasSharingPanel
        api={api}
        connected
        connectionKey="profile-a"
        workspaceProjectId="project-local"
        t={createTranslator("en")}
      />
    );

    await waitFor(() => expect(api.listCollaborationAuthorizedCanvases).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByTestId("workspace-canvas-sharing-toggle"));

    expect(screen.getByText("No shared canvases yet")).toBeVisible();
    expect(screen.queryByText("Default canvas")).not.toBeInTheDocument();
    expect(screen.getByTestId("workspace-canvas-add-toggle")).toBeVisible();
    await expandCanvasAdder();
    await userEvent.click(screen.getByTestId("workspace-canvas-add-select"));
    await userEvent.click(await screen.findByRole("option", { name: "Default canvas · Only you" }));
    await userEvent.click(screen.getByRole("button", { name: "Add to shared canvases" }));

    await waitFor(() => expect(mutateCurrentCanvasAccess).toHaveBeenCalledOnce());
    expect(api.publishWorkspaceCanvas).not.toHaveBeenCalled();
    expect(await screen.findByText("1 shared")).toBeVisible();
  });

  it("does not match an active Workspace canvas to another local project with the same canvas id", async () => {
    const api = {
      listWorkspaceCanvasSharingCandidates: vi.fn().mockResolvedValue([
        {
          localProjectId: "project-a",
          projectName: "Project A",
          canvasId: "default",
          canvasName: "Project A canvas",
          state: "local_only",
          workspaceCanvasId: null,
          visibility: null
        },
        {
          localProjectId: "project-b",
          projectName: "Project B",
          canvasId: "default",
          canvasName: "Project B canvas",
          state: "local_only",
          workspaceCanvasId: null,
          visibility: null
        }
      ]),
      listCollaborationAuthorizedCanvases: vi.fn().mockResolvedValue({
        items: [
          {
            registry: {
              workspaceId: "workspace-a",
              projectId: "project-a",
              canvasId: "default"
            },
            visibility: "shared"
          }
        ],
        nextCursor: null
      })
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <WorkspaceCanvasSharingPanel
        api={api}
        connected
        connectionKey="profile-a"
        workspaceProjectId="project-a"
        t={createTranslator("en")}
      />
    );

    await waitFor(() => expect(api.listCollaborationAuthorizedCanvases).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByTestId("workspace-canvas-sharing-toggle"));
    await userEvent.click(screen.getByTestId("workspace-canvas-project-select"));
    await userEvent.click(await screen.findByRole("option", { name: /Project B/ }));

    expect(screen.getByText("No shared canvases yet")).toBeVisible();
    expect(screen.getByTestId("workspace-canvas-add-toggle")).toBeVisible();
  });

  it("does not continue an old Workspace pagination request after switching connections", async () => {
    let resolveOldPage: ((value: { items: []; nextCursor: number | null }) => void) | undefined;
    const oldPage = new Promise<{ items: []; nextCursor: number | null }>((resolve) => {
      resolveOldPage = resolve;
    });
    const listCollaborationAuthorizedCanvases = vi.fn(
      ({ projectId, cursor }: { projectId: string; cursor?: number }) =>
        projectId === "project-a" && cursor === 0
          ? oldPage
          : Promise.resolve({ items: [], nextCursor: null })
    );
    const api = {
      listWorkspaceCanvasSharingCandidates: vi.fn().mockResolvedValue([
        {
          localProjectId: "project-a",
          projectName: "Project A",
          canvasId: "default",
          canvasName: "Default canvas",
          state: "local_only",
          workspaceCanvasId: null,
          visibility: null
        }
      ]),
      listCollaborationAuthorizedCanvases
    } as unknown as PlanWeaveCollaborationApi;
    const { rerender } = render(
      <WorkspaceCanvasSharingPanel
        api={api}
        connected
        connectionKey="profile-a"
        workspaceProjectId="project-a"
        t={createTranslator("en")}
      />
    );

    await waitFor(() => expect(listCollaborationAuthorizedCanvases).toHaveBeenCalledOnce());
    rerender(
      <WorkspaceCanvasSharingPanel
        api={api}
        connected
        connectionKey="profile-b"
        workspaceProjectId="project-b"
        t={createTranslator("en")}
      />
    );
    await waitFor(() => expect(listCollaborationAuthorizedCanvases).toHaveBeenCalledTimes(2));
    resolveOldPage?.({ items: [], nextCursor: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listCollaborationAuthorizedCanvases).not.toHaveBeenCalledWith({
      projectId: "project-a",
      cursor: 1,
      limit: 100
    });
  });

  it("does not call a local canvas shared until upload and visibility both say so", async () => {
    const onPublished = vi.fn();
    const initialCandidates = [
      {
        localProjectId: "project-local",
        projectName: "Local project",
        canvasId: "default",
        canvasName: "Default canvas",
        state: "local_only",
        workspaceCanvasId: null,
        visibility: null
      },
      {
        localProjectId: "project-local",
        projectName: "Local project",
        canvasId: "planning",
        canvasName: "Planning canvas",
        state: "published_shared",
        workspaceCanvasId: "server-planning",
        visibility: "shared"
      },
      {
        localProjectId: "project-other",
        projectName: "Other project",
        canvasId: "default",
        canvasName: "Other canvas",
        state: "published_private",
        workspaceCanvasId: "server-other",
        visibility: "private"
      }
    ];
    const listWorkspaceCanvasSharingCandidates = vi
      .fn()
      .mockResolvedValueOnce(initialCandidates)
      .mockResolvedValue(
        initialCandidates.map((candidate) =>
          candidate.canvasId === "default" && candidate.localProjectId === "project-local"
            ? {
                ...candidate,
                state: "published_shared",
                workspaceCanvasId: "server-default",
                visibility: "shared"
              }
            : candidate
        )
      );
    const publishWorkspaceCanvas = vi.fn().mockResolvedValue(publishedResult);
    const getCurrentCanvasAccess = vi.fn().mockResolvedValue({
      scope: {
        scopeKind: "canvas",
        workspaceId: "workspace-a",
        projectId: "project-a",
        canvasId: "server-default"
      },
      projectAclRevision: 3,
      canvasAclRevision: 4
    });
    const mutateCurrentCanvasAccess = vi.fn().mockResolvedValue({
      status: "applied",
      aclRevision: 5,
      updatedAt: "2030-01-01T00:00:00.000Z"
    });
    const api = {
      listWorkspaceCanvasSharingCandidates,
      publishWorkspaceCanvas,
      getCurrentCanvasAccess,
      mutateCurrentCanvasAccess
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <WorkspaceCanvasSharingPanel
        api={api}
        connected
        connectionKey="profile-a"
        workspaceProjectId={null}
        onPublished={onPublished}
        t={createTranslator("en")}
      />
    );

    await waitFor(() => expect(listWorkspaceCanvasSharingCandidates).toHaveBeenCalledOnce());
    expect(screen.getByRole("heading", { name: "Shared canvases" })).toHaveClass("text-base");
    expect(screen.getByTestId("workspace-canvas-sharing-toggle")).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    const sharingToggle = screen.getByTestId("workspace-canvas-sharing-toggle");
    expect(sharingToggle).toHaveClass("absolute", "inset-0");
    await userEvent.click(sharingToggle);
    expect(sharingToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("workspace-canvas-project-select")).toHaveTextContent(
      "Local project · project-local"
    );
    expect(screen.getByTestId("workspace-canvas-project-select")).not.toHaveClass("h-10");
    const localProject = within(
      screen.getByTestId("workspace-canvas-sharing-project-project-local")
    );
    expect(screen.getByTestId("workspace-canvas-shared-list-header")).not.toHaveClass("border-b");
    expect(screen.queryByTestId("workspace-canvas-add-select")).not.toBeInTheDocument();
    expect(localProject.getByText("Planning canvas")).toBeVisible();
    expect(localProject.queryByText("Default canvas")).not.toBeInTheDocument();
    expect(screen.queryByText("Other canvas")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("workspace-canvas-project-select"));
    await userEvent.click(await screen.findByRole("option", { name: /Other project/ }));
    expect(screen.getByTestId("workspace-canvas-project-select")).toHaveTextContent(
      "Other project · project-other"
    );
    expect(screen.getByText("No shared canvases yet")).toBeVisible();
    expect(screen.getByTestId("workspace-canvas-shared-empty")).not.toHaveClass("border-dashed");
    expect(screen.queryByText("Planning canvas")).not.toBeInTheDocument();
    await expandCanvasAdder();
    expect(screen.getByTestId("workspace-canvas-add-select")).toBeVisible();

    await userEvent.click(screen.getByTestId("workspace-canvas-project-select"));
    await userEvent.click(await screen.findByRole("option", { name: /Local project/ }));
    expect(screen.getByText("Planning canvas")).toBeVisible();
    expect(screen.queryByTestId("workspace-canvas-add-select")).not.toBeInTheDocument();
    await expandCanvasAdder();
    await userEvent.click(screen.getByTestId("workspace-canvas-add-select"));
    await userEvent.click(
      await screen.findByRole("option", { name: "Default canvas · Not shared" })
    );
    await userEvent.click(screen.getByRole("button", { name: "Add to shared canvases" }));
    await waitFor(() => expect(publishWorkspaceCanvas).toHaveBeenCalledOnce());
    expect(getCurrentCanvasAccess).toHaveBeenCalledWith({ canvasId: "server-default" });
    expect(mutateCurrentCanvasAccess).toHaveBeenCalledWith({
      canvasId: "server-default",
      request: {
        operation: "visibility",
        scope: {
          scopeKind: "canvas",
          workspaceId: "workspace-a",
          projectId: "project-a",
          canvasId: "server-default"
        },
        expectedAclRevision: 4,
        visibility: "shared"
      }
    });
    await waitFor(() => expect(screen.getByText("Default canvas")).toBeVisible());
    expect(screen.queryByRole("option", { name: "Default canvas · Not shared" })).toBeNull();
    expect(onPublished).toHaveBeenCalledWith(publishedResult);
    expect(listWorkspaceCanvasSharingCandidates.mock.invocationCallOrder[1]).toBeLessThan(
      onPublished.mock.invocationCallOrder[0]!
    );
  });

  it("keeps same-name projects distinguishable in the compact project picker", async () => {
    const api = {
      listWorkspaceCanvasSharingCandidates: vi.fn().mockResolvedValue([
        {
          localProjectId: "project-clone-a",
          projectName: "Cloned project",
          canvasId: "canvas-a",
          canvasName: "Canvas A",
          state: "local_only",
          workspaceCanvasId: null,
          visibility: null
        },
        {
          localProjectId: "project-clone-b",
          projectName: "Cloned project",
          canvasId: "canvas-b",
          canvasName: "Canvas B",
          state: "local_only",
          workspaceCanvasId: null,
          visibility: null
        }
      ])
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <WorkspaceCanvasSharingPanel
        api={api}
        connected
        connectionKey="profile-a"
        workspaceProjectId={null}
        t={createTranslator("en")}
      />
    );

    await waitFor(() => expect(api.listWorkspaceCanvasSharingCandidates).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByTestId("workspace-canvas-sharing-toggle"));
    await userEvent.click(screen.getByTestId("workspace-canvas-project-select"));
    expect(
      await screen.findByRole("option", { name: "Cloned project · project-clone-a" })
    ).toBeVisible();
    expect(
      await screen.findByRole("option", { name: "Cloned project · project-clone-b" })
    ).toBeVisible();
  });

  it("ignores a stale candidate response after switching Workspace connections", async () => {
    let resolveFirst: ((value: WorkspaceCanvasSharingCandidate[]) => void) | undefined;
    let resolveSecond: ((value: WorkspaceCanvasSharingCandidate[]) => void) | undefined;
    const first = new Promise<WorkspaceCanvasSharingCandidate[]>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<WorkspaceCanvasSharingCandidate[]>((resolve) => {
      resolveSecond = resolve;
    });
    const listWorkspaceCanvasSharingCandidates = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const api = { listWorkspaceCanvasSharingCandidates } as unknown as PlanWeaveCollaborationApi;
    const { rerender } = render(
      <WorkspaceCanvasSharingPanel
        api={api}
        connected
        connectionKey="workspace-a"
        workspaceProjectId={null}
        t={createTranslator("en")}
      />
    );

    await waitFor(() => expect(listWorkspaceCanvasSharingCandidates).toHaveBeenCalledOnce());
    rerender(
      <WorkspaceCanvasSharingPanel
        api={api}
        connected
        connectionKey="workspace-b"
        workspaceProjectId={null}
        t={createTranslator("en")}
      />
    );
    await waitFor(() => expect(listWorkspaceCanvasSharingCandidates).toHaveBeenCalledTimes(2));
    resolveSecond?.([
      {
        localProjectId: "project-b",
        projectName: "Workspace B project",
        canvasId: "canvas-b",
        canvasName: "Workspace B canvas",
        state: "local_only",
        workspaceCanvasId: null,
        visibility: null
      }
    ]);
    await userEvent.click(screen.getByTestId("workspace-canvas-sharing-toggle"));
    expect(await screen.findByTestId("workspace-canvas-project-select")).toHaveTextContent(
      "Workspace B project"
    );
    await expandCanvasAdder();
    await userEvent.click(screen.getByTestId("workspace-canvas-add-select"));
    expect(
      await screen.findByRole("option", { name: "Workspace B canvas · Not shared" })
    ).toBeVisible();
    await userEvent.keyboard("{Escape}");

    resolveFirst?.([
      {
        localProjectId: "project-a",
        projectName: "Workspace A project",
        canvasId: "canvas-a",
        canvasName: "Stale Workspace A canvas",
        state: "local_only",
        workspaceCanvasId: null,
        visibility: null
      }
    ]);
    await waitFor(() => expect(screen.queryByText("Stale Workspace A canvas")).toBeNull());
    expect(screen.getByTestId("workspace-canvas-project-select")).toHaveTextContent(
      "Workspace B project"
    );
  });

  it("stops an in-flight share before it mutates a newly selected Workspace", async () => {
    const candidateA: WorkspaceCanvasSharingCandidate = {
      localProjectId: "project-a",
      projectName: "Workspace A project",
      canvasId: "canvas-a",
      canvasName: "Workspace A canvas",
      state: "local_only",
      workspaceCanvasId: null,
      visibility: null
    };
    const candidateB: WorkspaceCanvasSharingCandidate = {
      localProjectId: "project-b",
      projectName: "Workspace B project",
      canvasId: "canvas-b",
      canvasName: "Workspace B canvas",
      state: "local_only",
      workspaceCanvasId: null,
      visibility: null
    };
    let resolvePublish: ((value: WorkspaceCanvasPublishResult) => void) | undefined;
    const publish = new Promise<WorkspaceCanvasPublishResult>((resolve) => {
      resolvePublish = resolve;
    });
    const getCurrentCanvasAccess = vi.fn();
    const mutateCurrentCanvasAccess = vi.fn();
    const onPublished = vi.fn();
    const api = {
      listWorkspaceCanvasSharingCandidates: vi
        .fn()
        .mockResolvedValueOnce([candidateA])
        .mockResolvedValueOnce([candidateB]),
      publishWorkspaceCanvas: vi.fn().mockReturnValue(publish),
      getCurrentCanvasAccess,
      mutateCurrentCanvasAccess
    } as unknown as PlanWeaveCollaborationApi;
    const { rerender } = render(
      <WorkspaceCanvasSharingPanel
        api={api}
        connected
        connectionKey="workspace-a"
        workspaceProjectId={null}
        onPublished={onPublished}
        t={createTranslator("en")}
      />
    );

    await waitFor(() => expect(api.listWorkspaceCanvasSharingCandidates).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByTestId("workspace-canvas-sharing-toggle"));
    await expandCanvasAdder();
    await userEvent.click(screen.getByTestId("workspace-canvas-add-select"));
    await userEvent.click(
      await screen.findByRole("option", { name: "Workspace A canvas · Not shared" })
    );
    await userEvent.click(screen.getByRole("button", { name: "Add to shared canvases" }));
    await waitFor(() => expect(api.publishWorkspaceCanvas).toHaveBeenCalledOnce());

    rerender(
      <WorkspaceCanvasSharingPanel
        api={api}
        connected
        connectionKey="workspace-b"
        workspaceProjectId={null}
        onPublished={onPublished}
        t={createTranslator("en")}
      />
    );
    await waitFor(() => expect(api.listWorkspaceCanvasSharingCandidates).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("workspace-canvas-project-select")).toHaveTextContent(
      "Workspace B project"
    );

    resolvePublish?.(publishedResult);
    await waitFor(() => expect(screen.queryByText("Workspace A canvas")).toBeNull());
    expect(getCurrentCanvasAccess).not.toHaveBeenCalled();
    expect(mutateCurrentCanvasAccess).not.toHaveBeenCalled();
    expect(onPublished).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("uses the Server canvas identity when sharing an already published private canvas", async () => {
    const candidate: WorkspaceCanvasSharingCandidate = {
      localProjectId: "project-local",
      projectName: "Local project",
      canvasId: "local-default",
      canvasName: "Default canvas",
      state: "published_private",
      workspaceCanvasId: "server-private",
      visibility: "private"
    };
    const publishWorkspaceCanvas = vi.fn();
    const getCurrentCanvasAccess = vi.fn().mockResolvedValue({
      scope: {
        scopeKind: "canvas",
        workspaceId: "workspace-a",
        projectId: "project-a",
        canvasId: "server-private"
      },
      projectAclRevision: 3,
      canvasAclRevision: 4
    });
    const mutateCurrentCanvasAccess = vi.fn().mockResolvedValue({
      status: "applied",
      aclRevision: 5,
      updatedAt: "2030-01-01T00:00:00.000Z"
    });
    const api = {
      listWorkspaceCanvasSharingCandidates: vi
        .fn()
        .mockResolvedValueOnce([candidate])
        .mockResolvedValueOnce([{ ...candidate, state: "published_shared", visibility: "shared" }]),
      publishWorkspaceCanvas,
      getCurrentCanvasAccess,
      mutateCurrentCanvasAccess
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <WorkspaceCanvasSharingPanel
        api={api}
        connected
        connectionKey="profile-a"
        workspaceProjectId={null}
        t={createTranslator("en")}
      />
    );

    await waitFor(() => expect(api.listWorkspaceCanvasSharingCandidates).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByTestId("workspace-canvas-sharing-toggle"));
    await expandCanvasAdder();
    await userEvent.click(screen.getByTestId("workspace-canvas-add-select"));
    await userEvent.click(await screen.findByRole("option", { name: "Default canvas · Only you" }));
    await userEvent.click(screen.getByRole("button", { name: "Add to shared canvases" }));

    await waitFor(() => expect(getCurrentCanvasAccess).toHaveBeenCalledOnce());
    expect(publishWorkspaceCanvas).not.toHaveBeenCalled();
    expect(getCurrentCanvasAccess).toHaveBeenCalledWith({ canvasId: "server-private" });
    expect(mutateCurrentCanvasAccess).toHaveBeenCalledWith(
      expect.objectContaining({ canvasId: "server-private" })
    );
  });

  it("retains a committed publish until a failed visibility step can finish", async () => {
    const onPublished = vi.fn();
    const candidate: WorkspaceCanvasSharingCandidate = {
      localProjectId: "project-local",
      projectName: "Local project",
      canvasId: "default",
      canvasName: "Default canvas",
      state: "local_only",
      workspaceCanvasId: null,
      visibility: null
    };
    const otherCandidate: WorkspaceCanvasSharingCandidate = {
      localProjectId: "project-other",
      projectName: "Other project",
      canvasId: "other",
      canvasName: "Other canvas",
      state: "local_only",
      workspaceCanvasId: null,
      visibility: null
    };
    const getCurrentCanvasAccess = vi
      .fn()
      .mockRejectedValueOnce(new Error("acl_lookup_failed"))
      .mockResolvedValueOnce({
        scope: {
          scopeKind: "canvas",
          workspaceId: "workspace-a",
          projectId: "project-a",
          canvasId: "server-default"
        },
        projectAclRevision: 3,
        canvasAclRevision: 4
      });
    const api = {
      listWorkspaceCanvasSharingCandidates: vi
        .fn()
        .mockResolvedValueOnce([candidate])
        .mockResolvedValueOnce([publishedCandidate, otherCandidate])
        .mockResolvedValueOnce([
          {
            ...publishedCandidate,
            state: "published_shared",
            visibility: "shared"
          }
        ]),
      publishWorkspaceCanvas: vi.fn().mockResolvedValue(publishedResult),
      getCurrentCanvasAccess,
      mutateCurrentCanvasAccess: vi.fn().mockResolvedValue({
        status: "applied",
        aclRevision: 5,
        updatedAt: "2030-01-01T00:00:00.000Z"
      })
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <WorkspaceCanvasSharingPanel
        api={api}
        connected
        connectionKey="profile-a"
        workspaceProjectId={null}
        onPublished={onPublished}
        t={createTranslator("en")}
      />
    );

    await waitFor(() => expect(api.listWorkspaceCanvasSharingCandidates).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByTestId("workspace-canvas-sharing-toggle"));
    await expandCanvasAdder();
    await userEvent.click(screen.getByTestId("workspace-canvas-add-select"));
    await userEvent.click(
      await screen.findByRole("option", { name: "Default canvas · Not shared" })
    );
    await userEvent.click(screen.getByRole("button", { name: "Add to shared canvases" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The canvas was saved, but member access could not be enabled."
    );
    expect(onPublished).not.toHaveBeenCalled();
    expect(screen.getByTestId("workspace-canvas-project-select")).toBeDisabled();
    expect(screen.getByTestId("workspace-canvas-add-select")).toBeDisabled();
    expect(screen.getByTestId("workspace-canvas-add-toggle")).toBeDisabled();
    expect(screen.getByTestId("workspace-canvas-add-toggle")).toHaveAttribute(
      "aria-expanded",
      "true"
    );

    await userEvent.click(screen.getByRole("button", { name: "Continue sharing" }));
    await waitFor(() => expect(onPublished).toHaveBeenCalledWith(publishedResult));
    expect(api.publishWorkspaceCanvas).toHaveBeenCalledOnce();
    expect(getCurrentCanvasAccess).toHaveBeenCalledTimes(2);
  });

  it("keeps an actionable, canvas-scoped diagnostic visible after a failed share refresh", async () => {
    const candidate: WorkspaceCanvasSharingCandidate = {
      localProjectId: "project-local",
      projectName: "Local project",
      canvasId: "default",
      canvasName: "Default canvas",
      state: "local_only",
      workspaceCanvasId: null,
      visibility: null
    };
    const api = {
      listWorkspaceCanvasSharingCandidates: vi.fn().mockResolvedValue([candidate]),
      publishWorkspaceCanvas: vi.fn().mockRejectedValue(new Error("registry_request_failed"))
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <WorkspaceCanvasSharingPanel
        api={api}
        connected
        connectionKey="profile-a"
        workspaceProjectId={null}
        t={createTranslator("en")}
      />
    );

    await waitFor(() => expect(api.listWorkspaceCanvasSharingCandidates).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByTestId("workspace-canvas-sharing-toggle"));
    await expandCanvasAdder();
    await userEvent.click(screen.getByTestId("workspace-canvas-add-select"));
    await userEvent.click(
      await screen.findByRole("option", { name: "Default canvas · Not shared" })
    );
    await userEvent.click(screen.getByRole("button", { name: "Add to shared canvases" }));

    const failedProject = screen.getByTestId("workspace-canvas-sharing-project-project-local");
    const alert = await within(failedProject).findByRole("alert");
    expect(alert).toHaveTextContent('Could not share "Default canvas"');
    expect(alert).toHaveTextContent("The canvas could not be saved to the Workspace.");
    expect(screen.queryByText("Sharing did not finish. Try again.")).not.toBeInTheDocument();

    await userEvent.click(within(alert).getByText("View diagnostic details"));
    expect(within(alert).getByText("Upload canvas")).toBeVisible();
    expect(within(alert).getByText("registry_request_failed")).toBeVisible();
    expect(within(alert).getByText("default")).toBeVisible();
    expect(api.listWorkspaceCanvasSharingCandidates).toHaveBeenCalledTimes(2);
  });

  it("retries opening the Workspace locator after Server commit without republishing", async () => {
    const onPublished = vi.fn();
    const candidate: WorkspaceCanvasSharingCandidate = {
      localProjectId: "project-local",
      projectName: "Local project",
      canvasId: "default",
      canvasName: "Default canvas",
      state: "local_only",
      workspaceCanvasId: null,
      visibility: null
    };
    const publishWorkspaceCanvas = vi.fn().mockResolvedValue({
      ...publishedResult,
      authoritySwitch: "retry_open"
    });
    const openWorkspaceCanvasSession = vi.fn().mockResolvedValue({
      locator: publishedResult.locator,
      status: "accepted",
      conflict: null,
      rejectCode: null,
      replica: null
    });
    const api = {
      listWorkspaceCanvasSharingCandidates: vi
        .fn()
        .mockResolvedValueOnce([candidate])
        .mockResolvedValue([
          {
            ...candidate,
            state: "published_shared",
            workspaceCanvasId: "server-default",
            visibility: "shared"
          }
        ]),
      publishWorkspaceCanvas,
      openWorkspaceCanvasSession,
      getCurrentCanvasAccess: vi.fn().mockResolvedValue({
        scope: {
          scopeKind: "canvas",
          workspaceId: "workspace-a",
          projectId: "project-a",
          canvasId: "server-default"
        },
        projectAclRevision: 3,
        canvasAclRevision: 4
      }),
      mutateCurrentCanvasAccess: vi.fn().mockResolvedValue({
        status: "applied",
        aclRevision: 5,
        updatedAt: "2030-01-01T00:00:00.000Z"
      })
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <WorkspaceCanvasSharingPanel
        api={api}
        connected
        connectionKey="profile-a"
        workspaceProjectId={null}
        onPublished={onPublished}
        t={createTranslator("en")}
      />
    );

    await waitFor(() => expect(api.listWorkspaceCanvasSharingCandidates).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByTestId("workspace-canvas-sharing-toggle"));
    await expandCanvasAdder();
    await userEvent.click(screen.getByTestId("workspace-canvas-add-select"));
    await userEvent.click(
      await screen.findByRole("option", { name: "Default canvas · Not shared" })
    );
    await userEvent.click(screen.getByRole("button", { name: "Add to shared canvases" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Open it again without uploading a second copy.");
    expect(publishWorkspaceCanvas).toHaveBeenCalledOnce();
    expect(onPublished).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Open Workspace canvas" }));
    await waitFor(() =>
      expect(openWorkspaceCanvasSession).toHaveBeenCalledWith(publishedResult.locator)
    );
    expect(publishWorkspaceCanvas).toHaveBeenCalledOnce();
    expect(onPublished).toHaveBeenCalledWith({
      ...publishedResult,
      authoritySwitch: "opened"
    });
  });
});
