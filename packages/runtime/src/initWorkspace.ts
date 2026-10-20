import {
  capturePackageStorageIdentity,
  writeNewResultsStorageIdentity,
  writeNewCanvasStorageIdentity
} from "./package/packageStorageIdentity.js";
import {
  withCanvasStorageMutation,
  withCanvasStorageReplacement
} from "./package/withCanvasStorageMutation.js";
import { withPackageFileConsistency } from "./package/packageFileConsistency.js";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { optionalStat } from "./fs/optionalFile.js";
import { withProjectMutationLock } from "./fs/withProjectMutationLock.js";
import { readProjectMetadataFile } from "./projectMetadata.js";
import { resolvePlanweaveHome } from "./paths.js";
import {
  assertCurrentProjectWorkspace,
  projectWorkspacePaths,
  resolveProjectWorkspaceInHome
} from "./project.js";
import { createManagedProjectId } from "./projectId.js";
import { createEmptyState } from "./state.js";
import { writeJsonFile } from "./json.js";
import { materializeProjectGraph } from "./projectGraph/index.js";
import type {
  InitWorkspaceResult,
  PlanPackageManifest,
  ProjectMetadata,
  ProjectWorkspace
} from "./types.js";

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

export const authoritativeImportReservationFile = ".planweave-content-replica-reservation";

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
    contentReplicaReservationToken?: string;
  }
): Promise<InitWorkspaceResult> {
  if (
    (options.resetPackage || options.resetResults) &&
    workspace.projectCreatedAt === null &&
    (await exists(workspace.projectFile))
  ) {
    workspace = {
      ...workspace,
      projectCreatedAt: (await readProjectMetadataFile(workspace.projectFile)).createdAt
    };
  }
  return withProjectMutationLock(workspace.workspaceRoot, () =>
    initializeWorkspaceLocked(workspace, project, projectName, options)
  );
}

async function initializeWorkspaceLocked(
  workspace: ProjectWorkspace,
  project: ProjectMetadata,
  projectName: string,
  options: {
    force?: boolean;
    resetPackage?: boolean;
    resetResults?: boolean;
    projectGraph?: boolean;
    contentReplicaReservationToken?: string;
  }
): Promise<InitWorkspaceResult> {
  if (workspace.kind === "managed") {
    await assertManagedWorkspaceReservation(
      workspace.workspaceRoot,
      options.contentReplicaReservationToken
    );
  }
  const alreadyExists = await exists(workspace.projectFile);
  if (alreadyExists && options.force) {
    throw new Error(
      `init --force would overwrite existing workspace '${workspace.workspaceRoot}'.`
    );
  }

  const resetting = options.resetPackage || options.resetResults;
  if (resetting && !alreadyExists) {
    throw new Error(
      `PlanWeave workspace for project '${workspace.rootPath}' has not been initialized.`
    );
  }
  if (resetting) await assertCurrentProjectWorkspace(workspace);

  let backup: InitWorkspaceResult["backup"];
  const initializeStorage = async () => {
    await mkdir(dirname(workspace.stateFile), { recursive: true });
    return withCanvasStorageMutation(workspace, async () => {
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
        }
        if (options.resetResults) {
          const resultsBackup = join(backupDir, "results");
          if (await exists(workspace.resultsDir)) {
            await cp(workspace.resultsDir, resultsBackup, { recursive: true });
            backup.resultsDir = resultsBackup;
          }
        }
        if (options.resetPackage) await writeNewCanvasStorageIdentity(workspace);
        if (options.resetResults) await writeNewResultsStorageIdentity(workspace);
        if (options.resetPackage) {
          await rm(workspace.packageDir, { recursive: true, force: true });
          await rm(workspace.stateFile, { force: true });
        }
        if (options.resetResults) {
          await rm(workspace.resultsDir, { recursive: true, force: true });
        }
      }

      await mkdir(join(workspace.planweaveHome, "config"), { recursive: true });
      await mkdir(join(workspace.packageDir, "nodes"), { recursive: true });
      await mkdir(dirname(workspace.projectPromptFile), { recursive: true });
      await mkdir(workspace.resultsDir, { recursive: true });

      if (!(await exists(join(workspace.planweaveHome, "config", "global-prompt.md")))) {
        await writeFile(
          join(workspace.planweaveHome, "config", "global-prompt.md"),
          "# Global Prompt\n",
          "utf8"
        );
      }
      if (!(await exists(workspace.projectPromptFile))) {
        await writeFile(workspace.projectPromptFile, "# Project Prompt\n", "utf8");
      }

      if (!alreadyExists || options.resetPackage) {
        if (!alreadyExists) await writeNewCanvasStorageIdentity(workspace);
        await writeJsonFile(workspace.projectFile, project);
        await writeJsonFile(workspace.manifestFile, initialManifest(projectName));
        await writeJsonFile(workspace.stateFile, createEmptyState());
      }
    });
  };
  await withPackageFileConsistency(
    [workspace.packageDir, workspace.stateFile, workspace.resultsDir],
    () =>
      resetting ? withCanvasStorageReplacement(workspace, initializeStorage) : initializeStorage()
  );

  const persistedProject = await readProjectMetadataFile(workspace.projectFile);
  workspace = await capturePackageStorageIdentity({
    ...workspace,
    projectCreatedAt: persistedProject.createdAt
  });
  const shouldMaterializeProjectGraph =
    options.projectGraph || !alreadyExists || options.resetPackage;
  const materializedProjectGraph = shouldMaterializeProjectGraph
    ? await materializeProjectGraph(workspace)
    : undefined;
  const projectGraph = options.projectGraph ? materializedProjectGraph : undefined;
  return {
    workspace,
    project: persistedProject,
    created: !alreadyExists,
    ...(projectGraph ? { projectGraph } : {}),
    ...(backup ? { backup } : {})
  };
}

export async function initWorkspace(options: {
  projectRoot: string;
  planweaveHome?: string;
  force?: boolean;
  resetPackage?: boolean;
  resetResults?: boolean;
  projectGraph?: boolean;
}): Promise<InitWorkspaceResult> {
  const planweaveHome = options.planweaveHome ?? resolvePlanweaveHome();
  const rootPath = await realpath(options.projectRoot);
  let canonicalPlanweaveHome: string;
  try {
    canonicalPlanweaveHome = await realpath(planweaveHome);
  } catch {
    canonicalPlanweaveHome = planweaveHome;
  }
  const workspace = await resolveProjectWorkspaceInHome(rootPath, planweaveHome);
  const homeRelativePath = relative(canonicalPlanweaveHome, rootPath);
  const isInsidePlanweaveHome =
    homeRelativePath === "" ||
    (!homeRelativePath.startsWith("..") && !isAbsolute(homeRelativePath));
  const topLevelHomeSegment = homeRelativePath.split(/[\\/]/)[0];
  const isLegacyManagedLocation =
    topLevelHomeSegment === "mcp-projects" || topLevelHomeSegment === "mcp-imports";
  if (isInsidePlanweaveHome && !isLegacyManagedLocation && workspace.workspaceRoot !== rootPath) {
    throw new Error(
      `PlanWeave projects must be initialized directly under '${join(planweaveHome, "projects")}'.`
    );
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
  planweaveHome?: string;
  force?: boolean;
  resetPackage?: boolean;
  resetResults?: boolean;
  projectGraph?: boolean;
  contentReplicaReservationToken?: string;
}): Promise<InitWorkspaceResult> {
  const projectName = options.name.trim();
  if (!projectName) {
    throw new Error("Managed project name must not be empty.");
  }
  const planweaveHome = options.planweaveHome ?? resolvePlanweaveHome();
  const id = createManagedProjectId(projectName);
  const workspaceRoot = join(planweaveHome, "projects", id);
  const workspace = projectWorkspacePaths({
    id,
    projectCreatedAt: null,
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

/** @internal Caller holds the project mutation lock through publication. */
export async function assertManagedWorkspaceReservation(
  workspaceRoot: string,
  contentReplicaReservationToken?: string
): Promise<void> {
  const reservationFile = join(workspaceRoot, authoritativeImportReservationFile);
  try {
    const reservationToken = (await readFile(reservationFile, "utf8")).trim();
    if (!contentReplicaReservationToken || contentReplicaReservationToken !== reservationToken) {
      throw new Error("Managed project is reserved by an authoritative content import.");
    }
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT" &&
      contentReplicaReservationToken
    ) {
      throw new Error("Authoritative content import reservation is missing.");
    }
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}
