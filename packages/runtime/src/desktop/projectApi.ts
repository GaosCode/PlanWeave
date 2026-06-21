import { access, readdir, realpath, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { initManagedWorkspace, initWorkspace } from "../initWorkspace.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { resolvePlanweaveHome } from "../paths.js";
import { normalizeProjectMetadata, readProject, resolveProjectWorkspace } from "../project.js";
import type { ProjectMetadata } from "../types.js";
import type { DesktopProjectSummary } from "./types.js";
import { getActiveTaskCanvasId, listTaskCanvases } from "./canvasApi.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
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

function isDescendant(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

async function readRegisteredProject(projectId: string): Promise<{ project: ProjectMetadata; workspaceRoot: string; projectFile: string } | null> {
  const planweaveHome = resolvePlanweaveHome();
  const workspaceRoot = join(planweaveHome, "projects", projectId);
  const projectFile = join(workspaceRoot, "project.json");
  if (!(await exists(projectFile))) {
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
  try {
    if (!(await exists(entry.project.rootPath))) {
      return null;
    }
    return await projectSummary(entry.project, entry.workspaceRoot);
  } catch {
    return null;
  }
}

export async function listProjects(): Promise<DesktopProjectSummary[]> {
  const projectsRoot = join(resolvePlanweaveHome(), "projects");
  try {
    const entries = await readdir(projectsRoot, { withFileTypes: true });
    const projects = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => readProjectById(entry.name))
    );
    return projects.filter((project): project is DesktopProjectSummary => project !== null).sort((left, right) => {
      return left.name.localeCompare(right.name) || left.projectId.localeCompare(right.projectId);
    });
  } catch {
    return [];
  }
}

export async function removeProject(projectId: string): Promise<void> {
  const projectsRoot = resolve(resolvePlanweaveHome(), "projects");
  const workspaceRoot = resolve(projectsRoot, projectId);
  const relativeWorkspace = relative(projectsRoot, workspaceRoot);
  if (
    !relativeWorkspace ||
    relativeWorkspace !== projectId ||
    relativeWorkspace.startsWith("..") ||
    isAbsolute(relativeWorkspace)
  ) {
    throw new Error(`Project '${projectId}' cannot be removed from the PlanWeave registry.`);
  }
  await rm(workspaceRoot, { recursive: true, force: true });
}

export async function initOrOpenProject(rootPath: string): Promise<DesktopProjectSummary> {
  const existing = await readProject(rootPath);
  if (existing) {
    const workspace = await resolveProjectWorkspace(rootPath);
    return projectSummary(existing, workspace.workspaceRoot);
  }
  const init = await initWorkspace({ projectRoot: rootPath });
  return projectSummary(init.project, init.workspace.workspaceRoot);
}

export async function initManagedProject(name: string): Promise<DesktopProjectSummary> {
  const init = await initManagedWorkspace({ name });
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
    const project = await readProjectById(input.projectId);
    if (!project) {
      throw new Error(`Project '${input.projectId}' does not exist.`);
    }
    return project;
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
  return projectSummary(project, workspace.workspaceRoot);
}
