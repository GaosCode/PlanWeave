import {
  capturePackageStorageIdentity,
  assertPackageStorageIdentity
} from "./package/packageStorageIdentity.js";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { PlanWeaveWorkspaceNotInitializedError } from "./errors.js";
import { optionalStat } from "./fs/optionalFile.js";
import { canonicalFileTarget } from "./fs/canonicalFileTarget.js";
import { withProjectMutationLock } from "./fs/withProjectMutationLock.js";
import { createProjectId } from "./projectId.js";
import { resolvePlanweaveHome } from "./paths.js";
import { readProjectMetadataFile } from "./projectMetadata.js";
import { canonicalCanvasWorkspacePaths } from "./projectGraph/canonicalWorkspace.js";
import type {
  PackageWorkspaceRef,
  ProjectKind,
  ProjectMetadata,
  ProjectWorkspace
} from "./types.js";

export function projectWorkspacePaths(input: {
  id: string;
  projectCreatedAt: string | null;
  kind: ProjectKind;
  rootPath: string;
  sourceRoot: string | null;
  planweaveHome: string;
  workspaceRoot: string;
}): ProjectWorkspace {
  const defaultCanvasWorkspace = canonicalCanvasWorkspacePaths("default");
  return {
    ...input,
    packageStorageIdentity: null,
    resultsStorageIdentity: null,
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

export async function directRegisteredWorkspaceId(
  planweaveHome: string,
  rootPath: string
): Promise<string | null> {
  let projectsRoot: string;
  try {
    projectsRoot = await realpath(join(planweaveHome, "projects"));
  } catch {
    projectsRoot = join(planweaveHome, "projects");
  }
  let resolvedRootPath: string;
  try {
    resolvedRootPath = await realpath(rootPath);
  } catch {
    try {
      resolvedRootPath = join(await realpath(dirname(rootPath)), basename(rootPath));
    } catch {
      resolvedRootPath = rootPath;
    }
  }
  const relativePath = relative(projectsRoot, resolvedRootPath);
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath) ||
    relativePath !== basename(resolvedRootPath)
  ) {
    return null;
  }
  return basename(resolvedRootPath);
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
      projectCreatedAt: null,
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
    projectCreatedAt: normalizedProject.createdAt,
    kind: metadataKind(normalizedProject),
    rootPath: normalizedProject.rootPath,
    sourceRoot: sourceRootForMetadata(normalizedProject),
    planweaveHome,
    workspaceRoot: rootPath
  });
}

async function resolveProjectWorkspaceAtRoot(
  rootPath: string,
  planweaveHome: string
): Promise<ProjectWorkspace> {
  const registeredWorkspace = await workspaceFromRegisteredRoot(rootPath, planweaveHome);
  if (registeredWorkspace) {
    return registeredWorkspace;
  }
  const id = await createProjectId(rootPath);
  const workspaceRoot = join(planweaveHome, "projects", id);
  const projectFile = join(workspaceRoot, "project.json");
  const project = (await optionalStat(projectFile))
    ? await readProjectMetadataFile(projectFile)
    : null;
  return projectWorkspacePaths({
    id,
    projectCreatedAt: project?.createdAt ?? null,
    kind: "external",
    rootPath,
    sourceRoot: rootPath,
    planweaveHome,
    workspaceRoot
  });
}

/** Resolves canonical project paths using the Home captured by a policy operation. */
export async function resolveProjectWorkspaceInHome(
  projectRoot: string,
  planweaveHome: string
): Promise<ProjectWorkspace> {
  return capturePackageStorageIdentity(
    await resolveProjectWorkspaceAtRoot(await realpath(projectRoot), planweaveHome)
  );
}

export async function resolveProjectWorkspace(projectRoot: string): Promise<ProjectWorkspace> {
  const planweaveHome = resolvePlanweaveHome();
  return resolveProjectWorkspaceInHome(projectRoot, planweaveHome);
}

export async function readProject(
  projectRoot: PackageWorkspaceRef
): Promise<ProjectMetadata | null> {
  const workspace =
    typeof projectRoot === "string" ? await resolveProjectWorkspace(projectRoot) : projectRoot;
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
  projectRoot: PackageWorkspaceRef
): Promise<ProjectWorkspace> {
  const workspace =
    typeof projectRoot === "string" ? await resolveProjectWorkspace(projectRoot) : projectRoot;
  if (!(await optionalStat(workspace.projectFile))) {
    throw new PlanWeaveWorkspaceNotInitializedError(workspace);
  }
  return workspace;
}

/** Revalidate a captured workspace while its mutation or storage admission is held. */
export async function assertCurrentProjectWorkspace(workspace: ProjectWorkspace): Promise<void> {
  const current = await resolveProjectWorkspaceInHome(workspace.rootPath, workspace.planweaveHome);
  const project = await readProjectMetadataFile(current.projectFile);
  if (
    current.id !== workspace.id ||
    project.id !== workspace.id ||
    workspace.projectCreatedAt === null ||
    project.createdAt !== workspace.projectCreatedAt ||
    (await canonicalFileTarget(current.projectFile)) !==
      (await canonicalFileTarget(workspace.projectFile))
  ) {
    throw new Error(`PlanWeave project workspace identity changed at '${workspace.rootPath}'.`);
  }
}

/** Project identity and its storage admission share the relocation lock. */
export async function withCurrentProjectWorkspace<T>(
  workspace: ProjectWorkspace,
  apply: () => Promise<T>
): Promise<T> {
  return withProjectMutationLock(dirname(workspace.projectFile), async () => {
    await assertCurrentProjectWorkspace(workspace);
    if (workspace.packageStorageIdentity !== null) await assertPackageStorageIdentity(workspace);
    return apply();
  });
}
