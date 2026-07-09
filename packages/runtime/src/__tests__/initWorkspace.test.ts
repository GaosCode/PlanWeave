import { access, mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initManagedWorkspace, initWorkspace } from "../initWorkspace.js";
import { readJsonFile } from "../json.js";
import { projectGraphPath } from "../projectGraph/index.js";

describe("initWorkspace", () => {
  it("creates a v1 workspace with separate global and project prompts", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave-project-"));
    process.env.PLANWEAVE_HOME = home;

    const result = await initWorkspace({ projectRoot: root });
    const manifest = await readJsonFile<Record<string, unknown>>(result.workspace.manifestFile);
    const state = await readJsonFile<Record<string, unknown>>(result.workspace.stateFile);

    expect(manifest.version).toBe("plan-package/v1");
    expect(manifest).not.toHaveProperty("global_prompt");
    expect(result.workspace.packageDir).toBe(
      join(result.workspace.workspaceRoot, "canvases", "default", "package")
    );
    expect(result.workspace.stateFile).toBe(
      join(result.workspace.workspaceRoot, "canvases", "default", "state.json")
    );
    expect(result.workspace.resultsDir).toBe(
      join(result.workspace.workspaceRoot, "canvases", "default", "results")
    );
    await expect(access(join(home, "config", "global-prompt.md"))).resolves.toBeUndefined();
    await expect(access(join(result.workspace.workspaceRoot, "package"))).rejects.toThrow();
    await expect(access(join(result.workspace.workspaceRoot, "state.json"))).rejects.toThrow();
    await expect(access(join(result.workspace.workspaceRoot, "results"))).rejects.toThrow();
    await expect(readFile(result.workspace.projectPromptFile, "utf8")).resolves.toContain(
      "# Project Prompt"
    );
    await expect(readJsonFile(projectGraphPath(result.workspace))).resolves.toMatchObject({
      version: "plan-project/v1",
      canvases: [
        {
          id: "default",
          type: "canvas",
          packageDir: "canvases/default/package",
          stateFile: "canvases/default/state.json",
          resultsDir: "canvases/default/results"
        }
      ]
    });
    expect(state).toEqual({
      currentRefs: [],
      currentFeedbackId: null,
      currentReviewBlockRef: null,
      tasks: {},
      blocks: {},
      feedback: {}
    });
    delete process.env.PLANWEAVE_HOME;
  });

  it("creates managed projects directly in the PlanWeave workspace registry", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    process.env.PLANWEAVE_HOME = home;

    const result = await initManagedWorkspace({ name: "New Project" });
    const project = await readJsonFile<Record<string, unknown>>(result.workspace.projectFile);

    expect(result.workspace.kind).toBe("managed");
    expect(result.workspace.rootPath).toBe(result.workspace.workspaceRoot);
    expect(result.workspace.sourceRoot).toBeNull();
    expect(result.workspace.workspaceRoot).toBe(join(home, "projects", result.workspace.id));
    expect(project).toMatchObject({
      id: result.workspace.id,
      name: "New Project",
      rootPath: result.workspace.workspaceRoot,
      kind: "managed",
      sourceRoot: null
    });
    await expect(
      access(
        join(result.workspace.workspaceRoot, "canvases", "default", "package", "manifest.json")
      )
    ).resolves.toBeUndefined();
    await expect(access(join(result.workspace.workspaceRoot, "package"))).rejects.toThrow();
    await expect(access(join(home, "mcp-projects"))).rejects.toThrow();
    delete process.env.PLANWEAVE_HOME;
  });

  it("initializes an empty directory directly under PLANWEAVE_HOME/projects in place", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = join(home, "projects", "manual-plan");
    process.env.PLANWEAVE_HOME = home;
    await mkdir(root, { recursive: true });

    const result = await initWorkspace({ projectRoot: root, projectGraph: true });
    const resolvedRoot = await realpath(root);
    const project = await readJsonFile<Record<string, unknown>>(result.workspace.projectFile);

    expect(result.workspace.kind).toBe("managed");
    expect(result.workspace.workspaceRoot).toBe(resolvedRoot);
    expect(result.workspace.rootPath).toBe(resolvedRoot);
    expect(result.workspace.sourceRoot).toBeNull();
    expect(project).toMatchObject({
      id: "manual-plan",
      name: "manual-plan",
      rootPath: resolvedRoot,
      kind: "managed",
      sourceRoot: null
    });
    await expect(
      access(join(root, "canvases", "default", "package", "manifest.json"))
    ).resolves.toBeUndefined();
    delete process.env.PLANWEAVE_HOME;
  });

  it("rejects init roots inside PLANWEAVE_HOME outside projects entries", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = join(home, "scratch", "manual-plan");
    process.env.PLANWEAVE_HOME = home;
    await mkdir(root, { recursive: true });

    await expect(initWorkspace({ projectRoot: root })).rejects.toThrow(
      `PlanWeave projects must be initialized directly under '${join(home, "projects")}'.`
    );
    await expect(access(join(home, "projects"))).rejects.toThrow();
    delete process.env.PLANWEAVE_HOME;
  });
});
