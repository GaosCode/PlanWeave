/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  accessCapabilityFlags,
  type CurrentCanvasAccessView
} from "@planweave-ai/collaboration-protocol/access/control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CurrentCanvasAccessPanel } from "../renderer/collaboration/CurrentCanvasAccessPanel";
import { CurrentCanvasMemberAccess } from "../renderer/collaboration/CurrentCanvasMemberAccess";
import { createTranslator } from "../renderer/i18n";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const t = createTranslator("en");
const scope = {
  scopeKind: "canvas" as const,
  workspaceId: "workspace-access-001",
  projectId: "project-access-001",
  canvasId: "canvas-access-001"
};

function accessView(
  projectRole: "owner" | "editor" | "viewer",
  canvasRole: "owner" | "editor" | "viewer" = projectRole
): CurrentCanvasAccessView {
  return {
    scope,
    projectVisibility: "private",
    canvasVisibility: "shared",
    projectAclRevision: 3,
    canvasAclRevision: 5,
    project: {
      scope: { ...scope, scopeKind: "project", canvasId: null },
      aclRevision: 3,
      effectiveRole: projectRole,
      roleSource: projectRole === "owner" ? "scope_owner" : "shared_workspace_membership",
      capabilities: accessCapabilityFlags(projectRole),
      disabledReason: null
    },
    canvas: {
      scope,
      aclRevision: 5,
      effectiveRole: canvasRole,
      roleSource: canvasRole === "owner" ? "scope_owner" : "shared_workspace_membership",
      capabilities: accessCapabilityFlags(canvasRole),
      disabledReason: null
    },
    people: [
      {
        humanPrincipalId: "human-member-001",
        displayName: "Member",
        membership: "active",
        effectiveRole: "viewer",
        capabilities: accessCapabilityFlags("viewer"),
        disabledReason: null,
        grants:
          projectRole === "owner" || canvasRole === "owner"
            ? [
                { grantId: "grant-project-viewer-001", scopeKind: "project", role: "viewer" },
                { grantId: "grant-canvas-viewer-001", scopeKind: "canvas", role: "viewer" }
              ]
            : []
      }
    ]
  };
}

afterEach(cleanupRendererTestEnvironment);

describe("CurrentCanvasAccessPanel", () => {
  it("stages canvas visibility without presenting identity records as a member list", async () => {
    const onUpdateVisibility = vi
      .fn()
      .mockResolvedValue({ status: "applied", aclRevision: 6, updatedAt: "2030-01-01T00:00:00Z" });
    render(
      <CurrentCanvasAccessPanel
        view={accessView("owner")}
        loading={false}
        error={null}
        busy={false}
        scopeSelector={<div data-testid="scope-selector-slot">Project / Canvas</div>}
        t={t}
        onRefresh={vi.fn()}
        onUpdateVisibility={onUpdateVisibility}
      />
    );

    expect(screen.queryByTestId("canvas-access-role")).not.toBeInTheDocument();
    expect(screen.queryByTestId("canvas-access-capability")).not.toBeInTheDocument();
    expect(screen.queryByTestId("canvas-access-person")).not.toBeInTheDocument();
    expect(screen.queryByText("Member")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View member" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("canvas-member-access")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("canvas-access-canvas-private"));
    expect(onUpdateVisibility).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("canvas-access-save"));
    expect(onUpdateVisibility).toHaveBeenCalledWith("canvas", "private");
  });

  it("keeps owner-only visibility visible but disabled for viewers with a stable reason", () => {
    render(
      <CurrentCanvasAccessPanel
        view={accessView("viewer")}
        loading={false}
        error={null}
        busy={false}
        t={t}
        onRefresh={vi.fn()}
        onUpdateVisibility={vi.fn()}
      />
    );

    const canvasVisibility = screen.getByTestId("canvas-access-canvas-shared");
    expect(canvasVisibility).toBeDisabled();
    expect(canvasVisibility).toHaveAttribute("title", "This action requires an owner capability.");
  });

  it("keeps owner-only visibility visible but disabled for editors", () => {
    render(
      <CurrentCanvasAccessPanel
        view={accessView("editor")}
        loading={false}
        error={null}
        busy={false}
        t={t}
        onRefresh={vi.fn()}
        onUpdateVisibility={vi.fn()}
      />
    );

    expect(screen.getByTestId("canvas-access-canvas-private")).toBeDisabled();
    expect(screen.getByTestId("canvas-access-canvas-private")).toHaveAttribute(
      "title",
      "This action requires an owner capability."
    );
  });

  it("binds project controls to project access when canvas ownership is independent", async () => {
    const onGrant = vi
      .fn()
      .mockResolvedValue({ status: "applied", aclRevision: 6, updatedAt: "2030-01-01T00:00:00Z" });
    const view = accessView("owner", "viewer");
    render(
      <CurrentCanvasMemberAccess
        view={view}
        person={view.people[0]!}
        busy={false}
        t={t}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />
    );

    await userEvent.click(screen.getByTestId("canvas-access-grant-project-editor"));
    expect(onGrant).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onGrant).toHaveBeenCalledWith("human-member-001", "editor", "project");
    expect(screen.getByTestId("canvas-access-grant-canvas-viewer")).toBeDisabled();
  });

  it("binds canvas controls to canvas access when project ownership is independent", async () => {
    const onGrant = vi
      .fn()
      .mockResolvedValue({ status: "applied", aclRevision: 6, updatedAt: "2030-01-01T00:00:00Z" });
    const view = accessView("viewer", "owner");
    render(
      <CurrentCanvasMemberAccess
        view={view}
        person={view.people[0]!}
        busy={false}
        t={t}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />
    );

    await userEvent.click(screen.getByTestId("canvas-access-grant-canvas-editor"));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onGrant).toHaveBeenCalledWith("human-member-001", "editor", "canvas");
    expect(screen.getByTestId("canvas-access-grant-project-editor")).toBeDisabled();
  });
  it("does not report success or attempt the canvas mutation after project authorization fails", async () => {
    const view = accessView("owner");
    const onGrant = vi
      .fn()
      .mockResolvedValue({ status: "conflict", reason: "acl_revision_conflict", aclRevision: 7 });
    render(
      <CurrentCanvasMemberAccess
        view={view}
        person={view.people[0]!}
        busy={false}
        t={t}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />
    );
    await userEvent.click(screen.getByTestId("canvas-access-grant-project-editor"));
    await userEvent.click(screen.getByTestId("canvas-access-grant-canvas-editor"));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onGrant).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("could not be saved");
    expect(screen.queryByText("Changes saved")).not.toBeInTheDocument();
  });

  it("cancels staged permission changes without issuing mutations", async () => {
    const view = accessView("owner");
    const onGrant = vi.fn();
    const onRevoke = vi.fn();
    render(
      <CurrentCanvasMemberAccess
        view={view}
        person={view.people[0]!}
        busy={false}
        t={t}
        onGrant={onGrant}
        onRevoke={onRevoke}
      />
    );
    await userEvent.click(screen.getByTestId("canvas-access-grant-canvas-none"));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("canvas-access-grant-canvas-viewer")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(onRevoke).not.toHaveBeenCalled();
    expect(onGrant).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });
});
