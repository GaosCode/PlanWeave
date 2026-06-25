import { access, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readJsonFile } from "../json.js";
import { manifestSchema } from "../schema/manifest.js";
import type { ProjectWorkspace } from "../types.js";

export type StagedCanvasWorkspaceWrite = {
  canvasId: string;
  stagingRoot: string;
  finalRoot: string;
  workspace: ProjectWorkspace;
};

export type CanvasWorkspaceDirectory = {
  name: string;
  path: string;
  mtimeMs: number;
};

export type CanvasWorkspaceAnomalies = {
  orphanDirectories: CanvasWorkspaceDirectory[];
  unrecognizedOrphanDirectories: CanvasWorkspaceDirectory[];
  stagingDirectories: CanvasWorkspaceDirectory[];
  quarantineDirectories: CanvasWorkspaceDirectory[];
};

export const DEFAULT_CANVAS_WORKSPACE_STALE_THRESHOLD_MS = 5 * 60 * 1000;

export type CanvasWorkspaceAnomalyOptions = {
  staleThresholdMs?: number;
  nowMs?: number;
};

export async function canvasRecoveryPathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, "-");
  let start = 0;
  let end = safe.length;
  while (start < end && safe[start] === "-") {
    start += 1;
  }
  while (end > start && safe[end - 1] === "-") {
    end -= 1;
  }
  return safe.slice(start, end) || "canvas";
}

function assertWorkspaceDescendant(projectWorkspace: ProjectWorkspace, path: string): void {
  const workspaceRoot = resolve(projectWorkspace.workspaceRoot);
  const target = resolve(path);
  const relativeTarget = relative(workspaceRoot, target);
  if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new Error(`Task canvas recovery path '${path}' is outside the PlanWeave workspace or points at the workspace root.`);
  }
}

function canvasRootWorkspace(projectWorkspace: ProjectWorkspace, workspaceRoot: string): ProjectWorkspace {
  return {
    ...projectWorkspace,
    workspaceRoot,
    packageDir: join(workspaceRoot, "package"),
    manifestFile: join(workspaceRoot, "package", "manifest.json"),
    stateFile: join(workspaceRoot, "state.json"),
    resultsDir: join(workspaceRoot, "results")
  };
}

function canvasStagingRoot(projectWorkspace: ProjectWorkspace): string {
  return join(projectWorkspace.workspaceRoot, "desktop", "canvas-staging");
}

function canvasQuarantineRoot(projectWorkspace: ProjectWorkspace): string {
  return join(projectWorkspace.workspaceRoot, "desktop", "canvas-quarantine");
}

async function uniqueRecoveryDirectory(parent: string, canvasId: string): Promise<string> {
  const safeCanvasId = safePathSegment(canvasId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = join(parent, `${safeCanvasId}-${Date.now()}-${randomUUID().slice(0, 8)}`);
    if (!(await canvasRecoveryPathExists(candidate))) {
      return candidate;
    }
  }
  throw new Error(`Could not allocate a unique canvas recovery directory for '${canvasId}'.`);
}

export async function stageCanvasWorkspaceWrite(
  projectWorkspace: ProjectWorkspace,
  options: { canvasId: string; finalRoot: string }
): Promise<StagedCanvasWorkspaceWrite> {
  assertWorkspaceDescendant(projectWorkspace, options.finalRoot);
  if (await canvasRecoveryPathExists(options.finalRoot)) {
    throw new Error(`Task canvas workspace '${toPosixPath(relative(projectWorkspace.workspaceRoot, options.finalRoot))}' already exists.`);
  }
  const parent = canvasStagingRoot(projectWorkspace);
  await mkdir(parent, { recursive: true });
  const stagingRoot = await uniqueRecoveryDirectory(parent, options.canvasId);
  await mkdir(stagingRoot, { recursive: true });
  return {
    canvasId: options.canvasId,
    stagingRoot,
    finalRoot: options.finalRoot,
    workspace: canvasRootWorkspace(projectWorkspace, stagingRoot)
  };
}

export async function commitCanvasWorkspaceWrite(projectWorkspace: ProjectWorkspace, staged: StagedCanvasWorkspaceWrite): Promise<void> {
  assertWorkspaceDescendant(projectWorkspace, staged.stagingRoot);
  assertWorkspaceDescendant(projectWorkspace, staged.finalRoot);
  if (await canvasRecoveryPathExists(staged.finalRoot)) {
    throw new Error(`Task canvas workspace '${toPosixPath(relative(projectWorkspace.workspaceRoot, staged.finalRoot))}' already exists.`);
  }
  await mkdir(dirname(staged.finalRoot), { recursive: true });
  await rename(staged.stagingRoot, staged.finalRoot);
}

export async function quarantineCanvasWorkspace(
  projectWorkspace: ProjectWorkspace,
  options: { canvasId: string; workspaceRoot: string }
): Promise<string | null> {
  assertWorkspaceDescendant(projectWorkspace, options.workspaceRoot);
  if (!(await canvasRecoveryPathExists(options.workspaceRoot))) {
    return null;
  }
  const parent = canvasQuarantineRoot(projectWorkspace);
  await mkdir(parent, { recursive: true });
  const quarantineRoot = await uniqueRecoveryDirectory(parent, options.canvasId);
  await rename(options.workspaceRoot, quarantineRoot);
  return quarantineRoot;
}

export async function restoreQuarantinedCanvasWorkspace(
  projectWorkspace: ProjectWorkspace,
  options: { quarantineRoot: string; workspaceRoot: string }
): Promise<void> {
  assertWorkspaceDescendant(projectWorkspace, options.quarantineRoot);
  assertWorkspaceDescendant(projectWorkspace, options.workspaceRoot);
  if (!(await canvasRecoveryPathExists(options.quarantineRoot))) {
    return;
  }
  if (await canvasRecoveryPathExists(options.workspaceRoot)) {
    throw new Error(`Task canvas workspace '${toPosixPath(relative(projectWorkspace.workspaceRoot, options.workspaceRoot))}' already exists.`);
  }
  await mkdir(dirname(options.workspaceRoot), { recursive: true });
  await rename(options.quarantineRoot, options.workspaceRoot);
}

export async function removeCanvasStagingWorkspace(projectWorkspace: ProjectWorkspace, path: string): Promise<void> {
  assertWorkspaceDescendant(projectWorkspace, path);
  const stagingRoot = resolve(canvasStagingRoot(projectWorkspace));
  const target = resolve(path);
  const relativeTarget = relative(stagingRoot, target);
  if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new Error(`Canvas staging path '${path}' is outside the staging directory.`);
  }
  await rm(path, { recursive: true, force: true });
}

async function listChildDirectories(root: string): Promise<CanvasWorkspaceDirectory[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const directories: CanvasWorkspaceDirectory[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const path = join(root, entry.name);
      try {
        const metadata = await stat(path);
        directories.push({ name: entry.name, path, mtimeMs: metadata.mtimeMs });
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
      }
    }
    return directories;
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function isRecognizedCanvasWorkspaceRoot(path: string): Promise<boolean> {
  try {
    const parsed = manifestSchema.safeParse(await readJsonFile<unknown>(join(path, "package", "manifest.json")));
    if (!parsed.success) {
      return false;
    }
  } catch (error) {
    if (isNotFoundError(error) || error instanceof SyntaxError) {
      return false;
    }
    throw error;
  }
  return (await isRegularFile(join(path, "state.json"))) || (await isDirectory(join(path, "results")));
}

export async function listCanvasWorkspaceAnomalies(
  projectWorkspace: ProjectWorkspace,
  registeredCanvasWorkspaces: ProjectWorkspace[],
  options: CanvasWorkspaceAnomalyOptions = {}
): Promise<CanvasWorkspaceAnomalies> {
  const registeredRoots = new Set(registeredCanvasWorkspaces.map((workspace) => resolve(workspace.workspaceRoot)));
  const canvasDirectories = await listChildDirectories(join(projectWorkspace.workspaceRoot, "canvases"));
  const orphanDirectories: CanvasWorkspaceDirectory[] = [];
  const unrecognizedOrphanDirectories: CanvasWorkspaceDirectory[] = [];
  for (const directory of canvasDirectories) {
    if (registeredRoots.has(resolve(directory.path))) {
      continue;
    }
    if (await isRecognizedCanvasWorkspaceRoot(directory.path)) {
      orphanDirectories.push(directory);
    } else {
      unrecognizedOrphanDirectories.push(directory);
    }
  }
  const staleThresholdMs = options.staleThresholdMs ?? DEFAULT_CANVAS_WORKSPACE_STALE_THRESHOLD_MS;
  const nowMs = options.nowMs ?? Date.now();
  const isStaleDirectory = (directory: CanvasWorkspaceDirectory) => nowMs - directory.mtimeMs >= staleThresholdMs;
  return {
    orphanDirectories,
    unrecognizedOrphanDirectories,
    stagingDirectories: (await listChildDirectories(canvasStagingRoot(projectWorkspace))).filter(isStaleDirectory),
    quarantineDirectories: (await listChildDirectories(canvasQuarantineRoot(projectWorkspace))).filter(isStaleDirectory)
  };
}
