import { realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { PlanWeaveWorkspaceNotInitializedError } from "./errors.js";
import { optionalStat } from "./fs/optionalFile.js";
import { createProjectId } from "./projectId.js";
import { resolvePlanweaveHome } from "./paths.js";
import { readProjectMetadataFile } from "./projectMetadata.js";
import { canonicalCanvasWorkspacePaths } from "./projectGraph/canonicalWorkspace.js";
import type { ProjectKind, ProjectMetadata, ProjectWorkspace } from "./types.js";

export function projectWorkspacePaths(input: {
  id: string;
  kind: ProjectKind;
  rootPath: string;
  sourceRoot: string | null;
  planweaveHome: string;
  workspaceRoot: string;
}): ProjectWorkspace {
  const defaultCanvasWorkspace = canonicalCanvasWorkspacePaths("default");
  return {
    ...input,
    projectFile: join(input.workspaceRoot, "project.json"),
    packageDir: join(input.workspaceRoot, defaultCanvasWorkspace.packageDir),
    manifestFile: join(input.workspaceRoot, defaultCanvasWorkspace.packageDir, "manifest.json"),
    stateFile: join(input.workspaceRoot, defaultCanvasWorkspace.stateFile),
    resultsDir: join(input.workspaceRoot, defaultCanvasWorkspace.resultsDir),
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

export function normalizeProjectMetadata(
  project: ProjectMetadata,
  input: { planweaveHome: string; workspaceRoot: string }
): ProjectMetadata {
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

async function directRegisteredWorkspaceId(
  planweaveHome: string,
  rootPath: string
): Promise<string | null> {
  let projectsRoot: string;
  try {
    projectsRoot = await realpath(join(planweaveHome, "projects"));
  } catch {
    projectsRoot = join(planweaveHome, "projects");
  }
  const relativePath = relative(projectsRoot, rootPath);
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath) ||
    relativePath !== basename(rootPath)
  ) {
    return null;
  }
  return basename(rootPath);
}

async function workspaceFromRegisteredRoot(
  rootPath: string,
  planweaveHome: string
): Promise<ProjectWorkspace | null> {
  const projectId = await directRegisteredWorkspaceId(planweaveHome, rootPath);
  if (!projectId) {
    return null;
  }
  const projectFile = join(rootPath, "project.json");
  if (!(await optionalStat(projectFile))) {
    return projectWorkspacePaths({
      id: projectId,
      kind: "managed",
      rootPath,
      sourceRoot: null,
      planweaveHome,
      workspaceRoot: rootPath
    });
  }
  const project = await readProjectMetadataFile(projectFile);
  if (project.id !== basename(rootPath)) {
    throw new Error(
      `PlanWeave workspace metadata id '${project.id}' does not match workspace directory '${basename(rootPath)}'.`
    );
  }
  const normalizedProject = normalizeProjectMetadata(project, {
    planweaveHome,
    workspaceRoot: rootPath
  });
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
  if (!(await optionalStat(workspace.projectFile))) {
    return null;
  }
  const project = await readProjectMetadataFile(workspace.projectFile);
  return normalizeProjectMetadata(project, {
    planweaveHome: workspace.planweaveHome,
    workspaceRoot: workspace.workspaceRoot
  });
}

export async function requireInitializedProjectWorkspace(
  projectRoot: string
): Promise<ProjectWorkspace> {
  const workspace = await resolveProjectWorkspace(projectRoot);
  if (!(await optionalStat(workspace.projectFile))) {
    throw new PlanWeaveWorkspaceNotInitializedError(workspace);
  }
  return workspace;
}
