import { access } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { listProjects, removeProject } from "../desktop/index.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("desktop project API", () => {
  it("lists projects from the PlanWeave home registry", async () => {
    const { init } = await createTestWorkspace();

    await expect(listProjects()).resolves.toEqual([
      expect.objectContaining({
        projectId: init.workspace.id,
        rootPath: init.workspace.rootPath
      })
    ]);
  });

  it("removes a project from the PlanWeave registry without deleting the source root", async () => {
    const { init, root } = await createTestWorkspace();

    await expect(removeProject(init.workspace.id)).resolves.toBeUndefined();

    await expect(listProjects()).resolves.toEqual([]);
    await expect(access(root)).resolves.toBeUndefined();
  });
});
