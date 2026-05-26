import { homedir } from "node:os";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { resolveTaskCanvasWorkspace } from "./desktop/canvasApi.js";
import { resolveProjectWorkspace } from "./project.js";
import type { ProjectPathsResult } from "./types.js";

export function resolvePlanweaveHome(): string {
  return process.env.PLANWEAVE_HOME ? resolve(process.env.PLANWEAVE_HOME) : join(homedir(), ".planweave");
}

export async function readProjectPaths(projectRoot: string): Promise<ProjectPathsResult> {
  const projectWorkspace = await resolveProjectWorkspace(projectRoot);
  try {
    await access(projectWorkspace.projectFile, constants.R_OK);
  } catch {
    throw new Error(`PlanWeave workspace for project '${projectWorkspace.rootPath}' has not been initialized.`);
  }
  const workspace = await resolveTaskCanvasWorkspace(projectRoot);

  return {
    workspaceDir: resolvePlanweaveHome(),
    projectId: workspace.id,
    projectDir: projectWorkspace.workspaceRoot,
    packageDir: workspace.packageDir,
    statePath: workspace.stateFile,
    resultsDir: workspace.resultsDir
  };
}
