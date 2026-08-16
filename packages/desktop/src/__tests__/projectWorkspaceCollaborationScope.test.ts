import { describe, expect, it } from "vitest";
import { collaborationSurfaceCanvasIdForView } from "../renderer/ProjectWorkspaceProvider";
import {
  resolveCollaborationCanvasReadBinding,
  resolveCollaborationSurfaceReadBinding
} from "../renderer/hooks/useCollaborationSurface";

describe("project workspace collaboration scope", () => {
  it("keeps the Members route global when a private sidebar canvas is selected", () => {
    expect(collaborationSurfaceCanvasIdForView("people", "private-canvas")).toBeNull();
  });

  it("keeps canvas filtering for canvas-scoped application routes", () => {
    expect(collaborationSurfaceCanvasIdForView("graph", "shared-canvas")).toBe("shared-canvas");
  });

  it("does not bind remote assignment reads to a different local project", () => {
    expect(
      resolveCollaborationSurfaceReadBinding({
        sessionConnected: true,
        profileId: "profile-1",
        profileProjectId: "tiny-notes",
        localProjectId: "planweave",
        canvasId: "default"
      })
    ).toEqual({ profileId: null, projectId: null, canvasId: null });
  });

  it("keeps same-project assignment reads scoped to the selected canvas", () => {
    expect(
      resolveCollaborationSurfaceReadBinding({
        sessionConnected: true,
        profileId: "profile-1",
        profileProjectId: "planweave",
        localProjectId: "planweave",
        canvasId: "default"
      })
    ).toEqual({ profileId: "profile-1", projectId: "planweave", canvasId: "default" });
  });

  it("does not bind project-global reads through a profile for another local project", () => {
    expect(
      resolveCollaborationSurfaceReadBinding({
        sessionConnected: true,
        profileId: "profile-1",
        profileProjectId: "tiny-notes",
        localProjectId: "planweave",
        canvasId: null
      })
    ).toEqual({ profileId: null, projectId: null, canvasId: null });
  });

  it("does not query assignments until the selected local canvas resolves to an authorized scope", () => {
    const readBinding = {
      profileId: "profile-1",
      projectId: "tiny-notes",
      canvasId: "private-canvas"
    };

    expect(resolveCollaborationCanvasReadBinding(readBinding, null)).toEqual({
      profileId: null,
      projectId: null,
      canvasId: null
    });
    expect(
      resolveCollaborationCanvasReadBinding(readBinding, {
        localProjectId: "tiny-notes",
        localCanvasId: "private-canvas",
        remoteProjectId: "tiny-notes",
        remoteCanvasId: "shared-canvas"
      })
    ).toEqual({
      profileId: "profile-1",
      projectId: "tiny-notes",
      canvasId: "shared-canvas"
    });
  });
});
