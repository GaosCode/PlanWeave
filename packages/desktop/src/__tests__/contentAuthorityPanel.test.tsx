/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import {
  contentVersionDesktopReadModelSchema,
  type ContentVersionDesktopReadModel
} from "@planweave-ai/collaboration-protocol/content/authority";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentAuthorityPanel } from "../renderer/collaboration/ContentAuthorityPanel";
import { createTranslator } from "../renderer/i18n";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

function materializableModel(): ContentVersionDesktopReadModel {
  const canonicalDigest = "a".repeat(64);
  const content = {
    versionId: `version-${canonicalDigest}`,
    canonicalDigest,
    verification: "complete" as const
  };
  return contentVersionDesktopReadModelSchema.parse({
    authoritativeHead: {
      schemaVersion: "content-version/v1",
      scope: { workspaceId: "workspace-1", projectId: "project-1", canvasId: "default" },
      revision: 1,
      content,
      advancedAt: "2026-07-31T00:00:00.000Z"
    },
    localReplica: null,
    replicaStatus: "snapshot_required",
    lastAcknowledgement: null,
    canPublishInitial: false,
    canMaterialize: true,
    canRecover: true,
    offlineWriteReason: null
  });
}

function hostedCandidate(
  model: ContentVersionDesktopReadModel,
  projectId = "local-project",
  canvasId = "default"
) {
  return {
    workspaceId: "workspace-1",
    projectId,
    canvasId,
    visibility: "shared" as const,
    authority: model,
    localReplica: null
  };
}

describe("ContentAuthorityPanel", () => {
  it("does not bind an unrelated selected local project when opening remote authority settings", async () => {
    const model = materializableModel();
    const bindCollaborationCanvasBindingContentAuthority = vi.fn().mockResolvedValue(model);
    const api = {
      bindCollaborationCanvasBindingContentAuthority,
      listCollaborationContentBootstrapCandidates: vi
        .fn()
        .mockResolvedValue([hostedCandidate(model, "remote-project")])
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <ContentAuthorityPanel
        api={api}
        connectionKey="profile-1"
        authorityProjectId="remote-project"
        localProjectId="unrelated-local-project"
        canvasId="default"
        connected
        t={createTranslator("en")}
      />
    );

    expect(await screen.findByRole("button", { name: "Sync to this device" })).toBeVisible();
    expect(bindCollaborationCanvasBindingContentAuthority).not.toHaveBeenCalled();
    expect(screen.queryByText("content_local_project_scope_mismatch")).not.toBeInTheDocument();
  });

  it("does not auto-bind a selected canvas outside the hosted Server scope", async () => {
    const model = materializableModel();
    const bindCollaborationCanvasBindingContentAuthority = vi.fn().mockResolvedValue(model);
    const api = {
      bindCollaborationCanvasBindingContentAuthority,
      listCollaborationContentBootstrapCandidates: vi
        .fn()
        .mockResolvedValue([hostedCandidate(model, "local-project", "default")])
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <ContentAuthorityPanel
        api={api}
        connectionKey="profile-1"
        authorityProjectId="local-project"
        localProjectId="local-project"
        canvasId="other-canvas"
        connected
        t={createTranslator("en")}
      />
    );

    expect(await screen.findByTestId("content-authority-canvas-not-hosted")).toBeVisible();
    expect(await screen.findByRole("button", { name: "Sync to this device" })).toBeVisible();
    expect(bindCollaborationCanvasBindingContentAuthority).not.toHaveBeenCalled();
  });

  it("rebinds the current canvas when retrying after the authority binding was lost", async () => {
    const user = userEvent.setup();
    const model = materializableModel();
    const bindCollaborationCanvasBindingContentAuthority = vi
      .fn()
      .mockRejectedValueOnce(new Error("collaboration_content_offline"))
      .mockResolvedValueOnce(model);
    const refreshCollaborationContentAuthority = vi
      .fn()
      .mockRejectedValue(new Error("content_canvas_binding_required"));
    const api = {
      bindCollaborationCanvasBindingContentAuthority,
      refreshCollaborationContentAuthority,
      listCollaborationContentBootstrapCandidates: vi
        .fn()
        .mockResolvedValue([hostedCandidate(model)])
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <ContentAuthorityPanel
        api={api}
        connectionKey="profile-1"
        authorityProjectId="local-project"
        localProjectId="local-project"
        canvasId="default"
        connected
        t={createTranslator("en")}
      />
    );

    expect(await screen.findByText("collaboration_content_offline")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(bindCollaborationCanvasBindingContentAuthority).toHaveBeenCalledTimes(2)
    );
    expect(bindCollaborationCanvasBindingContentAuthority).toHaveBeenLastCalledWith({
      kind: "local",
      localProjectId: "local-project",
      canvasId: "default"
    });
    expect(refreshCollaborationContentAuthority).not.toHaveBeenCalled();
    expect(await screen.findByTestId("content-authority-version")).toHaveTextContent(
      /version-aaaa/
    );
  });

  it("maps forbidden bind failures to a readable content-authority hint", async () => {
    const model = materializableModel();
    const api = {
      bindCollaborationCanvasBindingContentAuthority: vi
        .fn()
        .mockRejectedValue(new Error("CollaborationClientError: forbidden")),
      listCollaborationContentBootstrapCandidates: vi
        .fn()
        .mockResolvedValue([hostedCandidate(model)])
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <ContentAuthorityPanel
        api={api}
        connectionKey="profile-1"
        authorityProjectId="local-project"
        localProjectId="local-project"
        canvasId="default"
        connected
        t={createTranslator("en")}
      />
    );

    expect(await screen.findByText(/Add it under Shared canvases/i)).toBeVisible();
  });

  it("keeps bootstrap network failures visible and shows the raw IPC text in developer mode", async () => {
    const ipcError = new Error(
      "Error invoking remote method 'planweave-collaboration:listContentBootstrapCandidates': CollaborationClientError: Network request failed."
    );
    const api = {
      listCollaborationContentBootstrapCandidates: vi.fn().mockRejectedValue(ipcError)
    } as unknown as PlanWeaveCollaborationApi;

    const { rerender } = render(
      <ContentAuthorityPanel
        api={api}
        connectionKey="profile-1"
        authorityProjectId="local-project"
        localProjectId="local-project"
        canvasId="default"
        connected
        t={createTranslator("en")}
      />
    );

    expect(await screen.findByText("Network request failed.")).toBeVisible();
    expect(screen.queryByText(/Error invoking remote method/)).not.toBeInTheDocument();

    rerender(
      <ContentAuthorityPanel
        api={api}
        connectionKey="profile-1"
        authorityProjectId="local-project"
        localProjectId="local-project"
        canvasId="default"
        connected
        diagnosticsEnabled
        t={createTranslator("en")}
      />
    );

    expect(await screen.findByText(/Error invoking remote method/)).toBeVisible();
    expect(screen.getByText(/listContentBootstrapCandidates/)).toBeVisible();
  });

  it("refreshes the local project and reports success after materializing the authority head", async () => {
    const user = userEvent.setup();
    const model = materializableModel();
    const api = {
      bindCollaborationCanvasBindingContentAuthority: vi.fn().mockResolvedValue(model),
      listCollaborationContentBootstrapCandidates: vi
        .fn()
        .mockResolvedValue([hostedCandidate(model)]),
      materializeCollaborationContentHead: vi.fn().mockResolvedValue({
        ...model,
        localReplica: model.authoritativeHead?.content ?? null,
        replicaStatus: "in_sync"
      })
    } as unknown as PlanWeaveCollaborationApi;
    const onMaterialized = vi.fn().mockResolvedValue(undefined);

    render(
      <ContentAuthorityPanel
        api={api}
        connectionKey="profile-1"
        authorityProjectId="local-project"
        localProjectId="local-project"
        canvasId="default"
        connected
        onMaterialized={onMaterialized}
        t={createTranslator("en")}
      />
    );

    expect(await screen.findByTestId("content-authority-version")).toHaveTextContent(
      /version-aaaa/
    );
    expect(screen.getByTestId("content-authority-panel")).not.toHaveClass(
      "rounded-xl",
      "border",
      "bg-background"
    );
    expect(screen.queryByTestId("content-authority-section-icon")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Member content sync" })).toHaveClass("text-base");
    expect(screen.getByTestId("content-authority-digest")).toHaveAttribute("title", "a".repeat(64));
    expect(screen.getByTestId("content-authority-local-version")).toHaveTextContent(
      "Not materialized on this device"
    );

    await user.click(
      await screen.findByRole("button", { name: "Restore from authoritative version" })
    );

    await waitFor(() => expect(onMaterialized).toHaveBeenCalledTimes(1));
    expect(api.materializeCollaborationContentHead).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(
        "The authoritative version is synced to this device and the project view has been refreshed."
      )
    ).toBeInTheDocument();
  });

  it("keeps the materialized model but does not report refresh success when the project refresh fails", async () => {
    const user = userEvent.setup();
    const model = materializableModel();
    const api = {
      bindCollaborationCanvasBindingContentAuthority: vi.fn().mockResolvedValue(model),
      listCollaborationContentBootstrapCandidates: vi
        .fn()
        .mockResolvedValue([hostedCandidate(model)]),
      materializeCollaborationContentHead: vi.fn().mockResolvedValue({
        ...model,
        localReplica: model.authoritativeHead?.content ?? null,
        replicaStatus: "in_sync"
      })
    } as unknown as PlanWeaveCollaborationApi;
    const onMaterialized = vi.fn().mockRejectedValue(new Error("project_refresh_failed"));

    render(
      <ContentAuthorityPanel
        api={api}
        connectionKey="profile-1"
        authorityProjectId="local-project"
        localProjectId="local-project"
        canvasId="default"
        connected
        onMaterialized={onMaterialized}
        t={createTranslator("en")}
      />
    );

    await user.click(
      await screen.findByRole("button", { name: "Restore from authoritative version" })
    );

    await waitFor(() => expect(screen.getByText("project_refresh_failed")).toBeInTheDocument());
    expect(api.materializeCollaborationContentHead).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("content-authority-status")).toHaveTextContent("In sync");
    expect(screen.getByTestId("content-authority-local-version")).toHaveTextContent(/version-aaaa/);
    expect(screen.queryByText(/project view has been refreshed/i)).not.toBeInTheDocument();
  });

  it("creates and opens a local project from a remote authoritative package without a selected canvas", async () => {
    const user = userEvent.setup();
    const model = materializableModel();
    const candidate = {
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "default",
      visibility: "shared" as const,
      authority: model,
      localReplica: null
    };
    const result = {
      outcome: "created" as const,
      localProjectId: "local-project",
      localCanvasId: "default",
      remoteCanvasId: "default",
      acknowledgement: "acknowledged" as const,
      authority: model
    };
    const api = {
      listCollaborationContentBootstrapCandidates: vi.fn().mockResolvedValue([candidate]),
      bootstrapCollaborationContent: vi.fn().mockResolvedValue(result)
    } as unknown as PlanWeaveCollaborationApi;
    const onReplicaReady = vi.fn().mockResolvedValue(undefined);

    render(
      <ContentAuthorityPanel
        api={api}
        connectionKey="profile-1"
        authorityProjectId="project-1"
        localProjectId={null}
        canvasId={null}
        connected
        onReplicaReady={onReplicaReady}
        t={createTranslator("en")}
      />
    );

    await user.click(await screen.findByRole("button", { name: "Sync to this device" }));

    await waitFor(() =>
      expect(api.bootstrapCollaborationContent).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "default"
      })
    );
    expect(onReplicaReady).toHaveBeenCalledWith(result);
    expect(
      await screen.findByText("The authoritative Plan Package was synced and opened.")
    ).toBeInTheDocument();
  });
});
