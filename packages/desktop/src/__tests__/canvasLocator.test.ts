import { describe, expect, it } from "vitest";
import {
  canvasLocatorSchema,
  canvasLocatorToCollaborationBinding,
  parsePersistedWorkspaceCanvasLocator,
  workspaceCanvasLocatorSchema
} from "../shared/canvasLocator.js";
import { collaborationCanvasBindingInputSchema } from "../shared/collaborationCanvasBinding.js";
import { normalizeDesktopSettings } from "../shared/desktopSettings.js";

const workspaceLocator = {
  kind: "workspace" as const,
  connectionProfileId: "profile-1",
  workspaceId: "workspace-1",
  projectId: "project-1",
  canvasId: "canvas-1"
};

describe("canvasLocatorSchema", () => {
  it("keeps local and workspace identities mutually exclusive", () => {
    expect(
      canvasLocatorSchema.parse({
        kind: "local",
        projectId: "local-project",
        canvasId: "default"
      })
    ).toEqual({ kind: "local", projectId: "local-project", canvasId: "default" });
    expect(canvasLocatorSchema.parse(workspaceLocator)).toEqual(workspaceLocator);
  });

  it("maps workspace locators to remote bindings without connectionProfileId", () => {
    const binding = canvasLocatorToCollaborationBinding(workspaceLocator);
    expect(binding).toEqual({
      kind: "remote",
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });
    expect(binding).not.toHaveProperty("connectionProfileId");
    expect(collaborationCanvasBindingInputSchema.parse(binding)).toEqual(binding);
  });

  it("maps local locators to local bindings", () => {
    expect(
      canvasLocatorToCollaborationBinding({
        kind: "local",
        projectId: "local-project",
        canvasId: "default"
      })
    ).toEqual({
      kind: "local",
      localProjectId: "local-project",
      canvasId: "default"
    });
  });

  it.each([
    {},
    { kind: "workspace", workspaceId: "workspace-1", projectId: "project-1", canvasId: "canvas-1" },
    {
      ...workspaceLocator,
      graph: { tasks: [] }
    },
    {
      kind: "local",
      projectId: "local-project",
      canvasId: "default",
      connectionProfileId: "profile-1"
    }
  ])("rejects incomplete locators and extra authority payload", (input) => {
    expect(() => canvasLocatorSchema.parse(input)).toThrow();
  });
});

describe("parsePersistedWorkspaceCanvasLocator", () => {
  it("keeps a valid workspace locator and discards schema mismatches", () => {
    expect(parsePersistedWorkspaceCanvasLocator(workspaceLocator)).toEqual(workspaceLocator);
    expect(parsePersistedWorkspaceCanvasLocator(null)).toBeNull();
    expect(
      parsePersistedWorkspaceCanvasLocator({
        ...workspaceLocator,
        version: 2
      })
    ).toBeNull();
    expect(
      parsePersistedWorkspaceCanvasLocator({
        kind: "local",
        projectId: "local-project",
        canvasId: "default"
      })
    ).toBeNull();
  });

  it("discards an invalid last-opened workspace locator from desktop settings", () => {
    expect(
      normalizeDesktopSettings({
        lastOpenedWorkspaceLocator: {
          kind: "workspace",
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "canvas-1"
        }
      }).lastOpenedWorkspaceLocator
    ).toBeNull();
    expect(
      normalizeDesktopSettings({
        lastOpenedWorkspaceLocator: workspaceLocator
      }).lastOpenedWorkspaceLocator
    ).toEqual(workspaceCanvasLocatorSchema.parse(workspaceLocator));
  });
});
