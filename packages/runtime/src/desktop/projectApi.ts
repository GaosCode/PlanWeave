import { access, readdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { initWorkspace } from "../initWorkspace.js";
import { readJsonFile } from "../json.js";
import { resolvePlanweaveHome } from "../paths.js";
import { readProject, resolveProjectWorkspace } from "../project.js";
import type { ProjectMetadata } from "../types.js";
import type { DesktopProjectSummary } from "./types.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function projectSummary(project: ProjectMetadata, workspaceRoot: string): DesktopProjectSummary {
  return {
    projectId: project.id,
    name: project.name,
    rootPath: project.rootPath,
    workspaceRoot
  };
}

async function readProjectById(projectId: string): Promise<DesktopProjectSummary | null> {
  const workspaceRoot = join(resolvePlanweaveHome(), "projects", projectId);
  const projectFile = join(workspaceRoot, "project.json");
  if (!(await exists(projectFile))) {
    return null;
  }
  return projectSummary(await readJsonFile<ProjectMetadata>(projectFile), workspaceRoot);
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
