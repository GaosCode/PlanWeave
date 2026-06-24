import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSourceDefaultProject, initManagedProject, linkProjectSourceRoot, setSourceDefaultProject } from "@planweave-ai/runtime";
import { createProgram } from "../index.js";
import { resolveCliProjectRoot } from "../projectRoot.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.INIT_CWD;
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_PROJECT_ROOT;
});

describe("CLI project root resolution", () => {
  it("uses the source root default project when no explicit root is set", async () => {
    process.env.PLANWEAVE_HOME = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "planweave-cli-source-"));
    const project = await initManagedProject("CLI Source Default");
    await linkProjectSourceRoot(project.projectId, sourceRoot);
    await setSourceDefaultProject(sourceRoot, project.projectId);
    process.env.INIT_CWD = sourceRoot;

    await expect(resolveCliProjectRoot()).resolves.toBe(project.workspaceRoot);
  });

  it("lets PLANWEAVE_PROJECT_ROOT override the source root default", async () => {
    process.env.PLANWEAVE_HOME = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "planweave-cli-source-"));
    const explicitRoot = await realpath(await mkdtemp(join(tmpdir(), "planweave-explicit-")));
    const project = await initManagedProject("CLI Source Default Override");
    await linkProjectSourceRoot(project.projectId, sourceRoot);
    await setSourceDefaultProject(sourceRoot, project.projectId);
    process.env.INIT_CWD = sourceRoot;
    process.env.PLANWEAVE_PROJECT_ROOT = explicitRoot;

    await expect(resolveCliProjectRoot()).resolves.toBe(explicitRoot);
  });

  it("sets the source root default from the use command", async () => {
    process.env.PLANWEAVE_HOME = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "planweave-cli-source-"));
    const project = await initManagedProject("CLI Use Command");
    const alternateProject = await initManagedProject("CLI Alternate Use Command");
    await linkProjectSourceRoot(project.projectId, sourceRoot);
    await linkProjectSourceRoot(alternateProject.projectId, sourceRoot);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createProgram().parseAsync(["use", project.projectId, "--source-root", sourceRoot, "--json"], { from: "user" });

    expect(JSON.parse(log.mock.calls.at(-1)?.[0] ?? "{}")).toMatchObject({
      action: "set",
      defaultProject: {
        projectId: project.projectId,
        projectRoot: project.workspaceRoot
      }
    });
    expect(JSON.parse(log.mock.calls.at(-1)?.[0] ?? "{}")).toMatchObject({
      availableProjects: expect.arrayContaining([
        expect.objectContaining({ projectId: project.projectId }),
        expect.objectContaining({ projectId: alternateProject.projectId })
      ])
    });
    await expect(getSourceDefaultProject(sourceRoot)).resolves.toMatchObject({
      projectId: project.projectId,
      projectRoot: project.workspaceRoot
    });
  });
});
