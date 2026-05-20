import { homedir } from "node:os";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { resolveProjectWorkspace } from "./project.js";
import type { ProjectPathsResult } from "./types.js";

export function resolvePlanweaveHome(): string {
  return process.env.PLANWEAVE_HOME ? resolve(process.env.PLANWEAVE_HOME) : join(homedir(), ".planweave");
}

export async function readProjectPaths(projectRoot: string): Promise<ProjectPathsResult> {
  const workspace = await resolveProjectWorkspace(projectRoot);
  try {
    await access(workspace.projectFile, constants.R_OK);
  } catch {
    throw new Error(`PlanWeave workspace for project '${workspace.rootPath}' has not been initialized.`);
  }

  return {
    workspaceDir: resolvePlanweaveHome(),
    projectId: workspace.id,
    projectDir: workspace.workspaceRoot,
    packageDir: workspace.packageDir,
    statePath: workspace.stateFile,
    resultsDir: workspace.resultsDir
  };
}
