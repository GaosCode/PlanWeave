import { cp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { optionalStat } from "./fs/optionalFile.js";
import { resolvePlanweaveHome } from "./paths.js";
import { projectWorkspacePaths, resolveProjectWorkspace } from "./project.js";
import { createManagedProjectId } from "./projectId.js";
import { createEmptyState } from "./state.js";
import { writeJsonFile } from "./json.js";
import { materializeProjectGraph } from "./projectGraph/index.js";
import type { InitWorkspaceResult, PlanPackageManifest, ProjectMetadata, ProjectWorkspace } from "./types.js";

export function initialManifest(projectName: string): PlanPackageManifest {
  return {
    version: "plan-package/v1",
    project: {
      title: projectName,
      description: ""
    },
    execution: {
      parallel: {
        enabled: false,
        maxConcurrent: 1
      }
    },
    review: {
      maxFeedbackCycles: 1,
      completionPolicy: "strict"
    },
    executors: {},
    nodes: [],
    edges: []
  };
}

async function exists(path: string): Promise<boolean> {
  return (await optionalStat(path)) !== null;
}

async function initializeWorkspace(
  workspace: ProjectWorkspace,
  project: ProjectMetadata,
  projectName: string,
  options: {
    force?: boolean;
    resetPackage?: boolean;
    resetResults?: boolean;
    projectGraph?: boolean;
  }
): Promise<InitWorkspaceResult> {
  const alreadyExists = await exists(workspace.projectFile);
  if (alreadyExists && options.force) {
    throw new Error(`init --force would overwrite existing workspace '${workspace.workspaceRoot}'.`);
  }

  const resetting = options.resetPackage || options.resetResults;
  if (resetting && !alreadyExists) {
    throw new Error(`PlanWeave workspace for project '${workspace.rootPath}' has not been initialized.`);
  }

  let backup: InitWorkspaceResult["backup"];
  if (resetting) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = join(workspace.workspaceRoot, "backups", timestamp);
    await mkdir(backupDir, { recursive: true });
    backup = { backupDir };
    if (options.resetPackage) {
      const packageBackup = join(backupDir, "package");
      if (await exists(workspace.packageDir)) {
        await cp(workspace.packageDir, packageBackup, { recursive: true });
        backup.packageDir = packageBackup;
      }
      if (await exists(workspace.stateFile)) {
        const stateBackup = join(backupDir, "state.json");
        await cp(workspace.stateFile, stateBackup);
        backup.stateFile = stateBackup;
      }
      await rm(workspace.packageDir, { recursive: true, force: true });
      await rm(workspace.stateFile, { force: true });
    }
    if (options.resetResults) {
      const resultsBackup = join(backupDir, "results");
      if (await exists(workspace.resultsDir)) {
        await cp(workspace.resultsDir, resultsBackup, { recursive: true });
        backup.resultsDir = resultsBackup;
      }
      await rm(workspace.resultsDir, { recursive: true, force: true });
    }
  }

  await mkdir(join(resolvePlanweaveHome(), "config"), { recursive: true });
  await mkdir(join(workspace.packageDir, "nodes"), { recursive: true });
  await mkdir(dirname(workspace.projectPromptFile), { recursive: true });
  await mkdir(workspace.resultsDir, { recursive: true });

  if (!(await exists(join(resolvePlanweaveHome(), "config", "global-prompt.md")))) {
    await writeFile(join(resolvePlanweaveHome(), "config", "global-prompt.md"), "# Global Prompt\n", "utf8");
  }
  if (!(await exists(workspace.projectPromptFile))) {
    await writeFile(workspace.projectPromptFile, "# Project Prompt\n", "utf8");
  }

  if (!alreadyExists || options.resetPackage) {
    await writeJsonFile(workspace.projectFile, project);
    await writeJsonFile(workspace.manifestFile, initialManifest(projectName));
    await writeJsonFile(workspace.stateFile, createEmptyState());
  }

  const shouldMaterializeProjectGraph = options.projectGraph || !alreadyExists || options.resetPackage;
  const materializedProjectGraph = shouldMaterializeProjectGraph ? await materializeProjectGraph(workspace.rootPath) : undefined;
  const projectGraph = options.projectGraph ? materializedProjectGraph : undefined;

  return {
    workspace,
    project,
    created: !alreadyExists,
    ...(projectGraph ? { projectGraph } : {}),
    ...(backup ? { backup } : {})
  };
}

export async function initWorkspace(options: {
  projectRoot: string;
  force?: boolean;
  resetPackage?: boolean;
  resetResults?: boolean;
  projectGraph?: boolean;
}): Promise<InitWorkspaceResult> {
  const rootPath = await realpath(options.projectRoot);
  const planweaveHome = resolvePlanweaveHome();
  let canonicalPlanweaveHome: string;
  try {
    canonicalPlanweaveHome = await realpath(planweaveHome);
  } catch {
    canonicalPlanweaveHome = planweaveHome;
  }
  const workspace = await resolveProjectWorkspace(rootPath);
  const homeRelativePath = relative(canonicalPlanweaveHome, rootPath);
  const isInsidePlanweaveHome = homeRelativePath === "" || (!homeRelativePath.startsWith("..") && !isAbsolute(homeRelativePath));
  const topLevelHomeSegment = homeRelativePath.split(/[\\/]/)[0];
  const isLegacyManagedLocation = topLevelHomeSegment === "mcp-projects" || topLevelHomeSegment === "mcp-imports";
  if (isInsidePlanweaveHome && !isLegacyManagedLocation && workspace.workspaceRoot !== rootPath) {
    throw new Error(`PlanWeave projects must be initialized directly under '${join(planweaveHome, "projects")}'.`);
  }
  const projectName = basename(rootPath);
  const createdAt = new Date().toISOString();
  const project: ProjectMetadata = {
    id: workspace.id,
    name: projectName,
    rootPath: workspace.kind === "managed" ? workspace.workspaceRoot : rootPath,
    kind: workspace.kind,
    sourceRoot: workspace.kind === "managed" ? null : rootPath,
    createdAt
  };

  return initializeWorkspace(workspace, project, projectName, options);
}

export async function initManagedWorkspace(options: {
  name: string;
  force?: boolean;
  resetPackage?: boolean;
  resetResults?: boolean;
  projectGraph?: boolean;
}): Promise<InitWorkspaceResult> {
  const projectName = options.name.trim();
  if (!projectName) {
    throw new Error("Managed project name must not be empty.");
  }
  const planweaveHome = resolvePlanweaveHome();
  const id = createManagedProjectId(projectName);
  const workspaceRoot = join(planweaveHome, "projects", id);
  const workspace = projectWorkspacePaths({
    id,
    kind: "managed",
    rootPath: workspaceRoot,
    sourceRoot: null,
    planweaveHome,
    workspaceRoot
  });
  const project: ProjectMetadata = {
    id,
    name: projectName,
    rootPath: workspaceRoot,
    kind: "managed",
    sourceRoot: null,
    createdAt: new Date().toISOString()
  };

  return initializeWorkspace(workspace, project, projectName, options);
}
