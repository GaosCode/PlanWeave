import {
  initManagedWorkspace,
  listProjects,
  manifestSchema,
  validatePackage
} from "@planweave-ai/runtime";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  firstLaunchExampleMarkerPath,
  initializeFirstLaunchExample
} from "../main/firstLaunchExample.js";

const examplePackageDir = resolve(
  import.meta.dirname,
  "../../../..",
  "examples/basic-plan-package/package"
);
const exampleTaskCount = 6;
const exampleDependencyCount = 6;

describe("first-launch example", () => {
  let temporaryRoot: string;
  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "planweave-first-launch-"));
    vi.stubEnv("PLANWEAVE_HOME", join(temporaryRoot, "home"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("loads the bundled package once and leaves the managed project unchanged later", async () => {
    const userDataDir = join(temporaryRoot, "user-data");
    const firstResult = await initializeFirstLaunchExample({ userDataDir, examplePackageDir });

    expect(firstResult.outcome).toBe("example_loaded");
    const projects = await listProjects();
    expect(projects).toHaveLength(1);
    const [project] = projects;
    expect(project?.name).toBe("PlanWeave Example");
    if (!project) {
      throw new Error("Expected the example project to exist.");
    }
    await expect(validatePackage({ projectRoot: project.rootPath })).resolves.toMatchObject({
      ok: true
    });
    const manifest = manifestSchema.parse(
      JSON.parse(
        await readFile(
          join(project.workspaceRoot, "canvases/default/package/manifest.json"),
          "utf8"
        )
      )
    );
    expect(manifest.nodes).toHaveLength(exampleTaskCount);
    expect(manifest.edges).toHaveLength(exampleDependencyCount);
    expect(manifest.execution.parallel.enabled).toBe(true);

    const sentinelPath = join(project.workspaceRoot, "canvases/default/package/user-note.md");
    await writeFile(sentinelPath, "keep me\n", "utf8");

    await expect(initializeFirstLaunchExample({ userDataDir, examplePackageDir })).resolves.toEqual(
      { outcome: "already_initialized" }
    );
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("keep me\n");
    await expect(listProjects()).resolves.toHaveLength(1);
  });

  it("does not add an example when a project already exists", async () => {
    await initManagedWorkspace({ name: "Existing Project" });
    const userDataDir = join(temporaryRoot, "user-data");

    await expect(initializeFirstLaunchExample({ userDataDir, examplePackageDir })).resolves.toEqual(
      { outcome: "existing_projects" }
    );
    await expect(listProjects()).resolves.toHaveLength(1);
    await expect(
      JSON.parse(await readFile(firstLaunchExampleMarkerPath(userDataDir), "utf8"))
    ).toMatchObject({ state: "complete", outcome: "existing_projects" });
  });

  it("resumes an interrupted first-launch copy", async () => {
    const userDataDir = join(temporaryRoot, "user-data");
    await mkdir(userDataDir, { recursive: true });
    await writeFile(
      firstLaunchExampleMarkerPath(userDataDir),
      `${JSON.stringify({ schemaVersion: 1, state: "initializing" })}\n`,
      "utf8"
    );

    await expect(
      initializeFirstLaunchExample({ userDataDir, examplePackageDir })
    ).resolves.toMatchObject({ outcome: "example_loaded" });
    await expect(listProjects()).resolves.toHaveLength(1);
  });
});
