import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { optionalStat } from "../fs/optionalFile.js";
import { initialManifest } from "../initWorkspace.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { createEmptyState } from "../state.js";
import type { ProjectWorkspace } from "../types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function writeManifestTitle(
  workspace: ProjectWorkspace,
  title: string
): Promise<string> {
  const raw = asRecord(await readJsonFile<unknown>(workspace.manifestFile));
  if (!raw) {
    throw new Error(`Task canvas manifest '${workspace.manifestFile}' is not an object.`);
  }
  const project = asRecord(raw.project);
  if (!project || typeof project.title !== "string") {
    throw new Error(`Task canvas manifest '${workspace.manifestFile}' is missing project.title.`);
  }
  const previousTitle = project.title;
  await writeJsonFile(workspace.manifestFile, {
    ...raw,
    project: {
      ...project,
      title
    }
  });
  return previousTitle;
}

async function copyOptionalCanvasLayout(
  sourceWorkspace: ProjectWorkspace,
  targetWorkspace: ProjectWorkspace
): Promise<void> {
  const sourceLayoutFile = join(sourceWorkspace.workspaceRoot, "desktop", "layout.json");
  const sourceLayoutStat = await optionalStat(sourceLayoutFile);
  if (!sourceLayoutStat?.isFile()) {
    return;
  }
  const targetLayoutFile = join(targetWorkspace.workspaceRoot, "desktop", "layout.json");
  await mkdir(dirname(targetLayoutFile), { recursive: true });
  await cp(sourceLayoutFile, targetLayoutFile);
}

/** Write a brand-new empty canvas package + state + results into an existing staging root. */
export async function writeEmptyCanvasWorkspace(
  workspace: ProjectWorkspace,
  title: string
): Promise<void> {
  await mkdir(join(workspace.packageDir, "nodes"), { recursive: true });
  await mkdir(workspace.resultsDir, { recursive: true });
  await writeJsonFile(workspace.manifestFile, initialManifest(title));
  await writeJsonFile(workspace.stateFile, createEmptyState());
}

/**
 * Copy package content from a source canvas into a staging target.
 * Runtime state and results are reset; optional desktop layout is preserved when present.
 */
export async function populateDuplicatedCanvasWorkspace(
  sourceWorkspace: ProjectWorkspace,
  targetWorkspace: ProjectWorkspace,
  title: string
): Promise<void> {
  await cp(sourceWorkspace.packageDir, targetWorkspace.packageDir, { recursive: true });
  await writeManifestTitle(targetWorkspace, title);
  await writeJsonFile(targetWorkspace.stateFile, createEmptyState());
  await mkdir(targetWorkspace.resultsDir, { recursive: true });
  await copyOptionalCanvasLayout(sourceWorkspace, targetWorkspace);
}
