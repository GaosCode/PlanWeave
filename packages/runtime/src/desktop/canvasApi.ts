import { access, mkdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { initialManifest } from "../initWorkspace.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { resolveProjectWorkspace } from "../project.js";
import { loadProjectGraph, projectCanvasWorkspace as workspaceForProjectCanvas, resolveProjectCanvasWorkspace } from "../projectGraph/index.js";
import type { ProjectCanvasNode } from "../projectGraph/index.js";
import { createEmptyState } from "../state.js";
import type { ProjectWorkspace, ValidationIssue } from "../types.js";
import { canvasDiagnostics } from "./canvasDiagnostics.js";
import { normalizeRegistry, registryVersion, type TaskCanvasRecord, type TaskCanvasRegistry } from "./canvasRegistry.js";
import type { DesktopTaskCanvasSummary } from "./types.js";

const defaultCanvasId = "default";

export type DesktopTaskCanvasWorkspace = {
  canvasId: string;
  canvasName: string;
  workspace: ProjectWorkspace;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

function projectGraphReadDiagnostics(error: unknown): ValidationIssue[] {
  if (error instanceof ZodError) {
    return error.issues.map((zodIssue) =>
      issue("project_graph_schema", zodIssue.message, zodIssue.path.length > 0 ? `project-graph.json:${zodIssue.path.join(".")}` : "project-graph.json")
    );
  }
  return [issue("project_graph_read_failed", error instanceof Error ? error.message : String(error), "project-graph.json")];
}

function projectGraphDiagnosticCanvas(diagnostics: ValidationIssue[]): DesktopTaskCanvasSummary {
  return {
    canvasId: "project-graph",
    name: "Project graph",
    taskCount: 0,
    missingPromptCount: 0,
    diagnostics,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
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
    const raw = asRecord(await readJsonFile<unknown>(workspace.manifestFile));
    const project = asRecord(raw?.project);
    return typeof project?.title === "string" && project.title.trim() ? project.title : "任务画布";
  } catch {
    return "任务画布";
  }
}

async function readRegistry(
  projectRoot: string,
  options: { createDefault?: boolean } = {}
): Promise<{ projectWorkspace: ProjectWorkspace; registry: TaskCanvasRegistry }> {
  const projectWorkspace = await resolveProjectWorkspace(projectRoot);
  const path = registryPath(projectWorkspace);
  if (!(await exists(path))) {
    if (options.createDefault === false) {
      return { projectWorkspace, registry: { version: registryVersion, canvases: [] } };
    }
    const title = await readManifestTitle(projectWorkspace);
    const registry: TaskCanvasRegistry = {
      version: registryVersion,
      canvases: [defaultCanvasRecord(projectWorkspace, title)]
    };
    await mkdir(dirname(path), { recursive: true });
    await writeJsonFile(path, registry);
    return { projectWorkspace, registry };
  }
  return { projectWorkspace, registry: normalizeRegistry(await readJsonFile<unknown>(path)) };
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

function selectedCanvasRecord(registry: TaskCanvasRegistry, canvasId?: string | null): TaskCanvasRecord | undefined {
  if (canvasId) {
    return requireCanvasRecord(registry, canvasId);
  }
  return registry.activeCanvasId ? requireCanvasRecord(registry, registry.activeCanvasId) : registry.canvases[0];
}

async function taskCount(workspace: ProjectWorkspace): Promise<number> {
  try {
    const raw = asRecord(await readJsonFile<unknown>(workspace.manifestFile));
    const nodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
    return nodes.filter((node) => asRecord(node)?.type === "task").length;
  } catch {
    return 0;
  }
}

async function summarizeCanvas(projectWorkspace: ProjectWorkspace, record: TaskCanvasRecord): Promise<DesktopTaskCanvasSummary> {
  const workspace = canvasWorkspace(projectWorkspace, record);
  const diagnostics = await canvasDiagnostics(workspace);
  return {
    canvasId: record.canvasId,
    name: record.name,
    taskCount: await taskCount(workspace),
    missingPromptCount: diagnostics.filter((diagnostic) => diagnostic.code === "prompt_missing").length,
    diagnostics,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

async function summarizeProjectCanvas(projectWorkspace: ProjectWorkspace, canvas: ProjectCanvasNode): Promise<DesktopTaskCanvasSummary> {
  const workspace = workspaceForProjectCanvas(projectWorkspace, canvas);
  const diagnostics = await canvasDiagnostics(workspace);
  return {
    canvasId: canvas.id,
    name: canvas.title,
    taskCount: await taskCount(workspace),
    missingPromptCount: diagnostics.filter((diagnostic) => diagnostic.code === "prompt_missing").length,
    diagnostics,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
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

async function assertLegacyCanvasRegistryEditable(projectRoot: string): Promise<void> {
  const loaded = await loadProjectGraph(projectRoot);
  if (loaded.source === "project_graph") {
    throw new Error("Task canvas create/delete is disabled when project-graph.json is the canvas source; edit project-graph.json manually.");
  }
}

export async function listTaskCanvases(projectRoot: string): Promise<DesktopTaskCanvasSummary[]> {
  let loaded: Awaited<ReturnType<typeof loadProjectGraph>>;
  try {
    loaded = await loadProjectGraph(projectRoot);
  } catch (error) {
    return [projectGraphDiagnosticCanvas(projectGraphReadDiagnostics(error))];
  }
  if (loaded.source === "project_graph") {
    return Promise.all(loaded.manifest.canvases.map((canvas) => summarizeProjectCanvas(loaded.workspace, canvas)));
  }
  const { projectWorkspace, registry } = await readRegistry(projectRoot);
  return Promise.all(registry.canvases.map((record) => summarizeCanvas(projectWorkspace, record)));
}

export async function getActiveTaskCanvasId(projectRoot: string): Promise<string | null> {
  let loaded: Awaited<ReturnType<typeof loadProjectGraph>>;
  try {
    loaded = await loadProjectGraph(projectRoot);
  } catch {
    return null;
  }
  if (loaded.source === "project_graph") {
    return loaded.manifest.canvases[0]?.id ?? null;
  }
  const { registry } = await readRegistry(projectRoot);
  return selectedCanvasRecord(registry)?.canvasId ?? null;
}

export async function listTaskCanvasWorkspaces(
  projectRoot: string,
  options: { createRegistry?: boolean } = {}
): Promise<DesktopTaskCanvasWorkspace[]> {
  const loaded = await loadProjectGraph(projectRoot);
  if (loaded.source === "project_graph") {
    return loaded.manifest.canvases.map((canvas) => ({
      canvasId: canvas.id,
      canvasName: canvas.title,
      workspace: workspaceForProjectCanvas(loaded.workspace, canvas)
    }));
  }
  const { projectWorkspace, registry } = await readRegistry(projectRoot, { createDefault: options.createRegistry ?? false });
  return registry.canvases.map((record) => ({
    canvasId: record.canvasId,
    canvasName: record.name,
    workspace: canvasWorkspace(projectWorkspace, record)
  }));
}

export async function resolveTaskCanvasWorkspace(projectRoot: string, canvasId?: string | null): Promise<ProjectWorkspace> {
  const loaded = await loadProjectGraph(projectRoot);
  if (canvasId) {
    return resolveProjectCanvasWorkspace(projectRoot, canvasId);
  }
  if (loaded.source === "project_graph") {
    const canvas = loaded.manifest.canvases[0];
    if (!canvas) {
      throw new Error("Project has no task canvas.");
    }
    return workspaceForProjectCanvas(loaded.workspace, canvas);
  }
  const { projectWorkspace, registry } = await readRegistry(projectRoot);
  const record = selectedCanvasRecord(registry, canvasId);
  if (!record) {
    throw new Error("Project has no task canvas.");
  }
  return canvasWorkspace(projectWorkspace, record);
}

export async function createTaskCanvas(projectRoot: string, input: { name?: string | null } = {}): Promise<DesktopTaskCanvasSummary> {
  await assertLegacyCanvasRegistryEditable(projectRoot);
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
  await assertLegacyCanvasRegistryEditable(projectRoot);
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
