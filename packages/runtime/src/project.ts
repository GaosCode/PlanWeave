import { access, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { constants } from "node:fs";
import { PlanWeaveWorkspaceNotInitializedError } from "./errors.js";
import { createProjectId } from "./projectId.js";
import { resolvePlanweaveHome } from "./paths.js";
import { readJsonFile } from "./json.js";
import type { ProjectKind, ProjectMetadata, ProjectWorkspace } from "./types.js";

export function projectWorkspacePaths(input: {
  id: string;
  kind: ProjectKind;
  rootPath: string;
  sourceRoot: string | null;
  planweaveHome: string;
  workspaceRoot: string;
}): ProjectWorkspace {
  return {
    ...input,
    projectFile: join(input.workspaceRoot, "project.json"),
    packageDir: join(input.workspaceRoot, "package"),
    manifestFile: join(input.workspaceRoot, "package", "manifest.json"),
    stateFile: join(input.workspaceRoot, "state.json"),
    resultsDir: join(input.workspaceRoot, "results"),
    projectPromptFile: join(input.workspaceRoot, "policy", "project-prompt.md")
  };
}

function metadataKind(project: ProjectMetadata): ProjectKind {
  return project.kind === "managed" ? "managed" : "external";
}

function isPathDescendant(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function isLegacyManagedRoot(planweaveHome: string, rootPath: string): boolean {
  const legacyRoots = [join(planweaveHome, "mcp-projects"), join(planweaveHome, "mcp-imports")];
  return legacyRoots.some((legacyRoot) => isPathDescendant(legacyRoot, rootPath));
}

export function normalizeProjectMetadata(project: ProjectMetadata, input: { planweaveHome: string; workspaceRoot: string }): ProjectMetadata {
  if (project.kind === "managed") {
    return {
      ...project,
      kind: "managed",
      rootPath: input.workspaceRoot,
      sourceRoot: project.sourceRoot ?? null
    };
  }
  if (project.kind === undefined && isLegacyManagedRoot(input.planweaveHome, project.rootPath)) {
    return {
      ...project,
      kind: "managed",
      rootPath: input.workspaceRoot,
      sourceRoot: null
    };
  }
  return {
    ...project,
    kind: "external",
    sourceRoot: project.sourceRoot ?? project.rootPath
  };
}

function sourceRootForMetadata(project: ProjectMetadata): string | null {
  const kind = metadataKind(project);
  if (kind === "managed") {
    return project.sourceRoot ?? null;
  }
  return project.sourceRoot ?? project.rootPath;
}

async function isDirectRegisteredWorkspace(planweaveHome: string, rootPath: string): Promise<boolean> {
  let projectsRoot: string;
  try {
    projectsRoot = await realpath(join(planweaveHome, "projects"));
  } catch {
    projectsRoot = join(planweaveHome, "projects");
  }
  const relativePath = relative(projectsRoot, rootPath);
  return Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath) && relativePath === basename(rootPath);
}

async function workspaceFromRegisteredRoot(rootPath: string, planweaveHome: string): Promise<ProjectWorkspace | null> {
  if (!(await isDirectRegisteredWorkspace(planweaveHome, rootPath))) {
    return null;
  }
  const projectFile = join(rootPath, "project.json");
  try {
    await access(projectFile, constants.R_OK);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const project = await readJsonFile<ProjectMetadata>(projectFile);
  if (project.id !== basename(rootPath)) {
    throw new Error(`PlanWeave workspace metadata id '${project.id}' does not match workspace directory '${basename(rootPath)}'.`);
  }
  const normalizedProject = normalizeProjectMetadata(project, { planweaveHome, workspaceRoot: rootPath });
  return projectWorkspacePaths({
    id: normalizedProject.id,
    kind: metadataKind(normalizedProject),
    rootPath: normalizedProject.rootPath,
    sourceRoot: sourceRootForMetadata(normalizedProject),
    planweaveHome,
    workspaceRoot: rootPath
  });
}

export async function resolveProjectWorkspace(projectRoot: string): Promise<ProjectWorkspace> {
  const rootPath = await realpath(projectRoot);
  const planweaveHome = resolvePlanweaveHome();
  const registeredWorkspace = await workspaceFromRegisteredRoot(rootPath, planweaveHome);
  if (registeredWorkspace) {
    return registeredWorkspace;
  }
  const id = await createProjectId(rootPath);
  return projectWorkspacePaths({
    id,
    kind: "external",
    rootPath,
    sourceRoot: rootPath,
    planweaveHome,
    workspaceRoot: join(planweaveHome, "projects", id)
  });
}

export async function readProject(projectRoot: string): Promise<ProjectMetadata | null> {
  const workspace = await resolveProjectWorkspace(projectRoot);
  try {
    await access(workspace.projectFile, constants.R_OK);
  } catch {
    return null;
  }
  const project = await readJsonFile<ProjectMetadata>(workspace.projectFile);
  return normalizeProjectMetadata(project, { planweaveHome: workspace.planweaveHome, workspaceRoot: workspace.workspaceRoot });
}

export async function requireInitializedProjectWorkspace(projectRoot: string): Promise<ProjectWorkspace> {
  const workspace = await resolveProjectWorkspace(projectRoot);
  try {
    await access(workspace.projectFile, constants.R_OK);
  } catch {
    throw new PlanWeaveWorkspaceNotInitializedError(workspace);
  }
  return workspace;
}
