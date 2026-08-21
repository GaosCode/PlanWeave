/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration.js";
import { WorkspaceCanvasSharingPanel } from "../renderer/collaboration/WorkspaceCanvasSharingPanel";
import { createTranslator } from "../renderer/i18n";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(() => cleanupRendererTestEnvironment());

describe("WorkspaceCanvasSharingPanel", () => {
  it("does not call a local canvas shared until upload and visibility both say so", async () => {
    const listWorkspaceCanvasSharingCandidates = vi.fn().mockResolvedValue([
      {
        localProjectId: "project-local",
        projectName: "Local project",
        canvasId: "default",
        canvasName: "Default canvas",
        state: "local_only",
        visibility: null,
        authority: null
      }
    ]);
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
    const api = {
      listWorkspaceCanvasSharingCandidates,
      publishWorkspaceCanvas
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <WorkspaceCanvasSharingPanel
        api={api}
        connected
        connectionKey="profile-a"
        t={createTranslator("en")}
      />
    );

    await waitFor(() => expect(listWorkspaceCanvasSharingCandidates).toHaveBeenCalledOnce());
    expect(screen.getByTestId("workspace-canvas-sharing-toggle")).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(screen.queryByText("Local only")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("workspace-canvas-sharing-toggle"));
    expect(screen.getByTestId("workspace-canvas-sharing-toggle")).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(await screen.findByText("Local only")).toBeVisible();
    expect(screen.queryByText("Shared")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Upload to Workspace" }));
    await waitFor(() => expect(publishWorkspaceCanvas).toHaveBeenCalledOnce());
    expect(await screen.findByText("Uploaded (private)")).toBeVisible();
    expect(screen.queryByText("Shared")).not.toBeInTheDocument();
  });
});
