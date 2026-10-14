import { capturePackageStorageIdentity } from "../package/packageStorageIdentity.js";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { withProjectMutationLock } from "../fs/withProjectMutationLock.js";
import { optionalStat } from "../fs/optionalFile.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import {
  loadProjectGraphForWorkspace,
  projectCanvasWorkspace as workspaceForProjectCanvas
} from "../projectGraph/index.js";
import type { LoadedProjectGraph, ProjectCanvasNode } from "../projectGraph/index.js";
import {
  renameProjectCanvas,
  removeProjectCanvas
} from "../projectGraph/projectCanvasLifecycleMutation.js";
import {
  createProjectCanvas,
  duplicateProjectCanvas,
  nextDefaultDesktopCanvasTitle
} from "../projectGraph/projectCanvasMutation.js";
import { assertCurrentProjectWorkspace, resolveProjectWorkspace } from "../project.js";
import type { PackageWorkspaceRef, ProjectWorkspace, ValidationIssue } from "../types.js";
import {
  normalizeRegistry,
  registryVersion,
  type TaskCanvasRecord,
  type TaskCanvasRegistry
} from "./canvasRegistry.js";
import {
  readActiveTaskCanvasSelection,
  readActiveTaskCanvasSelectionForWorkspace
} from "./canvasSelectionStore.js";
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
  projectRoot: PackageWorkspaceRef,
  options: { createDefault?: boolean } = {}
): Promise<{
  projectWorkspace: ProjectWorkspace;
  registry: TaskCanvasRegistry;
  diagnosticsByCanvasId: Map<string, ValidationIssue[]>;
}> {
  const projectWorkspace =
    typeof projectRoot === "string" ? await resolveProjectWorkspace(projectRoot) : projectRoot;
  if (options.createDefault === false) return readRegistryForWorkspace(projectWorkspace, options);
  return withProjectMutationLock(
    projectWorkspace.workspaceRoot,
    async () => {
      await assertCurrentProjectWorkspace(projectWorkspace);
      return readRegistryForWorkspace(projectWorkspace, options);
    },
    { operation: "initialize-legacy-canvas-registry" }
  );
}

async function readRegistryForWorkspace(
  projectWorkspace: ProjectWorkspace,
  options: { createDefault?: boolean }
): Promise<{
  projectWorkspace: ProjectWorkspace;
  registry: TaskCanvasRegistry;
  diagnosticsByCanvasId: Map<string, ValidationIssue[]>;
}> {
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
    packageStorageIdentity: null,
    resultsStorageIdentity: null,
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

async function summarizeRenamedCanvas(
  result: Awaited<ReturnType<typeof renameProjectCanvas>>
): Promise<DesktopTaskCanvasSummary> {
  return result.registryRecord
    ? summarizeLegacyCanvas(result.projectWorkspace, result.registryRecord)
    : summarizeProjectCanvas(result.projectWorkspace, result.canvas);
}

class ProjectGraphCanvasStore implements ProjectCanvasStore {
  private loaded: LoadedProjectGraph;

  constructor(
    private readonly projectRoot: ProjectWorkspace,
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
    const result = await renameProjectCanvas({ projectRoot: this.projectRoot, canvasId, name });
    invalidateDesktopProjectProjection(this.projectRoot.rootPath);
    return summarizeRenamedCanvas(result);
  }

  async remove(canvasId: string): Promise<DesktopTaskCanvasSummary[]> {
    await removeProjectCanvas({ projectRoot: this.projectRoot, canvasId });
    invalidateDesktopProjectProjection(this.projectRoot.rootPath);
    return (await createProjectCanvasStore(this.projectRoot)).list();
  }
  private requireCanvas(canvasId: string): ProjectCanvasNode {
    const canvas = this.loaded.manifest.canvases.find((candidate) => candidate.id === canvasId);
    if (!canvas) {
      throw new Error(`Project canvas '${canvasId}' does not exist.`);
    }
    return canvas;
  }

  private async reloadFromDisk(): Promise<void> {
    this.loaded = await loadProjectGraphForWorkspace(this.projectRoot);
    invalidateDesktopProjectProjection(this.projectRoot.rootPath);
  }
}

class LegacyCanvasRegistryAdapter implements ProjectCanvasStore {
  constructor(
    private readonly projectRoot: ProjectWorkspace,
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
    invalidateDesktopProjectProjection(this.projectRoot.rootPath);
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
    invalidateDesktopProjectProjection(this.projectRoot.rootPath);
    return summarizeProjectCanvas(result.projectWorkspace, result.canvas);
  }

  async rename(canvasId: string, name: string): Promise<DesktopTaskCanvasSummary> {
    const result = await renameProjectCanvas({ projectRoot: this.projectRoot, canvasId, name });
    invalidateDesktopProjectProjection(this.projectRoot.rootPath);
    return summarizeRenamedCanvas(result);
  }

  async remove(canvasId: string): Promise<DesktopTaskCanvasSummary[]> {
    await removeProjectCanvas({ projectRoot: this.projectRoot, canvasId });
    invalidateDesktopProjectProjection(this.projectRoot.rootPath);
    return (await createProjectCanvasStore(this.projectRoot)).list();
  }
}

/**
 * Project canvas store that re-resolves the authoritative source on each call.
 * Construction-time source must not pin a permanent legacy create/duplicate lane:
 * after materialize, reads and mutations follow project-graph.json.
 */
class ResolvingProjectCanvasStore implements ProjectCanvasStore {
  constructor(private readonly projectRoot: ProjectWorkspace) {}

  private async open(): Promise<ProjectCanvasStore> {
    const loaded = await loadProjectGraphForWorkspace(this.projectRoot);
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
    return Promise.all(
      (await (await this.open()).listWorkspaces(options)).map(async (item) => ({
        ...item,
        workspace: await capturePackageStorageIdentity(item.workspace)
      }))
    );
  }

  async resolveWorkspace(canvasId?: string | null): Promise<ProjectWorkspace> {
    return capturePackageStorageIdentity(await (await this.open()).resolveWorkspace(canvasId));
  }

  async sourceCanvasWorkspace(
    canvasId: string
  ): Promise<{ name: string; workspace: ProjectWorkspace }> {
    const source = await (await this.open()).sourceCanvasWorkspace(canvasId);
    return { ...source, workspace: await capturePackageStorageIdentity(source.workspace) };
  }

  async create(input: { name?: string | null } = {}): Promise<DesktopTaskCanvasSummary> {
    // Always the coordinator — never a construction-time legacy stage/commit lane.
    const result = await createProjectCanvas({
      projectRoot: this.projectRoot,
      title: input.name,
      defaultTitle: nextDefaultDesktopCanvasTitle,
      idMode: "random"
    });
    invalidateDesktopProjectProjection(this.projectRoot.rootPath);
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
    invalidateDesktopProjectProjection(this.projectRoot.rootPath);
    return summarizeProjectCanvas(result.projectWorkspace, result.canvas);
  }

  async rename(canvasId: string, name: string): Promise<DesktopTaskCanvasSummary> {
    const result = await renameProjectCanvas({ projectRoot: this.projectRoot, canvasId, name });
    invalidateDesktopProjectProjection(this.projectRoot.rootPath);
    return summarizeRenamedCanvas(result);
  }

  async remove(canvasId: string): Promise<DesktopTaskCanvasSummary[]> {
    await removeProjectCanvas({ projectRoot: this.projectRoot, canvasId });
    invalidateDesktopProjectProjection(this.projectRoot.rootPath);
    return this.list();
  }
}

export async function createProjectCanvasStore(
  projectRoot: PackageWorkspaceRef
): Promise<ProjectCanvasStore> {
  const workspace =
    typeof projectRoot === "string" ? await resolveProjectWorkspace(projectRoot) : projectRoot;
  return new ResolvingProjectCanvasStore(workspace);
}

/** Read registered storage in the captured Home without creating a legacy registry. */
export async function listRegisteredCanvasWorkspacesForProject(
  projectWorkspace: ProjectWorkspace
): Promise<ProjectWorkspace[]> {
  const loaded = await loadProjectGraphForWorkspace(projectWorkspace);
  if (loaded.source === "project_graph") {
    return loaded.manifest.canvases.map((canvas) =>
      workspaceForProjectCanvas(loaded.workspace, canvas)
    );
  }
  if (loaded.source === "legacy_default_canvas") return [projectWorkspace];
  const { registry } = await readRegistry(projectWorkspace, { createDefault: false });
  return registry.canvases.map((record) => legacyCanvasWorkspace(projectWorkspace, record));
}

/** Resolve command/history membership using an internally resolved project owner. */
export async function resolveSelectedCanvasWorkspaceForProject(
  projectWorkspace: ProjectWorkspace
): Promise<ProjectWorkspace> {
  const loaded = await loadProjectGraphForWorkspace(projectWorkspace);
  if (loaded.source === "project_graph") {
    const { activeCanvasId } = await readActiveTaskCanvasSelectionForWorkspace(loaded.workspace);
    const canvas = loaded.manifest.canvases.find((candidate) => candidate.id === activeCanvasId);
    if (!canvas) throw new Error("Project has no task canvas.");
    return capturePackageStorageIdentity(workspaceForProjectCanvas(loaded.workspace, canvas));
  }
  const { registry } = await readRegistry(projectWorkspace);
  const record = selectedCanvasRecord(registry);
  if (!record) throw new Error("Project has no task canvas.");
  return capturePackageStorageIdentity(legacyCanvasWorkspace(projectWorkspace, record));
}
