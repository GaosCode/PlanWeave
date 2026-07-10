/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentScopePrompt, writeAgentScopePromptToClipboard } from "../renderer/agentPrompt";

const project = {
  projectId: "P-001",
  rootPath: "/tmp/plan-project",
  sourceRoot: "/tmp/source-root",
  workspaceRoot: "/tmp/plan-project"
};

describe("agent scope prompt", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined)
      }
    });
  });

  it("builds canvas scope without skill or status summary", () => {
    expect(
      buildAgentScopePrompt({
        project,
        canvasId: "default",
        packageDir: "canvases/default/package"
      })
    ).toBe(
      "projectId: P-001\nprojectRoot: /tmp/plan-project\nworkspaceRoot: /tmp/plan-project\ncanvasId: default\npackageDir: /tmp/plan-project/canvases/default/package\nsourceRoot: /tmp/source-root"
    );
  });

  it("adds task_id only when task scope is present", () => {
    const prompt = buildAgentScopePrompt({
      project,
      canvasId: "default",
      packageDir: "/tmp/absolute-package",
      taskId: "T-001"
    });

    expect(prompt).toBe(
      "projectId: P-001\nprojectRoot: /tmp/plan-project\nworkspaceRoot: /tmp/plan-project\ncanvasId: default\npackageDir: /tmp/absolute-package\nsourceRoot: /tmp/source-root\ntask_id: T-001"
    );
    expect(prompt).not.toContain("skill");
    expect(prompt).not.toContain("status");
  });

  it("keeps workspace and packageDir when projectRoot matches sourceRoot", () => {
    const externalProject = {
      projectId: "P-EXT",
      rootPath: "/tmp/source-root",
      sourceRoot: "/tmp/source-root",
      workspaceRoot: "/tmp/.planweave/P-EXT"
    };

    expect(
      buildAgentScopePrompt({
        project: externalProject,
        canvasId: "default",
        packageDir: "canvases/default/package"
      })
    ).toContain(
      "workspaceRoot: /tmp/.planweave/P-EXT\ncanvasId: default\npackageDir: /tmp/.planweave/P-EXT/canvases/default/package"
    );
  });

  it("rejects unavailable packageDir instead of writing an unusable prompt", async () => {
    expect(() => buildAgentScopePrompt({ project, canvasId: "default", packageDir: "" })).toThrow(
      "Cannot build agent prompt because packageDir is unavailable."
    );

    await expect(
      writeAgentScopePromptToClipboard({ project, canvasId: "default", packageDir: "" })
    ).rejects.toThrow("Cannot build agent prompt because packageDir is unavailable.");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
});
