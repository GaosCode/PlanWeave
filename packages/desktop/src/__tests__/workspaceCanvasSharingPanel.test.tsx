/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration.js";
import type { WorkspaceCanvasSharingCandidate } from "../shared/workspaceCanvasSharing.js";
import { WorkspaceCanvasSharingPanel } from "../renderer/collaboration/WorkspaceCanvasSharingPanel";
import { createTranslator } from "../renderer/i18n";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(() => cleanupRendererTestEnvironment());

describe("WorkspaceCanvasSharingPanel", () => {
  it("does not call a local canvas shared until upload and visibility both say so", async () => {
    const onPublished = vi.fn();
    const initialCandidates = [
      {
        localProjectId: "project-local",
        projectName: "Local project",
        canvasId: "default",
        canvasName: "Default canvas",
        state: "local_only",
        visibility: null,
        authority: null
      },
      {
        localProjectId: "project-local",
        projectName: "Local project",
        canvasId: "planning",
        canvasName: "Planning canvas",
        state: "published_shared",
        visibility: "shared",
        authority: null
      },
      {
        localProjectId: "project-other",
        projectName: "Other project",
        canvasId: "default",
        canvasName: "Other canvas",
        state: "published_private",
        visibility: "private",
        authority: null
      }
    ];
    const listWorkspaceCanvasSharingCandidates = vi
      .fn()
      .mockResolvedValueOnce(initialCandidates)
      .mockResolvedValue(
        initialCandidates.map((candidate) =>
          candidate.canvasId === "default" && candidate.localProjectId === "project-local"
            ? { ...candidate, state: "published_shared", visibility: "shared" }
            : candidate
        )
      );
    const publishWorkspaceCanvas = vi.fn().mockResolvedValue({
      localProjectId: "project-local",
      projectName: "Local project",
      canvasId: "default",
      canvasName: "Default canvas",
      state: "published_private",
      visibility: "private",
      authority: {
        authoritativeHead: {
          schemaVersion: "content-version/v1",
          scope: { workspaceId: "workspace-a", projectId: "project-a", canvasId: "default" },
          revision: 1,
          content: {
            versionId: "version-a",
            canonicalDigest: "a".repeat(64),
            verification: "complete"
          },
          advancedAt: "2030-01-01T00:00:00.000Z"
        },
        localReplica: null,
        lastAcknowledgement: null,
        replicaStatus: "snapshot_required",
        recoveryAction: "fetch_head",
        canPublishInitial: false,
        canMaterialize: true,
        canRecover: true
      }
    });
    const getCurrentCanvasAccess = vi.fn().mockResolvedValue({
      scope: {
        scopeKind: "canvas",
        workspaceId: "workspace-a",
        projectId: "project-a",
        canvasId: "default"
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
        onPublished={onPublished}
        t={createTranslator("en")}
      />
    );

    await waitFor(() => expect(listWorkspaceCanvasSharingCandidates).toHaveBeenCalledOnce());
    expect(screen.getByRole("heading", { name: "Share canvases" })).toHaveClass("text-base");
    expect(screen.getByTestId("workspace-canvas-sharing-toggle")).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(screen.queryByText("Not shared")).not.toBeInTheDocument();
    const sharingToggle = screen.getByTestId("workspace-canvas-sharing-toggle");
    expect(sharingToggle).toHaveClass("absolute", "inset-0");
    await userEvent.click(sharingToggle);
    expect(sharingToggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findAllByText("Not shared")).not.toHaveLength(0);
    expect(screen.getAllByText("Shared")).not.toHaveLength(0);
    const localProject = within(
      screen.getByTestId("workspace-canvas-sharing-project-project-local")
    );
    expect(localProject.getByRole("heading", { name: "Local project" })).toBeVisible();
    expect(localProject.getByText("Default canvas")).toBeVisible();
    expect(localProject.getByText("Planning canvas")).toBeVisible();
    const otherProject = within(
      screen.getByTestId("workspace-canvas-sharing-project-project-other")
    );
    expect(otherProject.getByRole("heading", { name: "Other project" })).toBeVisible();
    expect(otherProject.getByText("Other canvas")).toBeVisible();
    expect(otherProject.queryByText("Default canvas")).not.toBeInTheDocument();
    const localProjectToggle = screen.getByTestId("workspace-canvas-project-toggle-project-local");
    expect(localProjectToggle).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(localProjectToggle);
    expect(localProjectToggle).toHaveAttribute("aria-expanded", "false");
    expect(localProject.queryByText("Default canvas")).not.toBeVisible();
    expect(otherProject.getByText("Other canvas")).toBeVisible();
    await userEvent.click(localProjectToggle);
    expect(localProjectToggle).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(screen.getAllByRole("button", { name: "Share canvas" })[0]);
    await waitFor(() => expect(publishWorkspaceCanvas).toHaveBeenCalledOnce());
    expect(getCurrentCanvasAccess).toHaveBeenCalledWith({ canvasId: "default" });
    expect(mutateCurrentCanvasAccess).toHaveBeenCalledWith({
      canvasId: "default",
      request: {
        operation: "visibility",
        scope: {
          scopeKind: "canvas",
          workspaceId: "workspace-a",
          projectId: "project-a",
          canvasId: "default"
        },
        expectedAclRevision: 4,
        visibility: "shared"
      }
    });
    await waitFor(() => expect(localProject.getAllByText("Shared")).not.toHaveLength(0));
    expect(onPublished).toHaveBeenCalledOnce();
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
        t={createTranslator("en")}
      />
    );

    await waitFor(() => expect(listWorkspaceCanvasSharingCandidates).toHaveBeenCalledOnce());
    rerender(
      <WorkspaceCanvasSharingPanel
        api={api}
        connected
        connectionKey="workspace-b"
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
        visibility: null,
        authority: null
      }
    ]);
    await userEvent.click(screen.getByTestId("workspace-canvas-sharing-toggle"));
    expect(await screen.findByText("Workspace B canvas")).toBeVisible();

    resolveFirst?.([
      {
        localProjectId: "project-a",
        projectName: "Workspace A project",
        canvasId: "canvas-a",
        canvasName: "Stale Workspace A canvas",
        state: "local_only",
        visibility: null,
        authority: null
      }
    ]);
    await waitFor(() => expect(screen.queryByText("Stale Workspace A canvas")).toBeNull());
    expect(screen.getByText("Workspace B canvas")).toBeVisible();
  });

  it("keeps an actionable, canvas-scoped diagnostic visible after a failed share refresh", async () => {
    const candidate: WorkspaceCanvasSharingCandidate = {
      localProjectId: "project-local",
      projectName: "Local project",
      canvasId: "default",
      canvasName: "Default canvas",
      state: "local_only",
      visibility: null,
      authority: null
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
        t={createTranslator("en")}
      />
    );

    await waitFor(() => expect(api.listWorkspaceCanvasSharingCandidates).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByTestId("workspace-canvas-sharing-toggle"));
    await userEvent.click(screen.getByRole("button", { name: "Share canvas" }));

    const failedCanvas = screen.getByTestId("workspace-canvas-sharing-default");
    const alert = await within(failedCanvas).findByRole("alert");
    expect(alert).toHaveTextContent('Could not share "Default canvas"');
    expect(alert).toHaveTextContent("The canvas could not be saved to the Workspace.");
    expect(screen.queryByText("Sharing did not finish. Try again.")).not.toBeInTheDocument();

    await userEvent.click(within(alert).getByText("View diagnostic details"));
    expect(within(alert).getByText("Upload canvas")).toBeVisible();
    expect(within(alert).getByText("registry_request_failed")).toBeVisible();
    expect(within(alert).getByText("default")).toBeVisible();
    expect(api.listWorkspaceCanvasSharingCandidates).toHaveBeenCalledTimes(2);
  });
});
