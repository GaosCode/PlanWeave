import { access, cp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { constants } from "node:fs";
import { resolvePlanweaveHome } from "./paths.js";
import { resolveProjectWorkspace } from "./project.js";
import { createEmptyState } from "./state.js";
import { writeJsonFile } from "./json.js";
import type { InitWorkspaceResult, PlanPackageManifest, ProjectMetadata } from "./types.js";

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
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function initWorkspace(options: {
  projectRoot: string;
  force?: boolean;
  resetPackage?: boolean;
  resetResults?: boolean;
}): Promise<InitWorkspaceResult> {
  const rootPath = await realpath(options.projectRoot);
  const workspace = await resolveProjectWorkspace(rootPath);
  const projectName = basename(rootPath);
  const project: ProjectMetadata = {
    id: workspace.id,
    name: projectName,
    rootPath,
    createdAt: new Date().toISOString()
  };

  const alreadyExists = await exists(workspace.projectFile);
  if (alreadyExists && options.force) {
    throw new Error(`init --force would overwrite existing workspace '${workspace.workspaceRoot}'.`);
  }

  const resetting = options.resetPackage || options.resetResults;
  if (resetting && !alreadyExists) {
    throw new Error(`PlanWeave workspace for project '${rootPath}' has not been initialized.`);
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

  return {
    workspace,
    project,
    created: !alreadyExists,
    ...(backup ? { backup } : {})
  };
}
