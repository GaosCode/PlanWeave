import { initManagedWorkspace, listProjects, validatePackage } from "@planweave-ai/runtime";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const markerFileName = "first-launch-example.json";
const exampleProjectName = "PlanWeave Example";

const markerSchema = z.union([
  z
    .object({
      schemaVersion: z.literal(1),
      state: z.literal("initializing")
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      state: z.literal("complete"),
      outcome: z.literal("example_loaded"),
      projectId: z.string().min(1)
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      state: z.literal("complete"),
      outcome: z.literal("existing_projects")
    })
    .strict()
]);

type FirstLaunchMarker = z.infer<typeof markerSchema>;

type FirstLaunchExampleResult =
  | { outcome: "already_initialized" }
  | { outcome: "existing_projects" }
  | { outcome: "example_loaded"; projectId: string };

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && error.code === "ENOENT"
  );
}

function firstLaunchExampleMarkerPath(userDataDir: string): string {
  return join(userDataDir, markerFileName);
}

async function readMarker(path: string): Promise<FirstLaunchMarker | null> {
  try {
    return markerSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }
}

async function writeMarker(path: string, marker: FirstLaunchMarker): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function initializeFirstLaunchExample(options: {
  userDataDir: string;
  examplePackageDir: string;
}): Promise<FirstLaunchExampleResult> {
  const markerPath = firstLaunchExampleMarkerPath(options.userDataDir);
  const marker = await readMarker(markerPath);
  if (marker?.state === "complete") {
    return { outcome: "already_initialized" };
  }

  if (!marker) {
    const projects = await listProjects();
    if (projects.length > 0) {
      await writeMarker(markerPath, {
        schemaVersion: 1,
        state: "complete",
        outcome: "existing_projects"
      });
      return { outcome: "existing_projects" };
    }
    await writeMarker(markerPath, { schemaVersion: 1, state: "initializing" });
  }

  const initialized = await initManagedWorkspace({ name: exampleProjectName });
  await cp(options.examplePackageDir, initialized.workspace.packageDir, {
    recursive: true,
    force: true
  });
  const validation = await validatePackage({ projectRoot: initialized.workspace.rootPath });
  if (!validation.ok) {
    const diagnostics = validation.errors.map((issue) => {
      if (!issue.path) {
        return issue.message;
      }
      return `${issue.path}: ${issue.message}`;
    });
    throw new Error(`Bundled example package is invalid: ${diagnostics.join("; ")}`);
  }

  await writeMarker(markerPath, {
    schemaVersion: 1,
    state: "complete",
    outcome: "example_loaded",
    projectId: initialized.project.id
  });
  return { outcome: "example_loaded", projectId: initialized.project.id };
}

export type { FirstLaunchExampleResult };
export { firstLaunchExampleMarkerPath, initializeFirstLaunchExample };
