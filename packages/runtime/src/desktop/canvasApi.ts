import { mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { optionalStat } from "../fs/optionalFile.js";
import { initialManifest } from "../initWorkspace.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { resolveProjectWorkspace } from "../project.js";
import {
  canonicalProjectCanvasNode,
  loadProjectGraph,
  projectCanvasWorkspace as workspaceForProjectCanvas,
  resolveProjectCanvasWorkspace,
  writeProjectGraph
} from "../projectGraph/index.js";
import type { ProjectCanvasNode } from "../projectGraph/index.js";
import { createEmptyState } from "../state.js";
import type { ProjectWorkspace, ValidationIssue } from "../types.js";
import { canvasDiagnostics } from "./canvasDiagnostics.js";
import { normalizeRegistry, registryVersion, type TaskCanvasRecord, type TaskCanvasRegistry } from "./canvasRegistry.js";
import { readActiveTaskCanvasSelection } from "./canvasSelectionStore.js";
import {
  commitCanvasWorkspaceWrite,
  quarantineCanvasWorkspace,
  restoreQuarantinedCanvasWorkspace,
  stageCanvasWorkspaceWrite
} from "../projectGraph/canvasWorkspaceRecovery.js";
import { appendDesktopDiagnostics, desktopDiagnostic, errorMessage } from "./graph/desktopDiagnostics.js";
import { invalidateDesktopProjectProjection } from "./graph/projectProjectionModel.js";
import type { DesktopTaskCanvasSummary } from "./types.js";

const defaultCanvasId = "default";

export type DesktopTaskCanvasWorkspace = {
  canvasId: string;
  canvasName: string;
  workspace: ProjectWorkspace;
};

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

async function readManifestTitle(workspace: ProjectWorkspace): Promise<{ title: string; diagnostics: ValidationIssue[] }> {
  try {
    const raw = asRecord(await readJsonFile<unknown>(workspace.manifestFile));
    const project = asRecord(raw?.project);
    return {
      title: typeof project?.title === "string" && project.title.trim() ? project.title : "任务画布",
      diagnostics: []
    };
  } catch (caught) {
    return {
      title: "任务画布",
      diagnostics: [
        desktopDiagnostic("desktop_manifest_title_read_failed", `Default task canvas title could not be read: ${errorMessage(caught)}`, workspace.manifestFile)
      ]
    };
  }
}

async function writeManifestTitle(workspace: ProjectWorkspace, title: string): Promise<string> {
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

async function readRegistry(
  projectRoot: string,
  options: { createDefault?: boolean } = {}
): Promise<{ projectWorkspace: ProjectWorkspace; registry: TaskCanvasRegistry; diagnosticsByCanvasId: Map<string, ValidationIssue[]> }> {
  const projectWorkspace = await resolveProjectWorkspace(projectRoot);
  const path = registryPath(projectWorkspace);
  if (!(await optionalStat(path))) {
    if (options.createDefault === false) {
      return { projectWorkspace, registry: { version: registryVersion, canvases: [] }, diagnosticsByCanvasId: new Map() };
    }
    const title = await readManifestTitle(projectWorkspace);
    const registry: TaskCanvasRegistry = {
      version: registryVersion,
      canvases: [defaultCanvasRecord(projectWorkspace, title.title)]
    };
    await mkdir(dirname(path), { recursive: true });
    await writeJsonFile(path, registry);
    return {
      projectWorkspace,
      registry,
      diagnosticsByCanvasId: title.diagnostics.length > 0 ? new Map([[defaultCanvasId, title.diagnostics]]) : new Map()
    };
  }
  return { projectWorkspace, registry: normalizeRegistry(await readJsonFile<unknown>(path)), diagnosticsByCanvasId: new Map() };
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

async function taskCount(workspace: ProjectWorkspace): Promise<{ count: number; diagnostics: ValidationIssue[] }> {
  try {
    const raw = asRecord(await readJsonFile<unknown>(workspace.manifestFile));
    const nodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
    return { count: nodes.filter((node) => asRecord(node)?.type === "task").length, diagnostics: [] };
  } catch (caught) {
    return {
      count: 0,
      diagnostics: [
        desktopDiagnostic("desktop_canvas_task_count_read_failed", `Canvas task count could not be read: ${errorMessage(caught)}`, workspace.manifestFile)
      ]
    };
  }
}

async function summarizeCanvas(projectWorkspace: ProjectWorkspace, record: TaskCanvasRecord, extraDiagnostics: ValidationIssue[] = []): Promise<DesktopTaskCanvasSummary> {
  const workspace = canvasWorkspace(projectWorkspace, record);
  const diagnostics = await canvasDiagnostics(workspace);
  appendDesktopDiagnostics(diagnostics, extraDiagnostics);
  const taskCountResult = await taskCount(workspace);
  appendDesktopDiagnostics(diagnostics, taskCountResult.diagnostics);
  return {
    canvasId: record.canvasId,
    name: record.name,
    taskCount: taskCountResult.count,
    missingPromptCount: diagnostics.filter((diagnostic) => diagnostic.code === "prompt_missing").length,
    diagnostics,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

async function summarizeProjectCanvas(projectWorkspace: ProjectWorkspace, canvas: ProjectCanvasNode): Promise<DesktopTaskCanvasSummary> {
  const workspace = workspaceForProjectCanvas(projectWorkspace, canvas);
  const diagnostics = await canvasDiagnostics(workspace);
  const taskCountResult = await taskCount(workspace);
  appendDesktopDiagnostics(diagnostics, taskCountResult.diagnostics);
  return {
    canvasId: canvas.id,
    name: canvas.title,
    taskCount: taskCountResult.count,
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

function assertProjectCanvasUnreferenced(manifest: Awaited<ReturnType<typeof loadProjectGraph>>["manifest"], canvasId: string): void {
  const canvasEdges = manifest.edges.filter((edge) => edge.from === canvasId || edge.to === canvasId);
  const crossTaskEdges = manifest.crossTaskEdges.filter((edge) => edge.from.canvasId === canvasId || edge.to.canvasId === canvasId);
  if (canvasEdges.length === 0 && crossTaskEdges.length === 0) {
    return;
  }
  const references = [
    ...canvasEdges.map((edge) => `canvas edge ${edge.from}->${edge.to}`),
    ...crossTaskEdges.map((edge) => `cross-task edge ${edge.from.canvasId}:${edge.from.taskId}->${edge.to.canvasId}:${edge.to.taskId}`)
  ];
  throw new Error(`Cannot remove project canvas '${canvasId}' because it is referenced by project graph dependencies: ${references.join(", ")}. Remove those dependencies first.`);
}

async function restoreQuarantineAfterFailedRemoval(
  projectWorkspace: ProjectWorkspace,
  canvasId: string,
  workspaceRoot: string,
  quarantineRoot: string | null,
  removalError: unknown
): Promise<void> {
  if (!quarantineRoot) {
    return;
  }
  try {
    await restoreQuarantinedCanvasWorkspace(projectWorkspace, { quarantineRoot, workspaceRoot });
  } catch (rollbackError) {
    throw new Error(
      `Task canvas '${canvasId}' removal failed, and its quarantined workspace could not be restored: ${errorMessage(removalError)}; rollback failed: ${errorMessage(rollbackError)}`
    );
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
  const { projectWorkspace, registry, diagnosticsByCanvasId } = await readRegistry(projectRoot);
  return Promise.all(registry.canvases.map((record) => summarizeCanvas(projectWorkspace, record, diagnosticsByCanvasId.get(record.canvasId) ?? [])));
}

export async function getActiveTaskCanvasId(projectRoot: string): Promise<string | null> {
  try {
    return (await readActiveTaskCanvasSelection(projectRoot)).activeCanvasId;
  } catch (error) {
    if (error instanceof ZodError || (error instanceof Error && error.message === "Project has no task canvas.")) {
      return null;
    }
    throw error;
  }
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
    const activeCanvasId = (await readActiveTaskCanvasSelection(projectRoot)).activeCanvasId;
    const canvas = loaded.manifest.canvases.find((candidate) => candidate.id === activeCanvasId);
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
  const loaded = await loadProjectGraph(projectRoot);
  if (loaded.source === "project_graph") {
    const canvasId = newCanvasId();
    const canvas: ProjectCanvasNode = canonicalProjectCanvasNode({
      id: canvasId,
      title: input.name?.trim() || `新任务画布 ${loaded.manifest.canvases.length + 1}`
    });
    const workspace = workspaceForProjectCanvas(loaded.workspace, canvas);
    const staged = await stageCanvasWorkspaceWrite(loaded.workspace, { canvasId, finalRoot: workspace.workspaceRoot });
    await mkdir(join(staged.workspace.packageDir, "nodes"), { recursive: true });
    await mkdir(staged.workspace.resultsDir, { recursive: true });
    await writeJsonFile(staged.workspace.manifestFile, initialManifest(canvas.title));
    await writeJsonFile(staged.workspace.stateFile, createEmptyState());
    await commitCanvasWorkspaceWrite(loaded.workspace, staged);
    await writeProjectGraph(loaded.workspace, {
      ...loaded.manifest,
      canvases: [...loaded.manifest.canvases, canvas]
    });
    invalidateDesktopProjectProjection(projectRoot);
    return summarizeProjectCanvas(loaded.workspace, canvas);
  }
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
  const staged = await stageCanvasWorkspaceWrite(projectWorkspace, { canvasId, finalRoot: workspace.workspaceRoot });
  await mkdir(join(staged.workspace.packageDir, "nodes"), { recursive: true });
  await mkdir(staged.workspace.resultsDir, { recursive: true });
  await writeJsonFile(staged.workspace.manifestFile, initialManifest(record.name));
  await writeJsonFile(staged.workspace.stateFile, createEmptyState());
  await commitCanvasWorkspaceWrite(projectWorkspace, staged);
  const nextRegistry = { ...registry, canvases: [...registry.canvases, record] };
  await writeRegistry(projectWorkspace, nextRegistry);
  invalidateDesktopProjectProjection(projectRoot);
  return summarizeCanvas(projectWorkspace, record);
}

export async function renameTaskCanvas(projectRoot: string, canvasId: string, name: string): Promise<DesktopTaskCanvasSummary> {
  const nextName = name.trim();
  if (!nextName) {
    throw new Error("Task canvas name is required.");
  }

  const loaded = await loadProjectGraph(projectRoot);
  if (loaded.source === "project_graph") {
    const canvas = loaded.manifest.canvases.find((candidate) => candidate.id === canvasId);
    if (!canvas) {
      throw new Error(`Project canvas '${canvasId}' does not exist.`);
    }
    const workspace = workspaceForProjectCanvas(loaded.workspace, canvas);
    const previousTitle = await writeManifestTitle(workspace, nextName);
    const nextCanvas = { ...canvas, title: nextName };
    try {
      await writeProjectGraph(loaded.workspace, {
        ...loaded.manifest,
        canvases: loaded.manifest.canvases.map((candidate) => (candidate.id === canvasId ? nextCanvas : candidate))
      });
    } catch (error) {
      await writeManifestTitle(workspace, previousTitle);
      throw error;
    }
    invalidateDesktopProjectProjection(projectRoot);
    return summarizeProjectCanvas(loaded.workspace, nextCanvas);
  }

  const { projectWorkspace, registry } = await readRegistry(projectRoot);
  const record = requireCanvasRecord(registry, canvasId);
  const workspace = canvasWorkspace(projectWorkspace, record);
  const previousTitle = await writeManifestTitle(workspace, nextName);
  const nextRecord = {
    ...record,
    name: nextName,
    updatedAt: new Date().toISOString()
  };
  const nextRegistry = {
    ...registry,
    canvases: registry.canvases.map((canvas) => (canvas.canvasId === canvasId ? nextRecord : canvas))
  };
  try {
    await writeRegistry(projectWorkspace, nextRegistry);
  } catch (error) {
    await writeManifestTitle(workspace, previousTitle);
    throw error;
  }
  invalidateDesktopProjectProjection(projectRoot);
  return summarizeCanvas(projectWorkspace, nextRecord);
}

export async function removeTaskCanvas(projectRoot: string, canvasId: string): Promise<DesktopTaskCanvasSummary[]> {
  const loaded = await loadProjectGraph(projectRoot);
  if (loaded.source === "project_graph") {
    const canvas = loaded.manifest.canvases.find((candidate) => candidate.id === canvasId);
    if (!canvas) {
      throw new Error(`Project canvas '${canvasId}' does not exist.`);
    }
    const workspace = workspaceForProjectCanvas(loaded.workspace, canvas);
    assertWorkspaceChild(loaded.workspace, workspace.packageDir);
    assertWorkspaceChild(loaded.workspace, workspace.stateFile);
    assertWorkspaceChild(loaded.workspace, workspace.resultsDir);
    assertProjectCanvasUnreferenced(loaded.manifest, canvasId);
    if (workspace.workspaceRoot === loaded.workspace.workspaceRoot || workspace.packageDir === loaded.workspace.packageDir || loaded.manifest.canvases.length === 1) {
      await writeJsonFile(workspace.manifestFile, initialManifest(canvas.title));
      await writeJsonFile(workspace.stateFile, createEmptyState());
      await rm(workspace.resultsDir, { recursive: true, force: true });
      await mkdir(workspace.resultsDir, { recursive: true });
      invalidateDesktopProjectProjection(projectRoot);
      return listTaskCanvases(projectRoot);
    }
    const quarantineRoot = await quarantineCanvasWorkspace(loaded.workspace, { canvasId, workspaceRoot: workspace.workspaceRoot });
    try {
      await writeProjectGraph(loaded.workspace, {
        ...loaded.manifest,
        canvases: loaded.manifest.canvases.filter((candidate) => candidate.id !== canvasId)
      });
    } catch (error) {
      await restoreQuarantineAfterFailedRemoval(loaded.workspace, canvasId, workspace.workspaceRoot, quarantineRoot, error);
      throw error;
    }
    invalidateDesktopProjectProjection(projectRoot);
    return listTaskCanvases(projectRoot);
  }
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
    invalidateDesktopProjectProjection(projectRoot);
    return listTaskCanvases(projectRoot);
  }
  const quarantineRoot = await quarantineCanvasWorkspace(projectWorkspace, { canvasId, workspaceRoot: workspace.workspaceRoot });
  const nextRegistry = {
    ...registry,
    canvases: registry.canvases.filter((canvas) => canvas.canvasId !== canvasId)
  };
  try {
    await writeRegistry(projectWorkspace, nextRegistry);
  } catch (error) {
    await restoreQuarantineAfterFailedRemoval(projectWorkspace, canvasId, workspace.workspaceRoot, quarantineRoot, error);
    throw error;
  }
  invalidateDesktopProjectProjection(projectRoot);
  return listTaskCanvases(projectRoot);
}
