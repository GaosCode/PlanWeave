import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initWorkspace } from "../initWorkspace.js";
import { readProjectPaths } from "../paths.js";

describe("readProjectPaths", () => {
  it("returns stable agent-facing workspace paths after init", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave-project-"));
    process.env.PLANWEAVE_HOME = home;
    const init = await initWorkspace({ projectRoot: root });

    const paths = await readProjectPaths(root);

    expect(paths).toEqual({
      workspaceDir: home,
      projectId: init.workspace.id,
      projectDir: init.workspace.workspaceRoot,
      packageDir: init.workspace.packageDir,
      statePath: init.workspace.stateFile,
      resultsDir: init.workspace.resultsDir
    });
    delete process.env.PLANWEAVE_HOME;
  });

  it("does not create or imply a workspace when the project has not been initialized", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave-project-"));
    process.env.PLANWEAVE_HOME = home;

    await expect(readProjectPaths(root)).rejects.toThrow("has not been initialized");
    delete process.env.PLANWEAVE_HOME;
  });
});
