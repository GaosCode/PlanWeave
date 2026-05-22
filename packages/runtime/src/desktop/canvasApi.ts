import { access, mkdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { initialManifest } from "../initWorkspace.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { resolveProjectWorkspace } from "../project.js";
import { manifestSchema } from "../schema/manifest.js";
import { createEmptyState } from "../state.js";
import type { PlanPackageManifest, ProjectWorkspace } from "../types.js";
import type { DesktopTaskCanvasSummary } from "./types.js";

const registryVersion = "desktop-canvases/v1" as const;
const defaultCanvasId = "default";

type TaskCanvasRecord = {
  canvasId: string;
  name: string;
  packageDir: string;
  stateFile: string;
  resultsDir: string;
  createdAt: string;
  updatedAt: string;
};

type TaskCanvasRegistry = {
  version: typeof registryVersion;
  canvases: TaskCanvasRecord[];
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function registryPath(workspace: ProjectWorkspace): string {
  return join(workspace.workspaceRoot, "desktop", "canvases.json");
}

function toWorkspaceRelative(workspace: ProjectWorkspace, path: string): string {
  return relative(workspace.workspaceRoot, path).split("\\").join("/");
}

function fromWorkspaceRelative(workspace: ProjectWorkspace, path: string): string {
  return isAbsolute(path) ? path : join(workspace.workspaceRoot, path);
}

function defaultCanvasRecord(workspace: ProjectWorkspace, name: string): TaskCanvasRecord {
  const now = new Date().toISOString();
  return {
    canvasId: defaultCanvasId,
    name,
    packageDir: toWorkspaceRelative(workspace, workspace.packageDir),
    stateFile: toWorkspaceRelative(workspace, workspace.stateFile),
    resultsDir: toWorkspaceRelative(workspace, workspace.resultsDir),
    createdAt: now,
    updatedAt: now
  };
}

async function readManifestTitle(workspace: ProjectWorkspace): Promise<string> {
  try {
    const parsed = manifestSchema.parse(await readJsonFile<unknown>(workspace.manifestFile)) as PlanPackageManifest;
    return parsed.project.title || "任务画布";
  } catch {
    return "任务画布";
  }
}

async function readRegistry(projectRoot: string): Promise<{ projectWorkspace: ProjectWorkspace; registry: TaskCanvasRegistry }> {
  const projectWorkspace = await resolveProjectWorkspace(projectRoot);
  const path = registryPath(projectWorkspace);
  if (!(await exists(path))) {
    const title = await readManifestTitle(projectWorkspace);
    const registry: TaskCanvasRegistry = {
      version: registryVersion,
      canvases: [defaultCanvasRecord(projectWorkspace, title)]
    };
    await mkdir(dirname(path), { recursive: true });
    await writeJsonFile(path, registry);
    return { projectWorkspace, registry };
  }
  const registry = await readJsonFile<TaskCanvasRegistry>(path);
  if (registry.version !== registryVersion) {
    throw new Error(`Unsupported task canvas registry '${registry.version}'.`);
  }
  return { projectWorkspace, registry };
}

async function writeRegistry(workspace: ProjectWorkspace, registry: TaskCanvasRegistry): Promise<void> {
  const path = registryPath(workspace);
  await mkdir(dirname(path), { recursive: true });
  await writeJsonFile(path, registry);
}

function canvasWorkspace(projectWorkspace: ProjectWorkspace, record: TaskCanvasRecord): ProjectWorkspace {
  const packageDir = fromWorkspaceRelative(projectWorkspace, record.packageDir);
  const stateFile = fromWorkspaceRelative(projectWorkspace, record.stateFile);
  const resultsDir = fromWorkspaceRelative(projectWorkspace, record.resultsDir);
  const workspaceRoot = record.canvasId === defaultCanvasId ? projectWorkspace.workspaceRoot : dirname(packageDir);
  return {
    ...projectWorkspace,
    workspaceRoot,
    packageDir,
    manifestFile: join(packageDir, "manifest.json"),
    stateFile,
    resultsDir
  };
}

function requireCanvasRecord(registry: TaskCanvasRegistry, canvasId: string): TaskCanvasRecord {
  const record = registry.canvases.find((canvas) => canvas.canvasId === canvasId);
  if (!record) {
    throw new Error(`Task canvas '${canvasId}' does not exist.`);
  }
  return record;
}

async function taskCount(workspace: ProjectWorkspace): Promise<number> {
  try {
    const manifest = manifestSchema.parse(await readJsonFile<unknown>(workspace.manifestFile)) as PlanPackageManifest;
    return manifest.nodes.filter((node) => node.type === "task").length;
  } catch {
    return 0;
  }
}

async function summarizeCanvas(projectWorkspace: ProjectWorkspace, record: TaskCanvasRecord): Promise<DesktopTaskCanvasSummary> {
  return {
    canvasId: record.canvasId,
    name: record.name,
    taskCount: await taskCount(canvasWorkspace(projectWorkspace, record)),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function nextCanvasName(existing: TaskCanvasRecord[]): string {
  const names = new Set(existing.map((canvas) => canvas.name));
  let index = existing.length + 1;
  while (names.has(`新任务画布 ${index}`)) {
    index += 1;
  }
  return `新任务画布 ${index}`;
}

function newCanvasId(): string {
  return `canvas-${randomUUID().slice(0, 8)}`;
}

function assertWorkspaceChild(projectWorkspace: ProjectWorkspace, path: string): void {
  const workspaceRoot = resolve(projectWorkspace.workspaceRoot);
  const target = resolve(path);
  const relativeTarget = relative(workspaceRoot, target);
  if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new Error(`Task canvas path '${path}' is outside the PlanWeave workspace.`);
  }
}

export async function listTaskCanvases(projectRoot: string): Promise<DesktopTaskCanvasSummary[]> {
  const { projectWorkspace, registry } = await readRegistry(projectRoot);
  return Promise.all(registry.canvases.map((record) => summarizeCanvas(projectWorkspace, record)));
}

export async function resolveTaskCanvasWorkspace(projectRoot: string, canvasId?: string | null): Promise<ProjectWorkspace> {
  const { projectWorkspace, registry } = await readRegistry(projectRoot);
  const record = canvasId ? requireCanvasRecord(registry, canvasId) : registry.canvases[0];
  if (!record) {
    throw new Error("Project has no task canvas.");
  }
  return canvasWorkspace(projectWorkspace, record);
}

export async function createTaskCanvas(projectRoot: string, input: { name?: string | null } = {}): Promise<DesktopTaskCanvasSummary> {
  const { projectWorkspace, registry } = await readRegistry(projectRoot);
  const canvasId = newCanvasId();
  const record: TaskCanvasRecord = {
    canvasId,
    name: input.name?.trim() || nextCanvasName(registry.canvases),
    packageDir: `canvases/${canvasId}/package`,
    stateFile: `canvases/${canvasId}/state.json`,
    resultsDir: `canvases/${canvasId}/results`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const workspace = canvasWorkspace(projectWorkspace, record);
  await mkdir(join(workspace.packageDir, "nodes"), { recursive: true });
  await mkdir(workspace.resultsDir, { recursive: true });
  await writeJsonFile(workspace.manifestFile, initialManifest(record.name));
  await writeJsonFile(workspace.stateFile, createEmptyState());
  const nextRegistry = { ...registry, canvases: [...registry.canvases, record] };
  await writeRegistry(projectWorkspace, nextRegistry);
  return summarizeCanvas(projectWorkspace, record);
}

export async function removeTaskCanvas(projectRoot: string, canvasId: string): Promise<DesktopTaskCanvasSummary[]> {
  const { projectWorkspace, registry } = await readRegistry(projectRoot);
  const record = requireCanvasRecord(registry, canvasId);
  const workspace = canvasWorkspace(projectWorkspace, record);
  assertWorkspaceChild(projectWorkspace, workspace.packageDir);
  assertWorkspaceChild(projectWorkspace, workspace.stateFile);
  assertWorkspaceChild(projectWorkspace, workspace.resultsDir);
  if (record.canvasId === defaultCanvasId) {
    await writeJsonFile(workspace.manifestFile, initialManifest(record.name));
    await writeJsonFile(workspace.stateFile, createEmptyState());
    await rm(workspace.resultsDir, { recursive: true, force: true });
    await mkdir(workspace.resultsDir, { recursive: true });
    return listTaskCanvases(projectRoot);
  }
  await rm(dirname(workspace.packageDir), { recursive: true, force: true });
  const nextRegistry = {
    ...registry,
    canvases: registry.canvases.filter((canvas) => canvas.canvasId !== canvasId)
  };
  await writeRegistry(projectWorkspace, nextRegistry);
  return listTaskCanvases(projectRoot);
}
