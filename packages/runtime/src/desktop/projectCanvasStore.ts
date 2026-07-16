import { mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { optionalStat } from "../fs/optionalFile.js";
import { initialManifest } from "../initWorkspace.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import {
  loadProjectGraph,
  projectCanvasWorkspace as workspaceForProjectCanvas,
  writeProjectGraph
} from "../projectGraph/index.js";
import type {
  LoadedProjectGraph,
  ProjectCanvasNode,
  ProjectGraphManifest
} from "../projectGraph/index.js";
import {
  quarantineCanvasWorkspace,
  restoreQuarantinedCanvasWorkspace
} from "../projectGraph/canvasWorkspaceRecovery.js";
import { writeManifestTitle } from "../projectGraph/canvasWorkspaceContent.js";
import {
  createProjectCanvas,
  duplicateProjectCanvas,
  nextDefaultDesktopCanvasTitle
} from "../projectGraph/projectCanvasMutation.js";
import { resolveProjectWorkspace } from "../project.js";
import { createEmptyState } from "../state.js";
import type { ProjectWorkspace, ValidationIssue } from "../types.js";
import {
  normalizeRegistry,
  registryVersion,
  type TaskCanvasRecord,
  type TaskCanvasRegistry
} from "./canvasRegistry.js";
import { readActiveTaskCanvasSelection } from "./canvasSelectionStore.js";
import { desktopDiagnostic, errorMessage } from "./graph/desktopDiagnostics.js";
import { invalidateDesktopProjectProjection } from "./graph/projectProjectionModel.js";
import { summarizeTaskCanvasFromPackage } from "./canvasSummaryModel.js";
import type { DesktopTaskCanvasSummary } from "./types.js";

export { populateDuplicatedCanvasWorkspace } from "../projectGraph/canvasWorkspaceContent.js";

const defaultCanvasId = "default";

export type DesktopTaskCanvasWorkspace = {
  canvasId: string;
  canvasName: string;
  workspace: ProjectWorkspace;
};

export type ProjectCanvasStore = {
  list(): Promise<DesktopTaskCanvasSummary[]>;
  listWorkspaces(options?: { createRegistry?: boolean }): Promise<DesktopTaskCanvasWorkspace[]>;
  resolveWorkspace(canvasId?: string | null): Promise<ProjectWorkspace>;
  sourceCanvasWorkspace(canvasId: string): Promise<{ name: string; workspace: ProjectWorkspace }>;
  create(input?: { name?: string | null }): Promise<DesktopTaskCanvasSummary>;
  duplicate(canvasId: string, input?: { name?: string | null }): Promise<DesktopTaskCanvasSummary>;
  rename(canvasId: string, name: string): Promise<DesktopTaskCanvasSummary>;
  remove(canvasId: string): Promise<DesktopTaskCanvasSummary[]>;
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
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readManifestTitle(
  workspace: ProjectWorkspace
): Promise<{ title: string; diagnostics: ValidationIssue[] }> {
  try {
    const raw = asRecord(await readJsonFile<unknown>(workspace.manifestFile));
    const project = asRecord(raw?.project);
    return {
      title:
        typeof project?.title === "string" && project.title.trim() ? project.title : "任务画布",
      diagnostics: []
    };
  } catch (caught) {
    return {
      title: "任务画布",
      diagnostics: [
        desktopDiagnostic(
          "desktop_manifest_title_read_failed",
          `Default task canvas title could not be read: ${errorMessage(caught)}`,
          workspace.manifestFile
        )
      ]
    };
  }
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

async function readRegistry(
  projectRoot: string,
  options: { createDefault?: boolean } = {}
): Promise<{
  projectWorkspace: ProjectWorkspace;
  registry: TaskCanvasRegistry;
  diagnosticsByCanvasId: Map<string, ValidationIssue[]>;
}> {
  const projectWorkspace = await resolveProjectWorkspace(projectRoot);
  const path = registryPath(projectWorkspace);
  if (!(await optionalStat(path))) {
    if (options.createDefault === false) {
      return {
        projectWorkspace,
        registry: { version: registryVersion, canvases: [] },
        diagnosticsByCanvasId: new Map()
      };
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
      diagnosticsByCanvasId:
        title.diagnostics.length > 0 ? new Map([[defaultCanvasId, title.diagnostics]]) : new Map()
    };
  }
  return {
    projectWorkspace,
    registry: normalizeRegistry(await readJsonFile<unknown>(path)),
    diagnosticsByCanvasId: new Map()
  };
}

async function writeRegistry(
  workspace: ProjectWorkspace,
  registry: TaskCanvasRegistry
): Promise<void> {
  const path = registryPath(workspace);
  await mkdir(dirname(path), { recursive: true });
  await writeJsonFile(path, registry);
}

function legacyCanvasWorkspace(
  projectWorkspace: ProjectWorkspace,
  record: TaskCanvasRecord
): ProjectWorkspace {
  const packageDir = fromWorkspaceRelative(projectWorkspace, record.packageDir);
  const stateFile = fromWorkspaceRelative(projectWorkspace, record.stateFile);
  const resultsDir = fromWorkspaceRelative(projectWorkspace, record.resultsDir);
  const workspaceRoot =
    record.canvasId === defaultCanvasId ? projectWorkspace.workspaceRoot : dirname(packageDir);
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

function selectedCanvasRecord(
  registry: TaskCanvasRegistry,
  canvasId?: string | null
): TaskCanvasRecord | undefined {
  if (canvasId) {
    return requireCanvasRecord(registry, canvasId);
  }
  return registry.activeCanvasId
    ? requireCanvasRecord(registry, registry.activeCanvasId)
    : registry.canvases[0];
}

async function summarizeLegacyCanvas(
  projectWorkspace: ProjectWorkspace,
  record: TaskCanvasRecord,
  extraDiagnostics: ValidationIssue[] = []
): Promise<DesktopTaskCanvasSummary> {
  const workspace = legacyCanvasWorkspace(projectWorkspace, record);
  return summarizeTaskCanvasFromPackage({
    canvasId: record.canvasId,
    name: record.name,
    packageDir: record.packageDir,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    workspace,
    extraDiagnostics
  });
}

async function summarizeProjectCanvas(
  projectWorkspace: ProjectWorkspace,
  canvas: ProjectCanvasNode
): Promise<DesktopTaskCanvasSummary> {
  const workspace = workspaceForProjectCanvas(projectWorkspace, canvas);
  return summarizeTaskCanvasFromPackage({
    canvasId: canvas.id,
    name: canvas.title,
    packageDir: canvas.packageDir,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    workspace
  });
}

function assertWorkspaceChild(projectWorkspace: ProjectWorkspace, path: string): void {
  const workspaceRoot = resolve(projectWorkspace.workspaceRoot);
  const target = resolve(path);
  const relativeTarget = relative(workspaceRoot, target);
  if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new Error(`Task canvas path '${path}' is outside the PlanWeave workspace.`);
  }
}

function assertProjectCanvasUnreferenced(manifest: ProjectGraphManifest, canvasId: string): void {
  const canvasEdges = manifest.edges.filter(
    (edge) => edge.from === canvasId || edge.to === canvasId
  );
  const crossTaskEdges = manifest.crossTaskEdges.filter(
    (edge) => edge.from.canvasId === canvasId || edge.to.canvasId === canvasId
  );
  if (canvasEdges.length === 0 && crossTaskEdges.length === 0) {
    return;
  }
  const references = [
    ...canvasEdges.map((edge) => `canvas edge ${edge.from}->${edge.to}`),
    ...crossTaskEdges.map(
      (edge) =>
        `cross-task edge ${edge.from.canvasId}:${edge.from.taskId}->${edge.to.canvasId}:${edge.to.taskId}`
    )
  ];
  throw new Error(
    `Cannot remove project canvas '${canvasId}' because it is referenced by project graph dependencies: ${references.join(", ")}. Remove those dependencies first.`
  );
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

async function resetCanvasWorkspace(workspace: ProjectWorkspace, title: string): Promise<void> {
  await rm(workspace.packageDir, { recursive: true, force: true });
  await writeJsonFile(workspace.manifestFile, initialManifest(title));
  await writeJsonFile(workspace.stateFile, createEmptyState());
  await rm(workspace.resultsDir, { recursive: true, force: true });
  await mkdir(workspace.resultsDir, { recursive: true });
}

class ProjectGraphCanvasStore implements ProjectCanvasStore {
  private loaded: LoadedProjectGraph;

  constructor(
    private readonly projectRoot: string,
    loaded: LoadedProjectGraph
  ) {
    this.loaded = loaded;
  }

  async list(): Promise<DesktopTaskCanvasSummary[]> {
    return Promise.all(
      this.loaded.manifest.canvases.map((canvas) =>
        summarizeProjectCanvas(this.loaded.workspace, canvas)
      )
    );
  }

  async listWorkspaces(): Promise<DesktopTaskCanvasWorkspace[]> {
    return this.loaded.manifest.canvases.map((canvas) => ({
      canvasId: canvas.id,
      canvasName: canvas.title,
      workspace: workspaceForProjectCanvas(this.loaded.workspace, canvas)
    }));
  }

  async resolveWorkspace(canvasId?: string | null): Promise<ProjectWorkspace> {
    const resolvedCanvasId =
      canvasId ?? (await readActiveTaskCanvasSelection(this.projectRoot)).activeCanvasId;
    const canvas = this.loaded.manifest.canvases.find(
      (candidate) => candidate.id === resolvedCanvasId
    );
    if (!canvas) {
      throw new Error("Project has no task canvas.");
    }
    return workspaceForProjectCanvas(this.loaded.workspace, canvas);
  }

  async sourceCanvasWorkspace(
    canvasId: string
  ): Promise<{ name: string; workspace: ProjectWorkspace }> {
    const canvas = this.requireCanvas(canvasId);
    return {
      name: canvas.title,
      workspace: workspaceForProjectCanvas(this.loaded.workspace, canvas)
    };
  }

  async create(input: { name?: string | null } = {}): Promise<DesktopTaskCanvasSummary> {
    // Cache is only for reads; mutation always reloads under the project lock.
    const result = await createProjectCanvas({
      projectRoot: this.projectRoot,
      title: input.name,
      defaultTitle: nextDefaultDesktopCanvasTitle,
      idMode: "random"
    });
    await this.reloadFromDisk();
    return summarizeProjectCanvas(result.projectWorkspace, result.canvas);
  }

  async duplicate(
    canvasId: string,
    input: { name?: string | null } = {}
  ): Promise<DesktopTaskCanvasSummary> {
    const result = await duplicateProjectCanvas({
      projectRoot: this.projectRoot,
      sourceCanvasId: canvasId,
      name: input.name
    });
    await this.reloadFromDisk();
    return summarizeProjectCanvas(result.projectWorkspace, result.canvas);
  }

  async rename(canvasId: string, name: string): Promise<DesktopTaskCanvasSummary> {
    const nextName = name.trim();
    if (!nextName) {
      throw new Error("Task canvas name is required.");
    }
    const canvas = this.requireCanvas(canvasId);
    const workspace = workspaceForProjectCanvas(this.loaded.workspace, canvas);
    const previousTitle = await writeManifestTitle(workspace, nextName);
    const nextCanvas = { ...canvas, title: nextName };
    try {
      await this.writeManifest({
        ...this.loaded.manifest,
        canvases: this.loaded.manifest.canvases.map((candidate) =>
          candidate.id === canvasId ? nextCanvas : candidate
        )
      });
    } catch (error) {
      await writeManifestTitle(workspace, previousTitle);
      throw error;
    }
    return summarizeProjectCanvas(this.loaded.workspace, nextCanvas);
  }

  async remove(canvasId: string): Promise<DesktopTaskCanvasSummary[]> {
    const canvas = this.requireCanvas(canvasId);
    const workspace = workspaceForProjectCanvas(this.loaded.workspace, canvas);
    assertWorkspaceChild(this.loaded.workspace, workspace.packageDir);
    assertWorkspaceChild(this.loaded.workspace, workspace.stateFile);
    assertWorkspaceChild(this.loaded.workspace, workspace.resultsDir);
    assertProjectCanvasUnreferenced(this.loaded.manifest, canvasId);
    if (
      canvas.id === defaultCanvasId ||
      workspace.workspaceRoot === this.loaded.workspace.workspaceRoot ||
      workspace.packageDir === this.loaded.workspace.packageDir ||
      this.loaded.manifest.canvases.length === 1
    ) {
      await resetCanvasWorkspace(workspace, canvas.title);
      invalidateDesktopProjectProjection(this.projectRoot);
      return this.list();
    }
    const quarantineRoot = await quarantineCanvasWorkspace(this.loaded.workspace, {
      canvasId,
      workspaceRoot: workspace.workspaceRoot
    });
    try {
      await this.writeManifest({
        ...this.loaded.manifest,
        canvases: this.loaded.manifest.canvases.filter((candidate) => candidate.id !== canvasId)
      });
    } catch (error) {
      await restoreQuarantineAfterFailedRemoval(
        this.loaded.workspace,
        canvasId,
        workspace.workspaceRoot,
        quarantineRoot,
        error
      );
      throw error;
    }
    return this.list();
  }

  private requireCanvas(canvasId: string): ProjectCanvasNode {
    const canvas = this.loaded.manifest.canvases.find((candidate) => candidate.id === canvasId);
    if (!canvas) {
      throw new Error(`Project canvas '${canvasId}' does not exist.`);
    }
    return canvas;
  }

  private async reloadFromDisk(): Promise<void> {
    this.loaded = await loadProjectGraph(this.projectRoot);
    invalidateDesktopProjectProjection(this.projectRoot);
  }

  private async writeManifest(manifest: ProjectGraphManifest): Promise<void> {
    const nextManifest = await writeProjectGraph(this.loaded.workspace, manifest);
    this.loaded = {
      ...this.loaded,
      manifest: nextManifest
    };
    invalidateDesktopProjectProjection(this.projectRoot);
  }
}

class LegacyCanvasRegistryAdapter implements ProjectCanvasStore {
  constructor(
    private readonly projectRoot: string,
    private readonly loaded: LoadedProjectGraph
  ) {}

  async list(): Promise<DesktopTaskCanvasSummary[]> {
    const { projectWorkspace, registry, diagnosticsByCanvasId } = await readRegistry(
      this.projectRoot
    );
    return Promise.all(
      registry.canvases.map((record) =>
        summarizeLegacyCanvas(
          projectWorkspace,
          record,
          diagnosticsByCanvasId.get(record.canvasId) ?? []
        )
      )
    );
  }

  async listWorkspaces(
    options: { createRegistry?: boolean } = {}
  ): Promise<DesktopTaskCanvasWorkspace[]> {
    const { projectWorkspace, registry } = await readRegistry(this.projectRoot, {
      createDefault: options.createRegistry ?? false
    });
    return registry.canvases.map((record) => ({
      canvasId: record.canvasId,
      canvasName: record.name,
      workspace: legacyCanvasWorkspace(projectWorkspace, record)
    }));
  }

  async resolveWorkspace(canvasId?: string | null): Promise<ProjectWorkspace> {
    if (canvasId) {
      const canvas = this.loaded.manifest.canvases.find((candidate) => candidate.id === canvasId);
      if (!canvas) {
        throw new Error(`Project canvas '${canvasId}' does not exist.`);
      }
      return workspaceForProjectCanvas(this.loaded.workspace, canvas);
    }
    const { projectWorkspace, registry } = await readRegistry(this.projectRoot);
    const record = selectedCanvasRecord(registry, canvasId);
    if (!record) {
      throw new Error("Project has no task canvas.");
    }
    return legacyCanvasWorkspace(projectWorkspace, record);
  }

  async sourceCanvasWorkspace(
    canvasId: string
  ): Promise<{ name: string; workspace: ProjectWorkspace }> {
    const { projectWorkspace, registry } = await readRegistry(this.projectRoot);
    const record = requireCanvasRecord(registry, canvasId);
    return {
      name: record.name,
      workspace: legacyCanvasWorkspace(projectWorkspace, record)
    };
  }

  async create(input: { name?: string | null } = {}): Promise<DesktopTaskCanvasSummary> {
    // Legacy is only a read/migration adapter. Create always uses the shared
    // project mutation coordinator (materialize + lock + graph write).
    const result = await createProjectCanvas({
      projectRoot: this.projectRoot,
      title: input.name,
      defaultTitle: nextDefaultDesktopCanvasTitle,
      idMode: "random"
    });
    invalidateDesktopProjectProjection(this.projectRoot);
    return summarizeProjectCanvas(result.projectWorkspace, result.canvas);
  }

  async duplicate(
    canvasId: string,
    input: { name?: string | null } = {}
  ): Promise<DesktopTaskCanvasSummary> {
    const result = await duplicateProjectCanvas({
      projectRoot: this.projectRoot,
      sourceCanvasId: canvasId,
      name: input.name
    });
    invalidateDesktopProjectProjection(this.projectRoot);
    return summarizeProjectCanvas(result.projectWorkspace, result.canvas);
  }

  async rename(canvasId: string, name: string): Promise<DesktopTaskCanvasSummary> {
    const nextName = name.trim();
    if (!nextName) {
      throw new Error("Task canvas name is required.");
    }
    const { projectWorkspace, registry } = await readRegistry(this.projectRoot);
    const record = requireCanvasRecord(registry, canvasId);
    const workspace = legacyCanvasWorkspace(projectWorkspace, record);
    const previousTitle = await writeManifestTitle(workspace, nextName);
    const nextRecord = {
      ...record,
      name: nextName,
      updatedAt: new Date().toISOString()
    };
    const nextRegistry = {
      ...registry,
      canvases: registry.canvases.map((canvas) =>
        canvas.canvasId === canvasId ? nextRecord : canvas
      )
    };
    try {
      await writeRegistry(projectWorkspace, nextRegistry);
    } catch (error) {
      await writeManifestTitle(workspace, previousTitle);
      throw error;
    }
    invalidateDesktopProjectProjection(this.projectRoot);
    return summarizeLegacyCanvas(projectWorkspace, nextRecord);
  }

  async remove(canvasId: string): Promise<DesktopTaskCanvasSummary[]> {
    const { projectWorkspace, registry } = await readRegistry(this.projectRoot);
    const record = requireCanvasRecord(registry, canvasId);
    const workspace = legacyCanvasWorkspace(projectWorkspace, record);
    assertWorkspaceChild(projectWorkspace, workspace.packageDir);
    assertWorkspaceChild(projectWorkspace, workspace.stateFile);
    assertWorkspaceChild(projectWorkspace, workspace.resultsDir);
    if (record.canvasId === defaultCanvasId) {
      await resetCanvasWorkspace(workspace, record.name);
      invalidateDesktopProjectProjection(this.projectRoot);
      return this.list();
    }
    const quarantineRoot = await quarantineCanvasWorkspace(projectWorkspace, {
      canvasId,
      workspaceRoot: workspace.workspaceRoot
    });
    const nextRegistry = {
      ...registry,
      canvases: registry.canvases.filter((canvas) => canvas.canvasId !== canvasId)
    };
    try {
      await writeRegistry(projectWorkspace, nextRegistry);
    } catch (error) {
      await restoreQuarantineAfterFailedRemoval(
        projectWorkspace,
        canvasId,
        workspace.workspaceRoot,
        quarantineRoot,
        error
      );
      throw error;
    }
    invalidateDesktopProjectProjection(this.projectRoot);
    return this.list();
  }
}

/**
 * Project canvas store that re-resolves the authoritative source on each call.
 * Construction-time source must not pin a permanent legacy create/duplicate lane:
 * after materialize, reads and mutations follow project-graph.json.
 */
class ResolvingProjectCanvasStore implements ProjectCanvasStore {
  constructor(private readonly projectRoot: string) {}

  private async open(): Promise<ProjectCanvasStore> {
    const loaded = await loadProjectGraph(this.projectRoot);
    if (loaded.source === "project_graph") {
      return new ProjectGraphCanvasStore(this.projectRoot, loaded);
    }
    return new LegacyCanvasRegistryAdapter(this.projectRoot, loaded);
  }

  async list(): Promise<DesktopTaskCanvasSummary[]> {
    return (await this.open()).list();
  }

  async listWorkspaces(
    options: { createRegistry?: boolean } = {}
  ): Promise<DesktopTaskCanvasWorkspace[]> {
    return (await this.open()).listWorkspaces(options);
  }

  async resolveWorkspace(canvasId?: string | null): Promise<ProjectWorkspace> {
    return (await this.open()).resolveWorkspace(canvasId);
  }

  async sourceCanvasWorkspace(
    canvasId: string
  ): Promise<{ name: string; workspace: ProjectWorkspace }> {
    return (await this.open()).sourceCanvasWorkspace(canvasId);
  }

  async create(input: { name?: string | null } = {}): Promise<DesktopTaskCanvasSummary> {
    // Always the coordinator — never a construction-time legacy stage/commit lane.
    const result = await createProjectCanvas({
      projectRoot: this.projectRoot,
      title: input.name,
      defaultTitle: nextDefaultDesktopCanvasTitle,
      idMode: "random"
    });
    invalidateDesktopProjectProjection(this.projectRoot);
    return summarizeProjectCanvas(result.projectWorkspace, result.canvas);
  }

  async duplicate(
    canvasId: string,
    input: { name?: string | null } = {}
  ): Promise<DesktopTaskCanvasSummary> {
    const result = await duplicateProjectCanvas({
      projectRoot: this.projectRoot,
      sourceCanvasId: canvasId,
      name: input.name
    });
    invalidateDesktopProjectProjection(this.projectRoot);
    return summarizeProjectCanvas(result.projectWorkspace, result.canvas);
  }

  async rename(canvasId: string, name: string): Promise<DesktopTaskCanvasSummary> {
    return (await this.open()).rename(canvasId, name);
  }

  async remove(canvasId: string): Promise<DesktopTaskCanvasSummary[]> {
    return (await this.open()).remove(canvasId);
  }
}

export async function createProjectCanvasStore(projectRoot: string): Promise<ProjectCanvasStore> {
  return new ResolvingProjectCanvasStore(projectRoot);
}
