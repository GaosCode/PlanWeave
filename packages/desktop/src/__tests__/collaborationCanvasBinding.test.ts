import { describe, expect, it } from "vitest";
import { collaborationCanvasBindingInputSchema } from "../shared/collaborationCanvasBinding.js";

describe("collaborationCanvasBindingInputSchema", () => {
  it("keeps local and remote canvas identities mutually exclusive", () => {
    expect(
      collaborationCanvasBindingInputSchema.parse({
        kind: "local",
        localProjectId: "local-project",
        canvasId: "default"
      })
    ).toEqual({ kind: "local", localProjectId: "local-project", canvasId: "default" });
    expect(
      collaborationCanvasBindingInputSchema.parse({
        kind: "remote",
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "canvas-1"
      })
    ).toEqual({
      kind: "remote",
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });
  });

  it.each([
    {},
    { kind: "remote", projectId: "project-1", canvasId: "canvas-1" },
    {
      kind: "remote",
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "canvas-1",
      localProjectId: "synthetic-local"
    },
    { kind: "local", localProjectId: "local-project", canvasId: "default", projectId: "extra" }
  ])("rejects incomplete or mixed identities", (input) => {
    expect(() => collaborationCanvasBindingInputSchema.parse(input)).toThrow();
  });
});
