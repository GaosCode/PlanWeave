import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { readJsonFile } from "../json.js";
import type { ProjectWorkspace } from "../types.js";
import type { DesktopAutoRunState } from "./types.js";
import { loadProjectGraphForWorkspace, projectCanvasWorkspace } from "../projectGraph/index.js";
import { autoRunRoot, writeAutoRunState } from "./runStateStore.js";
import { normalizePersistedAutoRunState, recoverPersistedAutoRunState } from "./runRecovery.js";

const desktopRunIdPattern = /^DESKTOP-RUN-(\d{4,})$/;

function autoRunsRoot(workspace: ProjectWorkspace): string {
  return join(workspace.resultsDir, "auto-runs");
}

function projectsRoot(workspace: ProjectWorkspace): string {
  return join(workspace.planweaveHome, "projects");
}

function globalAutoRunIdsRoot(workspace: ProjectWorkspace): string {
  return join(workspace.planweaveHome, "desktop", "auto-run-ids");
}

function runNumber(runId: string): number | null {
  const match = desktopRunIdPattern.exec(runId);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function listRunDirectories(workspace: ProjectWorkspace): Promise<string[]> {
  return listRunDirectoriesAt(autoRunsRoot(workspace));
}

async function listRunDirectoriesAt(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && desktopRunIdPattern.test(entry.name)).map((entry) => entry.name);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function listProjectWorkspaceRoots(workspace: ProjectWorkspace): Promise<string[]> {
  try {
    const entries = await readdir(projectsRoot(workspace), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(projectsRoot(workspace), entry.name));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function workspaceFromRoot(workspace: ProjectWorkspace, workspaceRoot: string): ProjectWorkspace {
  return {
    id: basename(workspaceRoot),
    rootPath: workspaceRoot,
    planweaveHome: workspace.planweaveHome,
    workspaceRoot,
    projectFile: join(workspaceRoot, "project.json"),
    packageDir: join(workspaceRoot, "package"),
    manifestFile: join(workspaceRoot, "package", "manifest.json"),
    stateFile: join(workspaceRoot, "state.json"),
    resultsDir: join(workspaceRoot, "results"),
    projectPromptFile: join(workspaceRoot, "policy", "project-prompt.md")
  };
}

async function listCanvasAutoRunRoots(workspace: ProjectWorkspace): Promise<string[]> {
  try {
    const loaded = await loadProjectGraphForWorkspace(workspace);
    return loaded.manifest.canvases.map((canvas) => autoRunsRoot(projectCanvasWorkspace(loaded.workspace, canvas)));
  } catch (error) {
    void error;
    return [];
  }
}

async function listAutoRunRootsAcrossProjects(workspace: ProjectWorkspace): Promise<string[]> {
  const autoRunRoots = new Set([autoRunsRoot(workspace)]);
  for (const workspaceRoot of await listProjectWorkspaceRoots(workspace)) {
    autoRunRoots.add(join(workspaceRoot, "results", "auto-runs"));
    for (const canvasAutoRunRoot of await listCanvasAutoRunRoots(workspaceFromRoot(workspace, workspaceRoot))) {
      autoRunRoots.add(canvasAutoRunRoot);
    }
  }
  return [...autoRunRoots];
}

async function listPersistedRunDirectoriesAcrossProjects(workspace: ProjectWorkspace): Promise<string[]> {
  const runIds: string[] = [];
  for (const autoRunDirectory of await listAutoRunRootsAcrossProjects(workspace)) {
    runIds.push(...(await listRunDirectoriesAt(autoRunDirectory)));
  }
  return runIds;
}

function maxRunNumber(runIds: string[]): number {
  return runIds
    .map(runNumber)
    .filter((value): value is number => value !== null)
    .reduce((max, value) => Math.max(max, value), 0);
}

function compareAutoRunStatesNewestFirst(left: DesktopAutoRunState, right: DesktopAutoRunState): number {
  const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
  if (byUpdatedAt !== 0) {
    return byUpdatedAt;
  }
  return right.runId.localeCompare(left.runId, undefined, { numeric: true });
}

export async function nextPersistedAutoRunId(workspace: ProjectWorkspace, options: { isReserved?: (runId: string) => boolean } = {}): Promise<string> {
  await mkdir(autoRunsRoot(workspace), { recursive: true });
  await mkdir(globalAutoRunIdsRoot(workspace), { recursive: true });
  let nextNumber = Math.max(
    maxRunNumber(await listPersistedRunDirectoriesAcrossProjects(workspace)),
    maxRunNumber(await listRunDirectoriesAt(globalAutoRunIdsRoot(workspace)))
  ) + 1;
  while (true) {
    const runId = `DESKTOP-RUN-${String(nextNumber).padStart(4, "0")}`;
    if (options.isReserved?.(runId)) {
      nextNumber += 1;
      continue;
    }
    try {
      await mkdir(join(globalAutoRunIdsRoot(workspace), runId), { recursive: false });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        nextNumber += 1;
        continue;
      }
      throw error;
    }
    try {
      await mkdir(autoRunRoot(workspace, runId), { recursive: false });
      return runId;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        nextNumber += 1;
        continue;
      }
      throw error;
    }
  }
}

export async function readPersistedAutoRunState(workspace: ProjectWorkspace, runId: string, options: { hasActiveLoop?: boolean } = {}): Promise<DesktopAutoRunState | null> {
  const runRoot = autoRunRoot(workspace, runId);
  const statePath = join(runRoot, "state.json");
  const eventLogPath = join(runRoot, "events.ndjson");
  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(statePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    return null;
  }
  const state = normalizePersistedAutoRunState(raw, { statePath, eventLogPath });
  return state ? recoverPersistedAutoRunState(state, options.hasActiveLoop ?? false) : null;
}

export async function listPersistedAutoRunStates(workspace: ProjectWorkspace, options: { hasActiveLoop?: (runId: string) => boolean } = {}): Promise<DesktopAutoRunState[]> {
  const states: DesktopAutoRunState[] = [];
  for (const runId of await listRunDirectories(workspace)) {
    const state = await readPersistedAutoRunState(workspace, runId, { hasActiveLoop: options.hasActiveLoop?.(runId) ?? false });
    if (state) {
      states.push(state);
    }
  }
  return states.sort(compareAutoRunStatesNewestFirst);
}

export async function writePersistedAutoRunState(state: DesktopAutoRunState): Promise<void> {
  await writeAutoRunState(state);
}
