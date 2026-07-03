import { realpath, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { optionalReaddir, optionalStat } from "../fs/optionalFile.js";
import { initManagedWorkspace, initWorkspace } from "../initWorkspace.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { resolvePlanweaveHome } from "../paths.js";
import { normalizeProjectMetadata, projectWorkspacePaths, readProject, resolveProjectWorkspace } from "../project.js";
import { createManagedProjectId } from "../projectId.js";
import {
  detectDefaultCanvasWorkspaceMigration,
  loadProjectGraphForWorkspace,
  materializeProjectGraph,
  projectCanvasWorkspace,
  projectGraphPath,
  writeProjectGraph
} from "../projectGraph/index.js";
import { manifestSchema } from "../schema/manifest.js";
import type { PlanPackageManifest, ProjectMetadata, ProjectWorkspace } from "../types.js";
import type { DesktopProjectSummary } from "./types.js";
import { getActiveTaskCanvasId, listTaskCanvases } from "./canvasApi.js";
import { readActiveTaskCanvasSelection, writeActiveTaskCanvasSelection } from "./canvasSelectionStore.js";
import { updateSourceDefaultProjectReference } from "./sourceDefaultProject.js";

async function exists(path: string): Promise<boolean> {
  return (await optionalStat(path)) !== null;
}

async function projectSummary(project: ProjectMetadata, workspaceRoot: string): Promise<DesktopProjectSummary> {
  const [activeCanvasId, taskCanvases] = await Promise.all([getActiveTaskCanvasId(project.rootPath), listTaskCanvases(project.rootPath)]);
  const kind = project.kind === "managed" ? "managed" : "external";
  return {
    projectId: project.id,
    name: project.name,
    kind,
    rootPath: project.rootPath,
    sourceRoot: kind === "managed" ? project.sourceRoot ?? null : project.sourceRoot ?? project.rootPath,
    workspaceRoot,
    activeCanvasId,
    taskCanvases
  };
}

async function ensureFormalProjectGraph(projectRoot: string): Promise<void> {
  const workspace = await resolveProjectWorkspace(projectRoot);
  if (await exists(projectGraphPath(workspace))) {
    return;
  }
  const migrationPlan = await detectDefaultCanvasWorkspaceMigration(workspace);
  if (migrationPlan.action !== "none") {
    return;
  }
  const legacyActiveCanvasId = await readLegacyActiveCanvasId(projectRoot, workspace);
  await materializeProjectGraph(projectRoot);
  if (legacyActiveCanvasId) {
    await writeActiveTaskCanvasSelection(projectRoot, legacyActiveCanvasId);
  }
}

async function readLegacyActiveCanvasId(projectRoot: string, workspace: ProjectWorkspace): Promise<string | null> {
  const registryFile = join(workspace.workspaceRoot, "desktop", "canvases.json");
  if (!(await exists(registryFile))) {
    return null;
  }
  return (await readActiveTaskCanvasSelection(projectRoot)).activeCanvasId;
}

function isDescendant(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertDirectProjectWorkspace(projectsRoot: string, workspaceRoot: string, projectId: string, action: "changed" | "removed"): void {
  const relativeWorkspace = relative(projectsRoot, workspaceRoot);
  if (
    !relativeWorkspace ||
    relativeWorkspace !== projectId ||
    relativeWorkspace.startsWith("..") ||
    isAbsolute(relativeWorkspace)
  ) {
    throw new Error(`Project '${projectId}' cannot be ${action} in the PlanWeave registry.`);
  }
}

function projectWorkspacePathsForRename(project: ProjectMetadata, id: string, workspaceRoot: string): ProjectWorkspace {
  return projectWorkspacePaths({
    id,
    kind: "managed",
    rootPath: workspaceRoot,
    sourceRoot: project.sourceRoot ?? null,
    planweaveHome: resolvePlanweaveHome(),
    workspaceRoot
  });
}

async function readRegisteredProject(projectId: string): Promise<{ project: ProjectMetadata; workspaceRoot: string; projectFile: string } | null> {
  const planweaveHome = resolvePlanweaveHome();
  const workspaceRoot = join(planweaveHome, "projects", projectId);
  const projectFile = join(workspaceRoot, "project.json");
  if (!(await optionalStat(projectFile))) {
    return null;
  }
  const project = normalizeProjectMetadata(await readJsonFile<ProjectMetadata>(projectFile), {
    planweaveHome,
    workspaceRoot
  });
  return { project, workspaceRoot, projectFile };
}

async function readProjectById(projectId: string): Promise<DesktopProjectSummary | null> {
  const entry = await readRegisteredProject(projectId);
  if (!entry) {
    return null;
  }
  if (!(await optionalStat(entry.project.rootPath))) {
    return null;
  }
  return projectSummary(entry.project, entry.workspaceRoot);
}

export async function listProjects(): Promise<DesktopProjectSummary[]> {
  const projectsRoot = join(resolvePlanweaveHome(), "projects");
  const entries = await optionalReaddir(projectsRoot, { withFileTypes: true });
  if (!entries) {
    return [];
  }
  const projects = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => readProjectById(entry.name))
  );
  return projects.filter((project): project is DesktopProjectSummary => project !== null).sort((left, right) => {
    return left.name.localeCompare(right.name) || left.projectId.localeCompare(right.projectId);
  });
}

export async function removeProject(projectId: string): Promise<void> {
  const projectsRoot = resolve(resolvePlanweaveHome(), "projects");
  const workspaceRoot = resolve(projectsRoot, projectId);
  assertDirectProjectWorkspace(projectsRoot, workspaceRoot, projectId, "removed");
  await rm(workspaceRoot, { recursive: true, force: true });
}

async function rewriteJsonProjectId(path: string, projectId: string): Promise<void> {
  if (!(await optionalStat(path))) {
    return;
  }
  const raw = await readJsonFile<unknown>(path);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return;
  }
  await writeJsonFile(path, {
    ...raw,
    projectId
  });
}

async function rewritePackageManifestTitle(path: string, title: string): Promise<void> {
  if (!(await optionalStat(path))) {
    return;
  }
  const manifest = manifestSchema.parse(await readJsonFile<unknown>(path)) as PlanPackageManifest;
  await writeJsonFile(path, {
    ...manifest,
    project: {
      ...manifest.project,
      title
    }
  });
}

async function rewriteSingleCanvasProjectTitle(workspace: ProjectWorkspace, title: string): Promise<void> {
  const loaded = await loadProjectGraphForWorkspace(workspace);
  if (loaded.manifest.canvases.length !== 1) {
    return;
  }
  const canvas = loaded.manifest.canvases[0];
  if (!canvas) {
    return;
  }
  await writeProjectGraph(workspace, {
    ...loaded.manifest,
    canvases: [{ ...canvas, title }]
  });
  await rewritePackageManifestTitle(projectCanvasWorkspace(workspace, canvas).manifestFile, title);
}

type SingleCanvasTitleSnapshot = {
  canvasId: string;
  projectGraphTitle: string;
  manifestFile: string;
  manifestTitle: string | null;
} | null;

async function readSingleCanvasTitleSnapshot(workspace: ProjectWorkspace): Promise<SingleCanvasTitleSnapshot> {
  const loaded = await loadProjectGraphForWorkspace(workspace);
  if (loaded.manifest.canvases.length !== 1) {
    return null;
  }
  const canvas = loaded.manifest.canvases[0];
  if (!canvas) {
    return null;
  }
  const manifestFile = projectCanvasWorkspace(workspace, canvas).manifestFile;
  let manifestTitle: string | null = null;
  if (await optionalStat(manifestFile)) {
    const manifest = manifestSchema.parse(await readJsonFile<unknown>(manifestFile)) as PlanPackageManifest;
    manifestTitle = manifest.project.title;
  }
  return {
    canvasId: canvas.id,
    projectGraphTitle: canvas.title,
    manifestFile,
    manifestTitle
  };
}

async function restoreSingleCanvasTitleSnapshot(workspace: ProjectWorkspace, snapshot: SingleCanvasTitleSnapshot): Promise<void> {
  if (!snapshot) {
    return;
  }
  const loaded = await loadProjectGraphForWorkspace(workspace);
  await writeProjectGraph(workspace, {
    ...loaded.manifest,
    canvases: loaded.manifest.canvases.map((canvas) =>
      canvas.id === snapshot.canvasId ? { ...canvas, title: snapshot.projectGraphTitle } : canvas
    )
  });
  if (snapshot.manifestTitle !== null && (await optionalStat(snapshot.manifestFile))) {
    await rewritePackageManifestTitle(snapshot.manifestFile, snapshot.manifestTitle);
  }
}

async function rewriteManagedProjectIdentityFiles(workspace: ProjectWorkspace, project: ProjectMetadata): Promise<void> {
  await writeJsonFile(workspace.projectFile, project);
  await Promise.all([
    rewriteJsonProjectId(join(workspace.workspaceRoot, "desktop", "layout.json"), project.id),
    rewriteJsonProjectId(join(workspace.workspaceRoot, "desktop", "canvas-map-layout.json"), project.id)
  ]);
}

async function rewriteManagedProjectFiles(workspace: ProjectWorkspace, project: ProjectMetadata): Promise<void> {
  await rewriteManagedProjectIdentityFiles(workspace, project);
  await rewriteSingleCanvasProjectTitle(workspace, project.name);
}

async function renameManagedProject(entry: { project: ProjectMetadata; workspaceRoot: string; projectFile: string }, name: string): Promise<DesktopProjectSummary> {
  const previousProject = entry.project;
  const previousProjectId = previousProject.id;
  const nextProjectId = createManagedProjectId(name);
  const projectsRoot = resolve(resolvePlanweaveHome(), "projects");
  const previousWorkspaceRoot = resolve(entry.workspaceRoot);
  const nextWorkspaceRoot = resolve(projectsRoot, nextProjectId);
  assertDirectProjectWorkspace(projectsRoot, previousWorkspaceRoot, previousProjectId, "changed");
  assertDirectProjectWorkspace(projectsRoot, nextWorkspaceRoot, nextProjectId, "changed");

  const nextProject: ProjectMetadata = {
    ...previousProject,
    id: nextProjectId,
    name,
    kind: "managed",
    rootPath: nextWorkspaceRoot,
    sourceRoot: previousProject.sourceRoot ?? null
  };
  const nextWorkspace = projectWorkspacePathsForRename(nextProject, nextProjectId, nextWorkspaceRoot);

  if (nextProjectId === previousProjectId) {
    await rewriteManagedProjectFiles(nextWorkspace, nextProject);
    return projectSummary(nextProject, nextWorkspaceRoot);
  }

  if (await optionalStat(nextWorkspaceRoot)) {
    throw new Error(`PlanWeave project '${name}' already exists.`);
  }

  const previousWorkspace = projectWorkspacePathsForRename(previousProject, previousProjectId, previousWorkspaceRoot);
  const previousTitleSnapshot = await readSingleCanvasTitleSnapshot(previousWorkspace);
  let moved = false;
  try {
    await rename(previousWorkspaceRoot, nextWorkspaceRoot);
    moved = true;
    await rewriteManagedProjectFiles(nextWorkspace, nextProject);
    await updateSourceDefaultProjectReference(previousProjectId, {
      projectId: nextProjectId,
      projectRoot: nextWorkspaceRoot
    });
  } catch (error) {
    if (moved) {
      try {
        await writeJsonFile(join(nextWorkspaceRoot, "project.json"), {
          ...previousProject,
          id: previousProjectId,
          kind: "managed",
          rootPath: previousWorkspaceRoot,
          sourceRoot: previousProject.sourceRoot ?? null
        });
        await rename(nextWorkspaceRoot, previousWorkspaceRoot);
        await rewriteManagedProjectIdentityFiles(previousWorkspace, {
          ...previousProject,
          id: previousProjectId,
          kind: "managed",
          rootPath: previousWorkspaceRoot,
          sourceRoot: previousProject.sourceRoot ?? null
        });
        await restoreSingleCanvasTitleSnapshot(previousWorkspace, previousTitleSnapshot);
      } catch (rollbackError) {
        throw new Error(`Project rename failed: ${errorMessage(error)}; rollback failed: ${errorMessage(rollbackError)}`);
      }
    }
    throw error;
  }

  return projectSummary(nextProject, nextWorkspaceRoot);
}

export async function renameProject(projectId: string, name: string): Promise<DesktopProjectSummary> {
  const nextName = name.trim();
  if (!nextName) {
    throw new Error("Project name is required.");
  }
  const entry = await readRegisteredProject(projectId);
  if (!entry) {
    throw new Error(`Project '${projectId}' does not exist.`);
  }
  if (entry.project.kind === "managed") {
    return renameManagedProject(entry, nextName);
  }
  const nextProject: ProjectMetadata = {
    ...entry.project,
    name: nextName
  };
  await writeJsonFile(entry.projectFile, nextProject);
  return projectSummary(nextProject, entry.workspaceRoot);
}

export async function initOrOpenProject(rootPath: string): Promise<DesktopProjectSummary> {
  const existing = await readProject(rootPath);
  if (existing) {
    const workspace = await resolveProjectWorkspace(rootPath);
    await ensureFormalProjectGraph(rootPath);
    return projectSummary(existing, workspace.workspaceRoot);
  }
  const init = await initWorkspace({ projectRoot: rootPath, projectGraph: true });
  return projectSummary(init.project, init.workspace.workspaceRoot);
}

export async function initManagedProject(name: string): Promise<DesktopProjectSummary> {
  const init = await initManagedWorkspace({ name, projectGraph: true });
  return projectSummary(init.project, init.workspace.workspaceRoot);
}

export async function linkProjectSourceRoot(projectId: string, sourceRoot: string): Promise<DesktopProjectSummary> {
  const entry = await readRegisteredProject(projectId);
  if (!entry) {
    throw new Error(`Project '${projectId}' does not exist.`);
  }
  if (entry.project.kind !== "managed") {
    throw new Error("Only managed PlanWeave projects can bind a source root.");
  }
  const resolvedSourceRoot = await realpath(sourceRoot);
  const sourceRootStat = await stat(resolvedSourceRoot);
  if (!sourceRootStat.isDirectory()) {
    throw new Error("Source root must be a directory.");
  }
  const planweaveHome = await realpath(resolvePlanweaveHome());
  const workspaceRoot = await realpath(entry.workspaceRoot);
  if (resolvedSourceRoot === workspaceRoot || isDescendant(workspaceRoot, resolvedSourceRoot)) {
    throw new Error("Source root must be outside the PlanWeave project workspace.");
  }
  if (resolvedSourceRoot === planweaveHome || isDescendant(planweaveHome, resolvedSourceRoot)) {
    throw new Error("Source root must be outside the PlanWeave home directory.");
  }
  const nextProject: ProjectMetadata = {
    ...entry.project,
    kind: "managed",
    rootPath: entry.workspaceRoot,
    sourceRoot: resolvedSourceRoot
  };
  await writeJsonFile(entry.projectFile, nextProject);
  return projectSummary(nextProject, entry.workspaceRoot);
}

export async function unlinkProjectSourceRoot(projectId: string): Promise<DesktopProjectSummary> {
  const entry = await readRegisteredProject(projectId);
  if (!entry) {
    throw new Error(`Project '${projectId}' does not exist.`);
  }
  if (entry.project.kind !== "managed") {
    throw new Error("Only managed PlanWeave projects can unlink a source root.");
  }
  const nextProject: ProjectMetadata = {
    ...entry.project,
    kind: "managed",
    rootPath: entry.workspaceRoot,
    sourceRoot: null
  };
  await writeJsonFile(entry.projectFile, nextProject);
  return projectSummary(nextProject, entry.workspaceRoot);
}

export async function openProject(input: { projectId?: string; rootPath?: string }): Promise<DesktopProjectSummary> {
  if (input.projectId) {
    const entry = await readRegisteredProject(input.projectId);
    if (!entry) {
      throw new Error(`Project '${input.projectId}' does not exist.`);
    }
    if (!(await exists(entry.project.rootPath))) {
      throw new Error(`Project '${input.projectId}' does not exist.`);
    }
    await ensureFormalProjectGraph(entry.project.rootPath);
    return projectSummary(entry.project, entry.workspaceRoot);
  }
  if (input.rootPath) {
    return initOrOpenProject(input.rootPath);
  }
  throw new Error("openProject requires projectId or rootPath.");
}

export async function getProjectOverview(projectRoot: string): Promise<DesktopProjectSummary> {
  const project = await readProject(projectRoot);
  if (!project) {
    throw new Error(`PlanWeave project '${projectRoot}' has not been initialized.`);
  }
  const workspace = await resolveProjectWorkspace(projectRoot);
  await ensureFormalProjectGraph(projectRoot);
  return projectSummary(project, workspace.workspaceRoot);
}
